/**
 * One oversized string used to be copied whole into the tool result, the run
 * journal, the progress event, the run-event details and the telemetry
 * preview. A 10 MB base64 audio body from a paid service multiplied into
 * hundreds of megabytes that way and the kernel killed a 512 MB executor
 * (design-docs/incidents, SRI-49). Cap every string where external bytes
 * cross into our own records, and say that it was cut.
 */

/** Generous for text a tool legitimately returns, far below what OOMs a worker. */
export const MAX_EXTERNAL_STRING_CHARS = 128 * 1024;

/**
 * Truncate every string in `value` to `maxChars`, marking what was removed.
 * Media is extracted to artifacts before this runs, so what gets cut here is
 * text nobody reads in full: the model sees a 12k summary of it anyway.
 */
export function capStrings(value: unknown, maxChars = MAX_EXTERNAL_STRING_CHARS, depth = 0): unknown {
  if (typeof value === "string") return capString(value, maxChars);
  if (depth > 30 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => capStrings(item, maxChars, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item, maxChars, depth + 1)]));
}

export function capString(value: string, maxChars = MAX_EXTERNAL_STRING_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}[truncated ${value.length - maxChars} chars]`;
}
