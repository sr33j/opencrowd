/** Shared by the runtime and hosted gateway. Transport limits are bytes, not tokens. */
export const MODEL_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
/**
 * What one model request body may be, in bytes, at the seller that accepts the
 * least.
 *
 * `MODEL_REQUEST_MAX_BYTES` is the transport's ceiling. This is the market's,
 * and it is far lower. Measured against both sellers on 2026-11-01:
 * CrowdCode's Venice reseller refuses a body above 6.75 MB (three bytes a
 * token of the largest context window Venice sells), and BlockRun takes 10 MB
 * but not 11, where it truncates the body and answers `400 INVALID_JSON`
 * rather than a 413. The gateway re-serializes tool calls and tool definitions
 * on the way out, so a conversation compacted to this still fits after that,
 * with room for a seller whose cap we have measured wrong.
 *
 * A catalogue context window is a seller's claim about tokens, and on
 * 2026-11-01 a wrong one (1,000,000 for a model behind a 512 KiB body cap)
 * cost an owner two runs. This is a fact about bytes, so the hosted rail
 * compacts against both.
 */
export const MODEL_SELLER_REQUEST_MAX_BYTES = 5 * 1024 * 1024;
export const MODEL_MAX_MESSAGES = 1000;
/** Non-streaming generation can take minutes. Outer hops also allow quoting,
 * signing and receipt verification; they must not abandon a live paid call. */
export const MODEL_PROVIDER_TIMEOUT_MS = 300_000;
export const MODEL_GATEWAY_TIMEOUT_MS = 420_000;
// A new run may wait for one cancelled request to drain before its own call.
export const MODEL_BRIDGE_TIMEOUT_MS = 2 * MODEL_GATEWAY_TIMEOUT_MS + 30_000;
export const SERVICE_PROVIDER_TIMEOUT_MS = 300_000;
export const SERVICE_GATEWAY_TIMEOUT_MS = 330_000;
/**
 * How long the runtime waits on the supervisor socket for a *paid* call, which
 * may queue behind a model request before its own provider call begins. Only
 * payments get this: it is thirteen minutes, and nothing that cannot already
 * have moved money deserves to be waited on for thirteen minutes. Every other
 * hosted tool uses HOSTED_TOOL_BRIDGE_TIMEOUT_MS.
 */
export const SERVICE_BRIDGE_TIMEOUT_MS = MODEL_GATEWAY_TIMEOUT_MS + SERVICE_GATEWAY_TIMEOUT_MS + 30_000;
/**
 * One unpaid supervisor-executed tool (a wallet read, a catalog read, a
 * review). The supervisor's own ceiling on these is 30-60s, so this only has
 * to outlast it, and a lost reply costs the model one honest tool error rather
 * than a run.
 */
export const HOSTED_TOOL_BRIDGE_TIMEOUT_MS = 90_000;
/** deploy_service, request_secret and vault_request: control's own cap is 170s. */
export const HOSTED_CONTROL_TOOL_TIMEOUT_MS = 185_000;
/** Allows inline generated media; decoded artifacts are limited to 24 MiB. */
export const SERVICE_RESPONSE_MAX_BYTES = 34 * 1024 * 1024;
export const DEFAULT_CONTEXT_WINDOW = 64_000;

/** Shared by model transports and the agent loop: partial tools cannot execute. */
export function isOutputLimitFinishReason(reason: string | undefined): boolean {
  return reason === "length" || reason === "max_tokens" || reason === "max_output_tokens";
}

/** A definitive context rejection, with payment state already resolved. */
export class ContextWindowExceeded extends Error {
  readonly code = "context_window_exceeded";
}

export function contextLimits(window?: number, maxOutput?: number, requestedOutput = 4096) {
  const contextWindow = window && Number.isInteger(window) && window >= 1024 && window <= 4_000_000
    ? window : DEFAULT_CONTEXT_WINDOW;
  const outputTokens = Math.max(1, Math.min(requestedOutput, maxOutput && maxOutput > 0 ? maxOutput : requestedOutput, Math.floor(contextWindow / 8)));
  const inputCeiling = contextWindow - outputTokens - Math.max(256, Math.ceil(contextWindow * 0.02));
  return { contextWindow, outputTokens, trigger: Math.min(Math.floor(contextWindow * 0.8), inputCeiling), target: Math.min(Math.floor(contextWindow * 0.4), inputCeiling) };
}

/**
 * What one turn's input may cost before the run starts summarising its older
 * history away, in US dollars.
 *
 * A chat pays for its whole history on every single turn, so the bill grows
 * with the square of the conversation. An owner's chat reached 178,000 input
 * tokens on a model at $0.396 per million (Venice's $0.33 and the reseller's
 * margin) and every further message cost $0.0708 — for a 40-token reply. The
 * window was a million tokens, so nothing compacted: the context limit was
 * never the binding one, the price was.
 *
 * Two cents a turn is roughly 60,000 tokens at that model's price, which is a
 * long working conversation. It is deliberately a *cost* and not a token
 * count: the same two cents buys 200,000 tokens on `openai/gpt-5.6-luna` and
 * 5,000 on `claude-opus-5-5`, and each of those is the right amount of history
 * to carry for what it costs.
 */
