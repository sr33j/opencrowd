import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionState } from "@opencrowd/core";
import type { PaymentEvidence } from "./agentcash.js";

/**
 * Append-only purchase store: `sessions/<session-id>/purchases.jsonl`.
 * Every event is immutable; current state is a fold over the events, so
 * pending required reviews survive restarts by construction. Full responses
 * belong in artifacts, not here.
 */

export const MAX_REVIEW_ATTEMPTS = 2;

export type PurchaseOutcome = "free" | "siwx" | "paid_success" | "paid_failure" | "unknown";

export interface PurchaseRecord {
  purchase_id: string;
  session_id: string;
  /** Review gates belong to the query that made this purchase. */
  query_id?: string;
  created_at: string;
  endpoint: string;
  method: string;
  rail?: string;
  quoted_cost_cents: number;
  charged_cost_cents: number;
  outcome: PurchaseOutcome;
  artifact_path?: string;
  /** Confirmed paid outcomes require a CrowdCode review before further purchases. */
  review_required: boolean;
  /**
   * Receipt evidence captured by the adapter (settlement reference, raw
   * proof header, payee). Stored for reviews; never rendered to the model
   * or normal CLI output.
   */
  evidence?: PaymentEvidence;
  notes?: string;
}

export type PurchaseEvent =
  | { type: "purchase"; record: PurchaseRecord }
  | { type: "review_skipped"; purchase_id: string }
  | { type: "review_failed"; purchase_id: string; attempted_at: string }
  | { type: "review_submitted"; purchase_id: string; rating: number; submitted_at: string };

export interface PurchaseState {
  record: PurchaseRecord;
  reviewStatus: "not_required" | "pending" | "submitted";
  reviewRating?: number;
  reviewAttempts?: number;
}

export function purchasesPath(session: SessionState): string {
  return join(session.sessionDir, "purchases.jsonl");
}

export function newPurchaseId(): string {
  return `pur_${randomUUID().slice(0, 12)}`;
}

export async function appendPurchase(session: SessionState, record: PurchaseRecord): Promise<void> {
  await appendPurchaseEvent(session, { type: "purchase", record });
}

export async function recordReviewSubmitted(session: SessionState, purchaseId: string, rating: number): Promise<void> {
  await appendPurchaseEvent(session, {
    type: "review_submitted",
    purchase_id: purchaseId,
    rating,
    submitted_at: new Date().toISOString()
  });
}

export async function recordReviewFailed(session: SessionState, purchaseId: string): Promise<void> {
  await appendPurchaseEvent(session, { type: "review_failed", purchase_id: purchaseId, attempted_at: new Date().toISOString() });
}

export async function skipPendingReviews(session: SessionState): Promise<void> {
  for (const state of await pendingRequiredReviews(session)) await appendPurchaseEvent(session, { type: "review_skipped", purchase_id: state.record.purchase_id });
}

async function appendPurchaseEvent(session: SessionState, event: PurchaseEvent): Promise<void> {
  const path = purchasesPath(session);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export async function listPurchases(session: SessionState): Promise<PurchaseState[]> {
  let text: string;
  try {
    text = await readFile(purchasesPath(session), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const states = new Map<string, PurchaseState>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event: PurchaseEvent;
    try {
      event = JSON.parse(line) as PurchaseEvent;
    } catch {
      continue;
    }
    if (event.type === "purchase") {
      states.set(event.record.purchase_id, {
        record: event.record,
        reviewStatus: event.record.review_required ? "pending" : "not_required"
      });
    } else if (event.type === "review_skipped") {
      const state = states.get(event.purchase_id);
      if (state) state.reviewStatus = "not_required";
    } else if (event.type === "review_failed") {
      const state = states.get(event.purchase_id);
      if (state) state.reviewAttempts = (state.reviewAttempts ?? 0) + 1;
    } else if (event.type === "review_submitted") {
      const state = states.get(event.purchase_id);
      if (state) {
        state.reviewStatus = "submitted";
        state.reviewRating = event.rating;
      }
    }
  }
  return [...states.values()];
}

export async function pendingRequiredReviews(session: SessionState): Promise<PurchaseState[]> {
  return (await listPurchases(session)).filter((state) => state.reviewStatus === "pending"
    && (state.reviewAttempts ?? 0) < MAX_REVIEW_ATTEMPTS
    && (!session.query || state.record.query_id === session.query.id));
}

/** Model-visible view of a purchase: no payment proof, payer, or tx hashes. */
export function redactPurchase(state: PurchaseState): Record<string, unknown> {
  const { record } = state;
  return {
    purchase_id: record.purchase_id,
    endpoint: record.endpoint,
    method: record.method,
    rail: record.rail,
    outcome: record.outcome,
    quoted_cost_cents: record.quoted_cost_cents,
    charged_cost_cents: record.charged_cost_cents,
    artifact_path: record.artifact_path,
    review_status: state.reviewStatus,
    review_deferred: state.reviewStatus === "pending" && (state.reviewAttempts ?? 0) >= MAX_REVIEW_ATTEMPTS,
    created_at: record.created_at
  };
}
