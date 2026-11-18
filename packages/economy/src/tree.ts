import { readFile } from "node:fs/promises";
import { atomicWrite, type ToolResult } from "@opencrowd/core";
import { withDeadline } from "@opencrowd/protocol";

/**
 * CrowdCode's public, read-only API as the agent uses it before paying:
 * the capability tree (contract C7) and each endpoint's reliability state
 * (contract C3). Every call is bounded and every failure is an ordinary
 * answer, never an exception: a run must not wait on, or fail because of,
 * advice about which service to buy.
 */

export const DEFAULT_CROWDCODE_API = "https://crowdcode-backend.onrender.com";
/**
 * One attempt at the tree at session start. Two seconds was not enough: on
 * 2026-11-17 at 23:45 a run's fetch landed while the backend's new instance
 * was still warming its search index (p95 latency 165 s for that minute) and
 * the run went out on the September snapshot.
 */
export const TREE_FETCH_DEADLINE_MS = 4_000;
/** Attempts per fetch: the first and one retry, so a run waits at most about 8.3 s. */
const TREE_FETCH_ATTEMPTS = 2;
const TREE_RETRY_DELAY_MS = 300;
/**
 * The tree changes at most nightly. One copy per process per hour keeps the
 * system prompt byte-identical across a chat's runs, so prompt caching holds.
 */
export const TREE_CACHE_MS = 60 * 60_000;
/** A failed fetch is not retried for a minute: each session start would otherwise pay the full deadline. */
const TREE_FAILURE_CACHE_MS = 60_000;
const NODE_DEADLINE_MS = 10_000;
/** The gateway caches verdicts for five minutes too (C4); the agent's view should not be fresher than what pays. */
const RELIABILITY_CACHE_MS = 5 * 60_000;
const RELIABILITY_DEADLINE_MS = 4_000;
/** A reason is a sentence; the agent needs the first one to know why, not every number behind it. */
const REASON_MAX_CHARS = 120;

export type ReliabilityState = "reliable" | "unverified" | "unreliable";

export interface Reliability {
  state: ReliabilityState;
  /** C3's first reason, the one that decides the state. */
  reason?: string;
  service_id?: string;
}

export interface LiveTree {
  /** The tree's version number (C7). */
  version: number;
  builtAt?: string;
  /** The L0 rendering, at most about 800 tokens. */
  l0: string;
  /** Where it came from, for the session record. */
  source: string;
}

/** The last tree a backend served, kept on disk so a slow backend costs a day's freshness, not the tree. */
interface PersistedTree extends LiveTree {
  base: string;
  fetchedAt: string;
}

export interface CrowdCodeApiOptions {
  base?: string;
  fetcher?: typeof fetch;
}

/** `OPENCROWD_CROWDCODE_URL` points the runtime at another CrowdCode backend (staging, a local server). */
export function crowdcodeApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENCROWD_CROWDCODE_URL?.trim() || DEFAULT_CROWDCODE_API).replace(/\/+$/, "");
}

const TREE_VERSION = /^(current|candidate|\d{1,8})$/;

/**
 * The tree version a run should read: an explicit pin (a run.start field),
 * else `OPENCROWD_TREE_VERSION`, else the published `current`. W8's gate
 * pins `candidate` this way. Anything malformed is ignored, not fatal.
 */
export function treeVersionPin(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const value of [explicit, env.OPENCROWD_TREE_VERSION]) {
    const pin = value?.trim().toLowerCase();
    if (pin && TREE_VERSION.test(pin)) return pin;
  }
  return undefined;
}

const treeCache = new Map<string, { until: number; tree?: LiveTree; error?: string }>();

/** Tests only: forget every cached tree. */
export function clearTreeCache(): void {
  treeCache.clear();
  nodeCache.clear();
  reliabilityCache.clear();
}

export interface LiveTreeResult {
  tree?: LiveTree;
  /** Why the backend's answer was not used; with `tree`, the tree is the last one served, read from disk. */
  error?: string;
  /** When `tree` is a persisted copy: when it was fetched. */
  staleSince?: string;
}

/**
 * `GET /api/tree`: one attempt of `timeoutMs`, then one retry. Never rejects.
 *
 * The answer is kept for an hour in memory and, given `persistPath`, on disk:
 * a hosted agent's worker is a new process on every wake, so the disk copy is
 * what spares each run a fetch, and what a run falls back to when the backend
 * is slow (stale-if-error), instead of the bundled snapshot. Only the
 * published (`current`) tree is persisted; a run pinned to a version (W8's
 * gate, `fresh`) neither reads nor writes either cache.
 */
