/**
 * Selection for the meta-harness: candidates' metrics, the Pareto frontier
 * over (mean score up, cost down), fitness, and the parent choice. No
 * runtime imports, so other evaluators can share it: `evolve.ts` evolves
 * knowledge-tree files with local agent runs, and CrowdCode's hosted
 * evolution loop (`app/apps/reconciler/src/tree-evolve.ts` in the parent
 * repository) evolves the capability tree's policy with pinned hosted runs.
 */

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

/** What selection needs of a candidate. */
export interface Scored {
  id: string;
  status: string;
  metrics?: CandidateMetrics;
  /** Children proposed from it so far: parents are penalized for offspring. */
  children: number;
}

/** What metrics need of one evaluated task. */
export interface ScoredRow {
  score: number;
  correct: boolean;
  cost_cents?: number;
  turns?: number;
  paid_calls?: number;
  unnecessary_purchase?: boolean;
  error?: string;
}

export function metricsOfRows(rows: ScoredRow[]): CandidateMetrics {
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

export function paretoFrontier<T extends Scored>(entries: T[]): T[] {
  return entries.filter((candidate) => !entries.some((other) => other !== candidate && dominates(other, candidate)));
}

export function dominates(a: Scored, b: Scored): boolean {
  const ma = a.metrics!;
  const mb = b.metrics!;
  const betterOrEqual = ma.mean_score >= mb.mean_score && ma.total_cost_cents <= mb.total_cost_cents;
  const strictlyBetter = ma.mean_score > mb.mean_score || ma.total_cost_cents < mb.total_cost_cents;
  return betterOrEqual && strictlyBetter;
}

/**
 * Parent choice: fitness-weighted over the frontier, penalized by offspring
 * count (Darwin Gödel Machine style), deterministic per seed.
 */
export function pickParentFrom<T extends Scored>(entries: T[], seed: string, eligible: (entry: T) => boolean = () => true): T | undefined {
  const candidates = entries.filter((entry) => entry.status === "evaluated" && entry.metrics && eligible(entry));
  if (candidates.length === 0) {
    return undefined;
  }
  const frontier = paretoFrontier(candidates);
  const pool = frontier.length > 0 ? frontier : candidates;
  const weights = pool.map((entry) => Math.max(0.05, (entry.metrics?.fitness ?? 0) + 1) / (1 + entry.children));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = seededUnit(seed) * total;
  for (const [index, entry] of pool.entries()) {
    roll -= weights[index];
    if (roll <= 0) {
      return entry;
    }
  }
  return pool[pool.length - 1];
}

/** Highest fitness; cheaper wins a tie. */
export function bestOf<T extends Scored>(entries: T[]): T | undefined {
  return [...entries]
    .filter((entry) => entry.status === "evaluated" && entry.metrics)
    .sort((left, right) => (right.metrics!.fitness - left.metrics!.fitness) || (left.metrics!.total_cost_cents - right.metrics!.total_cost_cents))[0];
}

export function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % 100000) / 100000;
}
