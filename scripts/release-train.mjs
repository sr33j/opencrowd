#!/usr/bin/env node
/**
 * The release train: one opencrowd release a day, cut from `main`.
 *
 *   node scripts/release-train.mjs plan             what today's train would release, as JSON
 *   node scripts/release-train.mjs apply            bump, write CHANGELOG, delete the fragments
 *   node scripts/release-train.mjs check-pr <base>  a pull request leaves the version and CHANGELOG alone
 *
 * Pull requests no longer bump the version or edit CHANGELOG.md. Each adds a
 * fragment, `changes/<anything>.md`, holding its changelog bullets. When ten
 * workspaces each bumped the patch and prepended to CHANGELOG, every one of
 * them conflicted with the others and releases had to be taken in turn. The
 * train (`.github/workflows/release.yml`, daily and on demand) does both once:
 *
 * - if `apps/cli/package.json`'s version has no `v<version>` tag yet, that
 *   version is released as it is (someone bumped it by hand);
 * - otherwise, if anything shipped changed since the last tag, the next patch
 *   is released; documentation, tests and fragments alone release nothing;
 * - CHANGELOG gets one section: the fragments, oldest first, or the commit
 *   subjects since the tag when nobody wrote one.
 *
 * `apply` changes files only. The workflow runs the release checks, then
 * commits, tags, pushes, creates the GitHub Release and publishes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const CHANGES = join(root, "changes");
const PACKAGE = join(root, "apps/cli/package.json");
const LOCK = join(root, "package-lock.json");
const CHANGELOG = join(root, "CHANGELOG.md");

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
};

/** Paths whose change ships in the package: source and dependencies, not docs or tests. */
export function ships(path) {
  if (/^changes\//.test(path) || path === "CHANGELOG.md") return false;
  if (/(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/\.md$/.test(path) && !/^packages\/[^/]+\/(knowledge|assets)\//.test(path)) return false;
  return /^(packages|apps)\//.test(path) || path === "package.json" || path === "package-lock.json";
}

export function nextPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Not a plain semver version: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Fragments, oldest first: in the order of the commits that added them. */
function fragments() {
  if (!existsSync(CHANGES)) return [];
  const history = (tryGit("log", "--reverse", "--diff-filter=A", "--format=", "--name-only", "--", "changes") ?? "").split("\n").filter(Boolean);
  const order = (path) => {
    const at = history.indexOf(path);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return readdirSync(CHANGES)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => {
      const path = `changes/${f}`;
      return { path, added: order(path), text: readFileSync(join(root, path), "utf8").trim() };
    })
    .filter((f) => f.text)
    .sort((a, b) => a.added - b.added || a.path.localeCompare(b.path));
}

export function plan({ today = new Date().toISOString().slice(0, 10) } = {}) {
  const current = JSON.parse(readFileSync(PACKAGE, "utf8")).version;
  const head = git("rev-parse", "HEAD");
  const tagged = tryGit("rev-parse", "-q", "--verify", `refs/tags/v${current}`);
  const frags = fragments();
  if (!tagged) {
    return { release: true, version: current, bump: false, head, reason: `v${current} is in apps/cli/package.json but was never released`, fragments: frags.map((f) => f.path), today };
  }
  const since = `v${current}`;
  const changed = (tryGit("diff", "--name-only", `${since}..HEAD`) ?? "").split("\n").filter(Boolean);
  const shipped = changed.filter(ships);
  if (!shipped.length)
    return { release: false, version: current, head, reason: changed.length ? `nothing shipped changed since ${since} (${changed.length} files of docs, tests or fragments)` : `nothing since ${since}`, fragments: frags.map((f) => f.path), today };
  return { release: true, version: nextPatch(current), bump: true, head, since, reason: `${shipped.length} shipped files changed since ${since}`, fragments: frags.map((f) => f.path), today };
}

/** The CHANGELOG section for a release. */
export function section(version, today, frags, subjects) {
  const body = frags.length
    ? frags.map((f) => f.text).join("\n")
    : subjects.map((s) => `- ${s}`).join("\n") || "- Maintenance release.";
  return `## ${version} — ${today}\n\n${body}\n`;
}

function apply() {
  const p = plan();
  if (!p.release) return p;
  const frags = fragments();
  const subjects = p.since
    ? (tryGit("log", "--no-merges", "--format=%s", `${p.since}..HEAD`) ?? "").split("\n").filter((s) => s && !/^Release opencrowd /.test(s)).reverse()
    : [];
  if (p.bump) {
    const pkg = readFileSync(PACKAGE, "utf8");
    writeFileSync(PACKAGE, pkg.replace(/("version":\s*")[^"]+(")/, `$1${p.version}$2`));
    const lock = JSON.parse(readFileSync(LOCK, "utf8"));
    if (lock.packages?.["apps/cli"]) lock.packages["apps/cli"].version = p.version;
    writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  }
  const notes = section(p.version, p.today, frags, subjects);
  const log = readFileSync(CHANGELOG, "utf8");
  const at = log.indexOf("\n## ");
  writeFileSync(CHANGELOG, at < 0 ? `${log.trimEnd()}\n\n${notes}` : `${log.slice(0, at + 1)}${notes}\n${log.slice(at + 1)}`);
  for (const f of frags) rmSync(join(root, f.path));
  writeFileSync(join(root, ".release-notes.md"), notes.split("\n").slice(2).join("\n"));
  return { ...p, notes: ".release-notes.md" };
}

/** A pull request may not move the version or write CHANGELOG.md; the train does both. */
function checkPr(base) {
  const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const problems = [];
  if (changed.includes("CHANGELOG.md")) problems.push("CHANGELOG.md is written by the release train; put your bullets in changes/<branch>.md");
  if (changed.includes("apps/cli/package.json")) {
    const before = JSON.parse(git("show", `${base}:apps/cli/package.json`)).version;
    const after = JSON.parse(readFileSync(PACKAGE, "utf8")).version;
    if (before !== after) problems.push(`apps/cli/package.json moves the version ${before} → ${after}; the release train bumps it. For an urgent release, ask the owner to run the Release workflow`);
  }
  if (changed.some(ships) && !changed.some((f) => /^changes\/.+\.md$/.test(f) && f !== "changes/README.md"))
    console.log("::notice::This changes what ships but adds no changes/*.md fragment; its CHANGELOG line will be the commit subject.");
  return problems;
}

const [command = "plan", arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  if (command === "plan") console.log(JSON.stringify(plan(), null, 2));
  else if (command === "apply") {
    const result = apply();
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, `release=${result.release}\nversion=${result.version}\nhead=${result.head}\nreason=${result.reason}\n`, { flag: "a" });
  } else if (command === "check-pr") {
    if (!arg) throw new Error("check-pr needs the base commit");
    const problems = checkPr(arg);
    for (const p of problems) console.log(`::error::${p}`);
    if (problems.length) process.exit(1);
  } else throw new Error(`Unknown command ${command}: plan | apply | check-pr <base>`);
}
