import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "@opencrowd/core";
import { ensureGaiaAttachments, fetchGaiaValidation, isUnsupportedModality, selectGaiaTier, type GaiaQuestion, type GaiaTier } from "./gaia.js";
import { gaiaPrompt, resolveHarness, type GaiaHarness, type HarnessRun } from "./harnesses.js";
import { extractFinalAnswer, scoreGaiaAnswer } from "./scorer.js";

export interface GaiaRunOptions {
  tier: GaiaTier;
  harnesses: string[];
  workspaceRoot: string;
  hfToken?: string;
  model?: string;
  auto?: boolean;
  testMode?: boolean;
  testSeed?: string;
  /** Cap the question count after tier selection (debugging aid). */
  limit?: number;
  /** Concurrent questions per harness. Budget/ledger writes are mutex-guarded, so parallel spend is safe. */
  parallel?: number;
  log?: (message: string) => void;
  confirm?: (message: string) => Promise<boolean>;
}

export interface GaiaResultRow {
  harness: string;
  task_id: string;
  level: number;
  question: string;
  expected: string;
  answer?: string;
  correct: boolean;
  turns?: number;
  wall_time_ms: number;
  cost_cents?: number;
  llm_cost_cents?: number;
  service_cost_cents?: number;
  estimated_cost_usd?: number;
  tokens?: { input?: number; output?: number };
  model_policy?: unknown;
  trajectory_path?: string;
  compliance?: unknown;
  error?: string;
}

export interface GaiaSkippedQuestion {
  task_id: string;
  level: number;
  reason: string;
}

export interface GaiaHarnessReport {
  name: string;
  cost_basis: "on-chain" | "estimated";
  answered: number;
  correct: number;
  accuracy: number;
  accuracy_by_level: Record<string, { answered: number; correct: number; accuracy: number }>;
  mean_cost_cents?: number;
  median_cost_cents?: number;
  mean_estimated_cost_usd?: number;
  errors: number;
}

export interface GaiaReport {
  run_id: string;
  tier: GaiaTier;
  generated_at: string;
  results_dir: string;
  selected_questions: number;
  skipped: GaiaSkippedQuestion[];
  harnesses: GaiaHarnessReport[];
  rows: GaiaResultRow[];
}

