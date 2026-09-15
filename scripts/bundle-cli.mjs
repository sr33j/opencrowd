// Bundles the CLI (plus all @opencrowd/* workspace code) into a single file
// for npm publishing. Registry deps stay external and are installed by npm;
// only the unpublished workspace packages get inlined.
import { build } from "esbuild";
import { chmod, copyFile, cp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(root, "apps", "cli");
const pkg = JSON.parse(await readFile(join(cliDir, "package.json"), "utf8"));
const outfile = join(cliDir, "bundle", "opencrowd.js");

await build({
  entryPoints: [join(cliDir, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  external: Object.keys(pkg.dependencies ?? {}),
  // Inlined transitive CJS deps (e.g. ws) call require(); give the ESM
  // bundle a real one.
  banner: {
    js: 'import { createRequire as __ocCreateRequire } from "node:module"; const require = __ocCreateRequire(import.meta.url);'
  },
  logLevel: "warning"
});
await chmod(outfile, 0o755);

// Bundled modules resolve these assets one level above bundle/opencrowd.js,
// just as the workspace modules resolve them one level above src/ or dist/.
for (const [workspace, directory] of [["agent-runtime", "knowledge"], ["evals", "tasks"]]) {
  const target = join(cliDir, directory);
  await rm(target, { recursive: true, force: true });
  await cp(join(root, "packages", workspace, directory), target, { recursive: true });
}

// npm includes README/LICENSE from the package dir; mirror the repo's copies.
await copyFile(join(root, "README.md"), join(cliDir, "README.md"));
await copyFile(join(root, "LICENSE"), join(cliDir, "LICENSE"));

console.log(`bundled ${outfile}`);
