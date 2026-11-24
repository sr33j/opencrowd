#!/usr/bin/env bash
# Refuse to publish a release the CrowdCode release gate has not passed.
#
# Before an opencrowd version reaches npm, and so the hosted agents that run
# it, CrowdCode runs the tree gate's owner-style tasks on the candidate and on
# the current release, and records the verdict on the commit as an annotated
# tag, `release-gate/<full sha>`, whose subject is `passed` or `held`
# (CrowdCode's app/scripts/release-gate.ts and design-docs/TREE_GATE.md). Only
# someone who can push to this repository can write one. This passes only when
# that tag says `passed` for the commit being released, or for an ancestor
# that differs from it only in version and changelog files (a release train's
# bump commit).
#
# Usage: scripts/require-release-gate.sh <commit>
set -euo pipefail
commit="${1:?usage: require-release-gate.sh <commit>}"
# What a version bump may touch without needing a gate of its own.
bump_only='^(CHANGELOG\.md|package-lock\.json|apps/cli/package\.json|changes/.*)$'

candidate="$(git rev-parse "$commit^{commit}")"
for step in 0 1 2 3; do
  tag="release-gate/$candidate"
  git fetch -q --force origin "refs/tags/$tag:refs/tags/$tag" 2>/dev/null || true
  # The tag must be on this very commit, not merely carry its name.
  if [[ "$(git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null)" == "$candidate" ]]; then
    verdict="$(git tag -l --format='%(contents:subject)' "$tag")"
    echo "$tag: $verdict"
    if [[ "$verdict" == passed* ]]; then exit 0; fi
    echo "::error::The CrowdCode release gate did not pass ${candidate:0:12} ($verdict). Fix what it found, or ask for an override (TREE_GATE.md)." >&2
    exit 1
  fi
  parent="$(git rev-parse "$candidate^" 2>/dev/null)" || break
  changed="$(git diff --name-only "$parent" "$commit")"
  if [[ -n "$changed" ]] && grep -Evq "$bump_only" <<<"$changed"; then break; fi
  candidate="$parent"
done
echo "::error::No release-gate verdict on ${commit:0:12}. Gate it first: in CrowdCode, cd app && npx tsx scripts/release-gate.ts --rc ${commit:0:12}" >&2
exit 1
