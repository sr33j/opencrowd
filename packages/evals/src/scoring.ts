import { readFile, stat } from "node:fs/promises";
import { resolve as resolveDns } from "node:dns/promises";
import { join } from "node:path";
import { extractFinalAnswer, isFloat, normalizeNumberStr, normalizeStr, scoreGaiaAnswer } from "./scorer.js";
import type { EvalTask, ScorerSpec } from "./tasks.js";

/**
 * Task scoring. `score` is 0..1 (AssistantBench gives partial credit);
 * `correct` is score >= 0.5 for AssistantBench and exact for everything else.
 */

export interface TaskScore {
  score: number;
  correct: boolean;
  detail?: string;
}

export interface ScoreContext {
  /** Session artifacts directory (artifact scorers). */
  artifactsDir?: string;
  fetchImpl?: typeof fetch;
}

export async function scoreTask(task: EvalTask, finalMessage: string | undefined, context: ScoreContext = {}): Promise<TaskScore> {
  const answer = extractAnswerText(finalMessage);
  const spec = task.scorer;
  switch (spec.type) {
    case "gaia": {
      const correct = scoreGaiaAnswer(answer, task.expected);
      return { score: correct ? 1 : 0, correct };
    }
    case "assistantbench": {
      const score = scoreAssistantBench(answer, task.expected);
      return { score, correct: score >= 0.5, detail: `partial credit ${score.toFixed(2)}` };
    }
    case "contains_all": {
      const haystack = (answer ?? "").toLowerCase();
      const correct = answer !== undefined && spec.terms.every((term) => haystack.includes(term.toLowerCase()));
      return { score: correct ? 1 : 0, correct };
    }
    case "range": {
      if (answer === undefined || !isFloat(answer.replace(/[$%,°C]/g, "").trim())) {
        return { score: 0, correct: false, detail: "not a number" };
      }
      const value = normalizeNumberStr(answer.replace(/[°C]/g, ""));
      const correct = value >= spec.min && value <= spec.max;
      return { score: correct ? 1 : 0, correct, detail: `value ${value}` };
    }
    case "url_content": {
      const url = extractUrl(answer);
      if (!url) {
        return { score: 0, correct: false, detail: "no URL in answer" };
      }
      try {
        const response = await (context.fetchImpl ?? fetch)(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
        const text = await response.text();
        const correct = response.ok && text.includes(spec.contains);
        return { score: correct ? 1 : 0, correct, detail: `${url} -> ${response.status}` };
      } catch (error) {
        return { score: 0, correct: false, detail: `fetch failed: ${(error as Error).message}` };
      }
    }
    case "artifact": {
      if (!context.artifactsDir) {
        return { score: 0, correct: false, detail: "no artifacts dir" };
      }
      for (const name of spec.names) {
        const path = join(context.artifactsDir, name);
        let size: number;
        try {
          size = (await stat(path)).size;
        } catch {
          continue;
        }
        if (spec.min_bytes !== undefined && size < spec.min_bytes) {
          return { score: 0, correct: false, detail: `${name} too small (${size} bytes)` };
        }
        const buffer = await readFile(path);
        if (spec.image && !looksLikeImage(buffer)) {
          return { score: 0, correct: false, detail: `${name} is not a PNG/JPEG/WebP` };
        }
        if (spec.contains_all) {
          const text = buffer.toString("utf8");
          const missing = spec.contains_all.filter((term) => !text.includes(term));
          if (missing.length > 0) {
            return { score: 0, correct: false, detail: `${name} missing ${missing.join(", ")}` };
          }
        }
        return { score: 1, correct: true, detail: `${name} (${size} bytes)` };
      }
      return { score: 0, correct: false, detail: `none of ${spec.names.join(", ")} found` };
    }
    case "dns_a": {
      const candidate = (answer ?? "").match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
      if (!candidate) {
        return { score: 0, correct: false, detail: "no IPv4 in answer" };
      }
      try {
        const records = await resolveDns(spec.hostname, "A");
        const correct = records.includes(candidate);
        return { score: correct ? 1 : 0, correct, detail: `live A records: ${records.join(", ")}` };
      } catch (error) {
        return { score: 0, correct: false, detail: `dns failed: ${(error as Error).message}` };
      }
    }
    default:
      return { score: 0, correct: false, detail: `unknown scorer ${(spec as ScorerSpec).type}` };
  }
}

/**
 * The FINAL ANSWER line when present; otherwise a short final message is
 * taken as the answer itself (agents sometimes complete with just "55").
 */
export function extractAnswerText(finalMessage: string | undefined): string | undefined {
  const tagged = extractFinalAnswer(finalMessage);
  if (tagged !== undefined) {
    return tagged;
  }
  const trimmed = finalMessage?.trim();
  if (!trimmed || trimmed.length > 300 || /^stopped after/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.split(/\r?\n/).at(-1)?.trim();
}

/**
 * AssistantBench-style partial credit: gold lists are newline separated;
 * numbers score by relative closeness; strings by token F1; lists by greedy
 * best-match average with a length penalty; JSON dicts by per-key match.
 */
export function scoreAssistantBench(answer: string | undefined, gold: string): number {
  if (!answer) {
    return 0;
  }
  const goldItems = splitItems(gold);
  const predItems = splitItems(answer, true);
  if (goldItems.length === 1) {
    return scoreItem(predItems.join(" "), goldItems[0]);
  }
  if (predItems.length === 0) {
    return 0;
  }
  const used = new Set<number>();
  let total = 0;
  for (const goldItem of goldItems) {
    let best = 0;
    let bestIndex = -1;
    predItems.forEach((predItem, index) => {
      if (used.has(index)) {
        return;
      }
      const score = scoreItem(predItem, goldItem);
      if (score > best) {
        best = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
    }
    total += best;
  }
  const recall = total / goldItems.length;
  const precision = total / Math.max(predItems.length, 1);
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function scoreItem(pred: string, gold: string): number {
  const goldNumber = parseNumber(gold);
  if (goldNumber !== undefined) {
    const predNumber = parseNumber(pred);
    if (predNumber === undefined) {
      return 0;
    }
    if (goldNumber === 0) {
      return predNumber === 0 ? 1 : 0;
    }
    return Math.max(0, 1 - Math.abs(predNumber - goldNumber) / Math.abs(goldNumber));
  }
  if (gold.trim().startsWith("{")) {
    return scoreDict(pred, gold);
  }
  return tokenF1(pred, gold);
}

function scoreDict(pred: string, gold: string): number {
  let goldObject: Record<string, unknown>;
  try {
    goldObject = JSON.parse(gold) as Record<string, unknown>;
  } catch {
    return tokenF1(pred, gold);
  }
  let predObject: Record<string, unknown> | undefined;
  try {
    predObject = JSON.parse(pred) as Record<string, unknown>;
  } catch {
    predObject = undefined;
  }
  const keys = Object.keys(goldObject);
  if (keys.length === 0) {
    return 0;
  }
  let total = 0;
  for (const key of keys) {
    const goldValue = String(goldObject[key]);
    const predValue = predObject ? String(predObject[key] ?? "") : pred;
    total += scoreItem(predValue, goldValue);
  }
  return total / keys.length;
}

function tokenF1(pred: string, gold: string): number {
  const predTokens = tokens(pred);
  const goldTokens = tokens(gold);
  if (predTokens.length === 0 || goldTokens.length === 0) {
    return 0;
  }
  if (normalizeStr(pred) === normalizeStr(gold)) {
    return 1;
  }
  const counts = new Map<string, number>();
  for (const token of goldTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let overlap = 0;
  for (const token of predTokens) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(token, remaining - 1);
    }
  }
  if (overlap === 0) {
    return 0;
  }
  const precision = overlap / predTokens.length;
  const recall = overlap / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function tokens(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
    .filter((token) => !["the", "a", "an", "of", "and"].includes(token));
}

function parseNumber(value: string): number | undefined {
  const cleaned = value.replace(/[$%,]/g, "").replace(/\b(usd|sqft|sq ft)\b/gi, "").trim();
  if (cleaned === "" || !isFloat(cleaned)) {
    return undefined;
  }
  return Number.parseFloat(cleaned);
}

function splitItems(value: string, allowSemicolon = false): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    return [trimmed];
  }
  const separator = allowSemicolon ? /\r?\n|;/ : /\r?\n/;
  return trimmed.split(separator).map((item) => item.trim()).filter(Boolean);
}

function extractUrl(answer: string | undefined): string | undefined {
  return answer?.match(/https?:\/\/[^\s"'<>)\]]+/)?.[0];
}

function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    return false;
  }
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const webp = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return png || jpeg || webp;
}
