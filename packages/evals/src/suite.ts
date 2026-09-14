import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveHarness, type HarnessRun } from "./harnesses.js";
import { scoreTask } from "./scoring.js";
import { loadTaskSet, taskPrompt, type EvalTask, type TaskSetName } from "./tasks.js";

/**
 * Generic suite runner: one task set x one harness x one optional knowledge
 * tree. Every row records accuracy, on-chain cost split by LLM/services,
 * turns, and paid-call counts so a change can be placed on the
 * quality-vs-cost frontier rather than judged on accuracy alone.
 */

export interface SuiteRunOptions {
  set: TaskSetName;
  /** Explicit task list (overrides `set` loading, e.g. the evolve loop). */
  tasks?: EvalTask[];
  harness?: string;
  /** Where run directories are created: <resultsRoot>/<runId>/ */
  resultsRoot: string;
  /** Human label stored with the run (e.g. "baseline", "tree-gen2-c1"). */
  tag?: string;
  knowledgeDir?: string;
  hfToken?: string;
  model?: string;
  subagentModel?: string;
  auto?: boolean;
  maxTurns?: number;
  parallel?: number;
  limit?: number;
  /** Restrict to these task ids. */
  only?: string[];
  seed?: string;
  log?: (message: string) => void;
}

export interface SuiteResultRow {
  run_id: string;
  tag?: string;
  harness: string;
  suite: EvalTask["suite"];
  task_id: string;
  level?: number;
  capability?: string;
  expect_paid?: EvalTask["expect_paid"];
  question: string;
  expected: string;
  answer?: string;
  score: number;
  correct: boolean;
  score_detail?: string;
  turns?: number;
  wall_time_ms: number;
  cost_cents?: number;
  llm_cost_cents?: number;
  service_cost_cents?: number;
  paid_calls?: number;
  /** Paid call on a task where local tools clearly sufficed. */
  unnecessary_purchase: boolean;
  model_policy?: unknown;
  trajectory_path?: string;
  compliance?: unknown;
  error?: string;
}

export interface SuiteSummary {
  tasks: number;
  answered: number;
  correct: number;
  accuracy: number;
  mean_score: number;
  total_cost_cents: number;
  mean_cost_cents: number;
  llm_cost_cents: number;
  service_cost_cents: number;
  mean_turns: number;
  paid_calls: number;
  unnecessary_purchases: number;
  errors: number;
  /** Correct answers per dollar spent (the frontier metric). */
  correct_per_dollar: number;
  by_suite: Record<string, { tasks: number; correct: number; accuracy: number; mean_score: number; mean_cost_cents: number }>;
}

export interface SuiteReport {
  run_id: string;
  set: TaskSetName;
  tag?: string;
  harness: string;
  knowledge_dir?: string;
  model?: string;
  subagent_model?: string;
  generated_at: string;
  results_dir: string;
  summary: SuiteSummary;
  rows: SuiteResultRow[];
}

