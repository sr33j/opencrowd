import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ensureGaiaAttachments, fetchGaiaValidation, isUnsupportedModality, type GaiaQuestion } from "./gaia.js";

/**
 * Generalized eval tasks. Three suites:
 *  - gaia-hard: seeded sample of GAIA level 2/3 validation questions (held-out)
 *  - assistantbench: seeded sample of the AssistantBench dev split (held-out)
 *  - usage: real-usage tasks derived from CrowdCode demand (held-in)
 * "Held-in" tasks may inform the knowledge-tree proposer; held-out tasks never do.
 */

export type ScorerSpec =
  | { type: "gaia" }
  | { type: "assistantbench" }
  | { type: "contains_all"; terms: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "url_content"; contains: string }
  | { type: "artifact"; names: string[]; min_bytes?: number; image?: boolean; contains_all?: string[] }
  | { type: "dns_a"; hostname: string };

export interface EvalTask {
  /** Stable id; GAIA uses the official task_id. */
  task_id: string;
  suite: "gaia-hard" | "assistantbench" | "usage";
  question: string;
  expected: string;
  scorer: ScorerSpec;
  held_out: boolean;
  /** GAIA level or AssistantBench difficulty mapped to 1-3. */
  level?: number;
  capability?: string;
  /** Whether a paid service is expected: yes / no (local suffices) / optional. */
  expect_paid?: "yes" | "no" | "optional";
  file_name?: string;
  file_path?: string;
}

export const TASK_SETS = {
  usage: "15 real-usage tasks (held-in)",
  "gaia-hard": "15 seeded GAIA level 2/3 questions (held-out)",
  assistantbench: "10 seeded AssistantBench dev tasks (held-out)",
  heldin: "usage",
  heldout: "gaia-hard + assistantbench",
  all: "usage + gaia-hard + assistantbench (40 tasks)"
} as const;

export type TaskSetName = keyof typeof TASK_SETS;

export const DEFAULT_SEED = "opencrowd-evals-2026-09";
const GAIA_HARD_COUNT = 15;
const ASSISTANTBENCH_COUNT = 10;

export interface LoadTaskOptions {
  hfToken?: string;
  seed?: string;
  log?: (message: string) => void;
}

export async function loadTaskSet(name: TaskSetName, options: LoadTaskOptions = {}): Promise<EvalTask[]> {
  switch (name) {
    case "usage":
      return loadUsageTasks();
    case "gaia-hard":
      return loadGaiaHard(options);
    case "assistantbench":
      return loadAssistantBench(options);
    case "heldin":
      return loadUsageTasks();
    case "heldout":
      return [...await loadGaiaHard(options), ...await loadAssistantBench(options)];
    case "all":
      return [...await loadUsageTasks(), ...await loadGaiaHard(options), ...await loadAssistantBench(options)];
    default:
      throw new Error(`unknown task set: ${String(name)} (supported: ${Object.keys(TASK_SETS).join(", ")})`);
  }
}

function tasksDir(): string {
  // packages/evals/src or packages/evals/dist -> packages/evals/tasks
  return join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");
}

export async function loadUsageTasks(): Promise<EvalTask[]> {
  const raw = JSON.parse(await readFile(join(tasksDir(), "usage.json"), "utf8")) as {
    tasks: Array<Record<string, unknown>>;
  };
  return raw.tasks.map((task) => ({
    task_id: String(task.id),
    suite: "usage" as const,
    question: String(task.question),
    expected: String(task.expected),
    scorer: task.scorer as ScorerSpec,
    held_out: false,
    level: 1,
    capability: typeof task.capability === "string" ? task.capability : undefined,
    expect_paid: task.expect_paid as EvalTask["expect_paid"],
    file_name: typeof task.attachment === "string" ? task.attachment : undefined,
    file_path: typeof task.attachment === "string" ? join(tasksDir(), "attachments", task.attachment) : undefined
  }));
}

