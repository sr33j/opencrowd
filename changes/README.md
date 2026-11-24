# Changelog fragments

One file per pull request that changes what ships, named after its branch
(`changes/w98-run-budget-stop.md`). It holds the CHANGELOG bullets for the
change, written as they should appear under the release's heading:

```markdown
- **A run the host stops at its budget ends there, gracefully.** What the
  owner saw, what changed, and the names a reader would search for.
  - Detail, as nested bullets.
```

Do not edit `CHANGELOG.md` or the version in `apps/cli/package.json`: the
release train (`scripts/release-train.mjs`, `.github/workflows/release.yml`)
bumps the patch, moves these into CHANGELOG oldest first, deletes them and
publishes, once a day at 15:00 UTC. A change without a fragment is listed by
its commit subject. See `docs/releases.md`.