export const CONTEXT_COST_BUDGET_USD = 0.02;
/**
 * History no cost trigger may compact below. Two cents of the dearest models
 * is a few thousand tokens, which is not a conversation an agent can work in;
 * past this floor the right answer is a cheaper model, not a shorter memory.
 */
export const CONTEXT_MIN_HISTORY_TOKENS = 24_000;

/**
 * The input size at which a turn costs more than `CONTEXT_COST_BUDGET_USD`,
 * given what the seller charges per million input tokens and how much of the
 * last turn it served from its prompt cache.
 *
 * The cache is why this takes an observed hit rate rather than just a price.
 * Compaction and prompt caching pull in opposite directions: compacting
 * rewrites the prefix and throws away the cached history, while resending a
 * cached history is almost free — on `deepseek-v4-1-flash-uncensored` a cached
 * input token costs a fortieth of a fresh one. So the trigger is set by the
 * price actually being paid: while the cache keeps hitting, a long history
 * costs little and is kept; the turn it stops hitting, the trigger tightens to
 * the uncached price and the history is compacted.
 *
 * `undefined` when the seller's price is unknown — the window remains the only
 * limit, which is where this started.
 */
export function costTriggerTokens(prices?: {
  /** USD per million input tokens, as the buyer is charged. */
  inputPriceUsdPerMillion?: number;
  /** USD per million input tokens served from cache, where the seller discounts them. */
  cachedInputPriceUsdPerMillion?: number;
  /** Fraction of the last turn's input the seller said it read from cache. */
  cachedFraction?: number;
}): number | undefined {
  const input = prices?.inputPriceUsdPerMillion;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return undefined;
  const cachedPrice = prices?.cachedInputPriceUsdPerMillion;
  // A seller that discounts cached tokens without saying by how much is
  // treated as not discounting them at all.
  const cached = typeof cachedPrice === "number" && Number.isFinite(cachedPrice) && cachedPrice >= 0 && cachedPrice < input
    ? cachedPrice : input;
  const fraction = typeof prices?.cachedFraction === "number" && Number.isFinite(prices.cachedFraction)
    ? Math.min(1, Math.max(0, prices.cachedFraction)) : 0;
  const effective = input * (1 - fraction) + cached * fraction;
  if (effective <= 0) return undefined;
  return Math.max(CONTEXT_MIN_HISTORY_TOKENS, Math.floor((CONTEXT_COST_BUDGET_USD / effective) * 1_000_000));
}

/** A cent per thousand tokens, as this file's unit: ten dollars per million. */
export const centsPer1kToUsdPerMillion = (cents: number | undefined) =>
  typeof cents === "number" && Number.isFinite(cents) && cents > 0 ? cents * 10 : undefined;

/** Conservative fallback: ASCII ~3 chars/token; non-ASCII at its UTF-8 byte count.
 * Provider usage calibrates this upward. It is an estimate, never an exact tokenizer. */
export function estimateContextTokens(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  let ascii = 0, other = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 128) ascii++;
    else other += code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return Math.ceil(ascii / 3 + other) + 16;
}

export function estimateModelInput(messages: readonly unknown[], tools: unknown): number {
  return messages.reduce<number>((total, message) => total + estimateContextTokens(message), estimateContextTokens(tools) + 32);
}

/**
 * A seller's refusal that this exact body is too big for it.
 *
 * Unlike a context-window refusal this is about bytes, not tokens, and it is
 * always made before payment. HTTP 413 means it on its own; the sellers that
 * answer 400 have to say so in a code or a message. The run's answer to both
 * is the same: compact and ask again.
 */
export function isRequestTooLargeError(value: unknown, status?: number): boolean {
  if (status === 413) return true;
  const error = value as { code?: unknown; message?: unknown; error?: unknown } | undefined;
  if (!error || typeof error !== "object") return false;
  if (["request_too_large", "payload_too_large", "request_entity_too_large", "body_too_large"].includes(String(error.code))) return true;
  if (typeof error.message === "string" && /request (?:body|entity|payload) (?:is )?too large|payload too large|request too large|body must be at most/i.test(error.message)) return true;
  return error.error !== value && !!error.error && isRequestTooLargeError(typeof error.error === "string" ? { message: error.error } : error.error);
}

/** Only explicit model-context errors qualify; HTTP 400/413 alone never do. */
export function isContextWindowError(value: unknown): boolean {
  const error = value as { code?: unknown; message?: unknown; error?: unknown } | undefined;
  if (!error || typeof error !== "object") return false;
  if (["context_length_exceeded", "context_window_exceeded", "max_context_length_exceeded"].includes(String(error.code))) return true;
  if (typeof error.message === "string" && /maximum context length|context (?:length|window) (?:is )?exceeded|exceeds? (?:the )?(?:model.s? )?(?:maximum )?context (?:length|window)|prompt is too long/i.test(error.message)) return true;
  return error.error !== value && !!error.error && isContextWindowError(typeof error.error === "string" ? { message: error.error } : error.error);
}
