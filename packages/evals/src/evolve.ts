import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOpenCrowdSession } from "@opencrowd/core";
import { BudgetedLlmProvider, resolveLlmRuntime, type LlmProvider } from "@opencrowd/agent-runtime";
import { fetchCrowdCodeEvidence, renderEvidenceDigest, type EvidenceBundle } from "./evidence.js";
import {
  hashContent,
  proposeTree,
  readTree,
  updateTreeMeta,
  validateTree,
  writeTree,
  type FailureCase,
  type TreeFiles,
  type TreeMeta
} from "./knowledge.js";
import { runSuite, type SuiteReport, type SuiteResultRow } from "./suite.js";
import { loadTaskSet, type EvalTask } from "./tasks.js";

/**
 * Meta-harness: evolutionary search over knowledge trees.
 *
 *   population  = candidate trees (files on disk, lineage in meta.json)
 *   proposer    = LLM diffing against a parent, given evidence + held-in failures
 *   validator   = deterministic (validateTree)
 *   evaluator   = the OpenCrowd agent loop on the held-in suite
 *   selection   = Pareto frontier over (mean_score up, cost down); parents
 *                 sampled by fitness and inversely by offspring count
 *
 * Held-out suites are never shown to the proposer and are only run for
 * promotion, so the loop cannot overfit them.
 */

export interface EvolveOptions {
  resultsRoot: string;
  evidencePath?: string;
  refreshEvidence?: boolean;
  generations: number;
  candidatesPerGeneration: number;
  /** Agent model under evaluation (held fixed across the whole run). */
  agentModel: string;
  /** Proposer models, cycled per candidate (mix cheap breadth with strong depth). */
  proposerModels: string[];
  /** Existing candidate directories to seed the archive (skips gen-0 proposals for them). */
  seedTrees?: string[];
  /** Existing baseline report (no tree) to reuse instead of re-running. */
  baselineReport?: string;
  parallel?: number;
  maxTurns?: number;
  hfToken?: string;
  log?: (message: string) => void;
}

export interface ArchiveEntry {
  id: string;
  dir?: string;
  generation: number;
  parent?: string;
  proposer_model?: string;
  directive?: string;
  report_dir?: string;
  metrics?: CandidateMetrics;
  children: number;
  status: "evaluated" | "invalid" | "failed";
  errors?: string[];
}

export interface CandidateMetrics {
  tasks: number;
  correct: number;
  accuracy: number;
  mean_score: number;
  total_cost_cents: number;
  mean_turns: number;
  paid_calls: number;
  unnecessary_purchases: number;
  errors: number;
  /** correct answers minus dollars spent (one correct answer is worth one dollar). */
  fitness: number;
}

export interface Archive {
  started_at: string;
  agent_model: string;
  evidence_hash: string;
  entries: ArchiveEntry[];
}

const DIRECTIVES = [
  "Favor the cheapest correct path: free/local first, one paid call only when it clearly saves turns.",
  "Favor precision of request shapes: exact endpoints, methods, and body fields so the first paid call succeeds.",
  "Favor coverage: make sure every capability class agents actually asked for has a category page and a one-line L0 entry.",
  "Favor brevity: shrink L0 to the ten highest-value entries and push everything else into category pages."
];

