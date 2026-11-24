#!/usr/bin/env bash
# Refuse to publish a release the CrowdCode release gate has not passed.
#
# Before an opencrowd version reaches npm, and so the hosted agents that run
# it, CrowdCode runs the tree gate's owner-style tasks on the candidate and on
# the current release and posts the verdict on the commit as the
# `crowdcode/release-gate` status (CrowdCode's app/scripts/release-gate.ts and
# design-docs/TREE_GATE.md). This passes only when that status is `success`
# on the commit being released, or on an ancestor that differs from it only
# in version and changelog files (a release train's bump commit).
#
# Usage: scripts/require-release-gate.sh <commit>   (needs GH_TOKEN with statuses: read)
set -euo pipefail
commit="${1:?usage: require-release-gate.sh <commit>}"
repo="${GITHUB_REPOSITORY:-sr33j/opencrowd}"
context="crowdcode/release-gate"
# What a version bump may touch without needing a gate of its own.
bump_only='^(CHANGELOG\.md|package-lock\.json|apps/cli/package\.json|changes/.*)$'

candidate="$(git rev-parse "$commit^{commit}")"
for step in 0 1 2 3; do
  # The newest status with this context is the verdict.
  state="$(gh api "repos/$repo/commits/$candidate/statuses?per_page=100" \
    --jq "[.[] | select(.context == \"$context\")][0] | \"\(.state)\t\(.description)\"" 2>/dev/null || true)"
  if [[ -n "$state" && "$state" != "null"* ]]; then
    verdict="${state%%$'\t'*}"
    echo "$context on ${candidate:0:12}: $state"
    if [[ "$verdict" == "success" ]]; then exit 0; fi
    echo "::error::The CrowdCode release gate did not pass ${candidate:0:12} ($verdict). Fix what it found, or ask for an override (TREE_GATE.md)." >&2
    exit 1
  fi
  parent="$(git rev-parse "$candidate^" 2>/dev/null)" || break
  changed="$(git diff --name-only "$parent" "$commit")"
  if [[ -n "$changed" ]] && grep -Evq "$bump_only" <<<"$changed"; then break; fi
  candidate="$parent"
done
echo "::error::No $context status on ${commit:0:12}. Gate it first: in CrowdCode, cd app && npx tsx scripts/release-gate.ts --rc ${commit:0:12}" >&2
exit 1
