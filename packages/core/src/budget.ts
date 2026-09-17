import type { SessionState } from "./types.js";
import { saveSession } from "./session.js";
import { randomUUID, createHash } from "node:crypto";
import { spendingDecision } from "@opencrowd/protocol";

export interface SpendingApproval {
  id: string; queryId: string; amountCents: number; description: string;
  perCallCents: number; queryLimitCents: number; committedCents: number;
  projectedCents: number; reasons: string[];
}
export type SpendingAnswer = { decision: "approve" | "decline"; queryBudgetCents?: number };
export type SpendingHandler = (request: SpendingApproval) => Promise<SpendingAnswer>;
const spendingHandlers = new WeakMap<SessionState, SpendingHandler>();
export function setSpendingHandler(state: SessionState, handler?: SpendingHandler) {
  if (handler) spendingHandlers.set(state, handler); else spendingHandlers.delete(state);
}
export class SpendingApprovalRequired extends Error {
  constructor(readonly approval: SpendingApproval) {
    super(`Spending approval required: ${approval.description}, up to $${(approval.amountCents / 100).toFixed(4)}. Resume this query after approving.`);
    this.name = "SpendingApprovalRequired";
  }
}
export class SpendingDeclined extends Error {
  constructor() { super("Spending was declined; this query stopped before payment."); this.name = "SpendingDeclined"; }
}
export async function beginQuery(state: SessionState, id: string = randomUUID()) {
  if (state.query?.id === id) return;
  if (state.query?.pending) throw new SpendingApprovalRequired(state.query.pending);
  state.query = { id, limitCents: state.budgetCents, startSpentCents: state.spentCents };
  await saveSession(state);
}
export async function approvePendingSpending(state: SessionState, answer: SpendingAnswer) {
  const pending = state.query?.pending;
  if (!pending || !state.query) throw new Error("No spending approval is pending");
  if (answer.decision === "decline") { delete state.query.pending; await saveSession(state); throw new SpendingDeclined(); }
  if (answer.queryBudgetCents !== undefined) {
    assertCents(answer.queryBudgetCents, "query budget");
    if (answer.queryBudgetCents <= state.query.limitCents || answer.queryBudgetCents < pending.projectedCents)
      throw new Error("The query budget must increase and cover this call plus committed spending");
    state.query.limitCents = answer.queryBudgetCents;
  }
  state.query.approved = { ...state.query.approved, [pending.id]: pending.amountCents };
  delete state.query.pending;
  await saveSession(state);
}

export interface Reservation {
  id: string;
  amountCents: number;
}

/** The session's cumulative cap is exhausted — a deterministic stop, not a fault. */
export class BudgetExhaustedError extends Error {
  constructor(neededCents: number, remainingCents: number) {
    super(`budget exceeded: need ${neededCents} cents, remaining ${remainingCents} cents`);
    this.name = "BudgetExhaustedError";
  }
}

// Serialize budget mutations per session so concurrent callers (parallel
// subagents and the main loop) can't interleave check/mutate/save cycles.
const sessionLocks = new Map<string, Promise<unknown>>();

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  sessionLocks.set(sessionId, next.then(() => undefined, () => undefined));
  return next;
}

export function remainingBudgetCents(state: SessionState): number {
  return Math.max(0, (state.query?.limitCents ?? state.budgetCents) - (state.spentCents - (state.query?.startSpentCents ?? 0)) - state.reservedCents);
}

export async function reserveBudget(state: SessionState, amountCents: number, action?: { description: string; identity: string; forceApproval?: boolean }): Promise<Reservation> {
  return withSessionLock(state.sessionId, async () => {
    assertCents(amountCents, "reservation");
    if (state.query) {
      const committed = state.spentCents - state.query.startSpentCents + state.reservedCents;
      const atomic = (cents: number) => String(Math.round(cents * 10000));
      const check = spendingDecision({ amount: atomic(amountCents), perCall: atomic(state.perCallCents ?? 100),
        queryLimit: atomic(state.query.limitCents), queryCommitted: atomic(committed) });
      const id = createHash("sha256").update(JSON.stringify([state.query.id, action?.identity ?? "call", amountCents])).digest("hex");
      const approved = state.query.approved?.[id] !== undefined && state.query.approved[id] >= amountCents;
      if (state.query.pending && state.query.pending.id !== id && !approved) throw new SpendingApprovalRequired(state.query.pending);
      if ((check.approvalRequired || action?.forceApproval) && !approved) {
        const approval: SpendingApproval = { id, queryId: state.query.id, amountCents, description: action?.description ?? "Paid call",
          perCallCents: state.perCallCents ?? 100, queryLimitCents: state.query.limitCents, committedCents: committed,
          projectedCents: committed + amountCents, reasons: check.reasons };
        if (state.query.pending && state.query.pending.id !== id) throw new SpendingApprovalRequired(state.query.pending);
        state.query.pending = approval;
        await saveSession(state);
        const handler = spendingHandlers.get(state);
        if (!handler) throw new SpendingApprovalRequired(approval);
        await approvePendingSpending(state, await handler(approval));
      }
      if (state.query.approved) delete state.query.approved[id];
    } else if (remainingBudgetCents(state) < amountCents) {
      throw new BudgetExhaustedError(amountCents, remainingBudgetCents(state));
    }
    state.reservedCents += amountCents;
    await saveSession(state);
    return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, amountCents };
  });
}

export async function finalizeReservation(
  state: SessionState,
  reservation: Reservation,
  chargedCostCents: number
): Promise<void> {
  return withSessionLock(state.sessionId, async () => {
    // Charged costs are frequently fractional cents (a cheap LLM call costs
    // well under 1¢) — unlike reservations, they are not required to be
    // integers, only real spend.
    if (!Number.isFinite(chargedCostCents) || chargedCostCents < 0) {
      throw new Error("charged cost must be a non-negative number of cents");
    }
    // Charged may legitimately exceed the reservation: upto-style x402
    // billing reconciles a ceiling to actual usage after the call, and the
    // money is already spent — record reality rather than throwing.
    state.reservedCents = Math.max(0, state.reservedCents - reservation.amountCents);
    state.spentCents = Math.round((state.spentCents + chargedCostCents) * 10_000) / 10_000;
    await saveSession(state);
  });
}

export async function releaseReservation(state: SessionState, reservation: Reservation): Promise<void> {
  return withSessionLock(state.sessionId, async () => {
    state.reservedCents = Math.max(0, state.reservedCents - reservation.amountCents);
    await saveSession(state);
  });
}

function assertCents(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 10000) {
    throw new Error(`${label} must be a non-negative amount of cents`);
  }
}
