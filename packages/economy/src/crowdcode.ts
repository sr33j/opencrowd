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
  paymentReference: string;
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
  getServiceScore(query: ServiceQuery): Promise<ServiceEvidence>;
  reviewService(review: ReviewSubmission): Promise<ReviewResult>;
}

export class McpCrowdCodeAdapter implements CrowdCodeAdapter {
  constructor(private readonly connection: McpConnection) {}

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
      payment_reference: review.paymentReference,
      ...(review.apiEndpoint ? { api_endpoint: review.apiEndpoint } : {}),
      ...(review.paymentProvider ? { payment_provider: review.paymentProvider } : {}),
      ...(review.paymentProof ? { payment_proof: review.paymentProof } : {}),
      ...(review.paymentTargetRef ? { payment_target_ref: review.paymentTargetRef } : {}),
      ...(review.taskContext ? { task_context: review.taskContext } : {})
    });
    return { ok: result.ok, error: result.error, raw: result.data };
  }
}

export function normalizeEvidence(raw: unknown): ServiceEvidence {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    ok: true,
    score: numberValue(record.score),
    nEff: numberValue(record.n_eff ?? record.nEff),
    unproven: typeof record.unproven === "boolean" ? record.unproven : undefined,
    summary: typeof record.summary === "string" ? record.summary : undefined,
    raw
  };
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
