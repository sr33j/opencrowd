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
