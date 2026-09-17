// Generates docs/commands.md from the live command registry so documented
// help can never diverge from the running implementation. `--check` (CI)
// fails when the file is stale; run without flags to regenerate.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "docs", "commands.md");

const { COMMAND_REGISTRY, renderCommandHelpMarkdown } = await import(
  new URL("../apps/cli/dist/registry.js", import.meta.url)
);

const content = `# OpenCrowd interactive commands

<!-- Generated from the live command registry by scripts/generate-command-docs.mjs. Do not edit by hand. -->

Interactive slash commands act on the current session. Wallet → spending limits also saves defaults for future queries.
Persistent defaults can also change through \`opencrowd config\` or \`opencrowd wallet limits\`.

${renderCommandHelpMarkdown()}

${COMMAND_REGISTRY.length} commands. Autocomplete, \`/help\`, and
\`opencrowd --help\` render from this same registry.
`;

if (process.argv.includes("--check")) {
  const existing = await readFile(target, "utf8").catch(() => "");
  if (existing !== content) {
    console.error("docs/commands.md is out of date with the live command registry.");
    console.error("Run `npm run build && node scripts/generate-command-docs.mjs` and commit the result.");
    process.exit(1);
  }
  console.log("docs/commands.md matches the live command registry");
} else {
  await writeFile(target, content, "utf8");
  console.log(`wrote ${target}`);
}
