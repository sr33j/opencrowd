import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { LlmProvider } from "@opencrowd/agent-runtime";
import type { EvidenceBundle } from "./evidence.js";

/**
 * Knowledge tree: a three-level, progressively disclosed service memory
 * generated from CrowdCode review evidence.
 *
 *   L0.md               defaults block injected into the system prompt
 *   INDEX.md            category -> file map (read on demand)
 *   categories/<x>.md   ranked services, price observations, gotchas
 *
 * The proposer is an LLM; everything around it is deterministic: evidence
 * ranking, validation (size budgets, no hallucinated origins, no unproven
 * services in L0, no secrets), lineage metadata, and content hashing.
 */

export type TreeFiles = Record<string, string>;

export interface TreeMeta {
  id: string;
  generation: number;
  parent?: string;
  created_at: string;
  proposer_model?: string;
  directive?: string;
  evidence_hash: string;
  content_hash: string;
  notes?: string;
  validation?: TreeValidation;
  /** Filled in after evaluation. */
  scores?: Record<string, unknown>;
}

export interface TreeValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: { files: number; l0_tokens: number; total_tokens: number; referenced_services: number; unknown_origins: string[] };
}

export const L0_MAX_TOKENS = 900;
export const CATEGORY_MAX_TOKENS = 1800;
const REQUIRED_FILES = ["L0.md", "INDEX.md"];

