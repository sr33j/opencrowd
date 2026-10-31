/**
 * Wall-clock deadlines for work that waits on something outside this process.
 *
 * `AbortSignal.timeout` is not enough on its own, and run
 * 47a629fc-80d5-4c64-b9b7-13d2abb86f12 is why. Every HTTP probe in that run's
 * `find_paid_service` carried a ten-second signal, and the tool still never
 * returned: nine minutes later the supervisor gave up and the owner lost a
 * $0.57 run. An abort signal only cancels what the thing it was handed to can
 * cancel. `getaddrinfo` on libuv's four-thread pool cannot be interrupted at
 * all, so four lookups through an unresponsive resolver stall every lookup
 * behind them however many signals have fired; synchronous work — expanding a
 * provider's `$ref`-heavy OpenAPI document, say — never reaches the event loop
 * where the abort is delivered.
 *
 * A deadline is the layer above that. It does not try to cancel anything: it
 * stops *waiting*, and lets the caller answer honestly. Pair it with an abort
 * signal, which is still what frees the socket in the ordinary case.
 */

/** A deadline expired before the work it bounded finished. */
export class DeadlineExceeded extends Error {
  readonly code = "deadline_exceeded";
  constructor(
    /** What was being waited on, for the error the model and the owner see. */
    readonly stage: string,
    readonly timeoutMs: number
  ) {
    super(`${stage} did not finish within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * Reject with `DeadlineExceeded` once `timeoutMs` has passed, whatever the
 * work is still doing.
 *
 * The abandoned promise keeps running — there is no way to stop work that
 * ignores cancellation — so its eventual rejection is swallowed here rather
 * than left to crash the process as an unhandled rejection. Its eventual
 * *value* is discarded, which is why every caller must be able to say
 * something true about an unfinished operation; for a payment that means
 * reporting the outcome as unknown rather than failed.
 */
export function withDeadline<T>(work: () => Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = work();
  started.catch(() => undefined);
  const expiry = new Promise<never>((_resolve, reject) => {
    // Deliberately not unref'd. The deadline is the only thing that will ever
    // settle this race when the work does not, so a process whose sole pending
    // work is a deadline has to stay alive long enough to hear it fire.
    timer = setTimeout(() => reject(new DeadlineExceeded(stage, timeoutMs)), timeoutMs);
  });
  return Promise.race([started, expiry]).finally(() => clearTimeout(timer));
}

/**
 * A shared budget for a sequence of operations, so a sweep of probes cannot
 * cost the sum of their individual deadlines.
 */
export function deadline(totalMs: number, now: () => number = Date.now) {
  const expiresAt = now() + totalMs;
  return {
    /** Milliseconds left, never negative. */
    remaining: () => Math.max(0, expiresAt - now()),
    expired: () => now() >= expiresAt,
    /** The smaller of what is left and one operation's own ceiling. */
    slice: (operationMs: number) => Math.min(operationMs, Math.max(0, expiresAt - now()))
  };
}
