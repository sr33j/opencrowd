// Exercise the npm tarball outside the repository without making paid calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "opencrowd-pack-")));
const env = { ...process.env, OPENCROWD_CONFIG_DIR: join(temporary, "config") };

async function compareAssets(source, packed) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await compareAssets(join(source, entry.name), join(packed, entry.name));
    } else {
      assert.deepEqual(await readFile(join(packed, entry.name)), await readFile(join(source, entry.name)));
    }
  }
}

try {
  execFileSync("npm", ["pack", "--workspace", "opencrowd", "--pack-destination", temporary], { cwd: root, env, stdio: "inherit" });
  const tarball = (await readdir(temporary)).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack must produce a tarball");
  execFileSync("tar", ["-xzf", join(temporary, tarball), "-C", temporary]);
  // Reuse installed external dependencies; all unpublished workspace code is bundled.
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  const packed = join(temporary, "package");
  const cli = join(packed, "bundle", "opencrowd.js");
  const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: temporary, env, encoding: "utf8" });
  assert.equal(run("--version").trim(), manifest.version);
  assert.match(run("--help"), /opencrowd/);
  await compareAssets(join(root, "packages", "agent-runtime", "knowledge"), join(packed, "knowledge"));
  await compareAssets(join(root, "packages", "evals", "tasks"), join(packed, "tasks"));
  // Load the bundled task set, but select zero tasks so no provider is contacted.
  run("evals", "suite", "--set", "usage", "--limit", "0", "--out", join(temporary, "evals"));
  const result = JSON.parse(run("run", "--headless", "--test-mode", "--prompt", "smoke: buy a mock service and review it", "--output", "json", "--workspace", join(temporary, "demo")));
  assert.equal(result.outcome, "completed");
  assert.ok(result.service_calls.length > 0, "packed CLI must complete the mock purchase lifecycle");
  console.log("smoke: packed CLI, knowledge tree, and eval assets passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