export async function runSuite(options: SuiteRunOptions): Promise<SuiteReport> {
  const log = options.log ?? (() => undefined);
  const harness = resolveHarness(options.harness ?? "opencrowd");
  let tasks = options.tasks ?? await loadTaskSet(options.set, { hfToken: options.hfToken, seed: options.seed, log });
  if (options.only && options.only.length > 0) {
    const wanted = new Set(options.only);
    tasks = tasks.filter((task) => wanted.has(task.task_id));
  }
  if (options.limit !== undefined) {
    tasks = tasks.slice(0, options.limit);
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}${options.tag ? `-${slug(options.tag)}` : ""}`;
  const resultsDir = resolve(options.resultsRoot, runId);
  await mkdir(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, "results.jsonl");
  log(`suite ${options.set}${options.tag ? ` [${options.tag}]` : ""}: ${tasks.length} tasks, knowledge=${options.knowledgeDir ?? "none"}, results in ${resultsDir}`);

  const limit = createLimiter(Math.max(1, options.parallel ?? 3));
  const rows = await Promise.all(tasks.map((task, index) => limit(async () => {
    log(`[${index + 1}/${tasks.length}] ${task.task_id} (${task.suite})`);
    const row = await runOneTask(harness.name, harness, task, resultsDir, runId, options);
    await appendFile(resultsPath, `${JSON.stringify(row)}\n`, "utf8");
    log(`  ${task.task_id}: ${row.error ? `error (${truncate(row.error, 100)})` : row.correct ? "correct" : `incorrect (${truncate(row.answer ?? "", 60)} vs ${truncate(task.expected, 40)})`}${row.cost_cents !== undefined ? `, $${(row.cost_cents / 100).toFixed(3)}` : ""}${row.turns !== undefined ? `, ${row.turns} turns` : ""}${row.paid_calls ? `, ${row.paid_calls} paid` : ""}`);
    return row;
  })));

  const report: SuiteReport = {
    run_id: runId,
    set: options.set,
    tag: options.tag,
    harness: harness.name,
    knowledge_dir: options.knowledgeDir,
    model: options.model,
    subagent_model: options.subagentModel,
    generated_at: new Date().toISOString(),
    results_dir: resultsDir,
    summary: summarize(rows),
    rows
  };
  await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(resultsDir, "report.md"), `${renderSuiteReport(report)}\n`, "utf8");
  return report;
}

async function runOneTask(
  harnessName: string,
  harness: ReturnType<typeof resolveHarness>,
  task: EvalTask,
  resultsDir: string,
  runId: string,
  options: SuiteRunOptions
): Promise<SuiteResultRow> {
  const runDir = join(resultsDir, harnessName, task.task_id);
  await mkdir(runDir, { recursive: true });
  const started = Date.now();
  let run: HarnessRun;
  try {
    run = await harness.run(task, {
      runDir,
      prompt: taskPrompt(task),
      attachmentPath: task.file_path,
      model: options.model,
      subagentModel: options.subagentModel,
      auto: options.auto,
      knowledgeDir: options.knowledgeDir,
      maxTurns: options.maxTurns,
      log: options.log ?? (() => undefined)
    });
  } catch (error) {
    run = { error: (error as Error).message };
  }
  const scored = run.error
    ? { score: 0, correct: false, detail: "harness error" }
    : await scoreTask(task, run.final_message, { artifactsDir: run.artifacts_dir });
  const paidCalls = run.paid_calls ?? 0;
  return {
    run_id: runId,
    tag: options.tag,
    harness: harnessName,
    suite: task.suite,
    task_id: task.task_id,
    level: task.level,
    capability: task.capability,
    expect_paid: task.expect_paid,
    question: task.question,
    expected: task.expected,
    answer: extractAnswer(run.final_message),
    score: scored.score,
    correct: scored.correct,
    score_detail: scored.detail,
    turns: run.turns,
    wall_time_ms: Date.now() - started,
    cost_cents: run.cost_cents,
    llm_cost_cents: run.llm_cost_cents,
    service_cost_cents: run.service_cost_cents,
    paid_calls: paidCalls,
    unnecessary_purchase: task.expect_paid === "no" && paidCalls > 0,
    model_policy: run.model_policy,
    trajectory_path: run.trajectory_path,
    compliance: run.compliance,
    error: run.error
  };
}

export function summarize(rows: SuiteResultRow[]): SuiteSummary {
  const answered = rows.filter((row) => !row.error);
  const correct = rows.filter((row) => row.correct).length;
  const cost = (row: SuiteResultRow) => row.cost_cents ?? 0;
  const totalCost = rows.reduce((sum, row) => sum + cost(row), 0);
  const bySuite: SuiteSummary["by_suite"] = {};
  for (const suite of new Set(rows.map((row) => row.suite))) {
    const suiteRows = rows.filter((row) => row.suite === suite);
    const suiteCorrect = suiteRows.filter((row) => row.correct).length;
    bySuite[suite] = {
      tasks: suiteRows.length,
      correct: suiteCorrect,
      accuracy: suiteRows.length === 0 ? 0 : suiteCorrect / suiteRows.length,
      mean_score: mean(suiteRows.map((row) => row.score)),
      mean_cost_cents: mean(suiteRows.map(cost))
    };
  }
  return {
    tasks: rows.length,
    answered: answered.length,
    correct,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    mean_score: mean(rows.map((row) => row.score)),
    total_cost_cents: totalCost,
    mean_cost_cents: mean(rows.map(cost)),
    llm_cost_cents: rows.reduce((sum, row) => sum + (row.llm_cost_cents ?? 0), 0),
    service_cost_cents: rows.reduce((sum, row) => sum + (row.service_cost_cents ?? 0), 0),
    mean_turns: mean(rows.map((row) => row.turns ?? 0)),
    paid_calls: rows.reduce((sum, row) => sum + (row.paid_calls ?? 0), 0),
    unnecessary_purchases: rows.filter((row) => row.unnecessary_purchase).length,
    errors: rows.length - answered.length,
    correct_per_dollar: totalCost === 0 ? 0 : correct / (totalCost / 100),
    by_suite: bySuite
  };
}

export function renderSuiteReport(report: SuiteReport): string {
  const s = report.summary;
  const lines = [
    `# Suite ${report.set}${report.tag ? ` [${report.tag}]` : ""} — run ${report.run_id}`,
    "",
    `- harness: ${report.harness}, model: ${report.model ?? "default"}, subagent: ${report.subagent_model ?? "default"}`,
    `- knowledge: ${report.knowledge_dir ?? "none (static capability index)"}`,
    `- tasks: ${s.tasks}, errors: ${s.errors}`,
    `- accuracy: ${s.correct}/${s.tasks} (${pct(s.accuracy)}), mean score ${s.mean_score.toFixed(3)}`,
    `- cost: $${(s.total_cost_cents / 100).toFixed(3)} total, $${(s.mean_cost_cents / 100).toFixed(3)} mean (LLM $${(s.llm_cost_cents / 100).toFixed(3)}, services $${(s.service_cost_cents / 100).toFixed(3)})`,
    `- correct per dollar: ${s.correct_per_dollar.toFixed(2)}`,
    `- mean turns: ${s.mean_turns.toFixed(1)}, paid calls: ${s.paid_calls}, unnecessary purchases: ${s.unnecessary_purchases}`,
    "",
    "| suite | tasks | correct | accuracy | mean score | mean cost |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(s.by_suite).map(([suite, entry]) => `| ${suite} | ${entry.tasks} | ${entry.correct} | ${pct(entry.accuracy)} | ${entry.mean_score.toFixed(2)} | $${(entry.mean_cost_cents / 100).toFixed(3)} |`),
    "",
    "| task | ok | score | cost | turns | paid | answer | expected |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.rows.map((row) => `| ${row.task_id} | ${row.error ? "ERR" : row.correct ? "yes" : "no"} | ${row.score.toFixed(2)} | $${((row.cost_cents ?? 0) / 100).toFixed(3)} | ${row.turns ?? "-"} | ${row.paid_calls ?? 0}${row.unnecessary_purchase ? "!" : ""} | ${cell(row.answer ?? row.error ?? "")} | ${cell(row.expected)} |`)
  ];
  return lines.join("\n");
}

function extractAnswer(finalMessage: string | undefined): string | undefined {
  const matches = [...(finalMessage ?? "").matchAll(/FINAL ANSWER:\s*(.+)/gi)];
  return matches.at(-1)?.[1]?.trim() || (finalMessage ? truncate(finalMessage, 200) : undefined);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function cell(value: string): string {
  return truncate(value.replace(/\|/g, "\\|").replace(/\s+/g, " "), 60);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}
