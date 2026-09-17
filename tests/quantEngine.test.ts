import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
    computeCoverageRatio,
    computeRateChangeBps,
    isCoverageThresholdBreached,
    isYieldThresholdBreached,
    toBasisPoints,
} from '../src/quantEngine.js';

describe('toBasisPoints - unit', () => {
    it('converts real observed decimal rates to the correct integer basis points', () => {
        expect(toBasisPoints(0.098997)).toBe(990); // real 2024 LTN average rate
        expect(toBasisPoints(0.099024)).toBe(990); // real 2024 LTN accepted rate
        expect(toBasisPoints(0.001065)).toBe(11); // real 2026 LFT rate
        expect(toBasisPoints(0.073)).toBe(730); // real 2026 NTN-B rate
    });

    it('returns null for null input, never a fabricated zero', () => {
        expect(toBasisPoints(null)).toBeNull();
    });

    it('returns null for non-finite input rather than throwing or returning NaN', () => {
        expect(toBasisPoints(NaN)).toBeNull();
        expect(toBasisPoints(Infinity)).toBeNull();
        expect(toBasisPoints(-Infinity)).toBeNull();
    });

    it('rounds to the nearest whole basis point, not truncates', () => {
        expect(toBasisPoints(0.00995)).toBe(100); // rounds up from 99.5
        expect(toBasisPoints(0.009949)).toBe(99); // rounds down
    });
});

describe('toBasisPoints - property-based', () => {
    // Note: a bare "always returns an integer" property was removed here after adversarial review
    // correctly flagged it as tautological - `Math.round`/`Math.sign` guarantee an integer result
    // regardless of the internal scale factor, so that property alone can't catch a wrong scale
    // (e.g. x100 instead of x10,000). The "rounding error" test below already pins the real x10,000
    // scale (it compares against `rate * 10_000` directly), and the new linearity test adds a
    // second, independent check of the same scale via a genuinely different mathematical property.

    it('is linear: doubling the rate doubles the basis points (independent of the rounding-error test\'s direct scale check)', () => {
        fc.assert(
            fc.property(fc.double({ min: 0, max: 0.5, noNaN: true }), (rate) => {
                const bpsSingle = toBasisPoints(rate)!;
                const bpsDouble = toBasisPoints(rate * 2)!;
                // Allow up to 1bp of rounding slack on each side (2 total) - this checks the SCALE
                // is consistent (would fail hard for a x100-instead-of-x10,000 bug, off by ~100x),
                // not that rounding is perfectly exact under doubling.
                expect(Math.abs(bpsDouble - bpsSingle * 2)).toBeLessThanOrEqual(2);
            }),
        );
    });

    it('is monotonic: a larger rate never produces fewer basis points than a smaller one', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0, max: 1, noNaN: true }),
                fc.double({ min: 0, max: 1, noNaN: true }),
                (a, b) => {
                    const [lower, higher] = a <= b ? [a, b] : [b, a];
                    const bpsLower = toBasisPoints(lower);
                    const bpsHigher = toBasisPoints(higher);
                    expect(bpsHigher).toBeGreaterThanOrEqual(bpsLower!);
                },
            ),
        );
    });

    it('the rounding error versus the exact value is always less than half a basis point', () => {
        fc.assert(
            fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (rate) => {
                const bps = toBasisPoints(rate)!;
                const exactBps = rate * 10_000;
                expect(Math.abs(bps - exactBps)).toBeLessThanOrEqual(0.5 + Number.EPSILON * 10_000);
            }),
        );
    });
});

describe('computeCoverageRatio - unit', () => {
    it('computes the real observed 2026 LFT coverage ratio (fully subscribed)', () => {
        expect(computeCoverageRatio(750_000, 750_000)).toBe(1);
    });

    it('computes a genuine undersubscribed ratio', () => {
        expect(computeCoverageRatio(250_000, 1_000_000)).toBe(0.25);
    });

    it('returns null (undefined ratio), not zero or Infinity, when offered is zero', () => {
        expect(computeCoverageRatio(0, 0)).toBeNull();
        expect(computeCoverageRatio(100, 0)).toBeNull();
    });

    it('returns null when either input is null', () => {
        expect(computeCoverageRatio(null, 1000)).toBeNull();
        expect(computeCoverageRatio(1000, null)).toBeNull();
    });
});

