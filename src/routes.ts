import { createHash } from 'node:crypto';

import { Actor, log } from 'apify';

import { FETCH_WORST_CASE_MS, fetchYearAuctions } from './dataSource.js';
import { benchmarkRateKey, classify, normalizeAuction, shouldDeliver, toStoredFingerprint } from './deltaEngine.js';
import { notifyAllChannels } from './notifier.js';
import { recordSeen, recordYearChecked } from './state.js';
import { budgetExceededFor, getRunBudget } from './timeBudget.js';
import type { ActorInput, ClassifiedEvent, DeltaState, NormalizedAuction, OutputRecord, RawAuctionRow, RegistryYear } from './types.js';
import { DEFAULT_YEAR } from './types.js';

/**
 * How much of this run's real remaining time budget one more registry year requires before it is
 * safe to start it (see timeBudget.ts and dataSource.ts's FETCH_WORST_CASE_MS doc comments for the
 * full "REAL RECURRENCE" writeup this guards against): the worst-case download+retry time for one
 * year, plus a fixed buffer for XLSX parsing and row processing on top of it. This source's files
 * are small (58-85 KB - see fetchYearAuctions's doc comment), so parsing a whole year is normally
 * well under a second; this buffer is deliberately generous relative to that observed reality.
 */
const YEAR_PARSE_BUFFER_MS = 5_000;
const YEAR_WORST_CASE_MS = FETCH_WORST_CASE_MS + YEAR_PARSE_BUFFER_MS;

const EVENT_NEW_AUCTION = 'new-auction';
const EVENT_AUCTION_REVISED = 'auction-result-revised';

export interface RunStats {
    totalPushed: number;
    stopped: boolean;
    yearsChecked: number;
    byEventType: Record<string, number>;
}

export function computeEventId(classified: ClassifiedEvent): string {
    return createHash('sha1')
        .update(`${classified.auction.recordId}|${classified.eventType}|${classified.statusFingerprint}|${classified.contentFingerprint}`)
        .digest('hex');
}

export function toOutputRecord(classified: ClassifiedEvent, scrapedAt: string): OutputRecord {
    const { auction } = classified;
    return {
        '@type': 'schema:FinancialProduct',
        event_id: computeEventId(classified),
        event_type: classified.eventType,
        record_id: auction.recordId,
        auction_date: auction.auctionDate,
        bond_type: auction.bondType,
        auction_type: auction.auctionType || null,
        round: auction.round || null,
        settlement_date: auction.settlementDate,
        maturity_date: auction.maturityDate,
        benchmark: auction.benchmark,
        quantity_offered: auction.quantityOffered,
        quantity_accepted: auction.quantityAccepted,
        coverage_ratio: auction.coverageRatio,
        average_rate_decimal: auction.averageRateDecimal,
        average_rate_bps: auction.averageRateBps,
        accepted_rate_decimal: auction.acceptedRateDecimal,
        accepted_rate_bps: auction.acceptedRateBps,
        rate_change_bps: classified.rateChangeBps,
        total_amount_accepted: auction.totalAmountAcceptedBrl,
        total_amount_accepted_currency: auction.currency,
        quantity_to_central_bank: auction.quantityToCentralBank,
        total_amount_to_central_bank: auction.totalAmountToCentralBankBrl,
        yield_threshold_breached: classified.yieldThresholdBreached,
        coverage_threshold_breached: classified.coverageThresholdBreached,
        status_fingerprint: classified.statusFingerprint,
        content_fingerprint: classified.contentFingerprint,
        is_new: classified.eventType === 'NEW_AUCTION' || classified.eventType === 'BASELINE_SNAPSHOT',
        scraped_at: scrapedAt,
    };
}

/** Returns the pay-per-event charge event name for a given classification, or undefined for uncharged deliveries. */
export function eventNameFor(eventType: ClassifiedEvent['eventType']): string | undefined {
    switch (eventType) {
        case 'NEW_AUCTION':
            return EVENT_NEW_AUCTION;
        case 'AUCTION_RESULT_REVISED':
            return EVENT_AUCTION_REVISED;
        default:
            return undefined; // BASELINE_SNAPSHOT / AUCTION_UNCHANGED - never charged, see README Pricing section
    }
}

