import { endpointKey } from "./service-strategy.js";

/**
 * How a run keeps going when something it tried fails (owner, 2026-11-24:
 * "our agents should be really persistent, really long-horizon").
 *
 * Run adf318ab, "write an erotic story for me and generate naughty pictures":
 * one image service refused two rephrased prompts with HTTP 400, a second
 * refused the third, and the runtime's three-failures breaker ended the run.
 * The story, which needed no service at all, was never written, and the owner
 * read "Stopped after 3 service call failures".
 *
 * Nothing here ends a run on a count of failures. A failure changes what the
 * run is told and what it may send again:
 *
 *  - an exact repeat of a paid call that failed is refused before it is sent
 *    (it would fail the same way, and may charge again);
 *  - an endpoint that failed and was never inspected must be inspected before
 *    it is called again, so a bad request is fixed from the schema;
 *  - an endpoint that failed three times is marked bad for the rest of the run;
 *  - every failure carries a strategy: read the seller's answer, fix the
 *    request or switch provider, and deliver what does not need it.
 *
 * Only a long streak of turns in which nothing worked ends the run, and even
 * then the run's last turn is the model delivering every part of the task it
 * can, with what is blocked and the next option (`wrapUpPrompt`).
 */

/** Kept across checkpoints, so a paused and resumed run remembers what failed. */
export interface PersistenceState {
  /** Calls that failed, by fingerprint, with their error: exact repeats are refused. */
  failedCalls: Record<string, string>;
  /** Paid endpoints ("METHOD url") that failed in this run. */
  endpointFailures: Record<string, { count: number; lastError: string }>;
  /** Turns in a row in which every tool call failed or was refused. */
  fruitlessTurns: number;
  /** The streak length at which the run was last told to change strategy. */
  nudgedAt?: number;
  /** Set when CrowdCode has asked the run to deliver what it has and finish. The tools offered stay the same (so the prompt cache holds); any but complete_session is refused. */
  wrapUp?: { reason: string; turn: number; kind: "max_turns" | "no_progress" };
  /** Empty endings asked about (once). */
  emptyAnswers?: number;
}

export const newPersistenceState = (): PersistenceState => ({ failedCalls: {}, endpointFailures: {}, fruitlessTurns: 0 });

/** Failures at one endpoint before it is marked bad for the rest of the run. */
export const BAD_ENDPOINT_FAILURES = 3;
/** Fruitless turns in a row before the run is told to change strategy (again every few turns after). */
export const STRATEGY_NUDGE_TURNS = 4;
/** Fruitless turns in a row before CrowdCode asks for the deliverable and ends the run. */
export const WRAP_UP_TURNS = 12;