export async function runGaiaBenchmark(options: GaiaRunOptions): Promise<GaiaReport> {
  const log = options.log ?? (() => undefined);
  const harnesses = options.harnesses.map(resolveHarness);
  const questions = await fetchGaiaValidation({ hfToken: options.hfToken, log });
  let selected = selectGaiaTier(questions, options.tier);
  if (options.limit !== undefined) {
    selected = selected.slice(0, options.limit);
  }
  const skipped: GaiaSkippedQuestion[] = selected
    .filter((question) => isUnsupportedModality(question.file_name))
    .map((question) => ({
      task_id: question.task_id,
      level: question.level,
      reason: `unsupported attachment modality: ${question.file_name}`
    }));
  const runnable = selected.filter((question) => !isUnsupportedModality(question.file_name));
  await ensureGaiaAttachments(runnable, { hfToken: options.hfToken, log });

  const config = await loadConfig();
  const ceiling = await estimateGaiaCostCents(runnable.length, harnesses, config.x402LlmMaxCostCents);
  if (!options.testMode && options.confirm) {
    const proceed = await options.confirm(ceiling.message);
    if (!proceed) {
      throw new Error("GAIA run cancelled before spending");
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = resolve(options.workspaceRoot, "evals", "gaia", runId);
  await mkdir(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, "results.jsonl");
  log(`GAIA ${options.tier}: ${runnable.length} questions, ${skipped.length} skipped (unsupported modality), results in ${resultsDir}`);

  const parallel = Math.max(1, options.parallel ?? 4);
  const rows: GaiaResultRow[] = [];
  for (const harness of harnesses) {
    const limit = createLimiter(parallel);
    const harnessRows = await Promise.all(runnable.map((question, index) => limit(async () => {
      log(`[${harness.name}] ${index + 1}/${runnable.length} ${question.task_id} (level ${question.level})`);
      const row = await runOneQuestion(harness, question, resultsDir, options);
      await appendFile(resultsPath, `${JSON.stringify(row)}\n`, "utf8");
      log(`[${harness.name}] ${question.task_id}: ${row.error ? `error (${truncate(row.error, 120)})` : row.correct ? "correct" : "incorrect"}${row.cost_cents !== undefined ? `, $${(row.cost_cents / 100).toFixed(2)} on-chain` : ""}`);
      return row;
    })));
    rows.push(...harnessRows);
  }

  const report: GaiaReport = {
    run_id: runId,
    tier: options.tier,
    generated_at: new Date().toISOString(),
    results_dir: resultsDir,
    selected_questions: selected.length,
    skipped,
    harnesses: harnesses.map((harness) => summarizeHarness(harness, rows.filter((row) => row.harness === harness.name))),
    rows
  };
  await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function runOneQuestion(
  harness: GaiaHarness,
  question: GaiaQuestion,
  resultsDir: string,
  options: GaiaRunOptions
): Promise<GaiaResultRow> {
  const runDir = join(resultsDir, harness.name, question.task_id);
  await mkdir(runDir, { recursive: true });
  const prompt = gaiaPrompt(question);
  const started = Date.now();
  let run: HarnessRun;
  try {
    run = await harness.run(question, {
      runDir,
      prompt,
      attachmentPath: question.file_path,
      testMode: options.testMode,
      testSeed: options.testSeed,
      model: options.model,
      auto: options.auto,
      log: options.log ?? (() => undefined)
    });
  } catch (error) {
    run = { error: (error as Error).message };
  }
  const answer = extractFinalAnswer(run.final_message);
  return {
    harness: harness.name,
    task_id: question.task_id,
    level: question.level,
    question: question.question,
    expected: question.final_answer,
    answer,
    correct: !run.error && scoreGaiaAnswer(answer, question.final_answer),
    turns: run.turns,
    wall_time_ms: Date.now() - started,
    cost_cents: run.cost_cents,
    llm_cost_cents: run.llm_cost_cents,
    service_cost_cents: run.service_cost_cents,
    estimated_cost_usd: run.estimated_cost_usd,
    tokens: run.tokens,
    model_policy: run.model_policy,
    trajectory_path: run.trajectory_path,
    compliance: run.compliance,
    error: run.error
  };
}

export async function estimateGaiaCostCents(
  questionCount: number,
  harnesses: GaiaHarness[],
  maxLlmCostCents: number
): Promise<{ ceilingCents: number; message: string }> {
  // Ceiling, not an estimate of the mean: every turn priced at the request
  // cap plus a paid-service allowance per question.
  const perQuestionCents = maxLlmCostCents * 15 + 100;
  const onChainHarnesses = harnesses.filter((harness) => harness.onChainCost).length;
  const ceilingCents = perQuestionCents * questionCount * Math.max(onChainHarnesses, 0);
  const externalNames = harnesses.filter((harness) => !harness.onChainCost).map((harness) => harness.name);
  const message = [
    `Estimated on-chain cost ceiling: $${(ceilingCents / 100).toFixed(2)} USDC`,
    `(${questionCount} questions x ${onChainHarnesses} wallet-funded harness${onChainHarnesses === 1 ? "" : "es"} x $${(perQuestionCents / 100).toFixed(2)} ceiling per question).`,
    externalNames.length > 0
      ? `${externalNames.join(", ")} bill through their own accounts and are not covered by this ceiling.`
      : ""
  ].filter(Boolean).join(" ");
  return { ceilingCents, message };
}

function summarizeHarness(harness: GaiaHarness, rows: GaiaResultRow[]): GaiaHarnessReport {
  const answered = rows.filter((row) => !row.error);
  const correct = answered.filter((row) => row.correct);
  const byLevel: GaiaHarnessReport["accuracy_by_level"] = {};
  for (const level of [1, 2, 3]) {
    const levelRows = answered.filter((row) => row.level === level);
    if (levelRows.length === 0 && rows.every((row) => row.level !== level)) {
      continue;
    }
    const levelCorrect = levelRows.filter((row) => row.correct).length;
    byLevel[String(level)] = {
      answered: levelRows.length,
      correct: levelCorrect,
      accuracy: levelRows.length === 0 ? 0 : levelCorrect / levelRows.length
    };
  }
  const costs = rows.map((row) => row.cost_cents).filter((cost): cost is number => cost !== undefined);
  const estimates = rows.map((row) => row.estimated_cost_usd).filter((cost): cost is number => cost !== undefined);
  return {
    name: harness.name,
    cost_basis: harness.onChainCost ? "on-chain" : "estimated",
    answered: answered.length,
    correct: correct.length,
    accuracy: answered.length === 0 ? 0 : correct.length / answered.length,
    accuracy_by_level: byLevel,
    mean_cost_cents: mean(costs),
    median_cost_cents: median(costs),
    mean_estimated_cost_usd: mean(estimates),
    errors: rows.length - answered.length
  };
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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
