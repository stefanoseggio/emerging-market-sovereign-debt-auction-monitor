import { Actor } from 'apify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { budgetExceededFor, getRunBudget, remainingBudgetMs } from '../src/timeBudget.js';

vi.mock('apify', () => ({
    Actor: { isAtHome: vi.fn(), getEnv: vi.fn() },
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('getRunBudget', () => {
    it('enforces no deadline when not running on the Apify platform (local/dev run)', () => {
        vi.mocked(Actor.isAtHome).mockReturnValue(false);
        const budget = getRunBudget();
        expect(budget.deadline).toBeNull();
        expect(remainingBudgetMs(budget)).toBeNull();
    });

    it('enforces no deadline when on-platform but the run genuinely has no timeout set', () => {
        vi.mocked(Actor.isAtHome).mockReturnValue(true);
        // @ts-expect-error - only the field this module reads is provided
        vi.mocked(Actor.getEnv).mockReturnValue({ timeoutAt: null });
        const budget = getRunBudget();
        expect(budget.deadline).toBeNull();
    });

    it('derives a deadline that is SAFETY_MARGIN_MS before the real platform timeoutAt', () => {
        vi.useFakeTimers();
        const now = new Date('2026-09-19T00:00:00.000Z');
        vi.setSystemTime(now);
        const timeoutAt = new Date(now.getTime() + 300_000); // 300s run timeout, 0s elapsed
        vi.mocked(Actor.isAtHome).mockReturnValue(true);
        // @ts-expect-error - only the field this module reads is provided
        vi.mocked(Actor.getEnv).mockReturnValue({ timeoutAt });

        const budget = getRunBudget();
        expect(budget.deadline).toBe(timeoutAt.getTime() - 15_000);
        expect(remainingBudgetMs(budget)).toBe(300_000 - 15_000);
    });
});

describe('budgetExceededFor', () => {
    it('is never exceeded when no deadline is being enforced, regardless of how large requiredMs is', () => {
        expect(budgetExceededFor({ deadline: null }, Number.MAX_SAFE_INTEGER)).toBe(false);
    });

    it('is false while more than requiredMs genuinely remains before the deadline', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'));
        const budget = { deadline: Date.now() + 100_000 };
        expect(budgetExceededFor(budget, 89_100)).toBe(false);
    });

    it('is true once fewer than requiredMs remain before the deadline', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'));
        const budget = { deadline: Date.now() + 50_000 };
        expect(budgetExceededFor(budget, 89_100)).toBe(true);
    });

    it('is true once the deadline has already passed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'));
        const budget = { deadline: Date.now() - 1 };
        expect(budgetExceededFor(budget, 1)).toBe(true);
    });
});
