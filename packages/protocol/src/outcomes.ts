import { z } from "zod";

/** User-facing failure copy; detailed diagnostics belong to events and ledgers. */
export const RUN_FAILURE_MESSAGE = "Something went wrong. You can retry or send another message.";

/** Typed run outcomes (plan section 7.3). */
export const RUN_OUTCOMES = [
  "completed",
  "idle",
  "waiting_for_funds",
  "waiting_for_approval",
  "waiting_for_delegation",
  "budget_exhausted",
  "user_stopped",
  "payment_unknown",
  "max_turns",
  "failed",
  "cancelled"
] as const;
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** Outcomes that expect a `run.resume` once an external condition clears. */
export const WAITING_OUTCOMES = [
  "waiting_for_funds",
  "waiting_for_approval",
  "waiting_for_delegation",
  "payment_unknown"
] as const satisfies readonly RunOutcome[];

export function isWaitingOutcome(outcome: RunOutcome): boolean {
  return (WAITING_OUTCOMES as readonly RunOutcome[]).includes(outcome);
}

/** Why a paused run is being resumed. Each cause maps to a waiting outcome. */
export const RESUME_CAUSES = [
  "approval_granted",
  "funds_available",
  "delegation_renewed",
  "payment_reconciled"
] as const;
export const ResumeCauseSchema = z.enum(RESUME_CAUSES);
export type ResumeCause = z.infer<typeof ResumeCauseSchema>;

/** Coarse live state reported by `run.state`. */
export const RunStateSchema = z.enum([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_funds",
  "waiting_for_delegation",
  "checkpointing",
  "cancelling",
  "finished"
]);
export type RunState = z.infer<typeof RunStateSchema>;
