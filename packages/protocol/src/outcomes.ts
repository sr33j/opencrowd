import { z } from "zod";

/** User-facing failure copy; detailed diagnostics belong to events and ledgers. */
export const RUN_FAILURE_MESSAGE = "Something went wrong. You can retry or send another message.";

/**
 * Plain words for a model request a seller refused outright, before any
 * payment, and undefined for every other failure, where the generic copy above
 * is the honest answer.
 *
 * On 2026-11-01 a seller refused two of an owner's runs over a body-size cap
 * and both ended "Something went wrong": the refusal was in the gateway's logs
 * and nowhere the owner could see it. The gateway relays the seller's status
 * and code now, and this is what that becomes on the owner's screen.
 */
export function upstreamRefusalSummary(error: unknown): string | undefined {
  const refusal = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (!refusal || typeof refusal !== "object" || refusal.name !== "HostedRequestError" || refusal.code !== "upstream_refused") return undefined;
  const detail = typeof refusal.message === "string" ? refusal.message.trim() : "";
  return `The model provider refused this request before any payment, so nothing was charged${detail ? `: ${detail}` : "."} You can retry or send another message.`;
}

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
