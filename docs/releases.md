# npm releases

The public `sr33j/opencrowd` repository publishes the `opencrowd` CLI through
`.github/workflows/release.yml`. npm trusts that workflow through GitHub OIDC;
no `NPM_TOKEN` secret or interactive npm login is required in CI.

## The release train (the normal way)

**One release a day, cut from `main`.** Pull requests do not bump the version
or edit `CHANGELOG.md`; each one that changes what ships adds a fragment,
`changes/<branch>.md`, with its changelog bullets (`changes/README.md`). CI
fails a pull request that moves the version or writes `CHANGELOG.md`.

Every day at 15:00 UTC the `Release` workflow runs `scripts/release-train.mjs`:

1. If nothing that ships (`packages/`, `apps/`, the lockfile; not docs, tests
   or fragments) changed since the last `v*` tag, it stops: a green run that
   says "nothing since v…".
2. Otherwise it bumps the patch in `apps/cli/package.json` and the lockfile,
   writes one CHANGELOG section from the fragments (oldest first; the commit
   subjects when there are none) and deletes them.
3. It runs the release checks: `npm ci`, `typecheck`, `deadcode`, `test`,
   `smoke`, the command-docs check and `smoke:pack`.
4. It commits `Release opencrowd <version>` to `main`, tags `v<version>`,
   creates the GitHub Release with that section as its notes, and publishes
   to npm's `latest` tag with provenance.

If `main` moved while the checks ran, the push is refused and nothing is
tagged or published; the next run cuts again. If a version in
`apps/cli/package.json` was never released, the train releases it as it is.

`node scripts/release-train.mjs plan` shows what the next train would do.

**After a release** the CrowdCode parent repo still points at the commit it
pinned. The hosted executor builds from that pointer, not from npm, so a
change reaches CrowdCode when someone bumps the pointer, whether or not it has
been released; the train only decides when it reaches npm.

## An urgent release

When something cannot wait for 15:00 UTC, the owner runs the train now:

```bash
gh workflow run release.yml --repo sr33j/opencrowd            # cut and publish now
gh workflow run release.yml --repo sr33j/opencrowd -f dry_run=true   # cut and check only
```

or **Actions → Release → Run workflow**. It is the same job, so the same rules
apply.

## By hand (fallback)

A GitHub Release published by hand still publishes: the workflow checks that
the tag is `v<version>` of `apps/cli/package.json` and runs the same checks.
Use it only if the train itself is broken.

1. Run `npm version <version> --workspace opencrowd --no-git-tag-version`,
   move the fragments into `CHANGELOG.md`, and run the checks above.
2. Commit and push to `main`, then create a GitHub Release with tag
   `v<version>` targeting that commit. Prereleases are skipped.
3. Verify the Release action succeeded and `npm view opencrowd version`
   reports the new version.

Internal workspace packages are bundled into the CLI and are not published.
The packed-package smoke test uses mock purchases and performs no paid calls.
