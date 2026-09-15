import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSession, type SessionState } from "@opencrowd/core";

/**
 * Service knowledge tree: a CrowdCode-derived, progressively disclosed
 * memory of which paid services to use and when not to buy.
 *
 *   L0.md               -> system prompt (replaces the static capability line)
 *   INDEX.md, categories -> artifacts/knowledge/ (read on demand)
 *
 * Resolution order: OPENCROWD_KNOWLEDGE_DIR ("none" disables), then the
 * snapshot bundled with this package (the best tree from the last
 * evolution run). The loaded version is recorded on the session so runs
 * are reproducible. The daily-refresh design (fetch a versioned snapshot
 * from CrowdCode) is documented in design-docs; this loader is the seam.
 */

export interface LoadedKnowledge {
  version: string;
  source: string;
  l0: string;
  dir: string;
}

export interface KnowledgeOptions {
  /** Explicit tree directory; overrides the environment and the bundled snapshot. */
  dir?: string;
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
 * Load the tree, copy it under the session's artifacts (so read_file can
 * reach category pages), and record the version on the session. Returns
 * undefined when no tree is configured or the directory has no L0.md.
 */
export async function loadKnowledgeTree(session: SessionState, options: KnowledgeOptions = {}): Promise<LoadedKnowledge | undefined> {
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
  if (session.knowledge?.version !== version || session.knowledge?.source !== dir) {
    session.knowledge = { version, source: dir, loadedAt: new Date().toISOString() };
    await saveSession(session);
  }
  return { version, source: dir, l0, dir };
}

/** The prompt block: preamble, the L0 defaults, and the pointer to the on-demand pages. */
export function renderCapabilityIndex(l0: string): string {
  return [
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
