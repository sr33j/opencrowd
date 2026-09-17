import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Architecture and dead-code invariants: the final tree contains only the
 * target architecture. Legacy identifiers may survive in the changelog and
 * git history, never in source.
 */

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = [
  "packages/protocol/src",
  "packages/core/src",
  "packages/economy/src",
  "packages/agent-runtime/src",
  "packages/evals/src",
  "apps/cli/src"
];

async function sourceFiles(): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push({ path: full, text: await readFile(full, "utf8") });
      }
    }
  }
  for (const dir of SOURCE_DIRS) {
    await walk(join(ROOT, dir));
  }
  return files;
}

const FORBIDDEN_IDENTIFIERS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /PermissionMode/, reason: "renamed to ApprovalMode" },
  { pattern: /\bask_first\b/, reason: "approval modes are ask|auto|off" },
  { pattern: /\byolo\b/, reason: "approval modes are ask|auto|off" },
  { pattern: /OPENCROWD_PERMISSION_MODE/, reason: "renamed to OPENCROWD_APPROVAL_MODE" },
  { pattern: /x402LlmBaseUrl|x402LlmModel|x402LlmMaxCostCents/, reason: "replaced by the typed provider abstraction" },
  { pattern: /OPENCROWD_LLM_PROVIDER/, reason: "hidden provider branches are deleted" },
  { pattern: /[Bb]azaar/, reason: "the Bazaar fallback is retired" },
  { pattern: /\bsearch_services\b|\bcall_service\b|\badd_allowed_service\b|\brequest_service_permission\b/, reason: "legacy economy tools are retired" },
  { pattern: /FRUIT_LABELS|chooseFruitLabel/, reason: "the wallet registry is deleted" },
  { pattern: /wallet-secrets|walletSecretsPath|find-generic-password/, reason: "local key custody is deleted; AgentCash owns the wallet" },
  { pattern: /startMcpServer|startLocalApi/, reason: "the OpenCrowd MCP server and localhost API are deleted" }
];

describe("architecture invariants", () => {
  it("contains no legacy architecture identifiers in source", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    const violations: string[] = [];
    for (const file of files) {
      for (const { pattern, reason } of FORBIDDEN_IDENTIFIERS) {
        if (pattern.test(file.text)) {
          violations.push(`${file.path.replace(`${ROOT}/`, "")}: ${pattern} (${reason})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no deleted packages in the workspace, build graph, or lockfile", async () => {
    for (const gone of ["packages/mcp", "packages/local-api", "packages/connectors"]) {
      expect(existsSync(join(ROOT, gone))).toBe(false);
    }
    const rootPackage = await readFile(join(ROOT, "package.json"), "utf8");
    expect(rootPackage).not.toMatch(/packages\/(mcp|local-api|connectors)/);
    const lockfile = await readFile(join(ROOT, "package-lock.json"), "utf8");
    expect(lockfile).not.toMatch(/"packages\/(mcp|local-api|connectors)"/);
    const tsconfig = await readFile(join(ROOT, "tsconfig.json"), "utf8");
    expect(tsconfig).not.toMatch(/mcp|local-api|connectors/);
  });

  it("keeps core vendor-neutral: only the shared protocol dependency", async () => {
    const corePackage = JSON.parse(await readFile(join(ROOT, "packages/core/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(corePackage.dependencies ?? {})).toEqual(["@opencrowd/protocol"]);
  });

  it("publishes only the opencrowd CLI package", async () => {
    const release = await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8");
    const publishes = [...release.matchAll(/npm publish --workspace (\S+)/g)].map((match) => match[1]);
    expect(publishes).toEqual(["opencrowd"]);
    const cliPackage = JSON.parse(await readFile(join(ROOT, "apps/cli/package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(cliPackage.scripts?.prepack).toContain("npm --prefix ../.. run build");
  });

  it("enforces unused-code compiler checks", async () => {
    const base = JSON.parse(await readFile(join(ROOT, "tsconfig.base.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(base.compilerOptions.noUnusedLocals).toBe(true);
    expect(base.compilerOptions.noUnusedParameters).toBe(true);
  });
});
