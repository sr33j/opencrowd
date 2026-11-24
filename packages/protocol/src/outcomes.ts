import { z } from "zod";

/** User-facing failure copy; detailed diagnostics belong to events and ledgers. */
export const RUN_FAILURE_MESSAGE = "Something went wrong. You can retry or send another message.";
/**
 * What a run paused at `payment_unknown` tells its owner. The model call was
 * cut off while its payment may have been in flight; the hosted reconciler
 * settles or releases that payment from the chain and resumes the run, which
 * replays a saved answer rather than buying it again.
 */
export const PAYMENT_RECONCILING_MESSAGE = "The model call was interrupted while its payment was in flight. CrowdCode is confirming that payment and will continue this run automatically; nothing is charged twice. You can also send a new message.";

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

/**
 * How a run CrowdCode ended says so, after the answer it delivered: "<answer>
 * \n\nStopped by CrowdCode: <reason>". Run adf318ab's owner read "User
 * stopped" for a run a failure breaker ended (2026-11-24).
 */
export const CROWDCODE_STOP = "Stopped by CrowdCode: ";

/** A summary split into the answer the run delivered and CrowdCode's reason for ending it. */
export function splitCrowdcodeStop(summary: string): { answer: string; reason?: string } {
  const at = summary.lastIndexOf(CROWDCODE_STOP);
  if (at === -1 || (at > 0 && !/\n\s*$/.test(summary.slice(0, at)))) return { answer: summary };
  return { answer: summary.slice(0, at).trim(), reason: summary.slice(at + CROWDCODE_STOP.length).trim() };
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
  /** CrowdCode ended the run (no progress, a gate, the output limit) after it delivered what it could. Never the owner's doing. */
  "stopped",
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
