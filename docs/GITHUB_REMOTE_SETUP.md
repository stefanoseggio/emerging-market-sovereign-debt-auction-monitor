# GitHub Remote & CI Setup

**Current state, as of 2026-09-17:** this repository already exists on GitHub, public, with its
full commit history pushed — [github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor](https://github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor).
This document now records what was done and how CI/deployment actually work here, matching the
real, established convention already used across this developer's other 24+ Delta Registry actor
repositories (verified directly against `stefanoseggio/uk-hse-enforcement-monitor` via the GitHub
API) — it is not a step-by-step "create this" guide anymore, since that step is already done.

## How CI actually works here (and how it differs from an earlier draft of this repo)

`.github/workflows/test.yaml` runs `npm ci && npm run lint && npm run build && npm test` on every
push and pull request. It does **not** deploy anything. This repository's CI briefly had a
different `deploy.yml` workflow that authenticated with `apify login --token` and ran `apify push`
automatically on every push to `main` — that was removed and replaced with `test.yaml` specifically
to match the real, established pattern this developer already uses across the rest of the
portfolio: **CI exists as a public quality signal (a green checkmark anyone browsing the repo can
see), not as a deploy pipeline.** Confirmed directly: `uk-hse-enforcement-monitor`'s live Apify
Actor source type is `SOURCE_FILES`, not Git-linked — its maintainer deploys manually.

## How to actually deploy this actor to Apify

```bash
apify login --token <your token>   # only needed once per machine
apify push
```

Run this from the repository root whenever you want to publish a new build to Apify. This is a
deliberate, manual step — nothing in GitHub triggers it automatically. This matches how every
build referenced in this repo's `.actor/audit_manifest.json` was actually deployed this session.

## About the `APIFY_TOKEN` GitHub Actions secret

A secret named `APIFY_TOKEN` was set on this GitHub repository earlier, when this repo briefly had
an auto-deploy workflow. **It now serves no purpose** — `test.yaml` never references
`secrets.APIFY_TOKEN`, so nothing in CI reads it. It isn't a security risk on its own (GitHub
secrets aren't exposed to public repo visitors, only to workflow runs you control), but it's dead
configuration. To remove it:

```bash
gh secret remove APIFY_TOKEN --repo stefanoseggio/emerging-market-sovereign-debt-auction-monitor
```

This is optional cleanup, not required for anything to keep working.

## Setting up a fresh clone on a new machine

```bash
git clone https://github.com/stefanoseggio/emerging-market-sovereign-debt-auction-monitor.git
cd emerging-market-sovereign-debt-auction-monitor
npm ci
npm run lint && npm run build && npm test   # matches what CI runs on every push/PR
```

To deploy from that fresh clone, see "How to actually deploy this actor to Apify" above — you'll
need your own Apify API token from [console.apify.com/settings/integrations](https://console.apify.com/settings/integrations).

## The one-time setup script (`docs/setup_github_remote.sh`)

This script automated the original repo-creation step (`gh repo create`, initial push, and setting
the now-unused `APIFY_TOKEN` secret). It has already been run for this repository and does not need
to be run again — it's kept in this repo only as a reference for how the initial GitHub setup was
done, and as a reusable template if this actor's GitHub repo is ever recreated from scratch (e.g.
after a deliberate deletion). Since deployment is manual (see above), a future run of this script
could reasonably skip the `APIFY_TOKEN` step entirely rather than repeat now-obsolete config.
