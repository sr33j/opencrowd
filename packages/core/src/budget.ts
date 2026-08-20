import type { SessionState } from "./types.js";
import { saveSession } from "./session.js";

export interface Reservation {
  id: string;
  amountCents: number;
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
  return Math.max(0, state.budgetCents - state.spentCents - state.reservedCents);
}

export async function reserveBudget(state: SessionState, amountCents: number): Promise<Reservation> {
  return withSessionLock(state.sessionId, async () => {
    assertCents(amountCents, "reservation");
    if (remainingBudgetCents(state) < amountCents) {
      throw new Error(`budget exceeded: need ${amountCents} cents, remaining ${remainingBudgetCents(state)} cents`);
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
    assertCents(chargedCostCents, "charged cost");
    // Charged may legitimately exceed the reservation: upto-style x402
    // billing reconciles a ceiling to actual usage after the call, and the
    // money is already spent — record reality rather than throwing.
    state.reservedCents = Math.max(0, state.reservedCents - reservation.amountCents);
    state.spentCents += chargedCostCents;
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
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents`);
  }
}
