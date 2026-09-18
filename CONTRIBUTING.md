# Contributing

This repository ships the real, buildable TypeScript source for the **Emerging-Market Sovereign Debt Auction Monitor** Apify Actor. It is independently maintained by Stefano Seggio as part of the [Delta Registry](https://github.com/stefanoseggio) fleet — there is no separate contributor team, but external bug reports, source-coverage proposals, and documentation fixes are welcome.

## Local setup

```bash
git clone https://github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor.git
cd emerging-market-sovereign-debt-auction-monitor
npm install
apify login          # once per machine, needed only for `apify run`
```

No third-party credentials are required — this Actor calls only the official Tesouro Transparente open-data portal (`tesourotransparente.gov.br` / `sisweb.tesouro.gov.br`), which is unauthenticated and ODbL-licensed.

## Development workflow

```bash
npm run start:dev     # tsx src/main.ts, reads ./storage/key_value_stores/default/INPUT.json
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npm run format         # prettier --write .
npm run build          # tsc
npm test               # vitest run
```

Local runs against the real source always fully download and parse the selected year's XLSX file (this server's ETag is not a real content signal — see the README's "Two real findings" section) — there is no bundled fixture/mock server. Use a small `maxItems` and a single `years` entry while developing to keep runs fast.

## Branch naming

- `fix/<short-description>` — bug fixes
- `feat/<short-description>` — new input fields, new output fields, new source coverage
- `docs/<short-description>` — README/documentation-only changes
- `chore/<short-description>` — dependency bumps, tooling, CI changes

## Commit convention

This repository follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>

<optional body>
```

Types used here: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`. The `type` prefix drives automated changelog generation via `release-please` (see [`.github/workflows/release.yml`](.github/workflows/release.yml)) — a `feat:` commit triggers a minor version bump, `fix:` triggers a patch bump, and `feat!:`/a `BREAKING CHANGE:` footer triggers a major bump. Non-conventional commit messages are still accepted but won't be reflected in the auto-generated changelog entry for that change.

## Pull requests

1. Fork or branch, make your change, and ensure `npm run lint`, `npm run build`, and `npm test` all pass locally.
2. Open a PR against `main` using the repository's [PR template](.github/PULL_REQUEST_TEMPLATE.md).
3. CI (`.github/workflows/test.yaml`) runs automatically and must pass before merge.
4. Behavioral changes to the Actor's input/output schema should also update `.actor/input_schema.json` / `.actor/dataset_schema.json` and the corresponding README sections in the same PR — schema and documentation drift is treated as a real bug, not a follow-up.

## Scope boundaries

Feature proposals are evaluated against this Actor's own documented doctrine (README → "A note on two metrics this README will not overclaim" and "What this actor deliberately does not do"): no ISIN/CUSIP tracking or true bid-to-cover ratio (this source doesn't publish the underlying data for either), no forward-looking auction calendar (Brazil's real calendar is an unstructured PDF press release, and scraping it would undermine this Actor's reliability guarantee), and no file-level change-avoidance claim (this server's ETag isn't a real content signal, confirmed by direct testing). A proposal that requires overclaiming any of these will be declined or relabeled honestly rather than shipped as asked.

## Questions or non-code issues

For questions that aren't a code change (pricing, licensing, enterprise inquiries), use the Apify Store's Issues tab on the [live Actor page](https://apify.com/stefano_seggio/emerging-market-sovereign-debt-auction-monitor) rather than a GitHub issue.
