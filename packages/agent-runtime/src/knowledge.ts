import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSession, type SessionState } from "@opencrowd/core";
import { fetchLiveTree, treeVersionPin, type CrowdCodeApiOptions } from "@opencrowd/economy";

/**
 * Service knowledge tree: a CrowdCode-derived, progressively disclosed
 * memory of which paid services to use and when not to buy.
 *
 *   L0.md               -> system prompt (replaces the static capability line)
 *   INDEX.md, categories -> artifacts/knowledge/ (read on demand)
 *
 * Resolution order: an explicit directory, then OPENCROWD_KNOWLEDGE_DIR
 * ("none" disables), then — when the caller asks for it (hosted runs and
 * the CLI do) — CrowdCode's live capability tree (C7), rebuilt nightly from
 * verified purchases and probes, and finally the snapshot bundled with this
 * package. The live fetch has two seconds; a run never waits longer for
 * advice, and never fails for want of it. The loaded version is recorded on
 * the session so runs are reproducible.
 */

export interface LoadedKnowledge {
  version: string;
  source: string;
  l0: string;
  /** The bundled or explicit directory; absent for the live tree. */
  dir?: string;
  /** The live tree's version number, when the live tree was loaded. */
  tree?: number;
}

export interface LiveTreeOptions extends CrowdCodeApiOptions {
  /** current (default), candidate, or a version number; OPENCROWD_TREE_VERSION when absent. */
  version?: string;
  timeoutMs?: number;
  /** Bypass the caches (a run pinned to a tree version). */
  fresh?: boolean;
  /** Keep the last tree served here and fall back to it when the backend is slow (the agent's volume). */
  persistPath?: string;
  /** Tests: the pause before the retry, and the clock. */
  retryDelayMs?: number;
  now?: () => number;
}

export interface KnowledgeOptions {
  /** Explicit tree directory; overrides the environment, the live tree and the bundled snapshot. */
  dir?: string;
  /** Read CrowdCode's live tree first, falling back to the bundled snapshot. */
  live?: boolean | LiveTreeOptions;
}

const VERSION_FILE = ".version";

/** The snapshot shipped with @opencrowd/agent-runtime (../knowledge from src/ or dist/). */
export function bundledKnowledgeDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "knowledge");
}

export function knowledgeDisabledByEnv(): boolean {
  const value = process.env.OPENCROWD_KNOWLEDGE_DIR?.trim().toLowerCase();
  return value === "none" || value === "off" || value === "0";
}

export async function resolveKnowledgeDir(options: KnowledgeOptions = {}): Promise<string | undefined> {
  if (options.dir) {
    return options.dir;
  }
  const env = process.env.OPENCROWD_KNOWLEDGE_DIR?.trim();
  if (env) {
    return knowledgeDisabledByEnv() ? undefined : env;
  }
  const bundled = bundledKnowledgeDir();
  try {
    await access(join(bundled, "L0.md"));
    return bundled;
  } catch {
    return undefined;
  }
}

/**
 * Load the tree and record its version on the session. The live tree is
 * only the L0 text (deeper nodes come from browse_services); a directory
 * tree is copied under the session's artifacts so read_file can reach its
 * category pages. Returns undefined when no tree is configured or the
 * directory has no L0.md.
 */
export async function loadKnowledgeTree(session: SessionState, options: KnowledgeOptions = {}): Promise<LoadedKnowledge | undefined> {
  let fallback: string | undefined;
  if (options.live && !options.dir && !process.env.OPENCROWD_KNOWLEDGE_DIR?.trim()) {
    const live = options.live === true ? {} : options.live;
    const { tree, error, staleSince } = await fetchLiveTree({ ...live, version: treeVersionPin(live.version) });
    if (tree) {
      const version = `capability-tree-v${tree.version}`;
      // A persisted copy stands in for a slow backend; the session still says the fetch failed.
      const stale = error ? `${error}; using the last tree served, v${tree.version}, fetched ${staleSince}` : undefined;
      if (session.knowledge?.version !== version || session.knowledge?.source !== tree.source || session.knowledge?.tree !== tree.version
        || session.knowledge?.fallback !== stale) {
        session.knowledge = { version, source: tree.source, loadedAt: new Date().toISOString(), tree: tree.version, ...(stale ? { fallback: stale } : {}) };
        await saveSession(session);
      }
      return { version, source: tree.source, l0: tree.l0, tree: tree.version };
    }
    fallback = error;
  }
  const dir = await resolveKnowledgeDir(options);
  if (!dir) {
    return undefined;
  }
  let l0: string;
  try {
    l0 = (await readFile(join(dir, "L0.md"), "utf8")).trim();
  } catch {
    return undefined;
  }
  const version = await readVersion(dir, l0);
  const target = join(session.artifactsDir, "knowledge");
  if (await currentVersion(target) !== version) {
    await mkdir(session.artifactsDir, { recursive: true });
    await cp(dir, target, {
      recursive: true,
      force: true,
      filter: (source) => !source.endsWith("proposal.raw.txt")
    });
    await writeFile(join(target, VERSION_FILE), `${version}\n`, "utf8");
  }
  if (session.knowledge?.version !== version || session.knowledge?.source !== dir || session.knowledge?.fallback !== fallback || session.knowledge?.tree !== undefined) {
    session.knowledge = { version, source: dir, loadedAt: new Date().toISOString(), ...(fallback ? { fallback } : {}) };
    await saveSession(session);
  }
  return { version, source: dir, l0, dir };
}

/** The prompt block: preamble, the L0 defaults, and where the deeper pages are. */
export function renderCapabilityIndex(l0: string, live = false): string {
  return live
    ? ["Service knowledge (CrowdCode's capability tree, rebuilt nightly from verified purchases and daily probes):",
      l0.trim(),
      "browse_services(<node>) reads a node; do so before find_paid_service for an unfamiliar capability."].join("\n")
    : [
      "Service knowledge base (derived from CrowdCode reviews of real paid calls):",
      l0.trim(),
      "Deeper notes per capability live in the session artifact folder knowledge/ — knowledge/INDEX.md lists the category files; read_file the relevant one (e.g. knowledge/categories/<name>.md) before calling find_paid_service for an unfamiliar capability."
    ].join("\n");
}

async function readVersion(dir: string, l0: string): Promise<string> {
  try {
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as { content_hash?: string; id?: string };
    if (typeof meta.content_hash === "string" && meta.content_hash) {
      return meta.id ? `${meta.id}@${meta.content_hash}` : meta.content_hash;
    }
  } catch {
    // no metadata: fall through to a content hash of L0
  }
  const { createHash } = await import("node:crypto");
  return `l0-${createHash("sha256").update(l0).digest("hex").slice(0, 16)}`;
}

async function currentVersion(target: string): Promise<string | undefined> {
  try {
    return (await readFile(join(target, VERSION_FILE), "utf8")).trim();
  } catch {
    return undefined;
  }
}
