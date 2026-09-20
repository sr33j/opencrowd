import type { ToolResult } from "@opencrowd/core";
import { McpConnection } from "./mcp.js";

/**
 * Typed adapter over the CrowdCode MCP server. CrowdCode owns the
 * pre-payment reputation check and signed reviews; review signing happens
 * inside the vendor with the shared AgentCash wallet — OpenCrowd never
 * touches signatures.
 */

export interface ServiceEvidence {
  ok: boolean;
  /** Canonical trust-weighted rating when available. */
  score?: number;
  /** Effective evidence count behind the score. */
  nEff?: number;
  /** Not enough trusted reviews yet: insufficient evidence, not a bad score. */
  unproven?: boolean;
  summary?: string;
  error?: string;
  raw?: unknown;
}

export interface ServiceQuery {
  apiEndpoint?: string;
  paymentProvider?: "x402" | "mppx";
  paymentTargetRef?: string;
  serviceId?: string;
}

export interface ReviewSubmission {
  rating: number;
  reason: string;
  paymentReference?: string;
  reviewNonce?: string;
  apiEndpoint?: string;
  paymentProvider?: "x402" | "mppx";
  paymentProof?: string;
  paymentTargetRef?: string;
  taskContext?: string;
}

export interface ReviewResult {
  ok: boolean;
  error?: string;
  raw?: unknown;
}

export interface CrowdCodeAdapter {
  manage?(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  getServiceScore(query: ServiceQuery): Promise<ServiceEvidence>;
  reviewService(review: ReviewSubmission): Promise<ReviewResult>;
}

export class McpCrowdCodeAdapter implements CrowdCodeAdapter {
  constructor(private readonly connection: McpConnection) {}

  async manage(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.connection.call(name, args);
  }

  async getServiceScore(query: ServiceQuery): Promise<ServiceEvidence> {
    const result = await this.connection.call("get_service_score", {
      ...(query.apiEndpoint ? { api_endpoint: query.apiEndpoint } : {}),
      ...(query.paymentProvider ? { payment_provider: query.paymentProvider } : {}),
      ...(query.paymentTargetRef ? { payment_target_ref: query.paymentTargetRef } : {}),
      ...(query.serviceId ? { service_id: query.serviceId } : {})
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return normalizeEvidence(result.data);
  }

  async reviewService(review: ReviewSubmission): Promise<ReviewResult> {
    const result = await this.connection.call("review_service", {
      rating: review.rating,
      reason: review.reason,
      ...(review.paymentReference !== undefined ? { payment_reference: review.paymentReference } : {}),
      ...(review.reviewNonce ? { review_nonce: review.reviewNonce } : {}),
      ...(review.apiEndpoint ? { api_endpoint: review.apiEndpoint } : {}),
      ...(review.paymentProvider ? { payment_provider: review.paymentProvider } : {}),
      ...(review.paymentProof ? { payment_proof: review.paymentProof } : {}),
      ...(review.paymentTargetRef ? { payment_target_ref: review.paymentTargetRef } : {}),
      ...(review.taskContext ? { task_context: review.taskContext } : {})
    });
    const payload = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    const accepted = result.ok && payload.accepted === true;
    return { ok: accepted, error: accepted ? undefined : result.error ?? String(payload.reason ?? "CrowdCode did not accept the review"), raw: result.data };
  }
}

export function normalizeEvidence(raw: unknown): ServiceEvidence {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    ok: true,
    score: numberValue(record.score),
    nEff: numberValue(record.n_eff ?? record.nEff),
    unproven: typeof record.unproven === "boolean" ? record.unproven : undefined,
    summary: summarizeEvidence(record),
    raw
  };
}

/** Both transports expose the same digest, including fresh unpaid experiences. */
export function summarizeEvidence(record: Record<string, unknown>): string | undefined {
  const summary = record.summary;
  const lines: string[] = [];
  if (typeof summary === "string" && summary) lines.push(summary);
  else if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const digest = summary as Record<string, unknown>;
    for (const key of ["failure_modes", "strengths", "caveats"]) {
      const items = digest[key];
      if (Array.isArray(items)) lines.push(...items.filter((item): item is string => typeof item === "string").slice(0, 2));
    }
  }
  if (Array.isArray(record.recent_reviews)) {
    for (const value of record.recent_reviews.slice(0, 5)) {
      if (!value || typeof value !== "object") continue;
      const review = value as Record<string, unknown>;
      if (typeof review.reason !== "string" || !review.reason) continue;
      const payment = review.payment_verified === true ? "payment verified" : "payment not verified";
      lines.push(`Reviewer report (${payment}, ${review.rating}/5): ${review.reason.slice(0, 600)}`);
    }
  }
  return lines.length ? lines.join(" ") : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
