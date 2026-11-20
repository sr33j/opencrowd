import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, executeTool, harnessFeedbackPath, OPEN_CROWD_TOOLS, SUBAGENT_TOOL_NAMES, TOOL_NAMES } from "@opencrowd/core";
import { redactHarnessFeedbackText, type Command, type Event } from "@opencrowd/protocol";
import { MachineWorker } from "../src/worker.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "harness-feedback-")); roots.push(dir); return dir; }
const feedback = {
  category: "limit", severity: "high", tool_name: "run_shell",
  summary: "run_shell kills a 4-minute ffmpeg render at the default 10 s timeout",
  details: "I rendered a 90 s clip with ffmpeg; the call died at 10 s and the error did not say a longer timeout_ms was allowed.",
  suggested_change: "Say the maximum in the timeout error: `exceeded 10000 ms; pass timeout_ms up to 600000`.",
};

describe("submit_harness_feedback", () => {
  it("is a runtime tool for the main loop, never a subagent's", () => {
    expect(TOOL_NAMES).toContain("submit_harness_feedback");
    expect(SUBAGENT_TOOL_NAMES).not.toContain("submit_harness_feedback");
    expect(OPEN_CROWD_TOOLS.find((t) => t.name === "submit_harness_feedback")?.parameters).toMatchObject({
      required: ["category", "summary", "details", "severity"],
      properties: { category: { enum: ["bug", "missing_tool", "limit", "prompt", "docs", "other"] }, severity: { enum: ["low", "medium", "high"] } } });
  });

  it("on the CLI writes one redacted line to a local file, dedupes by summary and keeps to five a day", async () => {
    const session = await createSession({ workspaceRoot: await root(), budgetCents: 100, approvalMode: "off" });
    const first = await executeTool("submit_harness_feedback", { ...feedback, details: `${feedback.details} My key sk-abcdefghijklmnopqrstuv and me@example.com, ocs_abcdefghijklmnopqrstuvwx.` }, { session });
    expect(first).toMatchObject({ ok: true, data: { status: "recorded", path: harnessFeedbackPath(session) } });
    const [line] = (await readFile(harnessFeedbackPath(session), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(line).toMatchObject({ category: "limit", severity: "high", tool_name: "run_shell", summary: feedback.summary, session_id: session.sessionId });
    expect(line.details).not.toMatch(/sk-abc|me@example|ocs_abc/);
    expect(line.details).toContain("[EMAIL]");
    // The same summary with other casing and spacing is the same report.
    expect(await executeTool("submit_harness_feedback", { ...feedback, summary: `  ${feedback.summary.toUpperCase()}!` }, { session }))
      .toMatchObject({ ok: true, data: { status: "duplicate", id: line.id } });
    for (let i = 2; i <= 5; i++) expect((await executeTool("submit_harness_feedback", { ...feedback, summary: `problem ${i}` }, { session })).ok).toBe(true);
    expect(await executeTool("submit_harness_feedback", { ...feedback, summary: "problem 6" }, { session }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/5 a day/) });
  });

  it("refuses fields over their limits or outside their lists, with what to fix", async () => {
    const session = await createSession({ workspaceRoot: await root(), budgetCents: 100, approvalMode: "off" });
    expect(await executeTool("submit_harness_feedback", { ...feedback, summary: "x".repeat(201) }, { session })).toMatchObject({ ok: false, error: "summary is 201 characters; the most is 200" });
    expect(await executeTool("submit_harness_feedback", { ...feedback, category: "task" }, { session })).toMatchObject({ ok: false, error: expect.stringMatching(/category must be one of/) });
    expect(await executeTool("submit_harness_feedback", { ...feedback, details: "" }, { session })).toMatchObject({ ok: false, error: "details is required" });
  });

  it("redacts secrets and personal data but leaves code and numbers alone", () => {
    expect(redactHarnessFeedbackText("Bearer abc.def.ghi call +1 (415) 555-0100 or 415-555-0100; postgres://u:p@h/db"))
      .toBe("Bearer [REDACTED] call [PHONE] or [PHONE]; postgres://[REDACTED]@h/db");
    expect(redactHarnessFeedbackText("timeout_ms: 600000 at 2026-11-20 10:00:00, line 1204")).toBe("timeout_ms: 600000 at 2026-11-20 10:00:00, line 1204");
  });

  it("on a hosted run goes to CrowdCode through the supervisor, and its progress summary is only its category, severity and tool", async () => {
    const home = await root(); const events: Event[] = []; let turn = 0;
    const hosted = vi.fn(async () => ({ ok: true, data: { status: "recorded", id: "f-1" } }));
    const provider = { complete: vi.fn(async () => turn++ === 0
      ? { content: "", toolCalls: [{ id: "f", name: "submit_harness_feedback", arguments: feedback }] }
      : { content: "done", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "rendered" } }] }) };
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-11-20T00:00:00Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Render a clip", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };
    const worker = new MachineWorker({ agentHome: home, provider: () => provider, hostedTools: () => hosted, output: (line) => { events.push(JSON.parse(line)); } });
    await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    expect(hosted).toHaveBeenCalledTimes(1);
    expect(hosted.mock.calls[0].slice(0, 2)).toEqual(["submit_harness_feedback", feedback]);
    expect(events.find((e) => e.type === "tool.started")?.payload).toMatchObject({ toolName: "submit_harness_feedback", input: { category: "limit", severity: "high", tool_name: "run_shell" } });
    expect(events.filter((e) => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
  });
});
