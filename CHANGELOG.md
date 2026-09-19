# Changelog

All notable changes to this actor are documented here.

## [1.0.1](https://github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor/compare/emerging-market-sovereign-debt-auction-monitor-v1.0.0...emerging-market-sovereign-debt-auction-monitor-v1.0.1) (2026-09-19)


### Bug Fixes

* **ci:** pass RELEASE_PLEASE_TOKEN so release PRs skip the bot-approval gate ([becce2b](https://github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor/commit/becce2b717360057f64ead2ba8f9624c34e37fea))
* close real multi-year timeout-budget recurrence in fetchWithRetry ([#7](https://github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor/issues/7)) ([e3c5b74](https://github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor/commit/e3c5b7481cb8bcf2d6149d1c52c689d67a96fd91))

## 1.0.0 - 2026-09-17

Initial release.

- Delta-tracks Brazil's National Treasury domestic bond auction results (LTN, LFT, NTN-B, NTN-F)
  via the official Tesouro Transparente open-data portal.
- Financial-grade basis-point rate canonicalization and UTC-safe Excel-serial-to-date conversion.
- Quantitative threshold alerting on marginal-rate moves and coverage-ratio anomalies.
- Multi-channel alerting: generic webhook, Slack (Block Kit), Microsoft Teams (Adaptive Card via
  Workflows).
- 112 automated tests (unit, property-based, and integration) across eight test files.