/** Tools whose failure says nothing about the task: status reads and bookkeeping. */
const NEUTRAL_TOOLS = new Set(["complete_session", "get_budget_status", "get_wallet_status", "check_subagents", "submit_harness_feedback", "review_paid_service"]);
/** Discovery: a search finding nothing is not a failure, and finding something is not yet progress. */
const DISCOVERY_TOOLS = new Set(["find_paid_service", "browse_services", "inspect_paid_service"]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A body sent as a JSON string and the same body sent as an object are one request. */
const normalBody = (body: unknown) => {
  if (typeof body !== "string") return body;
  try { return JSON.parse(body); } catch { return body.trim(); }
};

/** What makes two calls the same request: for a paid call its method, full URL, body and headers; else all arguments. */
export function callFingerprint(name: string, args: Record<string, unknown>): string {
  if (name === "call_paid_service" || name === "read_service") {
    const method = String(args.method ?? (name === "call_paid_service" ? "POST" : "GET")).toUpperCase();
    return `${name} ${method} ${String(args.url ?? "").trim()} ${stable(normalBody(args.body))} ${stable(args.headers ?? null)}`;
  }
  const { max_cost_cents: _cap, purpose: _purpose, ...rest } = args;
  return `${name} ${stable(rest)}`;
}

const short = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * The refusal for a call this run must not send again, or undefined to let it
 * run. Paid calls only: their failures are deterministic often enough, and
 * cost money often enough, that the same request a second time is never the
 * next step. Other tools fail for reasons a retry can clear (a timeout, a
 * file another step is still writing), so they run again: a long streak of
 * failures is caught by the fruitless-turn count instead.
 */
export function refuseRepeat(state: PersistenceState, name: string, args: Record<string, unknown>, inspected: readonly string[]): string | undefined {
  if (name !== "call_paid_service") return undefined;
  const previous = state.failedCalls[callFingerprint(name, args)];
  if (previous !== undefined)
    return `Not sent: this exact request already failed in this run (${short(previous, 240)}). Sending it again unchanged would fail the same way and may charge again. `
      + "Change something first: fix the request from the seller's answer (inspect_paid_service shows its schema), use another provider (find_paid_service, browse_services), or do this part another way. "
      + "Meanwhile, deliver every part of the task that does not need this call.";
  const key = endpointKey(args.url, args.method);
  const failures = key ? state.endpointFailures[key] : undefined;
  if (!key || !failures) return undefined;
  if (failures.count >= BAD_ENDPOINT_FAILURES)
    return `Not sent: ${key} failed ${failures.count} times in this run (last: ${short(failures.lastError, 200)}) and is marked bad until the run ends. `
      + "Use another provider for this (find_paid_service, browse_services), or another way to do it, and deliver every part of the task that does not need it.";
  if (!inspected.includes(key))
    return `Not sent: ${key} failed in this run (${short(failures.lastError, 200)}) and has not been inspected. Call inspect_paid_service on it first (free) and fix the request from its schema, `
      + "or use another provider. Meanwhile, deliver every part of the task that does not need it.";
  return undefined;
}

/**
 * Record a tool result. A failed paid call returns the strategy the model
 * reads beside the error; anything else returns undefined. A refusal by this
 * module or by the owner's standing rule is not a new failure of the seller.
 */
export function recordResult(state: PersistenceState, name: string, args: Record<string, unknown>, result: { ok: boolean; error?: string }, refusal: boolean): string | undefined {
  if (result.ok || refusal) return undefined;
  const error = String(result.error ?? "failed");
  state.failedCalls[callFingerprint(name, args)] = short(error, 400);
  if (name !== "call_paid_service") return undefined;
  const key = endpointKey(args.url, args.method);
  if (!key) return undefined;
  const failures = { count: (state.endpointFailures[key]?.count ?? 0) + 1, lastError: short(error, 400) };
  state.endpointFailures[key] = failures;
  const others = Object.keys(state.endpointFailures).filter((other) => other !== key);
  return [
    `${key} failed${failures.count > 1 ? ` ${failures.count} times` : ""} in this run.`,
    "Read the seller's answer above: if the request was malformed, fix it (inspect_paid_service shows the schema); if the seller refused the content or is broken, switch to another provider (find_paid_service, browse_services) rather than rephrasing for the same one.",
    failures.count >= BAD_ENDPOINT_FAILURES ? "It is now marked bad for this run and will not be called again." : "The exact same request will not be sent again.",
    others.length ? `Also failed in this run: ${others.slice(0, 4).join(", ")}.` : "",
    "Do not stop: deliver every part of the task that does not need this call, and keep trying the rest another way.",
  ].filter(Boolean).join(" ");
}

/** What a finished tool batch says about progress. */
export function recordTurn(state: PersistenceState, results: { name: string; ok: boolean }[]): void {
  const counted = results.filter((r) => !NEUTRAL_TOOLS.has(r.name));
  if (!counted.length) return;
  if (counted.some((r) => r.ok && !DISCOVERY_TOOLS.has(r.name))) {
    state.fruitlessTurns = 0;
    state.nudgedAt = undefined;
    return;
  }
  // Searching after a failure is how a run changes provider: neither progress nor a failure.
  if (counted.every((r) => DISCOVERY_TOOLS.has(r.name))) return;
  if (counted.some((r) => !r.ok)) state.fruitlessTurns += 1;
}

function failureList(state: PersistenceState): string {
  const failed = Object.entries(state.endpointFailures).slice(-5).map(([key, f]) => `${key} (${f.count}×: ${short(f.lastError, 120)})`);
  return failed.length ? ` Failed so far: ${failed.join("; ")}.` : "";
}

/** A message telling the run to change strategy, when its streak calls for one. */
export function strategyNudge(state: PersistenceState): string | undefined {
  const streak = state.fruitlessTurns;
  if (streak < STRATEGY_NUDGE_TURNS || streak >= WRAP_UP_TURNS) return undefined;
  if (state.nudgedAt !== undefined && streak - state.nudgedAt < STRATEGY_NUDGE_TURNS) return undefined;
  state.nudgedAt = streak;
  return `CrowdCode: the last ${streak} turns made no progress: every call failed or was refused.${failureList(state)} `
    + "Change strategy rather than retrying: another provider or kind of service, a different approach to the same goal, or doing the step yourself. "
    + "First deliver every part of the task you can do without what is failing (for example, write the text now). Do not stop because of these failures.";
}

/** Whether the run should now deliver what it has and finish, and why. */
export function wrapUpReason(state: PersistenceState): string | undefined {
  if (state.wrapUp) return undefined;
  if (state.fruitlessTurns >= WRAP_UP_TURNS) return `${state.fruitlessTurns} turns in a row made no progress.${failureList(state)}`;
  return undefined;
}

/** The last turn's instruction: the deliverable, what is blocked, and the next option. */
export function wrapUpPrompt(reason: string): string {
  return `CrowdCode is ending this run: ${reason} This is your last turn: call only complete_session (any other tool will not run). `
    + "Call it now with your final answer to the owner: first, every part of the task you could do (write it out in full, not a summary of it); "
    + "then exactly what is still blocked and the error that blocked it; then the best next option (another service, a setting, or something the owner can do). "
    + "Do not apologise or ask to be allowed to continue.";
}

