import { Actor, log } from 'apify';

import { run as runRegistry } from './routes.js';
import { loadBenchmarkRates, loadState, saveBenchmarkRates, saveState, stateStoreName } from './state.js';
import type { ActorInput } from './types.js';
import { DEFAULT_YEAR } from './types.js';

await Actor.init();
await run();
await Actor.exit();

async function run(): Promise<void> {
    const input = (await Actor.getInput<ActorInput>()) ?? ({} as ActorInput);
    const years = input.years && input.years.length > 0 ? input.years : [DEFAULT_YEAR];
    log.info(`Starting run: years=${years.join(',')}, deltaStateName=${input.deltaStateName ?? 'default'}, onlyNew=${input.onlyNew ?? true}.`);

    const storeName = stateStoreName(input.deltaStateName ?? 'default');
    const resetState = input.resetState ?? false;
    const state = await loadState(storeName, resetState);
    const benchmarkRates = await loadBenchmarkRates(storeName, resetState);

    // Apify's platform can send 'migrating' (worker reassignment - the SDK's default
    // `gracefulShutdown` then calls `Actor.reboot()`) or 'aborting' (the SDK then calls
    // `Actor.exit()`) at any point during a long run. Neither is a JS exception, so a bare
    // try/catch around the run would miss both - without flushing this run's in-memory state
    // (per-auction fingerprints, per-year baseline-completion flags, AND the separate benchmark-rate history)
    // here, the SDK's default reboot/exit would proceed without ever persisting it, and the next
    // run would reload stale state and RE-CHARGE every auction already pushed this run. This
    // exact gap was found and fixed in Actor #1 (TED) after the fact; this actor is built with
    // the fix from the start. The SDK awaits registered event handlers before rebooting/exiting.
    const flushState = async (): Promise<void> => {
        try {
            await Promise.all([saveState(storeName, state), saveBenchmarkRates(storeName, benchmarkRates)]);
        } catch (error) {
            log.error(`Failed to flush state during shutdown: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    Actor.on('migrating', flushState);
    Actor.on('aborting', flushState);

    try {
        const stats = await runRegistry(input, state, benchmarkRates);
        const baselinedYears = Object.entries(state.yearCache)
            .filter(([, entry]) => entry.baselineComplete)
            .map(([year]) => year);
        log.info(
            `Run complete. Checked ${stats.yearsChecked} year(s). Pushed ${stats.totalPushed} record(s): ${Object.entries(stats.byEventType).map(([type, count]) => `${type}=${count}`).join(', ') || 'none'}. Baseline complete for: ${baselinedYears.join(', ') || 'none yet'}.`,
        );
    } catch (error) {
        log.error(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        // State is saved below regardless of success/failure, so progress already made this run
        // is never lost to a later failure - only the failing year's remaining rows are
        // re-evaluated on the next run.
        await Promise.all([saveState(storeName, state), saveBenchmarkRates(storeName, benchmarkRates)]);
        throw error;
    } finally {
        Actor.off('migrating', flushState);
        Actor.off('aborting', flushState);
    }

    await Promise.all([saveState(storeName, state), saveBenchmarkRates(storeName, benchmarkRates)]);
}
