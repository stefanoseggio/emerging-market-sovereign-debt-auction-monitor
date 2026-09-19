import { Actor } from 'apify';

/**
 * Safety margin subtracted from the Actor's real platform timeout before this run stops STARTING
 * new registry years. Leaves real time for main.ts's own graceful-shutdown state flush (on the
 * platform's `aborting`/`migrating` events, or in its `catch` block) to actually complete, rather
 * than this actor voluntarily racing its own kill signal.
 */
const SAFETY_MARGIN_MS = 15_000;

export interface RunBudget {
    /**
     * The wall-clock time (ms since epoch) this run should stop STARTING new, independently-costed
     * work by - already reduced by SAFETY_MARGIN_MS. `null` when there is no real platform timeout
     * to respect (not running on the Apify platform, or the run genuinely has none set), in which
     * case no budget is enforced - matching this actor's pre-existing local-dev behavior.
     */
    readonly deadline: number | null;
}

/**
 * Snapshots this run's real timeout deadline once (call at the start of a run - see routes.ts's
 * `run()`). This is the same `Actor.isAtHome() && env.timeoutAt` check the Apify SDK's own
 * `Actor.getRemainingTime()` uses internally (see node_modules/apify/dist/actor.js) - that method
 * is private and not exposed on the public `Actor` class, so this reimplements it against the
 * public `Actor.getEnv()` API instead of depending on SDK internals.
 */
export function getRunBudget(): RunBudget {
    if (!Actor.isAtHome()) return { deadline: null }; // local/dev run - no real platform timeout to hit
    const { timeoutAt } = Actor.getEnv();
    return { deadline: timeoutAt === null ? null : timeoutAt.getTime() - SAFETY_MARGIN_MS };
}

/** Milliseconds left before `budget`'s deadline, or `null` when no deadline is being enforced. */
export function remainingBudgetMs(budget: RunBudget): number | null {
    return budget.deadline === null ? null : budget.deadline - Date.now();
}

/**
 * True once fewer than `requiredMs` genuinely remain before this run's own timeout - the caller's
 * signal to stop STARTING another independently-costed unit of work (here: one more registry
 * year in routes.ts's `run()`) rather than begin one this run cannot safely finish. Never true
 * when there is no real deadline being enforced (`remainingBudgetMs` returns `null`).
 */
export function budgetExceededFor(budget: RunBudget, requiredMs: number): boolean {
    const remaining = remainingBudgetMs(budget);
    return remaining !== null && remaining < requiredMs;
}
