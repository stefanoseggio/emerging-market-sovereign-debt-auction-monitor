import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadBenchmarkRates, loadState, recordSeen, recordYearChecked, saveBenchmarkRates, saveState, stateStoreName } from '../src/state.js';
import type { DeltaState } from '../src/types.js';

const stores = new Map<string, Map<string, unknown>>();

vi.mock('apify', () => ({
    Actor: {
        openKeyValueStore: vi.fn(async (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name)!;
            return {
                getValue: vi.fn(async (key: string) => store.get(key) ?? null),
                setValue: vi.fn(async (key: string, value: unknown) => {
                    store.set(key, value);
                }),
            };
        }),
    },
}));

afterEach(() => {
    stores.clear();
    vi.clearAllMocks();
});

describe('stateStoreName', () => {
    it('scopes the KV store name by deltaStateName, matching the fleet-wide convention', () => {
        expect(stateStoreName('default')).toBe('SOVEREIGN-DEBT-DELTA-STATE-default');
        expect(stateStoreName('my-schedule')).toBe('SOVEREIGN-DEBT-DELTA-STATE-my-schedule');
    });
});

describe('loadState / saveState', () => {
    it('returns a fresh empty state when the KV store has nothing stored yet', async () => {
        const state = await loadState('fresh-store', false);
        expect(state).toEqual({ auctions: {}, yearCache: {} });
    });

    it('round-trips a real state object through save then load', async () => {
        const original: DeltaState = {
            auctions: { 'LTN-Venda-2025-04-01-2024-01-04-1.ª volta': { statusFingerprint: 'a', contentFingerprint: 'b', acceptedRateBps: 990, lastSeen: '2026-01-01T00:00:00.000Z' } },
            yearCache: { '2026': { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true } },
        };
        await saveState('round-trip-store', original);
        const loaded = await loadState('round-trip-store', false);
        expect(loaded).toEqual(original);
    });

    it('ignores whatever is stored and returns fresh empty state when resetState is true', async () => {
        const existing: DeltaState = {
            auctions: { x: { statusFingerprint: 'a', contentFingerprint: 'b', acceptedRateBps: 100, lastSeen: '2026-01-01T00:00:00.000Z' } },
            yearCache: {},
        };
        await saveState('reset-store', existing);

        const result = await loadState('reset-store', true);
        expect(result).toEqual({ auctions: {}, yearCache: {} });
    });
});

describe('loadBenchmarkRates / saveBenchmarkRates', () => {
    it('returns an empty object when nothing is stored yet', async () => {
        const rates = await loadBenchmarkRates('fresh-rates-store', false);
        expect(rates).toEqual({});
    });

    it('round-trips real benchmark rate history through save then load', async () => {
        const original = { 'LTN::2025-04-01': 990, 'LFT::2032-03-01': 11, 'NTN-B::2060-08-15': 730 };
        await saveBenchmarkRates('rates-store', original);
        const loaded = await loadBenchmarkRates('rates-store', false);
        expect(loaded).toEqual(original);
    });

    it('resetState returns a fresh empty object even when rates were previously saved', async () => {
        await saveBenchmarkRates('reset-rates-store', { 'LTN::2025-04-01': 990 });
        const result = await loadBenchmarkRates('reset-rates-store', true);
        expect(result).toEqual({});
    });

    it('is stored independently from the main delta state - the two use distinct KV keys within the same store', async () => {
        const storeName = 'shared-store';
        await saveState(storeName, { auctions: { a: { statusFingerprint: 'x', contentFingerprint: 'y', acceptedRateBps: 1, lastSeen: '2026-01-01T00:00:00.000Z' } }, yearCache: {} });
        await saveBenchmarkRates(storeName, { 'LTN::2025-04-01': 990 });

        const state = await loadState(storeName, false);
        const rates = await loadBenchmarkRates(storeName, false);
        expect(Object.keys(state.auctions)).toEqual(['a']);
        expect(rates).toEqual({ 'LTN::2025-04-01': 990 });
    });
});

describe('recordSeen / recordYearChecked (mutate-by-reference contract)', () => {
    it('recordSeen mutates the SAME state object passed in, not a copy', () => {
        const state: DeltaState = { auctions: {}, yearCache: {} };
        const stateRef = state;
        recordSeen(state, 'LTN-Venda-2025-04-01-2024-01-04-1.ª volta', { statusFingerprint: 'a', contentFingerprint: 'b', acceptedRateBps: 990, lastSeen: '2026-01-01T00:00:00.000Z' });

        expect(stateRef).toBe(state);
        expect(stateRef.auctions['LTN-Venda-2025-04-01-2024-01-04-1.ª volta']).toEqual({ statusFingerprint: 'a', contentFingerprint: 'b', acceptedRateBps: 990, lastSeen: '2026-01-01T00:00:00.000Z' });
    });

    it('recordYearChecked mutates the same state object and overwrites any prior entry for that year', () => {
        const state: DeltaState = { auctions: {}, yearCache: { '2026': { lastChecked: '2025-01-01T00:00:00.000Z', baselineComplete: false } } };
        recordYearChecked(state, '2026', { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true });

        expect(state.yearCache['2026']).toEqual({ lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true });
    });
});
