import { Actor, log } from 'apify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as DataSourceModule from '../src/dataSource.js';
import type { ActorInput, DeltaState, RawAuctionRow } from '../src/types.js';

const pushedRecords: { record: unknown; eventName?: string }[] = [];
const notifiedRecords: unknown[] = [];

vi.mock('apify', () => ({
    Actor: {
        pushData: vi.fn(async (record: unknown, eventName?: string) => {
            pushedRecords.push({ record, eventName });
            return {};
        }),
        // Not running on the Apify platform in tests - matches real local-dev behavior, under
        // which routes.ts's time-budget guard (timeBudget.ts) enforces no deadline at all, so it
        // never affects any of these tests' assertions about which years/rows get processed.
        isAtHome: vi.fn(() => false),
        getEnv: vi.fn(() => ({ timeoutAt: null })),
    },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const fetchYearAuctions = vi.fn();
vi.mock('../src/dataSource.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DataSourceModule>();
    return { ...actual, fetchYearAuctions: (...args: unknown[]) => fetchYearAuctions(...args) };
});

vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: { body?: string }) => {
        notifiedRecords.push(JSON.parse(options.body ?? '{}'));
        return { ok: true };
    }),
);

const { run } = await import('../src/routes.js');

function row(overrides: Partial<RawAuctionRow> = {}): RawAuctionRow {
    return {
        auctionDateSerial: 45295, // 2024-01-04
        bondType: 'LTN',
        auctionType: 'Venda',
        round: '1.ª volta',
        settlementDateSerial: 45296,
        maturityDateSerial: 45748, // 2025-04-01
        quantityOffered: 1_000_000,
        averageRate: 0.098997,
        acceptedRate: 0.099024, // 990 bps
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

afterEach(() => {
    pushedRecords.length = 0;
    notifiedRecords.length = 0;
    fetchYearAuctions.mockReset();
    vi.mocked(fetch).mockClear();
    vi.mocked(log.warning).mockClear();
    // Reset to the real local-dev default (no platform timeout enforced) so a test that
    // simulates an imminent Apify platform timeout can't leak into any test after it.
    vi.mocked(Actor.isAtHome).mockReturnValue(false);
    vi.mocked(Actor.getEnv).mockReturnValue({ timeoutAt: null } as ReturnType<typeof Actor.getEnv>);
    vi.useRealTimers();
});

describe('Full auction lifecycle: baseline -> unchanged -> revised -> new -> threshold breach', () => {
    it('walks a realistic multi-run sequence of real government data mutations and verifies every delta trigger fires correctly', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};
        const input: ActorInput = { years: ['2024'], onlyNew: false, yieldChangeThresholdBps: 10, coverageRatioFloor: 0.5, webhookUrl: 'https://example.com/hook' };

        // --- Run 1: first-ever observation of a single auction. Must be BASELINE_SNAPSHOT, uncharged, no notification. ---
        fetchYearAuctions.mockResolvedValueOnce({ rows: [row()] });
        const stats1 = await run(input, state, benchmarkRates);
        expect(stats1.byEventType.BASELINE_SNAPSHOT).toBe(1);
        expect(pushedRecords[0].eventName).toBeUndefined();
        expect(notifiedRecords).toHaveLength(0);
        pushedRecords.length = 0;

        // --- Run 2: the exact same government data, unchanged. Must be AUCTION_UNCHANGED, uncharged, no notification. ---
        fetchYearAuctions.mockResolvedValueOnce({ rows: [row()] });
        const stats2 = await run(input, state, benchmarkRates);
        expect(stats2.byEventType.AUCTION_UNCHANGED).toBe(1);
        expect(pushedRecords[0].eventName).toBeUndefined();
        expect(notifiedRecords).toHaveLength(0);
        pushedRecords.length = 0;

        // --- Run 3: the Treasury corrects a previously-published figure (a real, plausible government
        // data revision) - the settlement amount changes, and the marginal rate moves by exactly 5bps
        // (990 -> 995), below the 10bps threshold. Must be AUCTION_RESULT_REVISED, CHARGED, but no
        // notification (a real content change that is not itself a material market move). ---
        fetchYearAuctions.mockResolvedValueOnce({ rows: [row({ totalAmountAcceptedBrl: 605_220_930.0, acceptedRate: 0.0995 })] }); // 990 -> 995 bps = +5bps, below the 10bps threshold
        const stats3 = await run(input, state, benchmarkRates);
        expect(stats3.byEventType.AUCTION_RESULT_REVISED).toBe(1);
        expect(pushedRecords[0].eventName).toBe('auction-result-revised');
        expect(notifiedRecords).toHaveLength(0); // real change, but not a threshold breach
        pushedRecords.length = 0;

        // --- Run 4: a genuinely new auction for a different bond appears, AND the same LTN instrument's
        // marginal rate moves by a real, material 25 bps versus its last observed value (995 -> 1020 -
        // the last observed rate after run 3's revision, not run 1's original). The new auction always
        // notifies; the revised one now breaches the yield threshold and must ALSO notify. ---
        fetchYearAuctions.mockResolvedValueOnce({
            rows: [
                row({ acceptedRate: 0.102 }), // 995 -> 1020 bps = +25bps, breaches the 10bps threshold
                row({ bondType: 'NTN-F', maturityDateSerial: 46000, benchmark: 'NTN-F 5 anos', acceptedRate: 0.12 }),
            ],
        });
        const stats4 = await run(input, state, benchmarkRates);
        expect(stats4.byEventType.AUCTION_RESULT_REVISED).toBe(1);
        expect(stats4.byEventType.NEW_AUCTION).toBe(1);
        expect(notifiedRecords).toHaveLength(2); // both the breaching revision AND the new auction notify
        const revisedNotification = notifiedRecords.find((n) => (n as { record: { bond_type: string } }).record.bond_type === 'LTN') as { record: { rate_change_bps: number; yield_threshold_breached: boolean } };
        expect(revisedNotification.record.yield_threshold_breached).toBe(true);
        expect(revisedNotification.record.rate_change_bps).toBe(25);
    });

    it('an undersubscribed auction breaches the coverage threshold and notifies, even when the rate itself does not move', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};
        const input: ActorInput = { years: ['2024'], onlyNew: false, yieldChangeThresholdBps: 10, coverageRatioFloor: 0.5, webhookUrl: 'https://example.com/hook' };

        fetchYearAuctions.mockResolvedValueOnce({ rows: [row({ quantityOffered: 1_000_000, quantityAccepted: 1_000_000 })] }); // fully subscribed baseline
        await run(input, state, benchmarkRates);
        pushedRecords.length = 0;

        fetchYearAuctions.mockResolvedValueOnce({ rows: [row({ quantityOffered: 1_000_000, quantityAccepted: 300_000 })] }); // same rate, weak demand
        const stats = await run(input, state, benchmarkRates);
        expect(stats.byEventType.AUCTION_RESULT_REVISED).toBe(1);
        expect(notifiedRecords).toHaveLength(1);
        const {record} = (notifiedRecords[0] as { record: { coverage_threshold_breached: boolean; coverage_ratio: number } });
        expect(record.coverage_threshold_breached).toBe(true);
        expect(record.coverage_ratio).toBeCloseTo(0.3, 10);
    });

    it('does NOT cache the year baseline when maxItems truncates the pass, and correctly resumes on the next run without double-charging (regression test for the exact bug found live in Actors #1 and #2, applied here from the start)', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};

        fetchYearAuctions.mockResolvedValueOnce({
            rows: [row({ maturityDateSerial: 45748 }), row({ maturityDateSerial: 46113 })],
        });
        const stats1 = await run({ years: ['2024'], onlyNew: false, maxItems: 1 } as ActorInput, state, benchmarkRates);
        expect(stats1.totalPushed).toBe(1);
        expect(state.yearCache['2024']).toBeUndefined(); // truncated - must not be cached as baselined
        pushedRecords.length = 0;

        fetchYearAuctions.mockResolvedValueOnce({
            rows: [row({ maturityDateSerial: 45748 }), row({ maturityDateSerial: 46113 })],
        });
        const stats2 = await run({ years: ['2024'], onlyNew: false, maxItems: 10 } as ActorInput, state, benchmarkRates);
        expect(stats2.byEventType.AUCTION_UNCHANGED).toBe(1); // the first one, already seen - no double charge
        expect(stats2.byEventType.BASELINE_SNAPSHOT).toBe(1); // the second one, finally reached
        expect(state.yearCache['2024'].baselineComplete).toBe(true);
    });

    it('processes multiple years independently in one run, each with its own baseline state', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};

        fetchYearAuctions.mockImplementation(async (year: string) => {
            if (year === '2024') return { rows: [row()] };
            if (year === '2025') return { rows: [row({ auctionDateSerial: 45660 })] }; // a 2025 date
            return null;
        });

        const stats = await run({ years: ['2024', '2025'], onlyNew: false } as ActorInput, state, benchmarkRates);
        expect(stats.yearsChecked).toBe(2);
        expect(stats.totalPushed).toBe(2);
        expect(state.yearCache['2024'].baselineComplete).toBe(true);
        expect(state.yearCache['2025'].baselineComplete).toBe(true);
    });

    it('stops starting further registry years once this run\'s own real platform timeout is too close to safely attempt another (multi-year time-budget guard - real recurrence fix, 2026-09-19 fleet audit follow-up)', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};

        // A real Apify run with the Actor's own 300s timeoutSecs, simulated with fake system time
        // so each mocked year can advance the clock the way a real download+parse would - without
        // this test actually taking 300 real seconds to run.
        vi.useFakeTimers();
        const runStart = new Date('2026-09-19T00:00:00.000Z');
        vi.setSystemTime(runStart);
        vi.mocked(Actor.isAtHome).mockReturnValue(true);
        vi.mocked(Actor.getEnv).mockReturnValue({ timeoutAt: new Date(runStart.getTime() + 300_000) } as ReturnType<typeof Actor.getEnv>);

        fetchYearAuctions.mockImplementation(async (year: string) => {
            if (year === '2024') {
                vi.setSystemTime(new Date(Date.now() + 100_000)); // simulates this year taking 100s
                return { rows: [row()] };
            }
            if (year === '2025') {
                vi.setSystemTime(new Date(Date.now() + 100_000)); // another 100s - 200s elapsed total
                return { rows: [row({ auctionDateSerial: 45660 })] };
            }
            throw new Error(`should never be reached - ${year} should be deferred by the time budget guard`);
        });

        // By the time 2026 would start, only 85s of this run's real 300s budget remains (285s
        // deadline after the guard's own safety margin, minus 200s already spent) - less than the
        // ~94.1s worst case one more year could require, so 2024 and 2025 must still be fully
        // processed (they were genuinely safe to start), but 2026 must never even be attempted.
        const stats = await run({ years: ['2024', '2025', '2026'], onlyNew: false } as ActorInput, state, benchmarkRates);

        expect(stats.yearsChecked).toBe(2); // 2024 and 2025 only - 2026 was deferred, not attempted
        expect(state.yearCache['2024'].baselineComplete).toBe(true);
        expect(state.yearCache['2025'].baselineComplete).toBe(true);
        expect(state.yearCache['2026']).toBeUndefined(); // never started, so no state was written for it
        expect(stats.stopped).toBe(false); // this is a deferral, not the maxItems/eventChargeLimitReached truncation signal
        expect(vi.mocked(log.warning)).toHaveBeenCalledWith(expect.stringContaining('2026'));
    });

    it('a transient failure fetching one year does not abort processing of other, independent years', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};

        fetchYearAuctions.mockImplementation(async (year: string) => {
            if (year === '2024') throw new Error('simulated transient network failure');
            return { rows: [row()] };
        });

        const stats = await run({ years: ['2024', '2025'], onlyNew: false } as ActorInput, state, benchmarkRates);
        expect(stats.yearsChecked).toBe(1); // only 2025 succeeded
        expect(stats.totalPushed).toBe(1);
        expect(state.yearCache['2024']).toBeUndefined();
        expect(state.yearCache['2025'].baselineComplete).toBe(true);
    });

    it('stops the run immediately when Apify signals eventChargeLimitReached on a charged push, without processing further rows (found untested by adversarial review)', async () => {
        const state = emptyState();
        // Baseline already established for this year, so a never-before-seen row classifies as
        // NEW_AUCTION - a CHARGED event whose pushData call actually carries an eventChargeLimitReached
        // flag. An uncharged BASELINE_SNAPSHOT/AUCTION_UNCHANGED push never reads that flag (see
        // routes.ts's processRow), so this scenario is the only one that can exercise this branch.
        state.yearCache['2024'] = { lastChecked: '2020-01-01T00:00:00.000Z', baselineComplete: true };
        const benchmarkRates: Record<string, number | null> = {};
        const input: ActorInput = { years: ['2024'], onlyNew: false } as ActorInput;

        vi.mocked(Actor.pushData).mockResolvedValueOnce({ eventChargeLimitReached: true });
        fetchYearAuctions.mockResolvedValueOnce({
            rows: [row({ maturityDateSerial: 45748 }), row({ maturityDateSerial: 46113 })],
        });

        const stats = await run(input, state, benchmarkRates);
        expect(stats.stopped).toBe(true);
        expect(stats.totalPushed).toBe(1);
        expect(Object.keys(state.auctions)).toHaveLength(1); // the second row was never reached once the limit stopped the run
    });

    it('a row filtered out by bondTypeFilter is still tracked in state (baseline + rate history) but never pushed or notified (found untested by adversarial review)', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};
        const input: ActorInput = { years: ['2024'], onlyNew: false, bondTypeFilter: ['LFT'] } as ActorInput; // excludes the LTN row below

        fetchYearAuctions.mockResolvedValueOnce({ rows: [row()] }); // bondType: 'LTN'
        const stats = await run(input, state, benchmarkRates);

        expect(stats.totalPushed).toBe(0);
        expect(notifiedRecords).toHaveLength(0);
        expect(Object.keys(state.auctions)).toHaveLength(1); // recordSeen still fired despite the delivery filter
        expect(state.yearCache['2024'].baselineComplete).toBe(true); // the year is still considered fully walked
    });

    it('a year that 404s (not yet published) is not counted as checked and leaves no year-cache entry, exercised genuinely through run() rather than only at the dataSource unit level (found untested by adversarial review)', async () => {
        const state = emptyState();
        const benchmarkRates: Record<string, number | null> = {};
        const input: ActorInput = { years: ['2027'], onlyNew: false } as ActorInput;

        fetchYearAuctions.mockResolvedValueOnce(null); // a real 404 - not yet published

        const stats = await run(input, state, benchmarkRates);
        expect(stats.yearsChecked).toBe(0);
        expect(stats.totalPushed).toBe(0);
        expect(state.yearCache['2027']).toBeUndefined();
    });
});
