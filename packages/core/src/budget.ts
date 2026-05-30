import type { SessionState } from "./types.js";
import { saveSession } from "./session.js";

export interface Reservation {
  id: string;
  amountCents: number;
}

export function remainingBudgetCents(state: SessionState): number {
  return Math.max(0, state.budgetCents - state.spentCents - state.reservedCents);
}

export async function reserveBudget(state: SessionState, amountCents: number): Promise<Reservation> {
  assertCents(amountCents, "reservation");
  if (remainingBudgetCents(state) < amountCents) {
    throw new Error(`budget exceeded: need ${amountCents} cents, remaining ${remainingBudgetCents(state)} cents`);
  }
  state.reservedCents += amountCents;
  await saveSession(state);
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, amountCents };
}

export async function finalizeReservation(
  state: SessionState,
  reservation: Reservation,
  chargedCostCents: number
): Promise<void> {
  assertCents(chargedCostCents, "charged cost");
  if (chargedCostCents > reservation.amountCents) {
    throw new Error(`charged cost ${chargedCostCents} exceeds reserved cost ${reservation.amountCents}`);
  }
  state.reservedCents = Math.max(0, state.reservedCents - reservation.amountCents);
  state.spentCents += chargedCostCents;
  await saveSession(state);
}

export async function releaseReservation(state: SessionState, reservation: Reservation): Promise<void> {
  state.reservedCents = Math.max(0, state.reservedCents - reservation.amountCents);
  await saveSession(state);
}

function assertCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents`);
  }
}
