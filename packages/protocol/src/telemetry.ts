import type { JsonValue } from "./primitives.js";
import { capString } from "./limits.js";
import { isSensitiveKey } from "./redact.js";

/** Bounded, explicitly marked diagnostic payloads. Never export credentials. */
export function scrubText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ph[csx]_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/\b((?:[A-Z_]*(?:SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_TOKEN)[A-Z_]*|authorization|cookie|signature|x-amz-signature)\s*[=:]\s*)[^\s&,;]+/gi, "$1[REDACTED]")
    // Any scheme, not just http(s). A hosted agent's own stderr is scrubbed
    // with this, and the credential that turns up there is as likely to be in
    // a `postgres://user:password@host` DSN printed by psql, a failed
    // `redis://`, `mongodb+srv://` or `amqp://` connection, or a Python
    // traceback quoting the URL it was given, as it is to be in a web URL.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function captureDetail(input: unknown, maxBytes = 96 * 1024) {
  let redacted = false;
  // scrubText rewrites a string six times over; JSON.stringify copies it
  // again. Cut each string to what this preview could keep anyway, and stop
  // spending once the whole preview is accounted for, so the cost of
  // capturing a diagnostic stays proportional to maxBytes and not to the
  // megabytes an external service happened to return.
  let spent = 0, truncatedStrings = false;
  const budget = maxBytes * 8;
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 30) return "[depth limit]";
    if (typeof value === "string") {
      const limit = Math.min(maxBytes, Math.max(0, budget - spent));
      truncatedStrings ||= value.length > limit;
      const capped = capString(value, limit);
      spent += capped.length;
      const s = scrubText(capped);
      redacted ||= s !== capped;
      return s;
    }
    if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => {
        if (isSensitiveKey(key) || /^(signature|privatekey|seedphrase|mnemonic)$/i.test(key)) { redacted = true; return [key, "[REDACTED]"]; }
        return [key, clean(v, depth + 1)];
      }));
    }
    return typeof value === "bigint" ? value.toString() : value ?? null;
  };
  const value = clean(input), json = JSON.stringify(value), bytes = new TextEncoder().encode(json).length;
  // A preview is never represented as the complete result. Leave room for JSON escaping.
  return { value: bytes > maxBytes ? { preview: json.slice(0, Math.floor(maxBytes / 6)) } : value as JsonValue,
    redacted, truncated: bytes > maxBytes || truncatedStrings, bytes };
}
