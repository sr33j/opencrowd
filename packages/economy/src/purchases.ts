import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionState } from "@opencrowd/core";
import type { PaymentEvidence } from "./agentcash.js";

/**
 * Append-only purchase store: `sessions/<session-id>/purchases.jsonl`.
 * Every event is immutable; current state is a fold over the events, so a
 * submitted review survives restarts by construction. Full responses belong
 * in artifacts, not here.
 *
 * No purchase is ever owed a review. On hosted agents CrowdCode's gateway
 * judges every settled purchase itself, from its own record of the request,
 * the response and the payment; `review_paid_service` is optional notes.
 * Until 0.16.8 a paid purchase blocked the next one, and the run's
 * completion, until the agent reviewed it: an extra model turn per purchase
 * that cost more than the Exa search it reviewed, and 8 of 25 failed paid
 * calls in the fortnight before it went (SRI-115).
 */

export type PurchaseOutcome = "free" | "siwx" | "paid_success" | "paid_failure" | "unknown";

export interface PurchaseRecord {
  purchase_id: string;
  session_id: string;
  query_id?: string;
  created_at: string;
  endpoint: string;
  method: string;
  rail?: string;
  quoted_cost_cents: number;
  charged_cost_cents: number;
  outcome: PurchaseOutcome;
  artifact_path?: string;
  /**
   * Written by releases before 0.16.8, when a paid purchase required a
   * review before the next one. Read from old sessions, never acted on.
   */
  review_required?: boolean;
  /**
   * The call was refused on our side and never reached the service — no USDC
   * on a network it accepts, a spending cap, an unpayable rail. It is recorded
   * so the agent can see what it tried, and it is not reviewable: the provider
   * was never asked, so nothing here is evidence about them.
   */
  caller_error?: boolean;
  /**
   * Receipt evidence captured by the adapter (settlement reference, raw
   * proof header, payee). Stored for reviews; never rendered to the model
   * or normal CLI output.
   */
  evidence?: PaymentEvidence;
  /**
   * What the task needed from this call, as the agent stated it on
   * call_paid_service (SRI-135). The default task context of its review.
   */
  purpose?: string;
  notes?: string;
}

export type PurchaseEvent =
  | { type: "purchase"; record: PurchaseRecord }
  /** Old sessions only: CrowdCode was turned off with a review pending. */
  | { type: "review_skipped"; purchase_id: string }
  /**
   * `permanent` marks a rejection that is about the service's registration in
   * the CrowdCode directory rather than about this attempt — "service identity
   * conflict", for one — so the same review submitted again gets the same
   * answer.
   */
  | { type: "review_failed"; purchase_id: string; attempted_at: string; permanent?: boolean }
  | { type: "review_submitted"; purchase_id: string; rating: number; submitted_at: string };

export interface PurchaseState {
  record: PurchaseRecord;
  reviewStatus: "not_required" | "submitted";
  reviewRating?: number;
  /** CrowdCode refused a review of it for a reason a retry cannot change. */
  reviewRejected?: boolean;
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

export async function recordReviewFailed(
  session: SessionState,
  purchaseId: string,
  options: { permanent?: boolean } = {}
): Promise<void> {
  await appendPurchaseEvent(session, {
    type: "review_failed",
    purchase_id: purchaseId,
    attempted_at: new Date().toISOString(),
    ...(options.permanent ? { permanent: true } : {})
  });
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
      states.set(event.record.purchase_id, { record: event.record, reviewStatus: "not_required" });
    } else if (event.type === "review_failed") {
      const state = states.get(event.purchase_id);
      if (state && event.permanent) state.reviewRejected = true;
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
    created_at: record.created_at
  };
}
