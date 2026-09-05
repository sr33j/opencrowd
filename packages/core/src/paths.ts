import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/** Explicit mutable-state roots. Hosted callers inject this; local defaults stay local. */
export interface AgentPaths {
  home?: string;
  config: string;
  workspace: string;
  metadata: string;
}

export function resolveAgentPaths(options: { agentHome?: string; workspace?: string; configDir?: string } = {}): AgentPaths {
  if (options.agentHome) {
    const home = resolve(options.agentHome);
    return { home, config: join(home, "config"), workspace: join(home, "workspace"), metadata: join(home, "metadata") };
  }
  const workspace = resolve(options.workspace ?? process.cwd());
  return {
    config: resolve(options.configDir ?? process.env.OPENCROWD_CONFIG_DIR ?? join(homedir(), ".config", "opencrowd")),
    workspace,
    metadata: join(workspace, ".opencrowd")
  };
}

export function assertPathId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(id) || id === "." || id === "..") {
    throw new Error("invalid filesystem identifier");
  }
}

/** Reject traversal and every existing symlink component, including ancestors. */
export async function containedPath(root: string, requested: string): Promise<string> {
  if (requested.includes("\0") || isAbsolute(requested)) throw new Error("path must be relative");
  const base = resolve(root);
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path must stay inside its directory");
  let current = target;
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink paths are not permitted");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

/** Durable replace: sync file before rename and parent directory after rename. */
export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await rm(temp, { force: true });
  }
}