export async function fetchLiveTree(options: CrowdCodeApiOptions & {
  version?: string;
  timeoutMs?: number;
  now?: () => number;
  /** Neither read nor write the caches: a run pinned to a version (W8's gate) reads exactly that version, now. */
  fresh?: boolean;
  /** Where the last tree served is kept (the agent's volume). */
  persistPath?: string;
  /** Tests: the pause before the retry. */
  retryDelayMs?: number;
} = {}): Promise<LiveTreeResult> {
  const base = (options.base ?? crowdcodeApiBase()).replace(/\/+$/, "");
  const version = options.version ?? "current";
  const now = options.now ?? Date.now;
  const key = `${base} ${version}`;
  const persist = !options.fresh && version === "current" ? options.persistPath : undefined;
  const cached = options.fresh ? undefined : treeCache.get(key);
  if (cached?.tree && cached.until > now()) return { tree: cached.tree };
  const stored = persist ? await readPersistedTree(persist, base) : undefined;
  if (stored && now() - Date.parse(stored.fetchedAt) < TREE_CACHE_MS) {
    const tree = liveTree(stored);
    treeCache.set(key, { until: Date.parse(stored.fetchedAt) + TREE_CACHE_MS, tree });
    return { tree };
  }
  let error = cached?.error && cached.until > now() ? cached.error : undefined;
  if (!error) {
    const fetched = await fetchTreeWithRetry(base, version, options);
    if (fetched.tree) {
      if (!options.fresh) treeCache.set(key, { until: now() + TREE_CACHE_MS, tree: fetched.tree });
      if (persist) await atomicWrite(persist, JSON.stringify({ ...fetched.tree, base, fetchedAt: new Date(now()).toISOString() } satisfies PersistedTree))
        .catch(() => undefined);
      return { tree: fetched.tree };
    }
    error = fetched.error!;
    if (!options.fresh) treeCache.set(key, { until: now() + TREE_FAILURE_CACHE_MS, error });
  }
  return stored ? { tree: liveTree(stored), error, staleSince: stored.fetchedAt } : { error };
}

async function fetchTreeWithRetry(base: string, version: string, options: { fetcher?: typeof fetch; timeoutMs?: number; retryDelayMs?: number }):
  Promise<{ tree?: LiveTree; error?: string }> {
  const timeoutMs = options.timeoutMs ?? TREE_FETCH_DEADLINE_MS;
  const url = `${base}/api/tree${version === "current" ? "" : `?version=${encodeURIComponent(version)}`}`;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= TREE_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? TREE_RETRY_DELAY_MS));
    try {
      const body = await withDeadline(async () => {
        const response = await (options.fetcher ?? fetch)(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json() as Record<string, unknown>;
      }, timeoutMs, "CrowdCode capability tree");
      const number = typeof body.version === "number" ? body.version : Number(body.version);
      const l0 = typeof body.l0 === "string" ? body.l0.trim() : "";
      if (!Number.isInteger(number) || number < 0 || !l0) throw new Error("the answer had no version or no l0");
      return { tree: { version: number, l0, source: `${base}/api/tree`, ...(typeof body.built_at === "string" ? { builtAt: body.built_at } : {}) } };
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  return { error: `CrowdCode capability tree unavailable after ${TREE_FETCH_ATTEMPTS} attempts of ${Math.round(timeoutMs / 1000)} s: ${[...new Set(failures)].join("; ")}` };
}

async function readPersistedTree(path: string, base: string): Promise<PersistedTree | undefined> {
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedTree>;
    return stored.base === base && Number.isInteger(stored.version) && typeof stored.l0 === "string" && stored.l0
      && typeof stored.source === "string" && typeof stored.fetchedAt === "string" && !Number.isNaN(Date.parse(stored.fetchedAt))
      ? stored as PersistedTree : undefined;
  } catch {
    return undefined;
  }
}

const liveTree = ({ version, l0, source, builtAt }: LiveTree): LiveTree => ({ version, l0, source, ...(builtAt ? { builtAt } : {}) });

const NODE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const nodeCache = new Map<string, { until: number; result: ToolResult }>();

/** The ids an agent can start from (C7, as built), for an unknown-node answer. */
const TOP_NODES = "free-first, search, extraction, llm, image, video, audio, email, phone, social, finance, business, travel, files, developer";

