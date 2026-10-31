import { HOSTED_CONTROL_TOOL_TIMEOUT_MS, SERVICE_BRIDGE_TIMEOUT_MS } from "@opencrowd/protocol";
import { SHELL_TIMEOUT_CEILING_MS } from "@opencrowd/core";

/**
 * The last wall between one tool call and a run that never answers.
 *
 * Every layer underneath this one now has its own deadline, and those are the
 * deadlines that produce a good error: they know which origin went quiet, and
 * whether a payment was in flight. This table exists because that reasoning
 * has to be done per call site and run 47a629fc proved we will miss one. A
 * backstop that is wrong by a minute still turns a dead run into a tool error
 * the model can work around.
 *
 * So every figure here sits comfortably *above* the tool's own internal
 * budget. If this wall is what fires, something below it failed to honour its
 * own deadline, and that is worth seeing in the logs rather than hiding behind
 * a tighter number here.
 */
const TOOL_DEADLINE_MS: Record<string, number> = {
  // Its own ceiling is PAY_TIMEOUT_MS (gateway + 30s) for the payment, plus
  // inspection, the reputation check and one reconcile before that.
  call_paid_service: SERVICE_BRIDGE_TIMEOUT_MS + 120_000,
  // Catalogs, a ranking call and a bounded probe sweep.
  find_paid_service: 180_000,
  inspect_paid_service: 120_000,
  read_service: 120_000,
  review_paid_service: 120_000,
  // Quote, sign, submit, then wait for the funds to land (TRANSFER_WAIT_MS).
  bridge_usdc: 300_000,
  deploy_service: HOSTED_CONTROL_TOOL_TIMEOUT_MS + 60_000,
  request_secret: HOSTED_CONTROL_TOOL_TIMEOUT_MS + 60_000,
  vault_request: HOSTED_CONTROL_TOOL_TIMEOUT_MS + 60_000
};
/** Local file and bookkeeping tools; none of them touches the network. */
const DEFAULT_TOOL_DEADLINE_MS = 120_000;

/**
 * `run_shell` enforces its own timeout on the child process and the host
 * raises the ceiling for heavy toolchains, so the backstop follows the ceiling
 * rather than a fixed figure — a 45-minute Mathlib build must not trip it.
 */
export function toolDeadlineMs(name: string, env: NodeJS.ProcessEnv = process.env): number {
  if (name === "run_shell") return SHELL_TIMEOUT_CEILING_MS + 120_000;
  void env;
  return TOOL_DEADLINE_MS[name] ?? DEFAULT_TOOL_DEADLINE_MS;
}

/**
 * What the model is told when the backstop fires.
 *
 * A paid call is the one case where "it did not finish" is not the whole
 * truth: the payment may have settled, so this says so in the same words the
 * gateway uses for its own unknown outcomes, and tells the model not to retry.
 * Anything else is safe to try again or route around.
 */
export function toolDeadlineError(name: string, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  if (name === "call_paid_service")
    return `the paid call did not finish within ${seconds}s and its payment state is unknown. It was NOT retried and must not be retried automatically; check get_wallet_status and tell the owner the payment needs reconciling from the ledger.`;
  return `${name} did not finish within ${seconds}s and was abandoned. Nothing was charged for it. Try a different approach, or the same one once more if it is likely to have been a transient stall.`;
}
