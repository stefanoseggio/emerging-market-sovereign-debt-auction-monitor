#!/usr/bin/env bash
set -euo pipefail

# Creates a GitHub repository for this local repo and pushes its existing git history to it,
# then sets the APIFY_TOKEN secret so .github/workflows/deploy.yml's deploy job can authenticate
# and run `apify push` automatically on a future push to main.
#
# This script is NOT run automatically by anything - a human runs it, once, deliberately, when
# ready to put this repository on GitHub. It never hardcodes or echoes a real token anywhere; it
# only reads one that YOU already exported in your own shell before invoking it.
#
# Prerequisites (checked below, with a clear error if missing - nothing here silently no-ops):
#   - GitHub CLI (`gh`) installed and authenticated: `gh auth status`
#   - A real Apify API token in the APIFY_TOKEN environment variable of the shell that RUNS this
#     script (get one from https://console.apify.com/settings/integrations - "Personal API tokens")
#   - Run this from inside the actor's repo root (the directory containing .git)
#
# Usage:
#   APIFY_TOKEN=apify_api_xxxxxxxx ./docs/setup_github_remote.sh <github-repo-name> [--public]
#
# The created repository is PRIVATE by default. Pass --public only if you deliberately want this
# actor's source code publicly visible on GitHub - review LICENSE (MIT, permissive) and consider
# that this also publishes the full existing commit history, not just the current file state.

REPO_NAME="${1:-}"
VISIBILITY="--private"
if [[ "${2:-}" == "--public" ]]; then
    VISIBILITY="--public"
fi

if [[ -z "$REPO_NAME" ]]; then
    echo "Usage: APIFY_TOKEN=apify_api_xxx $0 <github-repo-name> [--public]" >&2
    exit 1
fi

if [[ -z "${APIFY_TOKEN:-}" ]]; then
    echo "ERROR: APIFY_TOKEN is not set in your shell environment." >&2
    echo "Get a real token from https://console.apify.com/settings/integrations, then re-run as:" >&2
    echo "  APIFY_TOKEN=apify_api_xxxxxxxx $0 $REPO_NAME" >&2
    exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI (gh) is not installed. See https://cli.github.com/" >&2
    exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: gh is not authenticated. Run 'gh auth login' first, then re-run this script." >&2
    exit 1
fi

if [[ ! -d .git ]]; then
    echo "ERROR: this directory is not a git repository. cd into the actor repo root (the one containing .git) and re-run." >&2
    exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo "ERROR: current branch is '$CURRENT_BRANCH', not 'main'. This script pushes 'main' specifically" >&2
    echo "to match .github/workflows/deploy.yml's 'branches: [main]' trigger. Switch to main first." >&2
    exit 1
fi

echo "This will:"
echo "  1. Create a $VISIBILITY GitHub repository named '$REPO_NAME' under your authenticated GitHub account"
echo "  2. Add it as this repo's 'origin' remote"
echo "  3. Push the local 'main' branch (and its full existing history) to it"
echo "  4. Set APIFY_TOKEN as a GitHub Actions secret on that new repository (value never logged)"
echo
read -r -p "Continue? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Aborted - nothing was created."
    exit 1
fi

echo "Creating repository and adding it as 'origin'..."
gh repo create "$REPO_NAME" "$VISIBILITY" --source=. --remote=origin

echo "Pushing local 'main' branch..."
git push -u origin main

REPO_FULL_NAME="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

echo "Setting APIFY_TOKEN as a repository secret on $REPO_FULL_NAME (value is never echoed or logged)..."
gh secret set APIFY_TOKEN --repo "$REPO_FULL_NAME" --body "$APIFY_TOKEN"

echo
echo "Done. $REPO_FULL_NAME is live with its CI/CD workflow wired to APIFY_TOKEN."
echo
echo "Confirm the secret exists WITHOUT revealing its value:"
echo "  gh secret list --repo $REPO_FULL_NAME"
echo
echo "IMPORTANT: do not push to 'main' yet if you just want to verify the pipeline first - see"
echo "'Verifying the pipeline safely, without deploying' in docs/GITHUB_REMOTE_SETUP.md."
