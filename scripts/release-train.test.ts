import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The release train, run as the workflow runs it, in a throwaway git
 * repository shaped like this one: a CLI package with a version, a lockfile,
 * a CHANGELOG, tags, and fragments in changes/.
 */
const SCRIPT = resolve(__dirname, "release-train.mjs");

function repo(version = "0.16.49") {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  mkdirSync(join(dir, "apps/cli"), { recursive: true });
  mkdirSync(join(dir, "packages/core/src"), { recursive: true });
  mkdirSync(join(dir, "changes"));
  writeFileSync(join(dir, "apps/cli/package.json"), `{\n  "name": "opencrowd",\n  "version": "${version}"\n}\n`);
  writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify({ name: "root", packages: { "": {}, "apps/cli": { name: "opencrowd", version } } }, null, 2)}\n`);
  writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## ${version} — 2026-11-23\n\n- The last release.\n`);
  writeFileSync(join(dir, "changes/README.md"), "One file per pull request.\n");
  writeFileSync(join(dir, "packages/core/src/a.ts"), "export const a = 1;\n");
  run("add", "-A");
  run("commit", "-qm", "Release opencrowd 0.16.49");
  run("tag", `v${version}`);
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    run("add", "-A");
    run("commit", "-qm", message);
    return run("rev-parse", "HEAD");
  };
  const train = (...args: string[]) => {
    try {
      return { ok: true, out: execFileSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } }) };
    } catch (error: any) {
      return { ok: false, out: `${error.stdout}${error.stderr}` };
    }
  };
  return { dir, run, commit, train, read: (p: string) => readFileSync(join(dir, p), "utf8") };
}

describe("the daily release train", () => {
  it("releases nothing when only docs, tests or fragments changed", () => {
    const r = repo();
    r.commit("Docs", { "docs/x.md": "words\n", "packages/core/test/a.test.ts": "test\n", "changes/w1.md": "- pending\n" });
    expect(JSON.parse(r.train("plan").out)).toMatchObject({ release: false, version: "0.16.49" });
  });

  it("cuts the next patch from the day's fragments, oldest first, and deletes them", () => {
    const r = repo();
    r.commit("A fix", { "packages/core/src/a.ts": "export const a = 2;\n", "changes/w-fix.md": "- **A fix.** It works now.\n" });
    r.commit("A feature", { "packages/core/src/b.ts": "export const b = 1;\n", "changes/w-feature.md": "- **A feature.**\n  - with detail\n" });
    const result = JSON.parse(r.train("apply").out);
    expect(result).toMatchObject({ release: true, version: "0.16.50", bump: true });
    expect(JSON.parse(r.read("apps/cli/package.json")).version).toBe("0.16.50");
    expect(JSON.parse(r.read("package-lock.json")).packages["apps/cli"].version).toBe("0.16.50");
    const today = new Date().toISOString().slice(0, 10);
    expect(r.read("CHANGELOG.md")).toBe(
      `# Changelog\n\n## 0.16.50 — ${today}\n\n- **A fix.** It works now.\n- **A feature.**\n  - with detail\n\n## 0.16.49 — 2026-11-23\n\n- The last release.\n`);
    expect(existsSync(join(r.dir, "changes/w-fix.md"))).toBe(false);
    expect(existsSync(join(r.dir, "changes/README.md"))).toBe(true);
    expect(r.read(".release-notes.md")).toBe("- **A fix.** It works now.\n- **A feature.**\n  - with detail\n");
  });

  it("writes the commit subjects when nobody wrote a fragment", () => {
    const r = repo();
    r.commit("run_shell passes the npm prefix (#126)", { "packages/core/src/a.ts": "export const a = 3;\n" });
    JSON.parse(r.train("apply").out);
    expect(r.read("CHANGELOG.md")).toContain("- run_shell passes the npm prefix (#126)\n");
  });

  it("releases a version someone bumped by hand without bumping it again", () => {
    const r = repo();
    r.commit("Urgent: 0.16.50", { "apps/cli/package.json": `{\n  "name": "opencrowd",\n  "version": "0.16.50"\n}\n`, "packages/core/src/a.ts": "export const a = 4;\n" });
    expect(JSON.parse(r.train("plan").out)).toMatchObject({ release: true, version: "0.16.50", bump: false });
  });
});

describe("a pull request under the train", () => {
  it("may add a fragment, but not move the version or write CHANGELOG.md", () => {
    const r = repo();
    const base = r.run("rev-parse", "HEAD");
    r.commit("Fine", { "packages/core/src/a.ts": "export const a = 5;\n", "changes/w2.md": "- Fine.\n" });
    expect(r.train("check-pr", base).ok).toBe(true);
    r.commit("Bumps", { "apps/cli/package.json": `{\n  "name": "opencrowd",\n  "version": "0.16.50"\n}\n`, "CHANGELOG.md": "# Changelog\n\n## 0.16.50\n" });
    const bumped = r.train("check-pr", base);
    expect(bumped.ok).toBe(false);
    expect(bumped.out).toContain("CHANGELOG.md is written by the release train");
    expect(bumped.out).toContain("moves the version 0.16.49 → 0.16.50");
  });
});
