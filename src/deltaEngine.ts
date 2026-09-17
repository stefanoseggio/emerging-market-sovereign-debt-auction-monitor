import { createHash } from 'node:crypto';

import { excelSerialToIsoDate } from './dataSource.js';
import { computeCoverageRatio, computeRateChangeBps, isCoverageThresholdBreached, isYieldThresholdBreached, toBasisPoints } from './quantEngine.js';
import type { ClassifiedEvent, DeltaState, EventType, NormalizedAuction, RawAuctionRow, StoredFingerprint } from './types.js';

/**
 * Real, unique per auction row - verified live against 2,850 real rows spanning 2024, 2025, and
 * 2026 with zero collisions (see ARCHITECTURE.md section 5). All five components are required.
 * `auctionType` was added after a live test caught a real collision a 4-component key (bondType +
 * maturityDate + auctionDate + round, without auctionType) missed: a live 2026-03-16 LTN row runs
 * a genuine "Extra Compra" (extraordinary purchase) and a separate "Extra Venda" (extraordinary
 * sale) for the SAME bond, maturity, date, and round - two real, independent operations, not a
 * duplicate or a correction of each other. Without auctionType in the key, the second row
 * overwrote the first's tracked fingerprint and was misclassified as a revision of it.
 */
function buildRecordId(auction: Pick<NormalizedAuction, 'bondType' | 'auctionType' | 'maturityDate' | 'auctionDate' | 'round'>): string {
    return `${auction.bondType}-${auction.auctionType}-${auction.maturityDate ?? 'no-maturity'}-${auction.auctionDate}-${auction.round}`;
}

/**
 * Groups rate history by the underlying instrument AND auction type - NOT by the human-readable
 * `benchmark` label, which is missing on some real rows (confirmed live: typically absent on a
 * 2nd-round row), while maturity date is always present and is the actual instrument identity.
 *
 * `auctionType` was added after adversarial review found the exact same collision class already
 * fixed in `buildRecordId` (see above) had not been ported here: a "Compra"/"Extra Compra"
 * (purchase/buyback) and a "Venda"/"Extra Venda" (sale) operation on the same bond+maturity are
 * economically different price-discovery mechanisms (a buyback rate reflects the Treasury's own
 * repurchase offer, not the market's issuance rate) - mixing them into one rolling "last observed
 * rate" slot produced a spurious rateChangeBps and could trigger a false threshold-breach alert.
 */
export function benchmarkRateKey(bondType: string, auctionType: string, maturityDate: string | null): string {
    return `${bondType}::${auctionType}::${maturityDate ?? 'no-maturity'}`;
}

export function normalizeAuction(row: RawAuctionRow): NormalizedAuction {
    if (!row.bondType) {
        throw new Error('Auction row is missing bondType - cannot classify this record.');
    }
    if (row.auctionDateSerial === null) {
        // Found by adversarial review: a prior version defaulted an unparseable auction-date
        // cell to serial 0, which excelSerialToIsoDate silently turns into the fabricated
        // sentinel date "1899-12-30" instead of rejecting the row - exactly the class of
        // fabrication this whole fleet's "never invent data" discipline exists to prevent.
        throw new Error('Auction row is missing a valid auction date - cannot classify this record.');
    }
    const auctionDate = excelSerialToIsoDate(row.auctionDateSerial);
    const maturityDate = row.maturityDateSerial !== null ? excelSerialToIsoDate(row.maturityDateSerial) : null;
    const settlementDate = row.settlementDateSerial !== null ? excelSerialToIsoDate(row.settlementDateSerial) : null;
    const averageRateBps = toBasisPoints(row.averageRate);
    const acceptedRateBps = toBasisPoints(row.acceptedRate);
    const coverageRatio = computeCoverageRatio(row.quantityAccepted, row.quantityOffered);

    const partial = { bondType: row.bondType, auctionType: row.auctionType, maturityDate, auctionDate, round: row.round };

    return {
        recordId: buildRecordId(partial),
        auctionDate,
        bondType: row.bondType,
        auctionType: row.auctionType,
        round: row.round,
        settlementDate,
        maturityDate,
        benchmark: row.benchmark,
        quantityOffered: row.quantityOffered,
        quantityAccepted: row.quantityAccepted,
        coverageRatio,
        averageRateDecimal: row.averageRate,
        averageRateBps,
        acceptedRateDecimal: row.acceptedRate,
        acceptedRateBps,
        totalAmountAcceptedBrl: row.totalAmountAcceptedBrl,
        quantityToCentralBank: row.quantityToCentralBank,
        totalAmountToCentralBankBrl: row.totalAmountToCentralBankBrl,
        currency: 'BRL',
    };
}