export async function runEvolution(options: EvolveOptions): Promise<{ archive: Archive; best?: ArchiveEntry }> {
  const log = options.log ?? (() => undefined);
  const root = resolve(options.resultsRoot);
  const treesDir = join(root, "trees");
  const runsDir = join(root, "runs");
  await mkdir(treesDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });

  const evidencePath = options.evidencePath ?? join(root, "evidence", "crowdcode-evidence.json");
  const evidence = await fetchCrowdCodeEvidence({ cachePath: evidencePath, useCache: !options.refreshEvidence, log });
  const digest = renderEvidenceDigest(evidence, { detailTop: 90, maxReviewsPerService: 4 });
  const evidenceHash = hashContent(digest);
  log(`evidence: ${evidence.stats.services} services, ${evidence.stats.reviews} reviews, digest ~${Math.round(digest.length / 4)} tokens`);

  const heldin = await loadTaskSet("heldin", { hfToken: options.hfToken, log });
  const proposer = await buildProposerProviders(root, options.proposerModels);

  const archivePath = join(root, "archive.json");
  const archive: Archive = await readArchive(archivePath) ?? {
    started_at: new Date().toISOString(),
    agent_model: options.agentModel,
    evidence_hash: evidenceHash,
    entries: []
  };
  const save = async (): Promise<void> => {
    await writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
    await writeFile(join(root, "frontier.md"), `${renderArchive(archive)}\n`, "utf8");
  };
  const evaluate = async (entry: ArchiveEntry, knowledgeDir?: string): Promise<SuiteReport> => {
    const report = await runSuite({
      set: "heldin",
      tasks: heldin,
      resultsRoot: runsDir,
      tag: entry.id,
      knowledgeDir,
      model: options.agentModel,
      subagentModel: "off",
      parallel: options.parallel ?? 4,
      maxTurns: options.maxTurns,
      log
    });
    entry.report_dir = report.results_dir;
    entry.metrics = metricsOf(report);
    entry.status = "evaluated";
    if (knowledgeDir) {
      await updateTreeMeta(knowledgeDir, { scores: { heldin: entry.metrics, report_dir: report.results_dir } });
    }
    return report;
  };

  // Generation 0: baseline (no tree) and initial proposals from evidence alone.
  if (!archive.entries.some((entry) => entry.id === "baseline")) {
    const baseline: ArchiveEntry = { id: "baseline", generation: 0, children: 0, status: "evaluated" };
    if (options.baselineReport) {
      const report = JSON.parse(await readFile(options.baselineReport, "utf8")) as SuiteReport;
      const rows = report.rows.filter((row) => row.suite === "usage");
      baseline.report_dir = report.results_dir;
      baseline.metrics = metricsOfRows(rows);
      log(`baseline reused from ${options.baselineReport}: ${baseline.metrics.correct}/${baseline.metrics.tasks}`);
    } else {
      await evaluate(baseline);
    }
    archive.entries.push(baseline);
    await save();
  }
  for (const seed of options.seedTrees ?? []) {
    const { meta } = await readTree(seed);
    const id = meta?.id ?? `seed-${hashContent((await readTree(seed)).tree)}`;
    if (archive.entries.some((entry) => entry.id === id)) {
      continue;
    }
    const entry: ArchiveEntry = { id, dir: seed, generation: 0, children: 0, status: "evaluated", proposer_model: meta?.proposer_model };
    archive.entries.push(entry);
    await evaluate(entry, seed);
    await save();
  }
  const gen0Count = archive.entries.filter((entry) => entry.generation === 0 && entry.dir).length;
  for (let index = gen0Count; index < options.candidatesPerGeneration; index += 1) {
    const model = options.proposerModels[index % options.proposerModels.length];
    const entry = await proposeCandidate({
      archive, treesDir, generation: 0, index, model, provider: proposer.get(model)!, evidence, evidenceHash, digest, log
    });
    archive.entries.push(entry);
    await save();
    if (entry.status === "invalid" || entry.status === "failed" || !entry.dir) {
      continue;
    }
    await evaluate(entry, entry.dir);
    await save();
  }

  // Generations 1..N: mutate frontier parents using held-in weaknesses.
  for (let generation = 1; generation <= options.generations; generation += 1) {
    for (let index = 0; index < options.candidatesPerGeneration; index += 1) {
      const parent = pickParent(archive, `${generation}:${index}`);
      if (!parent || !parent.dir || !parent.report_dir) {
        log("no evaluated tree to mutate; stopping");
        break;
      }
      const model = options.proposerModels[(generation + index) % options.proposerModels.length];
      const cases = await casesFromReport(parent.report_dir);
      const entry = await proposeCandidate({
        archive, treesDir, generation, index, model, provider: proposer.get(model)!, evidence, evidenceHash, digest, log,
        parent, cases, directive: DIRECTIVES[(generation * options.candidatesPerGeneration + index) % DIRECTIVES.length]
      });
      parent.children += 1;
      archive.entries.push(entry);
      await save();
      if (entry.status === "invalid" || entry.status === "failed" || !entry.dir) {
        continue;
      }
      await evaluate(entry, entry.dir);
      await save();
    }
  }

  const best = bestEntry(archive);
  if (best?.dir) {
    await writeFile(join(root, "BEST"), `${best.dir}\n`, "utf8");
  }
  await save();
  return { archive, best };
}

interface ProposeCandidateInput {
  archive: Archive;
  treesDir: string;
  generation: number;
  index: number;
  model: string;
  provider: LlmProvider;
  evidence: EvidenceBundle;
  evidenceHash: string;
  digest: string;
  parent?: ArchiveEntry;
  cases?: FailureCase[];
  directive?: string;
  log: (message: string) => void;
}