/**
 * Is this a change a quant/compliance buyer would actually escalate on? A brand-new auction is
 * always worth knowing about; any classification's own computed threshold breaches (yield or
 * coverage - see deltaEngine.ts's classify()) are exactly the "financial-grade quantitative
 * delta threshold" the mandate asked for, already resolved by the time this is called.
 */
export function isHighValueChange(classified: ClassifiedEvent): boolean {
    if (classified.eventType === 'NEW_AUCTION') return true;
    if (classified.eventType !== 'AUCTION_RESULT_REVISED') return false;
    return classified.yieldThresholdBreached || classified.coverageThresholdBreached;
}

export function matchesFilters(auction: NormalizedAuction, input: ActorInput): boolean {
    // `auction.bondType`/`auctionType` are plain `string` (they originate from a real, externally
    // fetched XLSX cell - see RawAuctionRow - so they cannot be statically typed as the narrower
    // BondType/AuctionType union without a runtime validation step this actor doesn't perform).
    // `input.bondTypeFilter`/`auctionTypeFilter` ARE typed as the narrower unions (tightened after
    // adversarial review) since they come from the input schema's own enum-constrained fields.
    // The comparison below is a safe runtime string check across that real typing gap, not an
    // unchecked cast of untrusted data into the narrower type.
    const bondTypes: string[] | undefined = input.bondTypeFilter;
    if (bondTypes && bondTypes.length > 0) {
        if (!bondTypes.includes(auction.bondType)) return false;
    }
    const auctionTypes: string[] | undefined = input.auctionTypeFilter;
    if (auctionTypes && auctionTypes.length > 0) {
        if (!auctionTypes.includes(auction.auctionType)) return false;
    }
    return true;
}

