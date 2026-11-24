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
3. **It requires the CrowdCode release gate** on the main commit it cut from
   (below). Without a `passed` verdict, it releases nothing that day and says
   so in the run's summary.
4. It runs the release checks: `npm ci`, `typecheck`, `deadcode`, `test`,
   `smoke`, the command-docs check and `smoke:pack`.
5. It commits `Release opencrowd <version>` to `main`, tags `v<version>`,
   creates the GitHub Release with that section as its notes, and publishes
   to npm's `latest` tag with provenance.

If `main` moved while the checks ran, the push is refused and nothing is
tagged or published; the next run cuts again. If a version in
`apps/cli/package.json` was never released, the train releases it as it is.

`node scripts/release-train.mjs plan` shows what the next train would do.

## The release gate

Hosted CrowdCode agents run opencrowd, so a release first runs CrowdCode's
owner-style tasks (the capability tree gate's tasks: answers, tools, files,
payments, standing rules) on the current release and on the candidate, on
the same tree, and passes only if the candidate is no worse on accuracy and
cost. From the CrowdCode repository, on the commit the train will cut from
(today's `main`), before 15:00 UTC:

```bash
cd app && npx tsx scripts/release-gate.ts --rc <commit>
```

It takes about 40 minutes and about $0.20 (at most $0.80), and records the
verdict as an annotated tag on the commit, `release-gate/<full sha>`, whose
subject is `passed` or `held`. Only someone who can push here can write one.
`scripts/require-release-gate.sh <commit>` is what the workflow checks:
`passed` on the commit, or on one it differs from only in version and
changelog files. If the gate cannot run, an operator records an override
(`--override <commit> --reason "…"`). CrowdCode's
`design-docs/TREE_GATE.md` has the rule and what each task checks.

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
2. Commit and push to `main`, gate the commit (above), then create a GitHub Release with tag
   `v<version>` targeting that commit. Prereleases are skipped.
3. Verify the Release action succeeded and `npm view opencrowd version`
   reports the new version.

Internal workspace packages are bundled into the CLI and are not published.
The packed-package smoke test uses mock purchases and performs no paid calls.