/** `GET /api/tree/{node}`: one node or leaf, at most about 600 tokens, as the text the agent reads. */
export async function browseTreeNode(node: unknown, options: CrowdCodeApiOptions & { version?: number | string } = {}): Promise<ToolResult> {
  const id = typeof node === "string" ? node.trim().toLowerCase() : "";
  if (!NODE_ID.test(id)) return { ok: false, error: `browse_services needs a node id, for example search, image or search.all. Top nodes: ${TOP_NODES}.` };
  const base = (options.base ?? crowdcodeApiBase()).replace(/\/+$/, "");
  const version = options.version === undefined ? undefined : String(options.version);
  const key = `${base} ${version ?? "current"} ${id}`;
  const cached = nodeCache.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  const url = `${base}/api/tree/${encodeURIComponent(id)}${version && version !== "current" ? `?version=${encodeURIComponent(version)}` : ""}`;
  try {
    const { status, body } = await withDeadline(async () => {
      const response = await (options.fetcher ?? fetch)(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(NODE_DEADLINE_MS) });
      return { status: response.status, body: await response.json().catch(() => undefined) as Record<string, unknown> | undefined };
    }, NODE_DEADLINE_MS, "CrowdCode capability tree");
    if (status === 404) return { ok: false, error: `No tree node "${id}". Top nodes: ${TOP_NODES}; leaves are <node>.<slug>, listed by their node.` };
    const text = typeof body?.text === "string" ? body.text : undefined;
    if (status >= 400 || !text) return { ok: false, error: `The capability tree is unavailable (HTTP ${status}); use find_paid_service instead.` };
    const result: ToolResult = { ok: true, data: { version: body!.version, id: body!.id ?? id, text } };
    nodeCache.set(key, { until: Date.now() + TREE_CACHE_MS, result });
    return result;
  } catch (error) {
    return { ok: false, error: `The capability tree is unavailable (${(error as Error).message}); use find_paid_service instead.` };
  }
}

const reliabilityCache = new Map<string, { until: number; value?: Reliability }>();

/**
 * One endpoint's C3 state and first reason, resolved the way the gateway
 * resolves it (origin and path, no query string). Undefined when CrowdCode
 * cannot say; the caller shows nothing rather than guess a state.
 */
export async function lookupReliability(url: string, method: string | undefined, options: CrowdCodeApiOptions = {}): Promise<Reliability | undefined> {
  let route: string;
  try {
    const parsed = new URL(url);
    route = `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
  const verb = (method ?? "POST").toUpperCase();
  const base = (options.base ?? crowdcodeApiBase()).replace(/\/+$/, "");
  const key = `${base} ${verb} ${route}`;
  const cached = reliabilityCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  let value: Reliability | undefined;
  try {
    const body = await withDeadline(async () => {
      const response = await (options.fetcher ?? fetch)(`${base}/api/reliability?url=${encodeURIComponent(route)}&method=${encodeURIComponent(verb)}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(RELIABILITY_DEADLINE_MS) });
      return response.ok ? await response.json() as Record<string, unknown> : undefined;
    }, RELIABILITY_DEADLINE_MS, "CrowdCode reliability");
    const state = body?.state;
    if (state === "reliable" || state === "unverified" || state === "unreliable") {
      const first = Array.isArray(body!.reasons) ? body!.reasons.find((reason): reason is string => typeof reason === "string" && reason !== "") : undefined;
      value = { state, ...(first ? { reason: capReason(first) } : {}),
        ...(typeof body!.service_id === "string" ? { service_id: body!.service_id } : {}) };
    }
  } catch {
    value = undefined;
  }
  // An unanswered lookup is retried sooner than an answered one.
  reliabilityCache.set(key, { until: Date.now() + (value ? RELIABILITY_CACHE_MS : 30_000), value });
  return value;
}

/** The timestamp in "(latest 2026-11-17 01:23 UTC)" is for the reliability page, not for choosing. */
const capReason = (text: string) => {
  const reason = text.replace(/\s*\(latest [^)]*\)/g, "");
  return reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS - 1)}…` : reason;
};

/** What the spending guard does with a state, in the agent's terms (C4). */
export function reliabilityNote(state: ReliabilityState): string {
  return state === "reliable" ? "pays automatically within the owner's caps"
    : state === "unverified" ? "the owner may be asked to approve the payment"
      : "refused before payment";
}

/** The seam the economy gateway reads CrowdCode's tree and reliability through. */
export interface CrowdCodeApi {
  browse(node: unknown, version?: number | string): Promise<ToolResult>;
  reliability(url: string, method?: string): Promise<Reliability | undefined>;
}

export function createCrowdCodeApi(options: CrowdCodeApiOptions = {}): CrowdCodeApi {
  return {
    browse: (node, version) => browseTreeNode(node, { ...options, version }),
    reliability: (url, method) => lookupReliability(url, method, options)
  };
}