/** Public, free origins the tree may mention as local alternatives. */
const FREE_ORIGIN_ALLOWLIST = new Set([
  "https://api.open-meteo.com", "https://geocoding-api.open-meteo.com", "https://nominatim.openstreetmap.org",
  "https://rxnav.nlm.nih.gov", "https://www.youtube.com", "https://api.github.com", "https://en.wikipedia.org",
  "https://api.coingecko.com", "https://api.frankfurter.app", "https://efts.sec.gov", "https://www.sec.gov",
  "https://dns.google", "https://api.exchangerate.host", "https://data.sec.gov", "https://r.jina.ai",
  "https://wttr.in", "https://ipinfo.io", "https://api.duckduckgo.com", "https://html.duckduckgo.com"
]);

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function hashContent(value: string | TreeFiles): string {
  const text = typeof value === "string"
    ? value
    : Object.keys(value).sort().map((name) => `${name}\n${value[name]}`).join("\n ");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function validateTree(tree: TreeFiles, evidence: EvidenceBundle): TreeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const required of REQUIRED_FILES) {
    if (!tree[required] || tree[required].trim().length === 0) {
      errors.push(`missing ${required}`);
    }
  }
  const knownOrigins = new Set(evidence.services.map((service) => service.origin));
  const unprovenOrigins = new Set(evidence.services.filter((service) => service.unproven).map((service) => service.origin));
  const provenOrigins = new Set(evidence.services.filter((service) => !service.unproven).map((service) => service.origin));
  const unknownOrigins = new Set<string>();
  let referenced = 0;
  let totalTokens = 0;

  for (const [name, content] of Object.entries(tree)) {
    totalTokens += approxTokens(content);
    if (!/^(L0\.md|INDEX\.md|categories\/[a-z0-9-]+\.md)$/.test(name)) {
      errors.push(`unexpected file ${name} (allowed: L0.md, INDEX.md, categories/<slug>.md)`);
    }
    if (/(0x[a-fA-F0-9]{64}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|hf_[A-Za-z0-9]{20,})/.test(content)) {
      errors.push(`${name} contains a secret-looking token`);
    }
    const urls = content.match(/https?:\/\/[^\s"'<>)\]`]+/g) ?? [];
    for (const raw of urls) {
      const url = raw.replace(/[.,;:]+$/, "");
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        continue;
      }
      if (knownOrigins.has(origin)) {
        referenced += 1;
        if (name === "L0.md" && unprovenOrigins.has(origin) && !provenOrigins.has(origin)) {
          errors.push(`L0.md references unproven service ${origin}`);
        }
      } else if (!FREE_ORIGIN_ALLOWLIST.has(origin)) {
        unknownOrigins.add(origin);
        if (name === "L0.md") {
          errors.push(`L0.md references an origin absent from CrowdCode evidence: ${origin}`);
        }
      }
    }
    if (name === "L0.md" && approxTokens(content) > L0_MAX_TOKENS) {
      errors.push(`L0.md is ${approxTokens(content)} tokens (max ${L0_MAX_TOKENS})`);
    }
    if (name.startsWith("categories/") && approxTokens(content) > CATEGORY_MAX_TOKENS) {
      warnings.push(`${name} is ${approxTokens(content)} tokens (max ${CATEGORY_MAX_TOKENS})`);
    }
  }
  if (tree["INDEX.md"]) {
    const linked = [...tree["INDEX.md"].matchAll(/categories\/[a-z0-9-]+\.md/g)].map((match) => match[0]);
    for (const link of new Set(linked)) {
      if (!tree[link]) {
        errors.push(`INDEX.md links to missing ${link}`);
      }
    }
    for (const name of Object.keys(tree)) {
      if (name.startsWith("categories/") && !linked.includes(name)) {
        warnings.push(`${name} is not linked from INDEX.md`);
      }
    }
  }
  if (unknownOrigins.size > 0) {
    warnings.push(`origins not in evidence (allowed outside L0, but unverified): ${[...unknownOrigins].slice(0, 12).join(", ")}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      files: Object.keys(tree).length,
      l0_tokens: approxTokens(tree["L0.md"] ?? ""),
      total_tokens: totalTokens,
      referenced_services: referenced,
      unknown_origins: [...unknownOrigins]
    }
  };
}

export async function writeTree(dir: string, tree: TreeFiles, meta: TreeMeta): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(tree)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export async function readTree(dir: string): Promise<{ tree: TreeFiles; meta?: TreeMeta }> {
  const tree: TreeFiles = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(".md")) {
        tree[relative(dir, path)] = await readFile(path, "utf8");
      }
    }
  };
  await walk(dir);
  let meta: TreeMeta | undefined;
  try {
    meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as TreeMeta;
  } catch {
    meta = undefined;
  }
  return { tree, meta };
}

export async function updateTreeMeta(dir: string, patch: Partial<TreeMeta>): Promise<void> {
  const { meta } = await readTree(dir);
  await writeFile(join(dir, "meta.json"), `${JSON.stringify({ ...(meta ?? {}), ...patch }, null, 2)}\n`, "utf8");
}

export interface FailureCase {
  task_id: string;
  question: string;
  expected: string;
  answer?: string;
  correct: boolean;
  cost_cents?: number;
  turns?: number;
  paid_calls?: number;
  unnecessary_purchase?: boolean;
  /** Compact tool trace, e.g. "find_paid_service(query=geocode) -> inspect_paid_service(url) -> call_paid_service -> complete_session". */
  tool_trace?: string;
}

export interface ProposeOptions {
  provider: LlmProvider;
  model: string;
  evidence: EvidenceBundle;
  /** Rendered evidence digest (renderEvidenceDigest). */
  digest: string;
  parent?: { tree: TreeFiles; meta?: TreeMeta };
  /** Held-in eval outcomes for the parent (weakness mining). Never pass held-out tasks. */
  cases?: FailureCase[];
  /** Free-form steering for this proposal (diversity: e.g. "favor cheap free alternatives"). */
  directive?: string;
  log?: (message: string) => void;
}

export interface Proposal {
  tree: TreeFiles;
  rawResponse: string;
  changed_files: string[];
}

const PROPOSER_SYSTEM = [
  "You write and maintain a compact service knowledge base for a budget-conscious tool-using agent (OpenCrowd).",
  "The agent has: local files, shell (curl/python), and paid x402/MPP services it can buy through find_paid_service -> inspect_paid_service -> call_paid_service -> review_paid_service. Each LLM turn costs money, so the knowledge base exists to let the agent pick the right path in ONE turn instead of searching.",
  "Ground every claim in the CrowdCode evidence you are given (scores, effective review counts, raw review reasons). Cite review ids like svc_x#r2 in category pages. Never invent services, endpoints, or prices. Only endpoints present in the evidence may appear in L0.md; free public alternatives may be mentioned in category pages when you are confident they exist.",
  "Structure (return ONLY a JSON object mapping file name -> markdown content):",
  "- L0.md (<= 800 tokens): the defaults block that goes into the system prompt. Ordered by how often agents actually need the capability. For each: capability -> exact endpoint -> one-line how-to (method, key body fields) -> typical price -> score/evidence strength -> when NOT to buy (local/free path). Start with a 2-3 line policy: prefer local/free when sufficient; buy when it saves turns; inspect exact schema before paying.",
  "- INDEX.md: one line per category: `- <capability keywords> -> categories/<slug>.md`.",
  "- categories/<slug>.md (<= 1500 tokens each): ranked services for that capability with endpoint, rail (x402 base / mppx tempo), observed price, score & n_eff, what reviewers said worked and failed (cite ids), request-shape gotchas, and the cheapest correct path including free alternatives.",
  "Be specific and terse. Markdown lists, no prose paragraphs. Do not include wallet addresses, keys, or payment proofs."
].join("\n");

export async function proposeTree(options: ProposeOptions): Promise<Proposal> {
  const log = options.log ?? (() => undefined);
  const sections: string[] = [];
  sections.push(`## CrowdCode evidence\n${options.digest}`);
  if (options.parent) {
    sections.push(`## Current knowledge base (parent)\n${Object.entries(options.parent.tree)
      .map(([name, content]) => `### FILE ${name}\n${content}`).join("\n\n")}`);
  }
  if (options.cases && options.cases.length > 0) {
    const rendered = options.cases.map((entry) => [
      `- ${entry.task_id} [${entry.correct ? "correct" : "WRONG"}${entry.unnecessary_purchase ? ", UNNECESSARY PURCHASE" : ""}] cost ${((entry.cost_cents ?? 0) / 100).toFixed(3)} USD, ${entry.turns ?? "?"} turns, ${entry.paid_calls ?? 0} paid`,
      `  task: ${compact(entry.question, 240)}`,
      `  expected: ${compact(entry.expected, 80)} | answer: ${compact(entry.answer ?? "(none)", 120)}`,
      entry.tool_trace ? `  trace: ${compact(entry.tool_trace, 400)}` : ""
    ].filter(Boolean).join("\n")).join("\n");
    sections.push([
      "## Held-in evaluation results with the parent knowledge base",
      "Each case: task, expected vs. the agent's answer, cost, turns, paid calls, and the tool trace. Failures and expensive successes are the weaknesses to fix; unnecessary purchases (paid on a task local tools could solve) are also failures.",
      rendered
    ].join("\n"));
  }
  const instruction = options.parent
    ? [
      "Propose an improved knowledge base. Make targeted edits: fix what the evaluation shows is wrong, missing, or too expensive; keep what works. Return the COMPLETE set of files (every file you want to exist), not a diff. Keep L0.md within budget; move detail into category pages.",
      options.directive ? `Directive for this proposal: ${options.directive}` : "",
      "Remember: the evaluation tasks above are examples of the kind of work agents do; generalize (cover the capability class), do not hard-code answers to those specific tasks."
    ].filter(Boolean).join("\n")
    : [
      "Write the initial knowledge base from the evidence. Prioritize by real demand: what tasks reviewers were doing (task contexts), which capabilities have the most verified successful reviews, and the obvious defaults (best LLM gateway for agent inference, best web search, best page extraction, best image generation, weather/geocoding, file hosting, social data, finance/crypto data). Include one category page per capability class you can support with evidence, plus a page for free-first capabilities (things curl/python can do without paying).",
      options.directive ? `Directive for this proposal: ${options.directive}` : ""
    ].filter(Boolean).join("\n");
  sections.push(`## Task\n${instruction}\nReturn only the JSON object.`);

  const userContent = sections.join("\n\n");
  log(`proposing tree with ${options.model} (~${approxTokens(userContent)} input tokens)`);
  const response = await options.provider.complete([
    { role: "system", content: PROPOSER_SYSTEM },
    { role: "user", content: userContent }
  ]);
  const tree = parseTreeJson(response.content);
  const changed = options.parent
    ? Object.keys(tree).filter((name) => tree[name] !== options.parent?.tree[name])
    : Object.keys(tree);
  return { tree, rawResponse: response.content, changed_files: changed };
}

export function parseTreeJson(text: string): TreeFiles {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("proposer returned no JSON object");
  }
  const parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
  const tree: TreeFiles = {};
  for (const [name, content] of Object.entries(parsed)) {
    if (typeof content === "string") {
      tree[name.replace(/^\.?\//, "")] = content;
    }
  }
  if (Object.keys(tree).length === 0) {
    throw new Error("proposer JSON contained no files");
  }
  return tree;
}

function compact(value: string, maxLength: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= maxLength ? single : `${single.slice(0, maxLength - 1)}...`;
}
