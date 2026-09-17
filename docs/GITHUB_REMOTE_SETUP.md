# GitHub Remote & CI/CD Secrets Setup

This document is a guide, not an automation this session ran for you. Creating a GitHub
repository, pushing your source code to it, and setting a secret on your real GitHub account are
all actions that affect a live account outside this local machine — they're deliberately left for
you to run yourself, when you're ready, using the script below or the equivalent manual commands.

**Current environment state, checked directly (not assumed):** `gh` (GitHub CLI) version 2.96.0 is
installed and already authenticated as `stefanoseggio` with `repo` and `workflow` token scopes —
enough to run every command in this guide. If you run this on a different machine, install `gh`
from [cli.github.com](https://cli.github.com/) and run `gh auth login` first.

## What already exists in this repository

- `.actor/`, `src/`, `tests/`, `docs/`, `README.md`, `LICENSE`, `.gitignore` — the actor's real
  source, already git-committed locally (see `git log`).
- `.github/workflows/deploy.yml` — a working CI/CD pipeline: every push and pull request runs
  lint, type-check/build, and the full test suite; a push specifically to `main` that passes all
  three then authenticates with the Apify CLI using an `APIFY_TOKEN` secret and runs `apify push`.
  It also now has a `workflow_dispatch:` trigger (added alongside this guide) so you can run the
  `verify` job on demand from GitHub's UI or CLI without needing to push or open a PR first — see
  "Verifying the pipeline safely" below.

Nothing about the actor's actual behavior, PPE pricing, or extraction logic is touched by anything
in this document.

## Step 1 — create the GitHub repository and push

### Option A: the provided script (recommended — it checks preconditions and asks for confirmation)

```bash
cd repo/sovereign-debt   # or whichever of the 4 actor repos you're setting up
APIFY_TOKEN=apify_api_xxxxxxxx ./docs/setup_github_remote.sh emerging-market-sovereign-debt-auction-monitor
```

Replace `apify_api_xxxxxxxx` with a real token from
[console.apify.com/settings/integrations](https://console.apify.com/settings/integrations)
("Personal API tokens") and the second argument with whatever repository name you want on GitHub
(it does not have to match the local folder name). Add `--public` as a third argument only if you
want the source code publicly visible — the default is a **private** repository.

The script will: create the GitHub repo, add it as `origin`, push your local `main` branch and its
full existing commit history, and set `APIFY_TOKEN` as a repository secret. It asks for a `y/N`
confirmation before doing anything, and never echoes or logs the actual token value.

### Option B: manual, step by step (same effect, if you want to run each command yourself)

```bash
cd repo/sovereign-debt
gh repo create emerging-market-sovereign-debt-auction-monitor --private --source=. --remote=origin
git push -u origin main
gh secret set APIFY_TOKEN --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)"
# ^ this last command will prompt you to paste the token interactively rather than pass it as
#   a CLI argument, which keeps it out of your shell history - press Enter after pasting.
```

Repeat this for each of the other 3 repos (`repo/ted-procurement/`, `repo/uk-modern-slavery/` and `repo/uae-corporate-registry/`) with a distinct repository name each — do not push more than one actor's
source into the same GitHub repository, since `.github/workflows/deploy.yml` in each is configured
to push that specific actor via its own `.actor/actor.json` identity.

## Step 2 — verify the secret was set (without ever revealing its value)

```bash
gh secret list --repo <your-username>/<repo-name>
```

This confirms `APIFY_TOKEN` exists as a secret name; GitHub never displays a secret's value again
after it's set, by design — if you need to confirm it's the *correct* token, the only way is to
rotate it (generate a new one in the Apify Console and re-run `gh secret set`) rather than try to
read the old one back.

## Verifying the pipeline safely, without deploying

Two independent ways to exercise the `verify` job (lint, build, test) without ever triggering the
`deploy` job's `apify push` — useful before you trust a fresh GitHub remote with real deploys:

### Method 1 — a feature branch and pull request (uses the existing trigger, no setup needed)

```bash
git checkout -b ci-smoke-test
git commit --allow-empty -m "Trigger CI verify job"
git push -u origin ci-smoke-test
gh pr create --title "CI smoke test" --body "Verifying the pipeline runs cleanly before trusting main." --base main
```

Opening this PR triggers the `pull_request` event, which runs `verify` only — the `deploy` job's
`if: github.event_name == 'push' && github.ref == 'refs/heads/main'` condition is false for a PR
event on any branch, so there is no code path here that can reach `apify push`. Watch it run with:

```bash
gh pr checks --watch
```

Once you're satisfied, either merge the PR (which WILL trigger a real `push` to `main`, and
therefore a real deploy — see the warning below) or close it without merging if you only wanted
the smoke test, then delete the branch (`gh pr close ci-smoke-test --delete-branch`, or
`git push origin --delete ci-smoke-test` afterward).

### Method 2 — manual workflow_dispatch (no branch or PR needed at all)

```bash
gh workflow run deploy.yml --ref main
gh run watch
```

This uses the `workflow_dispatch:` trigger added to `.github/workflows/deploy.yml`. Because the
deploy job's condition checks specifically for `github.event_name == 'push'`, a `workflow_dispatch`
run — even one you trigger `--ref main` — executes ONLY the `verify` job. This is the fastest way
to confirm `npm ci && npm run lint && npm run build && npm test` all pass in GitHub's actual
Actions environment before you ever push real code to `main`.

### The one command that WILL trigger a real deploy — know it before you run it

```bash
git push origin main   # or: merging any PR into main
```

Any push to `main` that passes the `verify` job's lint/build/test steps immediately proceeds to
the `deploy` job and runs a real `apify push` against your live actor, using the `APIFY_TOKEN`
secret. There is no additional confirmation step in the workflow itself — if you want a manual
gate before every deploy (rather than "every green push to main auto-deploys"), add
`environment: production` to the `deploy` job in `.github/workflows/deploy.yml` and configure a
required reviewer on a `production` environment in the repository's Settings → Environments; this
was not added by default since "every merge to main deploys" is a deliberate, common, valid choice
and this guide should not silently change that behavior for you.

## What this guide deliberately does not do

- It does not run `gh repo create`, `git push`, or `gh secret set` on your behalf — every command
  above is presented for you to run, in a terminal you control, at a time you choose.
- It does not include a token value anywhere in this file, the script, or any commit — the script
  reads `APIFY_TOKEN` from your shell's environment at the moment you run it, and GitHub's own
  secret store is opaque even to a repository's own future automation once set.
- It does not set up a recurring/scheduled deploy or add branch-protection rules — those are
  standing account-level configuration choices, not something to bundle silently into a setup
  script.