export async function loadGaiaHard(options: LoadTaskOptions = {}): Promise<EvalTask[]> {
  const questions = await fetchGaiaValidation({ hfToken: options.hfToken, log: options.log });
  const eligible = questions.filter((question) => question.level >= 2 && !isUnsupportedModality(question.file_name));
  const selected = seededSample(eligible, GAIA_HARD_COUNT, `${options.seed ?? DEFAULT_SEED}:gaia-hard`, (q) => q.task_id);
  await ensureGaiaAttachments(selected, { hfToken: options.hfToken, log: options.log });
  return selected.map((question) => gaiaToTask(question));
}

export function gaiaToTask(question: GaiaQuestion): EvalTask {
  return {
    task_id: question.task_id,
    suite: "gaia-hard",
    question: question.question,
    expected: question.final_answer,
    scorer: { type: "gaia" },
    held_out: true,
    level: question.level,
    capability: "web-research",
    expect_paid: "optional",
    file_name: question.file_name,
    file_path: question.file_path
  };
}

const ASSISTANTBENCH_ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=AssistantBench%2FAssistantBench&config=default&split=validation&offset=0&length=100";

export function defaultAssistantBenchCachePath(): string {
  return process.env.OPENCROWD_ASSISTANTBENCH_CACHE ?? join(homedir(), ".cache", "opencrowd", "assistantbench", "validation.jsonl");
}

export async function loadAssistantBench(options: LoadTaskOptions = {}): Promise<EvalTask[]> {
  const cachePath = defaultAssistantBenchCachePath();
  let text: string;
  try {
    text = await readFile(cachePath, "utf8");
  } catch {
    options.log?.(`fetching ${ASSISTANTBENCH_ROWS_URL}`);
    const headers: Record<string, string> = options.hfToken ? { authorization: `Bearer ${options.hfToken}` } : {};
    const response = await fetch(ASSISTANTBENCH_ROWS_URL, { headers });
    if (!response.ok) {
      throw new Error(`AssistantBench fetch failed: ${response.status} ${response.statusText}`);
    }
    const body = await response.json() as { rows?: Array<{ row?: Record<string, unknown> }> };
    text = `${(body.rows ?? []).map((item) => JSON.stringify(item.row)).join("\n")}\n`;
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, text, "utf8");
  }
  const rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const selected = seededSample(rows, ASSISTANTBENCH_COUNT, `${options.seed ?? DEFAULT_SEED}:assistantbench`, (row) => String(row.id));
  return selected.map((row) => ({
    task_id: `ab-${String(row.id).slice(0, 12)}`,
    suite: "assistantbench" as const,
    question: String(row.task),
    expected: String(row.answer),
    scorer: { type: "assistantbench" as const },
    held_out: true,
    level: String(row.difficulty).toLowerCase() === "hard" ? 3 : String(row.difficulty).toLowerCase() === "medium" ? 2 : 1,
    capability: "web-research",
    expect_paid: "optional" as const
  }));
}

/** Deterministic sample: sort by sha256(seed + key) and take the first n. */
export function seededSample<T>(items: T[], count: number, seed: string, key: (item: T) => string): T[] {
  return [...items]
    .map((item) => ({ item, hash: createHash("sha256").update(`${seed}:${key(item)}`).digest("hex") }))
    .sort((left, right) => left.hash.localeCompare(right.hash))
    .slice(0, count)
    .map((entry) => entry.item);
}

/** Shared prompt template so every harness answers under identical instructions. */
export function taskPrompt(task: EvalTask): string {
  const listRule = task.suite === "assistantbench"
    ? "If the answer is a list of items, separate the items with semicolons. If the answer is a number, give the number only (no units or currency symbols unless asked)."
    : [
      "YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers and/or strings.",
      "If you are asked for a number, don't use commas or units such as $ or % unless specified otherwise.",
      "If you are asked for a string, don't use articles or abbreviations (e.g. for cities), and write digits in plain text unless specified otherwise.",
      "If you are asked for a comma separated list, apply the above rules to each element."
    ].join("\n");
  return [
    "You are being evaluated on a benchmark task.",
    "Complete the task below using whatever tools you have. Be economical: prefer local computation when it is sufficient, and buy a paid capability when it is the fastest reliable path.",
    "Finish your reply with a line of exactly this form: FINAL ANSWER: [YOUR FINAL ANSWER]",
    listRule,
    "",
    `Task: ${task.question}`
  ].join("\n");
}
