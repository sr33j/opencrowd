import type { JsonValue } from "./primitives.js";
import { isSensitiveKey } from "./redact.js";

/** Bounded, explicitly marked diagnostic payloads. Never export credentials. */
export function scrubText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ph[csx]_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/\b((?:[A-Z_]*(?:SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_TOKEN)[A-Z_]*|authorization|cookie|signature|x-amz-signature)\s*[=:]\s*)[^\s&,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}

export function captureDetail(input: unknown, maxBytes = 96 * 1024) {
  let redacted = false;
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 30) return "[depth limit]";
    if (typeof value === "string") { const s = scrubText(value); redacted ||= s !== value; return s; }
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
    redacted, truncated: bytes > maxBytes, bytes };
}
