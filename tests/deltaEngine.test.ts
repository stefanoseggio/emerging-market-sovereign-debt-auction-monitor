import { describe, expect, it } from 'vitest';

import { excelSerialToIsoDate } from '../src/dataSource.js';
import { classify, computeContentFingerprint, computeStatusFingerprint, normalizeAuction, shouldDeliver } from '../src/deltaEngine.js';
import type { DeltaState, RawAuctionRow } from '../src/types.js';

function baseRow(overrides: Partial<RawAuctionRow> = {}): RawAuctionRow {
    return {
        auctionDateSerial: 45295, // real observed serial -> 2024-01-04
        bondType: 'LTN',
        auctionType: 'Venda',
        round: '1.ª volta',
        settlementDateSerial: 45296,
        maturityDateSerial: 45748,
        quantityOffered: 1_000_000,
        averageRate: 0.098997,
        acceptedRate: 0.099024,
        quantityAccepted: 680_000,
        totalAmountAcceptedBrl: 605_220_929.91,
        quantityToCentralBank: 0,
        totalAmountToCentralBankBrl: 0,
        benchmark: 'LTN 12 meses',
        ...overrides,
    };
}

function emptyState(): DeltaState {
    return { auctions: {}, yearCache: {} };
}

describe('excelSerialToIsoDate', () => {
    it('converts the real observed serial for a known 2024-01-04 auction date correctly', () => {
        expect(excelSerialToIsoDate(45295)).toBe('2024-01-04');
    });

    it('converts a real observed 2026 serial correctly', () => {
        // Confirmed live: 2026-09-15 auction date serial.
        expect(excelSerialToIsoDate(46280)).toBe('2026-09-15');
    });

    it('is timezone-independent - always produces the same UTC calendar date regardless of host timezone', () => {
        // This is the exact regression this function exists to prevent: a naive `new Date(serial)`
        // or `cellDates: true` conversion can shift by the host's local timezone offset.
        const iso = excelSerialToIsoDate(45295);
        expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(`${iso}T00:00:00.000Z`).getUTCDate()).toBe(4);
    });
});

describe('normalizeAuction', () => {
    it('maps a standard real-shaped row to a fully populated NormalizedAuction', () => {
        const result = normalizeAuction(baseRow());
        expect(result.bondType).toBe('LTN');
        expect(result.auctionDate).toBe('2024-01-04');
        expect(result.maturityDate).toBe('2025-04-01');
        expect(result.currency).toBe('BRL');
    });

    it('converts rates to basis points alongside the preserved decimal fraction', () => {
        const result = normalizeAuction(baseRow());
        expect(result.acceptedRateDecimal).toBe(0.099024);
        expect(result.acceptedRateBps).toBe(990);
    });

    it('computes the coverage ratio from quantityAccepted/quantityOffered', () => {
        const result = normalizeAuction(baseRow());
        expect(result.coverageRatio).toBeCloseTo(0.68, 10);
    });

    it('throws when bondType is missing - there is nothing to classify this record as', () => {
        expect(() => normalizeAuction(baseRow({ bondType: '' }))).toThrow(/bondType/);
    });

    it('builds a 5-component compound recordId including auctionType', () => {
        const result = normalizeAuction(baseRow());
        expect(result.recordId).toBe('LTN-Venda-2025-04-01-2024-01-04-1.ª volta');
    });

    it('gives two different auction types on the same bond/maturity/date/round two different recordIds (regression test for the real collision found live in the 2026 file: a genuine "Extra Compra" and "Extra Venda" on the same day)', () => {
        const compra = normalizeAuction(baseRow({ auctionType: 'Extra Compra' }));
        const venda = normalizeAuction(baseRow({ auctionType: 'Extra Venda' }));
        expect(compra.recordId).not.toBe(venda.recordId);
    });
});