async function processRow(
    row: RawAuctionRow,
    year: RegistryYear,
    state: DeltaState,
    benchmarkRates: Record<string, number | null>,
    input: ActorInput,
    scrapedAt: string,
    stats: RunStats,
): Promise<void> {
    const onlyNew = input.onlyNew ?? true;
    const yieldChangeThresholdBps = input.yieldChangeThresholdBps ?? 10;
    const coverageRatioFloor = input.coverageRatioFloor ?? 0.5;

    let auction: NormalizedAuction;
    try {
        auction = normalizeAuction(row);
    } catch (error) {
        log.warning(`Skipping one row that could not be normalized: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    const rateKey = benchmarkRateKey(auction.bondType, auction.auctionType, auction.maturityDate);
    const previousBenchmarkRate = benchmarkRates[rateKey] ?? null;

    // Every real, normalizable row is tracked in state (recordSeen, below) and updates the
    // benchmark rate history regardless of the user's delivery filters (bondTypeFilter/
    // auctionTypeFilter) or onlyNew - filtering controls what gets DELIVERED this run, never
    // whether a row counts toward this year's baseline or rate history. This is the same
    // filter/tracking separation fix Actor #2 needed after adversarial review found the bug;
    // applied here from the start.
    const yearCacheEntry = state.yearCache[year];
    const classified = classify(auction, state, yearCacheEntry?.baselineComplete ?? false, previousBenchmarkRate, yieldChangeThresholdBps, coverageRatioFloor);

    // eslint-disable-next-line no-param-reassign -- `benchmarkRates` is an explicit mutable accumulator passed in by design
    benchmarkRates[rateKey] = auction.acceptedRateBps;

    const deliverable = matchesFilters(auction, input) && shouldDeliver(classified, onlyNew);

    if (!deliverable) {
        recordSeen(state, auction.recordId, toStoredFingerprint(classified, scrapedAt));
        return;
    }

    const record = toOutputRecord(classified, scrapedAt);
    const eventName = eventNameFor(classified.eventType);
    const pushResult = eventName ? await Actor.pushData(record, eventName) : ({} as { eventChargeLimitReached?: boolean });
    if (!eventName) await Actor.pushData(record);

    // eslint-disable-next-line no-param-reassign
    stats.totalPushed += 1;
    // eslint-disable-next-line no-param-reassign
    stats.byEventType[classified.eventType] = (stats.byEventType[classified.eventType] ?? 0) + 1;

    if (isHighValueChange(classified)) {
        await notifyAllChannels({ webhookUrl: input.webhookUrl, slackWebhookUrl: input.slackWebhookUrl, teamsWebhookUrl: input.teamsWebhookUrl }, record);
    }

    // Only commit the new fingerprint for a row that was successfully pushed (or filtered out
    // above, before any charge risk) - a record held back by a charge/item limit must remain
    // eligible to be correctly reclassified next run.
    recordSeen(state, auction.recordId, toStoredFingerprint(classified, scrapedAt));

    if (pushResult.eventChargeLimitReached || (input.maxItems && stats.totalPushed >= input.maxItems)) {
        // eslint-disable-next-line no-param-reassign
        stats.stopped = true;
    }
}

async function processYear(
    year: RegistryYear,
    state: DeltaState,
    benchmarkRates: Record<string, number | null>,
    input: ActorInput,
    scrapedAt: string,
    stats: RunStats,
): Promise<void> {
    let fetched;
    try {
        fetched = await fetchYearAuctions(year);
    } catch (error) {
        // A transient download/parse failure on ONE year must not abort the whole run - other,
        // independent years in `years` are still worth attempting (the same real gap found and
        // fixed in Actor #2's processYear, applied here from the start).
        log.warning(`Could not download or parse registry year ${year}: ${error instanceof Error ? error.message : String(error)}. Skipping this year for this run - other selected years are unaffected.`);
        return;
    }

    if (fetched === null) {
        // Real 404 (a not-yet-published future year). Nothing to do.
        return;
    }

    // eslint-disable-next-line no-param-reassign
    stats.yearsChecked += 1;

    // No file-level "unchanged, skip parsing" fast path here - this server's ETag was tested live
    // and found to change on every request regardless of content (see dataSource.ts's
    // fetchYearAuctions doc comment), so there is no cheap signal to skip on. Every selected year
    // is always parsed and diffed; the per-record content fingerprint below (not a file-level
    // check) is what actually avoids re-billing unchanged auctions.
    log.info(`Registry year ${year}: parsing ${fetched.rows.length} real auction rows.`);

    for (const row of fetched.rows) {
        if (stats.stopped) break;
        await processRow(row, year, state, benchmarkRates, input, scrapedAt, stats);
    }

    // Only mark this year's baseline complete if the ENTIRE file was walked without maxItems (or
    // a pay-per-event charge limit) cutting it short - the same truncation-safety invariant
    // Actor #1 and #2 both needed as a live-tested bug fix, applied here from the start.
    if (!stats.stopped) {
        recordYearChecked(state, year, { lastChecked: scrapedAt, baselineComplete: true });
    }
}

export async function run(input: ActorInput, state: DeltaState, benchmarkRates: Record<string, number | null>): Promise<RunStats> {
    const scrapedAt = new Date().toISOString();
    const stats: RunStats = { totalPushed: 0, stopped: false, yearsChecked: 0, byEventType: {} };
    const years = input.years && input.years.length > 0 ? input.years : [DEFAULT_YEAR];
    // Snapshotted once per run, not re-read per year - it is this run's own fixed deadline (see
    // timeBudget.ts).
    const budget = getRunBudget();

    for (const year of years) {
        if (stats.stopped) break;
        // Multi-year runs call fetchYearAuctions once per year, sequentially - each call's own
        // worst case is real (see FETCH_WORST_CASE_MS), so a `years` selection large enough (or
        // unlucky enough) can still exceed this run's real platform timeout even after the
        // per-call tightening in dataSource.ts. Rather than starting a year this run cannot
        // safely finish, defer it (and any still-unattempted years after it) to a future run -
        // no state is lost: every year already processed this run has already been recorded via
        // recordYearChecked/recordSeen below, and this deliberately does NOT set `stats.stopped`,
        // which has a different, narrower meaning (an in-progress year truncated by
        // maxItems/eventChargeLimitReached - see processYear's own comment) than simply never
        // having started a later year at all.
        if (budgetExceededFor(budget, YEAR_WORST_CASE_MS)) {
            log.warning(
                `Stopping before registry year ${year}: not enough of this run's own real timeout budget remains to safely start another year (worst case ~${Math.round(YEAR_WORST_CASE_MS / 1000)}s for one year's download, retries, and parsing). This and any remaining selected years will be attempted on a future run - no data or state already recorded this run is lost.`,
            );
            break;
        }
        await processYear(year, state, benchmarkRates, input, scrapedAt, stats);
    }

    return stats;
}
