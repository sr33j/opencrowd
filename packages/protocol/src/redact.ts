/**
 * Key-based redaction applied to payloads before they cross the process
 * boundary. Matching is on the key name normalised to lowercase alphanumerics,
 * so `Authorization`, `x-api-key`, `refresh_token`, `Set-Cookie`, `apiKey`,
 * `clientSecret`, and `PRIVATE_KEY` are all removed. Token *counts*
 * (`maxTokens`, `inputTokens`, `tokenCount`, `tokenUsage`) are kept.
 * Over-redaction of an innocent `*key` field is preferred to leaking one.
 */
const SENSITIVE_KEY = /authorization|cookie|secret|password|passwd|credential|token(?!s$|count$|usage$)|keys?$/;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a deep copy of `value` with every sensitive key removed from every
 * nested plain object (including objects inside arrays). Non-object values
 * are returned unchanged; the input is never mutated.
 */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redact(item)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isSensitiveKey(key)) {
      out[key] = redact(item);
    }
  }
  return out as T;
}
