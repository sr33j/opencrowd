# npm releases

The public `sr33j/opencrowd` repository publishes the `opencrowd` CLI through
`.github/workflows/release.yml`. npm trusts that workflow through GitHub OIDC;
no `NPM_TOKEN` secret or interactive npm login is required in CI.

1. Run `npm version <version> --workspace opencrowd --no-git-tag-version`.
2. Update `CHANGELOG.md`, then run `npm ci`, `npm run typecheck`,
   `npm run deadcode`, `npm test`, `npm run smoke`,
   `node scripts/generate-command-docs.mjs --check`, and `npm run smoke:pack`.
3. Commit and push the release changes to the public repository.
4. Create a GitHub Release with tag `v<version>` targeting that commit.
   The workflow requires an exact match between the tag and package version;
   prereleases are skipped. It validates and publishes to npm's `latest` tag.
5. Verify the Release action succeeded and `npm view opencrowd version`
   reports the new version. Update any parent repository's submodule pointer.

Internal workspace packages are bundled into the CLI and are not published.
The packed-package smoke test uses mock purchases and performs no paid calls.
