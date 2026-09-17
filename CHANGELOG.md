# Changelog

All notable changes to this actor are documented here.

## 1.0.0 - 2026-09-17

Initial release.

- Delta-tracks Brazil's National Treasury domestic bond auction results (LTN, LFT, NTN-B, NTN-F)
  via the official Tesouro Transparente open-data portal.
- Financial-grade basis-point rate canonicalization and UTC-safe Excel-serial-to-date conversion.
- Quantitative threshold alerting on marginal-rate moves and coverage-ratio anomalies.
- Multi-channel alerting: generic webhook, Slack (Block Kit), Microsoft Teams (Adaptive Card via
  Workflows).
- 99 automated tests (unit, property-based, and integration) across seven test files.