async function proposeCandidate(input: ProposeCandidateInput): Promise<ArchiveEntry> {
  const id = `g${input.generation}-c${input.index}-${input.model.split("/").pop()?.replace(/[^a-z0-9.]/gi, "") ?? "m"}`;
  const entry: ArchiveEntry = {
    id,
    generation: input.generation,
    parent: input.parent?.id,
    proposer_model: input.model,
    directive: input.directive,
    children: 0,
    status: "failed"
  };
  const parentTree = input.parent?.dir ? await readTree(input.parent.dir) : undefined;
  let tree: TreeFiles | undefined;
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2 && !tree; attempt += 1) {
    try {
      const proposal = await proposeTree({
        provider: input.provider,
        model: input.model,
        evidence: input.evidence,
        digest: input.digest,
        parent: parentTree,
        cases: input.cases,
        directive: attempt === 0
          ? input.directive
          : `${input.directive ?? ""} The previous attempt was rejected by the validator: ${errors.join("; ")}. Fix these.`,
        log: input.log
      });
      const validation = validateTree(proposal.tree, input.evidence);
      const dir = join(input.treesDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "proposal.raw.txt"), proposal.rawResponse, "utf8");
      if (!validation.ok) {
        errors = validation.errors;
        input.log(`${id}: invalid (${validation.errors.join("; ")})`);
        entry.status = "invalid";
        entry.errors = validation.errors;
        continue;
      }
      tree = proposal.tree;
      const meta: TreeMeta = {
        id,
        generation: input.generation,
        parent: input.parent?.id,
        created_at: new Date().toISOString(),
        proposer_model: input.model,
        directive: input.directive,
        evidence_hash: input.evidenceHash,
        content_hash: hashContent(tree),
        notes: `changed: ${proposal.changed_files.join(", ")}`,
        validation
      };
      await writeTree(dir, tree, meta);
      entry.dir = dir;
      entry.status = "evaluated";
      entry.errors = validation.warnings.length > 0 ? validation.warnings : undefined;
      input.log(`${id}: ${Object.keys(tree).length} files, L0 ${validation.stats.l0_tokens} tokens, ${validation.stats.referenced_services} service refs${validation.warnings.length ? `, warnings: ${validation.warnings.length}` : ""}`);
    } catch (error) {
      errors = [(error as Error).message];
      input.log(`${id}: proposal failed (${(error as Error).message})`);
      entry.status = "failed";
      entry.errors = errors;
    }
  }
  return entry;
}

/** Parent choice: fitness-weighted, penalized by offspring count (Darwin Godel Machine style), deterministic per slot. */
export function pickParent(archive: Archive, slot: string): ArchiveEntry | undefined {
  const candidates = archive.entries.filter((entry) => entry.status === "evaluated" && entry.dir && entry.metrics);
  if (candidates.length === 0) {
    return undefined;
  }
  const frontier = paretoFrontier(candidates);
  const pool = frontier.length > 0 ? frontier : candidates;
  const weights = pool.map((entry) => Math.max(0.05, (entry.metrics?.fitness ?? 0) + 1) / (1 + entry.children));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = seededUnit(`${archive.started_at}:${slot}`) * total;
  for (const [index, entry] of pool.entries()) {
    roll -= weights[index];
    if (roll <= 0) {
      return entry;
    }
  }
  return pool[pool.length - 1];
}

export function paretoFrontier(entries: ArchiveEntry[]): ArchiveEntry[] {
  return entries.filter((candidate) => !entries.some((other) => other !== candidate && dominates(other, candidate)));
}

function dominates(a: ArchiveEntry, b: ArchiveEntry): boolean {
  const ma = a.metrics!;
  const mb = b.metrics!;
  const betterOrEqual = ma.mean_score >= mb.mean_score && ma.total_cost_cents <= mb.total_cost_cents;
  const strictlyBetter = ma.mean_score > mb.mean_score || ma.total_cost_cents < mb.total_cost_cents;
  return betterOrEqual && strictlyBetter;
}

export function bestEntry(archive: Archive): ArchiveEntry | undefined {
  return [...archive.entries]
    .filter((entry) => entry.status === "evaluated" && entry.metrics)
    .sort((left, right) => (right.metrics!.fitness - left.metrics!.fitness) || (left.metrics!.total_cost_cents - right.metrics!.total_cost_cents))[0];
}

export function metricsOf(report: SuiteReport): CandidateMetrics {
  return metricsOfRows(report.rows);
}

export function metricsOfRows(rows: SuiteResultRow[]): CandidateMetrics {
  const correct = rows.filter((row) => row.correct).length;
  const cost = rows.reduce((sum, row) => sum + (row.cost_cents ?? 0), 0);
  const meanScore = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
  return {
    tasks: rows.length,
    correct,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    mean_score: meanScore,
    total_cost_cents: cost,
    mean_turns: rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + (row.turns ?? 0), 0) / rows.length,
    paid_calls: rows.reduce((sum, row) => sum + (row.paid_calls ?? 0), 0),
    unnecessary_purchases: rows.filter((row) => row.unnecessary_purchase).length,
    errors: rows.filter((row) => row.error).length,
    fitness: rows.reduce((sum, row) => sum + row.score, 0) - cost / 100
  };
}

