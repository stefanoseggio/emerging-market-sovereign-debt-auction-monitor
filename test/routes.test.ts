import { describe, expect, it, vi } from 'vitest';

import { classify, normalizeAuction } from '../src/deltaEngine.js';
import { computeEventId, eventNameFor, isHighValueChange, matchesFilters, toOutputRecord } from '../src/routes.js';
import type { ActorInput, DeltaState, RawAuctionRow } from '../src/types.js';

vi.mock('apify', () => ({
    Actor: { pushData: vi.fn(async () => ({})) },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function baseRow(overrides: Partial<RawAuctionRow> = {}): RawAuctionRow {
    return {
        auctionDateSerial: 45295,
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

describe('matchesFilters', () => {
    const auction = normalizeAuction(baseRow());

    it('matches everything when no filters are set', () => {
        expect(matchesFilters(auction, {} as ActorInput)).toBe(true);
    });

    it('filters by bondType', () => {
        expect(matchesFilters(auction, { bondTypeFilter: ['LTN'] } as ActorInput)).toBe(true);
        expect(matchesFilters(auction, { bondTypeFilter: ['LFT'] } as ActorInput)).toBe(false);
    });

    it('filters by auctionType', () => {
        expect(matchesFilters(auction, { auctionTypeFilter: ['Venda'] } as ActorInput)).toBe(true);
        expect(matchesFilters(auction, { auctionTypeFilter: ['Troca'] } as ActorInput)).toBe(false);
    });
});

describe('eventNameFor', () => {
    it('maps NEW_AUCTION and AUCTION_RESULT_REVISED to distinct, separately-priceable pay-per-event names', () => {
        expect(eventNameFor('NEW_AUCTION')).toBe('new-auction');
        expect(eventNameFor('AUCTION_RESULT_REVISED')).toBe('auction-result-revised');
        expect(eventNameFor('NEW_AUCTION')).not.toBe(eventNameFor('AUCTION_RESULT_REVISED'));
    });

    it('returns undefined (uncharged) for BASELINE_SNAPSHOT and AUCTION_UNCHANGED', () => {
        expect(eventNameFor('BASELINE_SNAPSHOT')).toBeUndefined();
        expect(eventNameFor('AUCTION_UNCHANGED')).toBeUndefined();
    });
});

describe('isHighValueChange', () => {
    it('is always true for NEW_AUCTION', () => {
        const auction = normalizeAuction(baseRow());
        const classified = classify(auction, emptyState(), true, null, 10, 0.5);
        expect(classified.eventType).toBe('NEW_AUCTION');
        expect(isHighValueChange(classified)).toBe(true);
    });

    it('is true for AUCTION_RESULT_REVISED only when a real threshold was breached', () => {
        const auction = normalizeAuction(baseRow());
        const state = emptyState();
        const first = classify(auction, state, false, null, 10, 0.5);
        state.auctions[auction.recordId] = { statusFingerprint: first.statusFingerprint, contentFingerprint: first.contentFingerprint, acceptedRateBps: auction.acceptedRateBps, lastSeen: '2026-01-01T00:00:00.000Z' };

        const smallChange = normalizeAuction(baseRow({ totalAmountAcceptedBrl: 1 })); // content changes, status/rate does not
        const smallClassified = classify(smallChange, state, false, auction.acceptedRateBps, 10, 0.5);
        expect(smallClassified.eventType).toBe('AUCTION_RESULT_REVISED');
        expect(isHighValueChange(smallClassified)).toBe(false);

        const bigRateChange = normalizeAuction(baseRow({ acceptedRate: 0.5 }));
        const bigClassified = classify(bigRateChange, state, false, auction.acceptedRateBps, 10, 0.5);
        expect(isHighValueChange(bigClassified)).toBe(true);
    });

    it('is false for BASELINE_SNAPSHOT and AUCTION_UNCHANGED', () => {
        const auction = normalizeAuction(baseRow());
        const baseline = classify(auction, emptyState(), false, null, 10, 0.5);
        expect(isHighValueChange(baseline)).toBe(false);

        const state = emptyState();
        state.auctions[auction.recordId] = { statusFingerprint: baseline.statusFingerprint, contentFingerprint: baseline.contentFingerprint, acceptedRateBps: auction.acceptedRateBps, lastSeen: '2026-01-01T00:00:00.000Z' };
        const unchanged = classify(auction, state, true, auction.acceptedRateBps, 10, 0.5);
        expect(unchanged.eventType).toBe('AUCTION_UNCHANGED');
        expect(isHighValueChange(unchanged)).toBe(false);
    });
});

describe('toOutputRecord / computeEventId', () => {
    it('produces a stable idempotency key across two INDEPENDENTLY-constructed classifications of equivalent data - a real cross-run idempotency check, not a call-the-same-object-twice tautology', () => {
        // Corrected after adversarial review: an earlier version called computeEventId twice on
        // the SAME object reference, which is trivially true for any deterministic function and
        // provides no protection against e.g. an unstable JSON key-order dependency or a
        // timestamp/salt sneaking into the hash. This version rebuilds the whole pipeline twice
        // from two separately-constructed row objects with equivalent (but not identical-instance)
        // data, simulating two genuinely separate runs classifying the same real auction.
        const state1 = emptyState();
        const classified1 = classify(normalizeAuction(baseRow()), state1, true, null, 10, 0.5);

        const state2 = emptyState();
        const classified2 = classify(normalizeAuction(baseRow()), state2, true, null, 10, 0.5);

        expect(computeEventId(classified1)).toBe(computeEventId(classified2));
    });

    it('produces a DIFFERENT idempotency key when the underlying classification genuinely differs', () => {
        const classifiedA = classify(normalizeAuction(baseRow()), emptyState(), true, null, 10, 0.5);
        const classifiedB = classify(normalizeAuction(baseRow({ acceptedRate: 0.5 })), emptyState(), true, null, 10, 0.5);
        expect(computeEventId(classifiedA)).not.toBe(computeEventId(classifiedB));
    });

    it('carries the quantitative fields derived from the classification, not just the raw auction', () => {
        const auction = normalizeAuction(baseRow());
        const classified = classify(auction, emptyState(), true, 900, 10, 0.5); // acceptedRateBps=990, prev=900 -> +90bps breach
        const record = toOutputRecord(classified, '2026-01-01T00:00:00.000Z');
        expect(record.rate_change_bps).toBe(90);
        expect(record.yield_threshold_breached).toBe(true);
        expect(record.total_amount_accepted_currency).toBe('BRL');
    });
});
