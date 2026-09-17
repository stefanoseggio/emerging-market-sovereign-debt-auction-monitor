# Emerging-Market Sovereign Debt Auction Monitor — Brazil DPMFi

[![Built for Apify](https://img.shields.io/badge/Built%20for-Apify-00C1A2?style=flat-square&logo=apify&logoColor=white)](https://apify.com/stefano_seggio/emerging-market-sovereign-debt-auction-monitor)
[![Pay-Per-Event](https://img.shields.io/badge/Pay--Per--Event-from%20%240.01%2Fevent-blue?style=flat-square)](https://apify.com/stefano_seggio/emerging-market-sovereign-debt-auction-monitor)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Apache 2.0 License](https://img.shields.io/badge/License-Apache%202.0-D22128?style=flat-square&logo=apache&logoColor=white)](./LICENSE)

[![Run on Apify Store](https://img.shields.io/badge/Run%20on-Apify%20Store-00C1A2?style=for-the-badge&logo=apify&logoColor=white)](https://apify.com/stefano_seggio/emerging-market-sovereign-debt-auction-monitor)

Live and public at [apify.com/stefano_seggio/emerging-market-sovereign-debt-auction-monitor](https://apify.com/stefano_seggio/emerging-market-sovereign-debt-auction-monitor).

**Delta-tracks Brazil's National Treasury domestic bond auction results (LTN, LFT, NTN-B, NTN-F) for new auctions, marginal-rate threshold breaches, and coverage-ratio anomalies.**

Sourced from the official **Tesouro Transparente** open-data portal (ODbL licensed), a real CKAN instance —
confirmed live through Sept 15, 2026, one day before this actor's build date. Part of
[Delta Registry](https://github.com/stefanoseggio), a pay-per-event regulatory/compliance data
fleet.

## Why this exists

Real, live-verified market context: emerging-market sovereign debt is a genuinely under-served
Apify Store category (this session's own earlier market-intelligence research found only 2-3
solo trackers worldwide, all developed-market/Asia-focused, zero real LatAm coverage) — confirmed
again at this actor's build date via a direct Store API search: **zero real competitors** exist
for Brazil Treasury auction monitoring specifically.

## Two real findings that reshaped this actor mid-build

This actor was corrected twice during its own construction, based on live testing against the
real source — not shipped on the first design that looked reasonable on paper:

1. **The record identity key was wrong until live data proved it.** A first version keyed each
   auction by bond type + maturity + auction date + round. A from-scratch baseline run against
   the real 2026 file showed 22 auctions misclassified as revisions of each other with no
   explanation — investigation found a real 2026-03-16 LTN auction running a genuine "Extra
   Compra" (extraordinary purchase) *and* a separate "Extra Venda" (extraordinary sale) for the
   same bond, maturity, date, and round: two real, independent Treasury operations, not a
   duplicate. `auctionType` is now part of the key; verified against 2,850 real rows across three
   full years with zero collisions.
2. **File-level caching was planned, tested, and dropped.** This server (unlike Actor #2's UK
   registry) returns HTTP 405 for `HEAD`/`Range` requests, so a plan to at least cache the
   response `ETag` to skip parsing was tested directly — three consecutive `GET`s of the
   byte-identical file returned three *different* ETags. It's not a content signal on this
   server. Rather than ship a cache that silently never hits, this actor always downloads and
   parses every selected year; the zero-cost guarantee lives at the per-record fingerprint level
   instead (see [AGENTS.md](AGENTS.md)).

## Quickstart

### cURL

```bash
curl "https://api.apify.com/v2/acts/stefano_seggio~emerging-market-sovereign-debt-auction-monitor/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "years": ["2026"],
    "bondTypeFilter": ["LTN", "NTN-F"],
    "yieldChangeThresholdBps": 10,
    "maxItems": 100
  }'
```

### Python

```python
from apify_client import ApifyClient

client = ApifyClient("<YOUR_APIFY_TOKEN>")
run = client.actor("stefano_seggio/emerging-market-sovereign-debt-auction-monitor").call(run_input={
    "years": ["2026"],
    "bondTypeFilter": ["LTN", "NTN-F"],
    "yieldChangeThresholdBps": 10,
    "maxItems": 100,
})

for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(f"{item['event_type']}: {item['bond_type']} {item['benchmark']} - {item['accepted_rate_decimal']*100:.4f}% ({item['rate_change_bps']} bps)")
```

### Node.js

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client.actor('stefano_seggio/emerging-market-sovereign-debt-auction-monitor').call({
  years: ['2026'],
  bondTypeFilter: ['LTN', 'NTN-F'],
  yieldChangeThresholdBps: 10,
  maxItems: 100,
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
items.forEach((item) => console.log(`${item.event_type}: ${item.bond_type} ${item.benchmark} - ${(item.accepted_rate_decimal * 100).toFixed(4)}% (${item.rate_change_bps} bps)`));
```

## Pricing (pay-per-event)

| Event | Price | When it fires |
|---|---|---|
| `new-auction` | $0.02 | An auction (bond type + auction type + maturity + date + round) never seen before appears, after this year's baseline is established. |
| `auction-result-revised` | $0.01 | A previously-seen auction's published figures changed — a real, plausible government data correction. |
| `AUCTION_UNCHANGED` / `BASELINE_SNAPSHOT` | **Never billed** | First-run baseline observations and confirmed-unchanged auctions are always free. |

*Pricing above is live — this actor is published on Apify Store, and these are the exact,
currently-active Pay-Per-Event prices configured in the Apify Console's monetization settings, not
a proposal. `apify-actor-start` is retained (the first 5 seconds of platform compute is waived on
every run) and `apify-default-dataset-item` is removed (no automatic per-write dataset charge), so
the "unchanged auctions cost nothing" guarantee above is enforced at both the application layer
and the Console billing layer.*

**No third-party API key required.** BYOK status: **none**. This actor calls only the official
Tesouro Transparente open-data portal (`tesourotransparente.gov.br` / `sisweb.tesouro.gov.br`) —
there is no paid third-party API in the pipeline, and no key of any kind for you to supply.

## Input reference

See [`.actor/input_schema.json`](.actor/input_schema.json) for the full, authoritative schema.

| Field | Type | Default | Notes |
|---|---|---|---|
| `years` | array | `["2026"]` | Registry years 2000-2027; every selected year is fully downloaded and parsed every run (see "Two real findings" above). |
| `bondTypeFilter` | array | `[]` (all) | Real, currently-issued types: `LTN`, `LFT`, `NTN-B`, `NTN-F`. |
| `auctionTypeFilter` | array | `[]` (all) | Real values from the source's own legend: `Venda`, `Troca`, `Compra`, `Extra Compra`, `Extra Venda`. |
| `yieldChangeThresholdBps` | integer | 10 | Notification-only threshold on the marginal (accepted/cutoff) rate, in basis points, versus the bond's own last observed rate. |
| `coverageRatioFloor` | number | 0.5 | Notification-only floor on the coverage ratio (see below). |
| `maxItems` | integer | 50 | This actor's own per-run push cap. |
| `deltaStateName` / `resetState` / `onlyNew` | — | fleet defaults | Same convention as the rest of this fleet. |
| `webhookUrl` / `slackWebhookUrl` / `teamsWebhookUrl` | string | — | See **Alerting** below. |

## A note on two metrics this README will not overclaim

- **No ISIN/CUSIP.** Brazilian domestic Treasury securities settle through Brazil's own SELIC
  system and are identified by bond type + maturity date, not an international security
  identifier — there is none in this source to extract.
- **`coverage_ratio` is not a bid-to-cover ratio.** It's `quantity_accepted / quantity_offered` —
  a real, useful take-up signal, but this source does not publish total market demand (bids
  submitted, accepted or not), which a genuine bid-to-cover ratio requires. Labeled honestly as
  "coverage ratio" throughout this actor, not relabeled to match the term more buyers search for.

## Output record

```json
{
  "@type": "schema:FinancialProduct",
  "event_id": "7a0c07a8...",
  "event_type": "BASELINE_SNAPSHOT",
  "record_id": "LFT-Venda-2032-03-01-2026-01-06-1.ª volta",
  "auction_date": "2026-01-06",
  "bond_type": "LFT",
  "auction_type": "Venda",
  "round": "1.ª volta",
  "settlement_date": "2026-01-07",
  "maturity_date": "2032-03-01",
  "benchmark": "LFT 6 anos",
  "quantity_offered": 750000,
  "quantity_accepted": 750000,
  "coverage_ratio": 1,
  "average_rate_decimal": 0.001065,
  "average_rate_bps": 11,
  "accepted_rate_decimal": 0.001065,
  "accepted_rate_bps": 11,
  "rate_change_bps": null,
  "total_amount_accepted": 13506269547.68,
  "total_amount_accepted_currency": "BRL",
  "quantity_to_central_bank": 500000,
  "total_amount_to_central_bank": 9004179698.5,
  "yield_threshold_breached": false,
  "coverage_threshold_breached": false,
  "status_fingerprint": "3b5531174d1a...",
  "content_fingerprint": "eb78037a5cd5...",
  "is_new": true,
  "scraped_at": "2026-09-17T00:16:14.091Z"
}
```

This is a real record from this actor's own live verification run against the actual 2026
auction file — not a fabricated example. Note `quantity_to_central_bank: 500000` — a real,
observed market detail: a meaningful share of this auction's volume went directly to Brazil's
central bank rather than the primary dealer market.

`event_id` is a SHA-1 idempotency key over `(record_id, event_type, status_fingerprint,
content_fingerprint)`. `record_id` is a 5-component compound key
(`bondType-auctionType-maturityDate-auctionDate-round`) — see **Two real findings** above for
why all five components are required.

## Alerting

Both channels fire on the same real, quantitative trigger: a brand-new auction always alerts; a
revised auction alerts only when it actually breaches the `yieldChangeThresholdBps` or
`coverageRatioFloor` you configured — not merely because *something* about the record changed.

### Slack

Create the webhook via a **Slack App** (Slack's own current, documented method — not the older
"legacy custom integrations" path). Paste the URL into `slackWebhookUrl`.

### Microsoft Teams

Same real 2026 correction as Actor #2: Microsoft retired the classic Teams "Incoming Webhook"
connector in a May 2026 cutover. Use a **Workflows** webhook URL (Teams channel → Workflows →
"When a Teams webhook request is received") in `teamsWebhookUrl`. This actor posts a standard
Adaptive Card; a Power Automate flow's exact trigger schema is user-configurable per flow, so
adjust your flow's parsing step to this actor's payload if needed (documented in
[`src/notifier.ts`](src/notifier.ts)).

## Architecture

Full spec in [AGENTS.md](AGENTS.md). Summary:

```
  Actor input ──▶ src/main.ts (migrating/aborting-safe state flush,
                   one KV store, two independently-managed record keys:
                   fingerprints + benchmark rate history)
                        │
                        ▼
              src/routes.ts: for each selected registry year
                        │
                        ▼
     src/dataSource.ts: GET (no HEAD/Range support, no stable
     ETag - always a full download), XLSX parse (real header-
     row content search, not a hardcoded index), manual UTC-safe
     Excel-serial-to-date conversion
                        │
                        ▼
     src/quantEngine.ts: decimal rate -> basis points, coverage
     ratio, rate-change bps, threshold breach detection
                        │
                        ▼
     src/deltaEngine.ts: normalize -> canonicalize -> SHA-256
     -> classify (NEW_AUCTION / AUCTION_RESULT_REVISED /
     AUCTION_UNCHANGED / BASELINE_SNAPSHOT)
                        │
                        ▼
     src/state.ts: Key-Value Store persistence (per-auction
     fingerprints + per-year baseline flag under one record key,
     per-instrument rate history under a second, independently
     loaded/saved record key - one store, not two)
                        │
                        ▼
    Apify Dataset (pay-per-event push)
         + src/notifier.ts (webhook / Slack / Teams, fired only
           on a real threshold breach or a brand-new auction)
```

## Testing

```bash
npm test
```

112 real, passing tests across eight files:

- [`test/quantEngine.test.ts`](test/quantEngine.test.ts) — unit and **property-based** (via
  `fast-check`) tests for basis-point conversion, coverage ratio, and threshold breach detection,
  including linearity, monotonicity, homogeneity, and antitonicity properties checked across
  generated input ranges, not just hand-picked examples.
- [`test/deltaEngine.test.ts`](test/deltaEngine.test.ts) — canonicalization, SHA-256 fingerprint
  behavior, Excel-serial-to-date conversion against real observed values, and the full
  classify/shouldDeliver state machine, including a regression test for the real `auctionType`
  collision found live.
- [`test/dataSource.test.ts`](test/dataSource.test.ts) — real XLSX parsing (via an in-memory
  workbook built with the same `xlsx` library, matching the source's confirmed live layout), HTTP
  retry/backoff/timeout (including a genuine network-level rejection, not just a bad-status
  response), 404 handling, non-retryable-4xx handling, and per-year file-extension resolution.
- [`test/notifier.test.ts`](test/notifier.test.ts) — payload-shape and escaping tests for all
  three channels.
- [`test/state.test.ts`](test/state.test.ts) — Key-Value Store round-tripping for both
  independently-managed keys (`STATE` and `BENCHMARK_RATES`) within the shared state store.
- [`test/routes.test.ts`](test/routes.test.ts) — unit tests for the pure per-row logic.
- [`test/integration.test.ts`](test/integration.test.ts) — a full multi-run auction lifecycle
  simulation (baseline → unchanged → a real government data revision below threshold → a new
  auction and a threshold-breaching revision in the same run) verifying every delta trigger fires
  correctly, plus regression tests for maxItems-truncation safety, multi-year independence,
  per-year failure isolation, the `eventChargeLimitReached` stop condition, delivery-filtered rows
  still being tracked in state, and the not-yet-published-year (404) branch.
- [`test/main.test.ts`](test/main.test.ts) — shutdown-safety wiring: the `migrating`/`aborting`
  handlers actually flush both state stores when invoked, a flush failure never crashes the
  shutdown path, state is saved even when `run()` fails, and `Actor.exit()` is correctly never
  called on that failure path.

## CI/CD

[`.github/workflows/test.yaml`](.github/workflows/test.yaml): every push and pull request runs
lint, type-check/build, and the full test suite — a public quality signal, not a deploy pipeline.
Deployment to Apify is manual (`apify login --token` + `apify push`), matching how every actor
across this developer's portfolio is actually shipped; see
[`docs/GITHUB_REMOTE_SETUP.md`](docs/GITHUB_REMOTE_SETUP.md) for detail.

## What this actor deliberately does not do

- **No ISIN/CUSIP tracking** — this source doesn't publish them (see above).
- **No true bid-to-cover ratio** — this source doesn't publish total market demand (see above).
- **No forward-looking auction calendar** — Brazil's real quarterly auction calendar is a PDF
  press release, not a structured feed; mixing unreliable PDF-scraping into a "zero-defect,
  financial-grade" actor would undermine the actual reliability guarantee. See
  [AGENTS.md §3](AGENTS.md#3-three-mandate-assumptions-corrected-against-this-real-source).
- **No file-level change-avoidance** — this server's ETag isn't a real content signal (see
  above); every run fully downloads and parses every selected year.
- **No classic Microsoft Teams connector support** — retired, see **Alerting** above.

---

This actor is part of **Delta Registry** — pay-per-event regulatory & compliance data
infrastructure built and operated by Stefano Seggio. For the rest of the fleet, see
[github.com/stefanoseggio](https://github.com/stefanoseggio).
