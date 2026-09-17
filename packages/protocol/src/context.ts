/** Shared by the runtime and hosted gateway. Transport limits are bytes, not tokens. */
export const MODEL_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
export const MODEL_MAX_MESSAGES = 1000;
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

/** Only explicit model-context errors qualify; HTTP 400/413 alone never do. */
export function isContextWindowError(value: unknown): boolean {
  const error = value as { code?: unknown; message?: unknown; error?: unknown } | undefined;
  if (!error || typeof error !== "object") return false;
  if (["context_length_exceeded", "context_window_exceeded", "max_context_length_exceeded"].includes(String(error.code))) return true;
  if (typeof error.message === "string" && /maximum context length|context (?:length|window) (?:is )?exceeded|exceeds? (?:the )?(?:model.s? )?(?:maximum )?context (?:length|window)|prompt is too long/i.test(error.message)) return true;
  return error.error !== value && !!error.error && isContextWindowError(typeof error.error === "string" ? { message: error.error } : error.error);
}
