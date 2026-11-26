/**
 * When a hosted run re-reads its money (w124, harness experiment 2).
 *
 * `every_step`, the default, reads the hosted financial state before every
 * model call, after every model call and after every tool call: 2 + k reads
 * for a turn with k tool calls. Each read is a supervisor round trip to
 * control and about ten queries there.
 *
 * None of those reads guards money. The gateway reserves and settles every
 * payment against the wallet, the run's budget and the owner's approvals, and
 * it is the gateway that refuses a payment the money does not cover (the
 * runtime then pauses or stops on that refusal, not on anything it read). The
 * snapshot only feeds what the model is told: the "Money:" line,
 * `get_budget_status`, `complete_session`'s budget and the early-stop nudge.
 *
 * `on_change` keeps the snapshot and reads again only when it may be wrong:
 *
 * - **money moved**: after a model call (its payment settled), and after any
 *   tool that is not known to be free (a paid call, a transfer, a subagent,
 *   anything unknown). The first tool result after a model call reads, so the
 *   line it carries includes that call's charge, as before;
 * - **it is old**: more than `MONEY_READ_MAX_AGE_MS` since the last read, for
 *   what this run does not see happen (an owner's top-up, a sibling spending
 *   from a shared wallet, a seller releasing a hold);
 * - **something else is spending**: while a background subagent runs, every
 *   point reads, as `every_step` does;
 * - **it was asked for**: `get_budget_status` and `complete_session` always
 *   read (neither is free).
 *
 * The allowed staleness: a line never misses a payment this run made before
 * it (own spending is exact), and what moved outside the run is at most
 * `MONEY_READ_MAX_AGE_MS` old when a line carries it. A turn whose tools are
 * all free reads once instead of 2 + k times.
 */
export type MoneyReads = "every_step" | "on_change";

export const MONEY_READ_MAX_AGE_MS = 30_000;

/**
 * Tools that neither move this run's money nor report it. Everything else
 * reads after it runs. A name missing here only costs a read.
 */
export const MONEY_FREE_TOOLS: ReadonlySet<string> = new Set([
  // Built-in, local to the sandbox. run_shell holds no keys: it cannot pay.
  "save_file", "read_file", "list_files", "run_shell",
  // CrowdCode's free tools: discovery, inspection and reading what was paid for.
  "crowdcode_status", "set_crowdcode_enabled", "request_service", "list_my_reviews", "delete_my_review",
  "read_service", "browse_services", "find_paid_service", "inspect_paid_service", "submit_harness_feedback",
]);

/** The flag's value from the environment (`OPENCROWD_MONEY_READS`), or undefined for the default. */
export function moneyReadsFromEnv(env: NodeJS.ProcessEnv = process.env): MoneyReads | undefined {
  const value = env.OPENCROWD_MONEY_READS?.trim();
  return value === "on_change" || value === "every_step" ? value : undefined;
}

export interface MoneyReader {
  readonly mode: MoneyReads;
  /** Before a model call: whether to read now. */
  beforeModel(live: boolean): boolean;
  /** A model call returned: its payment has settled (or was refused). */
  afterModel(): boolean;
  /** A tool returned: whether to read now. */
  afterTool(name: string, live: boolean): boolean;
  /** A read finished. A failed one leaves the snapshot due, so the next point tries again. */
  read(ok: boolean): void;
}

/** The read policy; the caller performs the read when a method answers true, then calls `read()`. */
export function moneyReader(mode: MoneyReads = "every_step", now: () => number = Date.now,
  maxAgeMs = MONEY_READ_MAX_AGE_MS): MoneyReader {
  let dirty = true;
  let readAt = Number.NEGATIVE_INFINITY;
  const due = (live: boolean) => dirty || live || now() - readAt > maxAgeMs;
  return {
    mode,
    beforeModel: (live) => mode === "every_step" || due(live),
    afterModel: () => { dirty = true; return mode === "every_step"; },
    afterTool: (name, live) => mode === "every_step" || !MONEY_FREE_TOOLS.has(name) || due(live),
    read: (ok) => { if (!ok) return; dirty = false; readAt = now(); },
  };
}
