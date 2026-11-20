import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HARNESS_FEEDBACK_CATEGORIES, HARNESS_FEEDBACK_LIMITS, HARNESS_FEEDBACK_SEVERITIES, harnessFeedbackKey, redactHarnessFeedbackText } from "@opencrowd/protocol";
import type { SessionState } from "./types.js";

export type HarnessFeedbackCategory = typeof HARNESS_FEEDBACK_CATEGORIES[number];
export type HarnessFeedbackSeverity = typeof HARNESS_FEEDBACK_SEVERITIES[number];
export interface HarnessFeedback {
  category: HarnessFeedbackCategory;
  severity: HarnessFeedbackSeverity;
  summary: string;
  details: string;
  suggested_change?: string;
  tool_name?: string;
}

/** The fields, checked and redacted; throws with a message the agent can act on. */
export function parseHarnessFeedback(args: Record<string, unknown>): HarnessFeedback {
  const text = (key: keyof typeof HARNESS_FEEDBACK_LIMITS & string, required: boolean) => {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim() && !required)) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
    const limit = HARNESS_FEEDBACK_LIMITS[key];
    if (value.length > limit) throw new Error(`${key} is ${value.length} characters; the most is ${limit}`);
    return redactHarnessFeedbackText(value.trim());
  };
  const pick = <T extends string>(key: string, values: readonly T[]) => {
    if (!values.includes(args[key] as T)) throw new Error(`${key} must be one of ${values.join(", ")}`);
    return args[key] as T;
  };
  const suggested = text("suggested_change", false), tool = text("tool_name", false);
  return {
    category: pick("category", HARNESS_FEEDBACK_CATEGORIES),
    severity: pick("severity", HARNESS_FEEDBACK_SEVERITIES),
    summary: text("summary", true)!,
    details: text("details", true)!,
    ...(suggested ? { suggested_change: suggested } : {}),
    ...(tool ? { tool_name: tool } : {})
  };
}

/** Where a local (CLI) run keeps its feedback: one JSON line each, never sent anywhere. */
export function harnessFeedbackPath(session: SessionState): string {
  return join(session.workspaceRoot, "harness-feedback.jsonl");
}

/**
 * The CLI's `submit_harness_feedback`: appended to a local file the user can
 * read and send to CrowdCode if they choose (docs/commands.md). Nothing
 * leaves the machine. Same limits as hosted: five a day, one per summary.
 */
export async function recordLocalHarnessFeedback(session: SessionState, args: Record<string, unknown>, now = new Date()): Promise<Record<string, unknown>> {
  const feedback = parseHarnessFeedback(args);
  const path = harnessFeedbackPath(session);
  const existing = (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as { summary?: string; created_at?: string; id?: string }; } catch { return {}; } });
  const key = harnessFeedbackKey(feedback.summary);
  const duplicate = existing.find((row) => typeof row.summary === "string" && harnessFeedbackKey(row.summary) === key);
  if (duplicate) return { status: "duplicate", id: duplicate.id, note: "This was already recorded; nothing more to do. Carry on with the task." };
  const today = existing.filter((row) => row.created_at && now.getTime() - Date.parse(row.created_at) < 24 * 3600_000).length;
  if (today >= HARNESS_FEEDBACK_LIMITS.perDay)
    throw new Error(`Feedback is limited to ${HARNESS_FEEDBACK_LIMITS.perDay} a day and that many are recorded; carry on with the task.`);
  const id = `local-${now.getTime().toString(36)}-${existing.length + 1}`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ id, created_at: now.toISOString(), session_id: session.sessionId, model: session.models?.main, ...feedback })}\n`, { mode: 0o600 });
  return { status: "recorded", id, path, note: "Saved locally; the OpenCrowd CLI never sends it. Carry on with the task." };
}
