/**
 * Converts a raw decimal-fraction rate (e.g. 0.098997 for 9.8997%) to an integer number of basis
 * points, rounded to the nearest whole bp. Basis points, not the raw fraction, are this actor's
 * canonical unit for storage, hashing, and threshold comparisons - see ARCHITECTURE.md section 4
 * for why: repeated floating-point arithmetic on decimal fractions accumulates real, non-obvious
 * rounding error that an integer bp representation avoids for comparison purposes.
 *
 * Two real, adversarial-review-caught issues with a plain `Math.round(rate * 10_000)`, both fixed
 * here: (1) `Math.round` breaks exact half-bp ties toward +Infinity, not away from zero, so it is
 * sign-asymmetric (e.g. 0.09895 -> 990 but -0.09895 -> -989, not -990) - not realistically
 * reachable via this actor's actual data (Brazilian nominal Treasury yields are always positive),
 * but wrong for a function this actor's own architecture doc calls precision-critical. (2) IEEE-754
 * multiplication noise can push a mathematical half-bp tie just under the rounding boundary (e.g.
 * `0.00015 * 10_000` evaluates to `1.4999999999999998`, not `1.5`, rounding to 1 instead of 2). The
 * intermediate `toFixed(4)` pass absorbs that noise (bounding it to 4 decimal places of basis
 * points, far finer than any real published rate's precision) before the final sign-symmetric
 * round.
 */
export function toBasisPoints(rateDecimal: number | null): number | null {
    if (rateDecimal === null || !Number.isFinite(rateDecimal)) return null;
    const scaled = Number((rateDecimal * 10_000).toFixed(4));
    return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/**
 * Coverage/take-up ratio: how much of the offered supply was actually placed. Explicitly NOT a
 * bid-to-cover ratio - this source does not publish total market demand (bids submitted,
 * accepted or not), only the Treasury's own offered and accepted quantities. See ARCHITECTURE.md
 * section 3. Returns null when the offered quantity is missing or zero (an undefined ratio, not
 * a fabricated zero or infinity).
 */
export function computeCoverageRatio(quantityAccepted: number | null, quantityOffered: number | null): number | null {
    if (quantityAccepted === null || quantityOffered === null || quantityOffered === 0) return null;
    return quantityAccepted / quantityOffered;
}

/**
 * Signed basis-point difference between a current and previous rate. Returns null when either
 * side is missing (there's nothing to compare - e.g. the first time a bond type + benchmark is
 * observed).
 */
export function computeRateChangeBps(currentBps: number | null, previousBps: number | null): number | null {
    if (currentBps === null || previousBps === null) return null;
    return currentBps - previousBps;
}

/**
 * True when the absolute rate change meets or exceeds the configured threshold. A `rateChangeBps`
 * of null (no previous value to compare against) never breaches - there is nothing to have
 * "changed" yet.
 */
export function isYieldThresholdBreached(rateChangeBps: number | null, thresholdBps: number): boolean {
    if (rateChangeBps === null) return false;
    return Math.abs(rateChangeBps) >= thresholdBps;
}

/**
 * True when the coverage ratio is at or below the configured floor - a real, meaningful weak-
 * demand signal (the Treasury placed a materially smaller share of what it offered). A
 * `coverageRatio` of null (undefined - e.g. zero offered) never breaches, and a floor of 0
 * disables this check entirely (a real ratio can be 0 in a genuine failed/undersubscribed
 * auction, but a floor of exactly 0 is the documented "disable" sentinel, matching the input
 * schema's own description).
 */
export function isCoverageThresholdBreached(coverageRatio: number | null, floor: number): boolean {
    if (coverageRatio === null || floor <= 0) return false;
    return coverageRatio <= floor;
}