describe('computeContentFingerprint (canonicalization + SHA-256)', () => {
    it('is deterministic', () => {
        const auction = normalizeAuction(baseRow());
        expect(computeContentFingerprint(auction)).toBe(computeContentFingerprint(auction));
    });

    it('produces a 64-character lowercase hex SHA-256 digest', () => {
        const auction = normalizeAuction(baseRow());
        expect(computeContentFingerprint(auction)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes when the accepted rate changes', () => {
        const a = normalizeAuction(baseRow());
        const b = normalizeAuction(baseRow({ acceptedRate: 0.1 }));
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });

    it('is order-independent (canonicalization sorts keys recursively)', () => {
        const auction = normalizeAuction(baseRow());
        const reordered = Object.fromEntries(Object.entries(auction).reverse()) as typeof auction;
        expect(computeContentFingerprint(reordered)).toBe(computeContentFingerprint(auction));
    });
});

describe('computeStatusFingerprint', () => {
    it('changes when the accepted rate changes', () => {
        const a = normalizeAuction(baseRow());
        const b = normalizeAuction(baseRow({ acceptedRate: 0.1 }));
        expect(computeStatusFingerprint(a)).not.toBe(computeStatusFingerprint(b));
    });

    it('changes when the coverage ratio changes', () => {
        const a = normalizeAuction(baseRow());
        const b = normalizeAuction(baseRow({ quantityAccepted: 500_000 }));
        expect(computeStatusFingerprint(a)).not.toBe(computeStatusFingerprint(b));
    });

    it('does NOT change when only a non-status field changes (e.g. totalAmountAcceptedBrl) - content fingerprint still does', () => {
        const a = normalizeAuction(baseRow());
        const b = normalizeAuction(baseRow({ totalAmountAcceptedBrl: 1 }));
        expect(computeStatusFingerprint(a)).toBe(computeStatusFingerprint(b));
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });
});

describe('classify (state machine, per-year baseline scoping)', () => {
    it('classifies a never-seen auction as BASELINE_SNAPSHOT when this year has no baseline yet', () => {
        const auction = normalizeAuction(baseRow());
        const result = classify(auction, emptyState(), false, null, 10, 0.5);
        expect(result.eventType).toBe('BASELINE_SNAPSHOT');
    });

    it('classifies a never-seen auction as NEW_AUCTION once THIS year is baselined', () => {
        const auction = normalizeAuction(baseRow());
        const result = classify(auction, emptyState(), true, null, 10, 0.5);
        expect(result.eventType).toBe('NEW_AUCTION');
    });

    it('classifies a previously-seen, unchanged auction as AUCTION_UNCHANGED', () => {
        const auction = normalizeAuction(baseRow());
        const state = emptyState();
        const first = classify(auction, state, false, null, 10, 0.5);
        state.auctions[auction.recordId] = { statusFingerprint: first.statusFingerprint, contentFingerprint: first.contentFingerprint, acceptedRateBps: auction.acceptedRateBps, lastSeen: '2026-01-01T00:00:00.000Z' };
        const second = classify(auction, state, true, null, 10, 0.5);
        expect(second.eventType).toBe('AUCTION_UNCHANGED');
    });

    it('classifies a previously-seen, changed auction as AUCTION_RESULT_REVISED', () => {
        const original = normalizeAuction(baseRow());
        const state = emptyState();
        const first = classify(original, state, false, null, 10, 0.5);
        state.auctions[original.recordId] = { statusFingerprint: first.statusFingerprint, contentFingerprint: first.contentFingerprint, acceptedRateBps: original.acceptedRateBps, lastSeen: '2026-01-01T00:00:00.000Z' };

        const changed = normalizeAuction(baseRow({ acceptedRate: 0.15 }));
        const second = classify(changed, state, false, null, 10, 0.5);
        expect(second.eventType).toBe('AUCTION_RESULT_REVISED');
    });

    it('never mutates the passed-in state', () => {
        const auction = normalizeAuction(baseRow());
        const state = emptyState();
        const snapshotBefore = JSON.stringify(state);
        classify(auction, state, false, null, 10, 0.5);
        expect(JSON.stringify(state)).toBe(snapshotBefore);
    });

    it('computes rateChangeBps against the supplied previous benchmark rate, independent of the recordId-level fingerprint', () => {
        const auction = normalizeAuction(baseRow({ acceptedRate: 0.1 })); // 1000 bps
        const result = classify(auction, emptyState(), true, 990, 10, 0.5);
        expect(result.rateChangeBps).toBe(10);
        expect(result.yieldThresholdBreached).toBe(true);
    });

    it('flags a coverage threshold breach for a genuinely undersubscribed auction', () => {
        const auction = normalizeAuction(baseRow({ quantityAccepted: 100_000, quantityOffered: 1_000_000 })); // 10% coverage
        const result = classify(auction, emptyState(), true, null, 10, 0.5);
        expect(result.coverageThresholdBreached).toBe(true);
    });

    it('does not flag a coverage breach for a fully subscribed auction', () => {
        const auction = normalizeAuction(baseRow({ quantityAccepted: 1_000_000, quantityOffered: 1_000_000 }));
        const result = classify(auction, emptyState(), true, null, 10, 0.5);
        expect(result.coverageThresholdBreached).toBe(false);
    });
});

describe('shouldDeliver (delivery filter, kept separate from classify)', () => {
    it('always delivers NEW_AUCTION and AUCTION_RESULT_REVISED regardless of onlyNew', () => {
        const auction = normalizeAuction(baseRow());
        const classified = classify(auction, emptyState(), true, null, 10, 0.5);
        expect(classified.eventType).toBe('NEW_AUCTION');
        expect(shouldDeliver(classified, true)).toBe(true);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('suppresses BASELINE_SNAPSHOT when onlyNew is true, delivers it when false', () => {
        const auction = normalizeAuction(baseRow());
        const classified = classify(auction, emptyState(), false, null, 10, 0.5);
        expect(classified.eventType).toBe('BASELINE_SNAPSHOT');
        expect(shouldDeliver(classified, true)).toBe(false);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('a not-yet-baselined year correctly reports NEW_AUCTION once baselined (regression test for the classify/onlyNew conflation bug found in Actor #1, applied here from the start)', () => {
        const auction = normalizeAuction(baseRow());
        const classified = classify(auction, emptyState(), true, null, 10, 0.5);
        expect(classified.eventType).toBe('NEW_AUCTION');
        expect(shouldDeliver(classified, false)).toBe(true);
    });
});
