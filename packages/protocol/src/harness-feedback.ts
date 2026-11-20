import { scrubText } from "./telemetry.js";

/**
 * `submit_harness_feedback` (SRI-113): what an agent may tell CrowdCode about
 * its harness. The runtime's tool schema, the CLI's local file and CrowdCode's
 * control route all read these, so the three cannot drift apart.
 */
export const HARNESS_FEEDBACK_CATEGORIES = ["bug", "missing_tool", "limit", "prompt", "docs", "other"] as const;
export const HARNESS_FEEDBACK_SEVERITIES = ["low", "medium", "high"] as const;
export const HARNESS_FEEDBACK_LIMITS = { summary: 200, details: 4000, suggested_change: 8000, tool_name: 100, perDay: 5 } as const;

/**
 * Secrets out of the agent's own words: tokens, keys, credentialed URLs and
 * private-key-length hex (scrubText), vault placeholders (`ocs_…`), and the
 * plainest personal data, email addresses and phone numbers.
 */
export function redactHarnessFeedbackText(text: string): string {
  return scrubText(text)
    .replace(/\bocs_[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\b(?:0x)?[0-9a-fA-F]{64}\b/g, "[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
    .replace(/(?<![\w.:/-])(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w.:-])|\+\d{10,14}\b/g, "[PHONE]");
}

/** Two summaries that say the same thing up to case, spacing and punctuation are one report. */
export function harnessFeedbackKey(summary: string): string {
  return summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
