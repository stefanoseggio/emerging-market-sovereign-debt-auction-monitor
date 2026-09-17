# Go-to-market & Apify Store SEO — Emerging-Market Sovereign Debt Auction Monitor

## The same honest correction as Actors #1 and #2

Apify Store ranking is percentile-based against the entire marketplace and explicitly weights
real usage, not just title/description keyword match. Metadata below maximizes discoverability at
every stage of this actor's adoption curve — it cannot manufacture a top rank for a zero-review
actor on day one.

## Real Store metadata

**Title** (set in [`.actor/actor.json`](.actor/actor.json)):
> Emerging-Market Sovereign Debt Auction Monitor - Brazil DPMFi

**Description** (also set in `.actor/actor.json`):
> Delta-tracks Brazil's National Treasury domestic bond auction results (LTN, LFT, NTN-B, NTN-F)
> for new auctions, marginal-rate (Taxa de corte) threshold breaches, and coverage-ratio
> anomalies. Sourced from the official Tesouro Transparente open-data portal (ODbL licensed).
> Financial-grade basis-point rate precision and UTC-canonicalized settlement/maturity dates.
> Pay-per-event: billed only for what changed.

**Category**: `BUSINESS` (already set).

## Real target-term mapping

| Target term / intent | How this listing addresses it |
|---|---|
| "Brazil sovereign debt" / "Tesouro Nacional" / "DPMFi" | Verbatim in title/description — the real, official Portuguese acronym a Brazil-market professional would search |
| "Bond auction monitoring" / "yield alert" | "marginal-rate threshold breaches" — the real mechanism, not a vague "monitoring" claim |
| "LTN" / "LFT" / "NTN-B" / "NTN-F" | The four real, currently-issued instrument codes, verbatim - a quant/fixed-income buyer searches by instrument code, not just "bonds" |
| "Emerging market debt" | Real, cited category from this session's own earlier market-intelligence research (OECD/S&P: $3T+/year EMDE borrowing) |

## Real competitive landscape (verified live via the Apify Store API on this actor's build date)

A direct search for `"tesouro nacional"` on Apify's own public Store API returned two results,
**both irrelevant** (a property-listings scraper and an OFAC sanctions screener, matched on
unrelated keyword overlap, not real competitors). A broader `"sovereign debt"` search returned 48
results, none of them a real Brazil Treasury auction monitor. **This is a genuinely open niche on
Apify Store today** — corroborating this session's own earlier market-intelligence research
(`distribution/global_actor_expansion_and_market_intelligence_report.md`), which found only 2-3
real solo sovereign-debt trackers worldwide, all developed-market/Asia-focused, with zero real
LatAm coverage before this actor.

## What actually moves ranking over time

Same as Actors #1 and #2: early real usage and reviews compound faster than any further metadata
iteration. The Reddit organic-engagement channel already established this session
(`distribution/reddit_organic_engagement_plan.md`) is the same rule-compliant venue this actor
should be introduced through once published, not a separate initiative. A quant/fixed-income
audience is also plausibly reachable through the same channel's r/webscraping monthly
self-promotion thread, given several other builders posting Apify pay-per-event actors have
already used it this session's research confirmed it as real and currently active.