/** Weakness mining: every held-in row becomes a case, with a compact tool trace from the trajectory. */
export async function casesFromReport(reportDir: string): Promise<FailureCase[]> {
  const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as SuiteReport;
  const cases: FailureCase[] = [];
  for (const row of report.rows) {
    cases.push({
      task_id: row.task_id,
      question: row.question,
      expected: row.expected,
      answer: row.answer,
      correct: row.correct,
      cost_cents: row.cost_cents,
      turns: row.turns,
      paid_calls: row.paid_calls,
      unnecessary_purchase: row.unnecessary_purchase,
      tool_trace: row.trajectory_path ? await summarizeTrajectory(row.trajectory_path) : undefined
    });
  }
  // Failures and unnecessary purchases first, then the most expensive successes.
  return cases.sort((left, right) => Number(right.unnecessary_purchase || !right.correct) - Number(left.unnecessary_purchase || !left.correct)
    || (right.cost_cents ?? 0) - (left.cost_cents ?? 0));
}

export async function summarizeTrajectory(path: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const steps: string[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = asRecord(entry.message ?? entry);
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const raw of message.toolCalls) {
        const call = asRecord(raw);
        const args = asRecord(call.arguments);
        const detail = typeof args.query === "string" ? `query=${args.query}`
          : typeof args.url === "string" ? args.url
            : typeof args.command === "string" ? `cmd=${args.command.slice(0, 60)}`
              : typeof args.path === "string" ? args.path
                : "";
        steps.push(`${String(call.name)}${detail ? `(${detail.slice(0, 80)})` : ""}`);
      }
    }
    if (message.role === "tool" && typeof message.content === "string") {
      const payload = asRecord(parseJson(message.content));
      const result = asRecord(payload.result);
      if (result.ok === false && typeof result.error === "string") {
        steps.push(`ERROR(${result.error.slice(0, 80)})`);
      }
    }
  }
  return steps.length > 0 ? steps.join(" -> ") : undefined;
}

async function buildProposerProviders(root: string, models: string[]): Promise<Map<string, LlmProvider>> {
  const session = await createOpenCrowdSession({ workspaceRoot: join(root, "proposer"), approvalMode: "auto", shellEnabled: false });
  const providers = new Map<string, LlmProvider>();
  for (const model of new Set(models)) {
    const llm = await resolveLlmRuntime(session, { model, subagentModel: "off", nonInteractive: true });
    providers.set(model, new BudgetedLlmProvider(session, llm.provider, {
      model: llm.models.main,
      maxCostCentsPerCall: Math.max(llm.maxCostCentsPerCall, 150),
      tools: [],
      extraTools: [],
      catalog: llm.catalog
    }));
  }
  return providers;
}

async function readArchive(path: string): Promise<Archive | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Archive;
  } catch {
    return undefined;
  }
}

export function renderArchive(archive: Archive): string {
  const evaluated = archive.entries.filter((entry) => entry.metrics);
  const frontier = new Set(paretoFrontier(evaluated.filter((entry) => entry.dir)).map((entry) => entry.id));
  const lines = [
    `# Knowledge-tree evolution (agent model ${archive.agent_model}, started ${archive.started_at})`,
    "",
    "| id | gen | parent | proposer | status | correct | mean score | cost | turns | paid | unnecessary | fitness | frontier |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...archive.entries.map((entry) => {
      const m = entry.metrics;
      return `| ${entry.id} | ${entry.generation} | ${entry.parent ?? "-"} | ${entry.proposer_model?.split("/").pop() ?? "-"} | ${entry.status} | ${m ? `${m.correct}/${m.tasks}` : "-"} | ${m ? m.mean_score.toFixed(3) : "-"} | ${m ? `$${(m.total_cost_cents / 100).toFixed(3)}` : "-"} | ${m ? m.mean_turns.toFixed(1) : "-"} | ${m ? m.paid_calls : "-"} | ${m ? m.unnecessary_purchases : "-"} | ${m ? m.fitness.toFixed(3) : "-"} | ${frontier.has(entry.id) ? "yes" : ""} |`;
    })
  ];
  const best = bestEntry(archive);
  if (best) {
    lines.push("", `Best by fitness: ${best.id}${best.dir ? ` (${best.dir})` : ""}`);
  }
  return lines.join("\n");
}

function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % 100000) / 100000;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export type { EvalTask };
