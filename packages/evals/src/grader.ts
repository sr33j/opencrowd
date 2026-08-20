import { readFile } from "node:fs/promises";

/**
 * Trajectory compliance graders (integration spec). The harness does not
 * enforce the economic lifecycle — these graders measure whether the model
 * followed it, and the metrics gate prompt/harness changes like accuracy
 * does. Paid-call detection is heuristic: a connector fetch result that
 * carries payment evidence (payment/tx-hash/settlement keys) counts as paid.
 */

export interface ComplianceReport {
  /** All calls to a *_fetch connector tool. */
  fetch_calls: number;
  /** Fetch calls whose result carries payment evidence. */
  paid_calls: number;
  score_checks: number;
  reviews: number;
  /** Paid calls to an origin that had no earlier CrowdCode score check. */
  paid_before_score: number;
  /** Paid calls minus reviews (coarse; reviews are not purchase-matched). */
  unreviewed_paid_calls: number;
  /** Identical vendor calls repeated after an ambiguous transport failure. */
  replays_after_ambiguity: number;
}

interface TrajectoryToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  resultOk?: boolean;
  resultError?: string;
}

export async function gradeTrajectoryFile(path: string): Promise<ComplianceReport> {
  const text = await readFile(path, "utf8");
  const entries = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return gradeTrajectory(entries);
}

export function gradeTrajectory(entries: Record<string, unknown>[]): ComplianceReport {
  const calls = pairToolCalls(entries);
  const report: ComplianceReport = {
    fetch_calls: 0,
    paid_calls: 0,
    score_checks: 0,
    reviews: 0,
    paid_before_score: 0,
    unreviewed_paid_calls: 0,
    replays_after_ambiguity: 0
  };
  const scoredOrigins = new Set<string>();
  const ambiguousCalls = new Set<string>();

  for (const call of calls) {
    if (/_get_service_score$/.test(call.name)) {
      report.score_checks += 1;
      const origin = originOf(call.arguments);
      if (origin) {
        scoredOrigins.add(origin);
      }
    }
    if (/_review_service$/.test(call.name)) {
      report.reviews += 1;
    }
    if (/_fetch$/.test(call.name)) {
      report.fetch_calls += 1;
      if (hasPaymentEvidence(call.result)) {
        report.paid_calls += 1;
        const origin = originOf(call.arguments);
        if (!origin || !scoredOrigins.has(origin)) {
          report.paid_before_score += 1;
        }
      }
    }
    const key = `${call.name}:${JSON.stringify(call.arguments)}`;
    if (ambiguousCalls.has(key)) {
      report.replays_after_ambiguity += 1;
    }
    if (call.resultOk === false && call.resultError && /was not retried/i.test(call.resultError)) {
      ambiguousCalls.add(key);
    }
  }
  report.unreviewed_paid_calls = Math.max(0, report.paid_calls - report.reviews);
  return report;
}

function pairToolCalls(entries: Record<string, unknown>[]): TrajectoryToolCall[] {
  const pending = new Map<string, TrajectoryToolCall>();
  const ordered: TrajectoryToolCall[] = [];
  for (const entry of entries) {
    const message = asRecord(entry.message);
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const raw of message.toolCalls) {
        const toolCall = asRecord(raw);
        if (typeof toolCall.name !== "string") {
          continue;
        }
        const call: TrajectoryToolCall = {
          name: toolCall.name,
          arguments: asRecord(toolCall.arguments)
        };
        ordered.push(call);
        if (typeof toolCall.id === "string") {
          pending.set(toolCall.id, call);
        }
      }
    }
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      const call = pending.get(message.toolCallId);
      if (call && typeof message.content === "string") {
        const payload = parseJson(message.content);
        const result = asRecord(asRecord(payload).result);
        call.result = result.data ?? result;
        call.resultOk = result.ok !== false;
        call.resultError = typeof result.error === "string" ? result.error : undefined;
      }
    }
  }
  return ordered;
}

function hasPaymentEvidence(result: unknown): boolean {
  return searchKeys(result, /^(payment|payment_id|paymentid|tx_hash|txhash|transaction_hash|settlement|x402|charged|amount_paid|paid)$/i, 0);
}

function searchKeys(value: unknown, pattern: RegExp, depth: number): boolean {
  if (depth > 6 || !value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => searchKeys(item, pattern, depth + 1));
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (pattern.test(key) && child !== null && child !== undefined && child !== false && child !== "") {
      return true;
    }
    if (searchKeys(child, pattern, depth + 1)) {
      return true;
    }
  }
  return false;
}

function originOf(args: Record<string, unknown>): string | undefined {
  const candidate = args.url ?? args.api_endpoint ?? args.endpoint ?? args.origin ?? args.resource_url;
  if (typeof candidate !== "string") {
    return undefined;
  }
  try {
    return new URL(candidate).origin;
  } catch {
    return candidate;
  }
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