/** Recursive key-sort canonicalization - same discipline as Actors #1/#2. */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        const sortedEntries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => [key, canonicalize(val)] as const);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

/** Excludes `recordId` (the state key itself, derived from other fields) from the content hash. */
function hashableFields(auction: NormalizedAuction): Omit<NormalizedAuction, 'recordId'> {
    const { recordId: _id, ...rest } = auction;
    return rest;
}

export function computeContentFingerprint(auction: NormalizedAuction): string {
    return sha256(JSON.stringify(canonicalize(hashableFields(auction))));
}

/** The subset a quant/compliance buyer actually escalates on: the marginal rate and coverage. */
function statusRelevantFields(auction: NormalizedAuction) {
    return {
        acceptedRateBps: auction.acceptedRateBps,
        coverageRatio: auction.coverageRatio,
    };
}

export function computeStatusFingerprint(auction: NormalizedAuction): string {
    return sha256(JSON.stringify(canonicalize(statusRelevantFields(auction))));
}

/**
 * Classifies one auction against the persisted delta state. Determines the auction's TRUE event
 * type only - it deliberately does not know about `onlyNew` (see Actor #1's classify/onlyNew
 * conflation bug, applied as a lesson from the start here) and does not decide delivery (see
 * `shouldDeliver` - not exported from this module, callers combine filters + this).
 * `yearBaselineComplete` is the per-YEAR baseline flag (see Actor #2's global-vs-per-year
 * baseline bug, also applied as a lesson from the start: this parameter is scoped by the caller
 * to the specific year this row was fetched from, not read from a single fleet-wide flag).
 * `previousBenchmarkRateBps` is the last observed rate for this auction's bond type + maturity
 * (see `benchmarkRateKey`), used only to compute `rateChangeBps` / threshold breaches - entirely
 * independent of whether this exact auction record itself is new or changed.
 */
export function classify(
    auction: NormalizedAuction,
    state: DeltaState,
    yearBaselineComplete: boolean,
    previousBenchmarkRateBps: number | null,
    yieldChangeThresholdBps: number,
    coverageRatioFloor: number,
): ClassifiedEvent {
    const contentFingerprint = computeContentFingerprint(auction);
    const statusFingerprint = computeStatusFingerprint(auction);
    const previous = state.auctions[auction.recordId];

    let eventType: EventType;
    if (!previous) {
        eventType = yearBaselineComplete ? 'NEW_AUCTION' : 'BASELINE_SNAPSHOT';
    } else if (previous.contentFingerprint !== contentFingerprint) {
        eventType = 'AUCTION_RESULT_REVISED';
    } else {
        eventType = 'AUCTION_UNCHANGED';
    }

    const rateChangeBps = computeRateChangeBps(auction.acceptedRateBps, previousBenchmarkRateBps);

    return {
        auction,
        eventType,
        statusFingerprint,
        contentFingerprint,
        rateChangeBps,
        yieldThresholdBreached: isYieldThresholdBreached(rateChangeBps, yieldChangeThresholdBps),
        coverageThresholdBreached: isCoverageThresholdBreached(auction.coverageRatio, coverageRatioFloor),
    };
}

/**
 * Delivery filter, kept separate from classify() (see above). NEW_AUCTION and
 * AUCTION_RESULT_REVISED are always delivered - the two charged, buyer-relevant tiers.
 * BASELINE_SNAPSHOT and AUCTION_UNCHANGED are only delivered when `onlyNew` is false.
 */
export function shouldDeliver(classified: ClassifiedEvent, onlyNew: boolean): boolean {
    if (classified.eventType === 'NEW_AUCTION' || classified.eventType === 'AUCTION_RESULT_REVISED') return true;
    return !onlyNew;
}

export function toStoredFingerprint(classified: ClassifiedEvent, seenAt: string): StoredFingerprint {
    return {
        statusFingerprint: classified.statusFingerprint,
        contentFingerprint: classified.contentFingerprint,
        acceptedRateBps: classified.auction.acceptedRateBps,
        lastSeen: seenAt,
    };
}
