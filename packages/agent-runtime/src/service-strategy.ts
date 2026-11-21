import type { FinancialState } from "@opencrowd/protocol";

/**
 * Deterministic hints that make a run change strategy instead of repeating
 * itself (SRI-119). On 2026-11-17 a GTM-leads run called the same Reddit
 * user-search endpoint eight times, every answer `{"data":{}}`, never tried
 * the content search it had already inspected, and stopped with 29 of 100
 * leads and $2.26 of its $2.50 unspent. Nothing here blocks a call or forces
 * spending: it adds one hint to a tool result and asks once before an early
 * stop.
 */

/** What a run has done with paid services, kept across checkpoints. */
export interface ServiceLog {
  /** Endpoints inspected in this run, as "METHOD url" (no query string). */
  inspected: string[];
  /** Endpoints this run called, in the same form. */
  called: string[];
  /** Per endpoint, how many of its latest answers in a row were empty. */
  emptyStreaks: Record<string, number>;
  /** Empty answers this run received, from every endpoint. */
  emptyResults: number;
  /** Discovery calls answered so far, by what they asked (see discoveryKey). Absent in older checkpoints. */
  discovery?: Record<string, number>;
  /** Searches and tree reads since the last paid call that answered. */
  searchesSinceCall?: number;
}

export const emptyServiceLog = (): ServiceLog => ({ inspected: [], called: [], emptyStreaks: {}, emptyResults: 0 });

/** "METHOD url" without the query string or fragment, which carry the inputs. */
export function endpointKey(url: unknown, method: unknown): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  const bare = url.trim().replace(/[?#].*$/, "");
  return `${(typeof method === "string" && method.trim() ? method : "POST").toUpperCase()} ${bare}`;
}

/**
 * What a discovery call asked, so the same question is not paid for in model
 * turns again (w107 phase 0). On 2026-11-20 an image-research run called
 * find_paid_service("image generation") 9 times, browse_services
 * ("image.generate") 10 times and inspected the same four endpoints four or
 * five times each, over 54 turns, and bought nothing (run d20be67e).
 */
export function discoveryKey(name: string, args: Record<string, unknown>): string | undefined {
  const words = (value: unknown) => typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
  if (name === "find_paid_service") {
    const asked = words(args.origin) || words(args.task) || words(args.query);
    return asked ? `find_paid_service ${asked}` : undefined;
  }
  if (name === "browse_services") return words(args.node) ? `browse_services ${words(args.node)}` : undefined;
  if (name === "inspect_paid_service") {
    // A quote for a particular body is a different question; query-string variants of one endpoint are not.
    if (args.sample_body !== undefined) return undefined;
    const key = endpointKey(args.url, args.method);
    return key ? `inspect_paid_service ${key}` : undefined;
  }
  return undefined;
}

/** A discovery question may be asked this many times in a run; the next is refused unasked. */
export const DISCOVERY_REPEATS_MAX = 2;
/** After this many searches and tree reads without a paid call, each one says to decide. */
export const SEARCHES_BEFORE_DECIDING = 6;

/**
 * The refusal for a discovery call this run already made DISCOVERY_REPEATS_MAX
 * times. Nothing is called and nothing is paid; the earlier answers are in the
 * conversation.
 */
export function repeatedDiscovery(log: ServiceLog, name: string, args: Record<string, unknown>): string | undefined {
  const key = discoveryKey(name, args);
  const asked = key ? log.discovery?.[key] ?? 0 : 0;
  if (!key || asked < DISCOVERY_REPEATS_MAX) return undefined;
  return `Not run again: this run already made exactly this call (${key}) ${asked} times and the answers are above. `
    + "Choose from what they returned and call it with call_paid_service, try a different capability, "
    + "or, if nothing fits, say so and record the need with request_service. Nothing was paid.";
}

/**
 * Keys that frame an answer rather than carry it: an answer made only of
 * these (`{"status":200,"message":"OK","data":{}}`) holds no records.
 */
const ENVELOPE = new Set([
  "status", "statuscode", "message", "msg", "ok", "success", "error", "errors", "code", "detail",
  "cursor", "next", "nextcursor", "next_cursor", "nextpage", "next_page", "page", "pages", "pagesize", "page_size",
  "limit", "offset", "total", "totalcount", "total_count", "count", "has_more", "hasmore",
  "took", "elapsed", "time", "timestamp", "requestid", "request_id", "query", "q", "params", "meta", "metadata",
  "pagination", "version", "kind", "type", "object", "credits", "cost", "price", "usage", "charged"
]);

function contentLeaves(value: unknown, depth = 0): number {
  if (depth > 12 || value === null || value === undefined) return 0;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + contentLeaves(item, depth + 1), 0);
  if (typeof value === "object") {
    let sum = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!ENVELOPE.has(key.toLowerCase())) sum += contentLeaves(item, depth + 1);
    }
    return sum;
  }
  return 0;
}

