import { Actor } from 'apify';

import type { DeltaState, StoredFingerprint, YearCacheEntry } from './types.js';

/** Mirrors the fleet's `deltaStateName` convention: scope the KV store name per schedule/query. */
export function stateStoreName(deltaStateName: string): string {
    return `SOVEREIGN-DEBT-DELTA-STATE-${deltaStateName}`;
}

const STATE_KEY = 'STATE';
const BENCHMARK_RATES_KEY = 'BENCHMARK_RATES';

function emptyState(): DeltaState {
    return { auctions: {}, yearCache: {} };
}

export async function loadState(storeName: string, resetState: boolean): Promise<DeltaState> {
    if (resetState) {
        return emptyState();
    }
    const store = await Actor.openKeyValueStore(storeName);
    const stored = await store.getValue<DeltaState>(STATE_KEY);
    return stored ?? emptyState();
}

export async function saveState(storeName: string, state: DeltaState): Promise<void> {
    const store = await Actor.openKeyValueStore(storeName);
    await store.setValue(STATE_KEY, state);
}

/** Separate from the main state blob so it can be loaded/saved independently - a distinct concern (rate history for threshold comparisons) from per-record fingerprint tracking. */
export async function loadBenchmarkRates(storeName: string, resetState: boolean): Promise<Record<string, number | null>> {
    if (resetState) return {};
    const store = await Actor.openKeyValueStore(storeName);
    const stored = await store.getValue<Record<string, number | null>>(BENCHMARK_RATES_KEY);
    return stored ?? {};
}

export async function saveBenchmarkRates(storeName: string, rates: Record<string, number | null>): Promise<void> {
    const store = await Actor.openKeyValueStore(storeName);
    await store.setValue(BENCHMARK_RATES_KEY, rates);
}

export function recordSeen(state: DeltaState, recordId: string, fingerprint: StoredFingerprint): void {
    // `state` is an explicit mutable accumulator passed in by design, mirroring the same pattern
    // already used across this fleet's other delta-tracking actors.
    // eslint-disable-next-line no-param-reassign
    state.auctions[recordId] = fingerprint;
}

export function recordYearChecked(state: DeltaState, year: string, entry: YearCacheEntry): void {
    // eslint-disable-next-line no-param-reassign
    state.yearCache[year] = entry;
}