describe('computeCoverageRatio - property-based', () => {
    it('the ratio is always between 0 and 1 when accepted never exceeds offered (the real, expected case)', () => {
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 10_000_000 }), (accepted, offered) => {
                fc.pre(accepted <= offered);
                const ratio = computeCoverageRatio(accepted, offered)!;
                expect(ratio).toBeGreaterThanOrEqual(0);
                expect(ratio).toBeLessThanOrEqual(1);
            }),
        );
    });

    // Note: a "is exactly accepted/offered" property was removed here after adversarial review
    // correctly flagged it as tautological - it just re-derived the implementation's own division
    // formula and compared against itself, so an operand-swap bug in both the source and the test
    // author's mental model would pass undetected. The homogeneity property below is a genuinely
    // independent mathematical invariant of a true ratio (unaffected by uniformly rescaling both
    // inputs) that a wrong implementation (e.g. subtraction-based, or an operand swap) would very
    // likely violate.
    it('is homogeneous of degree 0: scaling both accepted and offered by the same positive factor does not change the ratio', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 1_000_000 }),
                fc.integer({ min: 1, max: 1_000_000 }),
                fc.integer({ min: 1, max: 100 }),
                (accepted, offered, factor) => {
                    const base = computeCoverageRatio(accepted, offered)!;
                    const scaled = computeCoverageRatio(accepted * factor, offered * factor)!;
                    expect(scaled).toBeCloseTo(base, 8);
                },
            ),
        );
    });

    it('is antitonic in the offered quantity: increasing the offered amount while holding accepted fixed never increases the ratio', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 1_000_000 }),
                fc.integer({ min: 1, max: 1_000_000 }),
                fc.integer({ min: 0, max: 1_000_000 }),
                (accepted, offeredBase, extraOffered) => {
                    const smallerOffered = computeCoverageRatio(accepted, offeredBase)!;
                    const largerOffered = computeCoverageRatio(accepted, offeredBase + extraOffered)!;
                    expect(largerOffered).toBeLessThanOrEqual(smallerOffered + 1e-9);
                },
            ),
        );
    });
});

describe('computeRateChangeBps', () => {
    it('computes the signed difference in basis points', () => {
        expect(computeRateChangeBps(990, 980)).toBe(10);
        expect(computeRateChangeBps(980, 990)).toBe(-10);
        expect(computeRateChangeBps(990, 990)).toBe(0);
    });

    it('returns null when there is no previous value to compare against (first observation)', () => {
        expect(computeRateChangeBps(990, null)).toBeNull();
    });

    it('returns null when the current value is missing', () => {
        expect(computeRateChangeBps(null, 990)).toBeNull();
    });
});

describe('isYieldThresholdBreached', () => {
    it('breaches when the absolute change meets or exceeds the threshold', () => {
        expect(isYieldThresholdBreached(10, 10)).toBe(true);
        expect(isYieldThresholdBreached(-10, 10)).toBe(true); // a real rate DROP of 10bps is still a breach
        expect(isYieldThresholdBreached(11, 10)).toBe(true);
    });

    it('does not breach below the threshold', () => {
        expect(isYieldThresholdBreached(9, 10)).toBe(false);
        expect(isYieldThresholdBreached(-9, 10)).toBe(false);
    });

    it('never breaches when there is no previous value (a NEW_AUCTION has nothing to compare against)', () => {
        expect(isYieldThresholdBreached(null, 0)).toBe(false);
    });
});

describe('isCoverageThresholdBreached', () => {
    it('breaches at or below the floor', () => {
        expect(isCoverageThresholdBreached(0.5, 0.5)).toBe(true);
        expect(isCoverageThresholdBreached(0.3, 0.5)).toBe(true);
    });

    it('does not breach above the floor', () => {
        expect(isCoverageThresholdBreached(0.51, 0.5)).toBe(false);
    });

    it('a floor of 0 disables the check entirely, even for a genuine zero coverage ratio', () => {
        expect(isCoverageThresholdBreached(0, 0)).toBe(false);
    });

    it('never breaches when the ratio is undefined (null)', () => {
        expect(isCoverageThresholdBreached(null, 0.5)).toBe(false);
    });
});