/**
 * Whether a seller's answer holds no records: blank, or JSON with no content
 * outside its envelope (`{"results": []}`, `{"data": {}}`). A pending job
 * (`{"job_id": ...}`), a saved media file or any non-JSON text is not empty.
 */
export function isEmptyServiceData(data: unknown): boolean {
  if (data === undefined || data === null) return true;
  if (typeof data === "string") {
    const text = data.trim();
    if (!text) return true;
    if (!/^[[{]/.test(text)) return false;
    try { return contentLeaves(JSON.parse(text)) === 0; } catch { return false; }
  }
  return contentLeaves(data) === 0;
}

/**
 * Record one paid-service tool result in the log, and return the hint to put
 * on it when it is the second (or later) empty answer in a row from the same
 * endpoint.
 */
export function recordServiceResult(
  log: ServiceLog, name: string, args: Record<string, unknown>,
  result: { ok: boolean; data?: unknown }
): string | undefined {
  const asked = discoveryKey(name, args);
  if (asked && result.ok) {
    log.discovery = { ...(log.discovery ?? {}), [asked]: (log.discovery?.[asked] ?? 0) + 1 };
  }
  if ((name === "find_paid_service" || name === "browse_services") && result.ok) {
    const searches = (log.searchesSinceCall ?? 0) + 1;
    log.searchesSinceCall = searches;
    if (searches >= SEARCHES_BEFORE_DECIDING)
      return `${searches} searches and tree reads since this run's last paid call. Decide now: call the best fit you have already found `
        + "(results marked inspected need no inspect_paid_service), or stop and tell the owner what is missing, with request_service if a service would fix it.";
    return undefined;
  }
  if (name === "inspect_paid_service") {
    if (!result.ok) return undefined;
    const data = (result.data ?? {}) as Record<string, unknown>;
    const key = endpointKey(data.endpoint ?? args.url, data.method ?? args.method);
    if (key && !log.inspected.includes(key)) log.inspected.push(key);
    return undefined;
  }
  if (name !== "call_paid_service") return undefined;
  const key = endpointKey(args.url, args.method);
  if (!key) return undefined;
  if (!log.called.includes(key)) log.called.push(key);
  // Only an answer counts: a refusal, a cap or a failure is a different problem.
  if (!result.ok) return undefined;
  log.searchesSinceCall = 0;
  const answer = (result.data ?? {}) as Record<string, unknown>;
  if (!isEmptyServiceData(answer.data)) {
    log.emptyStreaks[key] = 0;
    return undefined;
  }
  log.emptyResults += 1;
  const streak = (log.emptyStreaks[key] ?? 0) + 1;
  log.emptyStreaks[key] = streak;
  if (streak < 2) return undefined;
  const others = log.inspected.filter((other) => other !== key);
  return `${streak} empty results in a row from ${key}: inspect its parameters, or try a different service or mode`
    + (others.length ? ` you already inspected (${others.slice(0, 5).join(", ")})` : " (find_paid_service with the capability you need)")
    + ", before calling it again.";
}

/** Nouns that count time, money or length, never the things a task asks for. */
const NOT_A_TARGET = /^(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|cents?|dollars?|usd|usdc|tokens?|percent|times|steps?|turns?|words?|characters?|chars?|sentences?|paragraphs?|pages?|lines?|bytes?|kb|mb|gb|ms|calls?|retries|attempts?|runs?|tries)$/i;
const TARGET = /(?<![\w$.,:/-])(\d{1,5})(?![\d.,:%])\s+(?:[A-Za-z][\w/-]*,?\s+){0,4}?([A-Za-z][A-Za-z-]*s)\b/g;

/** The first explicit count a task asks for ("Find 100 useful individual GTM prospects"). */
export function taskTarget(task: string): { target: number; noun: string } | undefined {
  for (const match of task.matchAll(TARGET)) {
    const target = Number(match[1]);
    const noun = match[2];
    if (target < 3 || (target >= 1900 && target <= 2100) || NOT_A_TARGET.test(noun)) continue;
    return { target, noun: noun.toLowerCase() };
  }
  return undefined;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How many of the target an answer says it delivered: "32 of 100", or the
 * largest "N <the noun>" / "N rows/records/results" it states. Undefined when
 * the answer states no count, so an answer that only names a file never
 * reads as a shortfall.
 */
export function deliveredCount(answer: string, target: { target: number; noun: string }): number | undefined {
  const of = new RegExp(`(?<![\\w$.])(\\d{1,5})\\s*(?:of|out of|/)\\s*(?:the\\s+|a\\s+|an\\s+)?(?:target\\s+(?:of\\s+)?|goal\\s+(?:of\\s+)?)?${target.target}(?!\\d|\\.\\d)`, "i").exec(answer);
  if (of) return Number(of[1]);
  const singular = target.noun.replace(/ies$/, "y").replace(/s$/, "");
  const stems = [escape(singular), escape(target.noun), "rows?", "records?", "entries", "entry", "items?", "results?", "leads?", "candidates?"];
  const counted = new RegExp(`(?<![\\w$.,])(\\d{1,5})(?![\\d.,:%])\\s+(?:[\\w/-]+,?\\s+){0,3}?(?:${stems.join("|")})\\b`, "gi");
  let best: number | undefined;
  for (const match of answer.matchAll(counted)) best = Math.max(best ?? 0, Number(match[1]));
  return best;
}

/** The run delivered fewer than the count its task asked for, by its own account. */
export function countShortfall(task: string, answer: string | undefined): { delivered: number; target: number; noun: string } | undefined {
  if (!answer) return undefined;
  const target = taskTarget(task);
  if (!target) return undefined;
  const delivered = deliveredCount(answer, target);
  return delivered !== undefined && delivered < target.target ? { delivered, ...target } : undefined;
}

/** A run that has spent at most this share of its budget stopped early. */
export const EARLY_STOP_SPENT_SHARE = 0.5;

const dollars = (value: number) => `$${value.toFixed(2)}`;

/**
 * The one question asked of a run that stops early: most of its budget is
 * left, and it delivered less than its task's explicit count, or its paid
 * calls came back empty while services it inspected went untried.
 */
export function earlyStopNudge(input: { task: string; finalMessage?: string; financial: FinancialState; log: ServiceLog }): string | undefined {
  if (input.financial.status !== "available") return undefined;
  const run = input.financial.current_run;
  const limit = Number(run.budget_limit_usdc);
  const spent = Number(run.total_spent_usdc);
  if (!(limit > 0) || !Number.isFinite(spent) || spent > limit * EARLY_STOP_SPENT_SHARE) return undefined;
  const remaining = Math.max(0, Number(run.remaining_budget_usdc));
  const short = countShortfall(input.task, input.finalMessage);
  const untested = input.log.inspected.filter((key) => !input.log.called.includes(key));
  if (!short && !(untested.length && input.log.emptyResults > 0)) return undefined;
  const lead = short
    ? `You delivered ${short.delivered} of ${short.target} ${short.noun}`
    : `Your paid calls returned ${input.log.emptyResults} empty result${input.log.emptyResults === 1 ? "" : "s"}`;
  const options = untested.length
    ? `untested options ${untested.slice(0, 5).join(", ")}`
    : "services you have not tried yet (find_paid_service)";
  return `${lead} with ${dollars(remaining)} of ${dollars(limit)} left and ${options}. Either try the most promising one, or state exactly why stopping is justified. `
    + "An honest partial result is allowed; when you call complete_session again, give the complete answer, saying what you delivered against the target.";
}
