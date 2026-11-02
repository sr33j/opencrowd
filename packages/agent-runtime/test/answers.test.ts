import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, executeTool } from "@opencrowd/core";
import { atomicUsdc, stripReasoning, type Command, type Event, type FinancialState } from "@opencrowd/protocol";
import type { EconomyGateway } from "@opencrowd/economy";
import { economyTools } from "../src/economy-tools.js";
import { runAgentTaskDetailed, type LlmMessage, type LlmProvider, type LlmResponse, type ToolExecutor } from "../src/index.js";
import { MachineWorker, RuntimePause } from "../src/worker.js";

/**
 * A finished answer has to reach the owner. These are the four ways the
 * SRI-60 reliability sweep found production losing or garbling one on the
 * very turn that had succeeded.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function tempRoot() { const dir = await mkdtemp(join(tmpdir(), "answers-")); roots.push(dir); return dir; }
async function session() { return createSession({ workspaceRoot: await tempRoot(), budgetCents: 1000, approvalMode: "auto", shellEnabled: true }); }
const runId = randomUUID();
const financial = (): FinancialState => ({
  status: "available", run_id: runId, currency: "USDC", observed_at: new Date().toISOString(),
  wallet: { balance_status: "available", balance_usdc: atomicUsdc(1_010_000n), reserved_usdc: "0.000000", available_usdc: atomicUsdc(1_010_000n) },
  current_run: { inference_spent_usdc: "0.005698", service_spent_usdc: "0.000000", total_spent_usdc: "0.005698",
    reserved_usdc: "0.000000", budget_limit_usdc: "1.000000", remaining_budget_usdc: "0.994302",
    per_call_approval_threshold_usdc: "0.100000", approval_mode: "auto" } });
const answer = "The SHA-256 of `hello` begins 2cf24dba5fb0.";
const complete = (text: string, content = ""): LlmResponse => ({ content, toolCalls: [{ id: `done-${text.length}`, name: "complete_session", arguments: { final_message: text } }] });
/** The CrowdCode reflection gate, as hosted runs have it. */
function reflection(extra: Partial<EconomyGateway> = {}) {
  return economyTools({
    definitions: () => [{ name: "request_service", description: "Request a missing service", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, data: { enabled: true } }),
    hasPendingRequiredReviews: async () => false,
    ...extra,
  });
}

describe("SRI-65: the financial snapshot is not the owner's turn", () => {
  /**
   * A model that, like gpt-5.6-luna, gpt-4.1-nano and glm-5.3-flash did in
   * production, answers whatever user-role text it read last.
   */
  const suggestible: LlmProvider = { complete: async messages => {
    const last = messages.at(-1)!;
    if (last.role === "tool") return complete(answer);
    if (last.content.startsWith("Current hosted financial snapshot: "))
      return complete("Snapshot received and noted as authoritative. No additional action taken.");
    return { content: "", toolCalls: [{ id: "sh", name: "run_shell", arguments: { command: "printf hello | sha256sum" } }] };
  } };

  it("answers the owner after a tool call, not the snapshot", async () => {
    const requests: LlmMessage[][] = [];
    const result = await runAgentTaskDetailed(await session(), "Use the shell to compute the SHA-256 of 'hello'.", {
      hosted: true, runId, knowledge: false, financialState: async () => financial(),
      toolExecutor: shell(async () => ({ ok: true, data: { stdout: "2cf24dba5fb0a30e  -\n", exit_code: 0 } })),
      provider: { complete: async (messages, context) => { requests.push(structuredClone(messages)); return suggestible.complete(messages, context); } },
    });
    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toBe(answer);
    expect(String(result.summary.final_message)).not.toMatch(/financial snapshot|snapshot received|hosted financial/i);
    // The owner's words are the last thing in every request that has them.
    expect(requests[0].at(-1)!.content.endsWith("Use the shell to compute the SHA-256 of 'hello'.")).toBe(true);
    expect(requests[1].at(-1)!.role).toBe("tool");
  });

  it("keeps the note off a tool result and on the latest user message after a steering message", async () => {
    const requests: LlmMessage[][] = [];
    let turn = 0;
    const result = await runAgentTaskDetailed(await session(), "Start", {
      hosted: true, runId, knowledge: false, financialState: async () => financial(),
      inbox: { pending: async () => turn === 1 ? [{ id: "m", prompt: "Also say hi." }] : [], delivered: async () => { turn = 2; } },
      provider: { complete: async messages => {
        requests.push(structuredClone(messages)); turn += 1;
        return turn === 1 ? { content: "", toolCalls: [{ id: "b", name: "get_budget_status", arguments: {} }] } : complete("Hi.");
      } },
    });
    expect(result.summary.final_message).toBe("Hi.");
    const last = requests[1].at(-1)!;
    expect(last).toMatchObject({ role: "user" });
    expect(last.content).toMatch(/^\[Automatic note from CrowdCode[\s\S]*\]\n\nAlso say hi\.$/);
    expect(requests[1].filter(m => m.content.includes("Current hosted financial snapshot: "))).toHaveLength(1);
  });
});

describe("SRI-62: housekeeping that fails does not throw the answer away", () => {
  it.each([
    ["a lost gateway reply", () => new RuntimePause("payment_unknown", "op", "Model request interrupted; payment status needs reconciliation.")],
    ["a gateway 503", () => new Error("Hosted bridge request failed (503)")],
  ])("delivers the held answer when the housekeeping model call hits %s", async (_label, failure) => {
    const tools = reflection();
    const provider = { complete: vi.fn().mockResolvedValueOnce(complete(answer)).mockRejectedValueOnce(failure()) };
    const result = await runAgentTaskDetailed(await session(), "hash it", { provider, dynamicTools: tools, completionGate: tools.completionGate, knowledge: false });
    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toBe(answer);
    expect(String(result.summary.housekeeping_error)).toContain("housekeeping model call failed");
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("delivers the held answer when a housekeeping tool throws", async () => {
    const tools = reflection({ execute: async (name: string) => {
      if (name === "request_service") throw new RuntimePause("waiting_for_approval", "op", "Spending approval required.");
      return { ok: true, data: { enabled: true } };
    } });
    const provider = { complete: vi.fn().mockResolvedValueOnce(complete(answer))
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "r", name: "request_service", arguments: { input: "x" } }] }) };
    const result = await runAgentTaskDetailed(await session(), "hash it", { provider, dynamicTools: tools, completionGate: tools.completionGate, knowledge: false });
    expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
  });

  it("still fails a run whose model call fails before any answer exists", async () => {
    const provider = { complete: vi.fn().mockRejectedValue(new Error("Hosted bridge request failed (503)")) };
    await expect(runAgentTaskDetailed(await session(), "hash it", { provider })).rejects.toThrow("503");
  });

  it("still stops a run the gate blocks twice before any answer exists", async () => {
    const provider = { complete: vi.fn().mockResolvedValue({ content: " ", toolCalls: [] }) };
    const result = await runAgentTaskDetailed(await session(), "hash it", { provider, completionGate: async () => "a review is owed" });
    expect(result.outcome).toBe("stopped");
  });

  it("still honours a cancellation during housekeeping", async () => {
    const controller = new AbortController();
    const tools = reflection();
    const provider = { complete: vi.fn().mockResolvedValueOnce(complete(answer))
      .mockImplementationOnce(async () => { controller.abort(); throw new Error("aborted"); }) };
    await expect(runAgentTaskDetailed(await session(), "hash it", { provider, signal: controller.signal, completionGate: tools.completionGate }))
      .rejects.toThrow();
  });

  it("finishes the hosted run completed, with the answer, when the housekeeping call pauses", async () => {
    const { events } = await hostedRun([
      async () => complete(answer),
      async (_m, context) => { throw new RuntimePause("payment_unknown", context!.operationId!, "Model request interrupted; payment status needs reconciliation."); },
    ]);
    const finished = events.filter(e => e.type === "run.finished").at(-1)!;
    expect(finished.payload).toMatchObject({ outcome: "completed", summary: answer });
    // The failed call is still on the record for whoever investigates it.
    expect(events.some(e => e.type === "model.finished" && e.payload.status === "blocked")).toBe(true);
  });
});

describe("SRI-66: owners read the answer, not our bookkeeping", () => {
  it("does not show the housekeeping turn's words as part of the reply", async () => {
    const { events } = await hostedRun([
      async () => complete(answer, "Computing done."),
      async () => complete("Acknowledged.", "</think>\n\nEverything worked well and cheaply with local text scanning at $0 cost — no paid service would have improved the outcome."),
    ]);
    const said = events.filter(e => e.type === "assistant.message").map(e => e.payload.content);
    expect(said).toEqual(["Computing done."]);
    expect(events.filter(e => e.type === "run.finished").at(-1)!.payload).toMatchObject({ outcome: "completed", summary: answer });
  });

  it("strips a model's leftover reasoning from what the owner reads", async () => {
    const { events } = await hostedRun([
      async () => ({ content: "Let me think about the hash.</think>\n\nIt is 2cf24dba5fb0.", toolCalls: [] }),
    ], { gate: false });
    expect(events.filter(e => e.type === "assistant.message").map(e => e.payload.content)).toEqual(["It is 2cf24dba5fb0."]);
    expect(events.filter(e => e.type === "run.finished").at(-1)!.payload.summary).toBe("It is 2cf24dba5fb0.");
  });

  it.each([
    ["<think>plan</think>\n\nAnswer.", "Answer."],
    ["reasoning\n</think>\nAnswer.", "Answer."],
    ["</think>", ""],
    ["Answer only.", "Answer only."],
    ["Explain what <think> and </think> tags do.", "Explain what <think> and </think> tags do."],
  ])("stripReasoning(%j) is %j", (input, expected) => {
    expect(stripReasoning(input)).toBe(expected);
  });
});

describe("SRI-63: a malformed tool call is a tool error, not a failed run", () => {
  it("tells the model its arguments were not JSON and lets it call again", async () => {
    const requests: LlmMessage[][] = [];
    const provider = { complete: vi.fn(async (messages: LlmMessage[]) => {
      requests.push(structuredClone(messages));
      if (requests.length === 1) return { content: "", toolCalls: [{ id: "bad", name: "run_shell", arguments: {}, invalidArguments: '{"command": "echo }' }] };
      if (requests.length === 2) return { content: "", toolCalls: [{ id: "ok", name: "run_shell", arguments: { command: "echo hi" } }] };
      return complete("hi");
    }) };
    const executed: unknown[] = [];
    const result = await runAgentTaskDetailed(await session(), "say hi", { provider, toolExecutor: shell(async args => { executed.push(args); return { ok: true, data: { stdout: "hi" } }; }) });
    expect(result).toMatchObject({ outcome: "completed", summary: { final_message: "hi" } });
    expect(executed).toEqual([{ command: "echo hi" }]);
    const error = JSON.parse(requests[1].at(-1)!.content).result.error;
    expect(error).toContain("not a valid JSON object");
    // The raw text is for the error; the history a provider is sent keeps the call's shape.
    expect(requests[1].find(m => m.role === "assistant")!.toolCalls![0]).not.toHaveProperty("invalidArguments");
  });

  it("finishes with the reply's own text when complete_session's arguments are broken", async () => {
    const provider = { complete: vi.fn().mockResolvedValueOnce({ content: "A stock represents an ownership share in a company.",
      toolCalls: [{ id: "c", name: "complete_session", arguments: {}, invalidArguments: '{"final_message": "}"Acknowledged.' }] }) };
    const result = await runAgentTaskDetailed(await session(), "What is a stock?", { provider });
    expect(result).toMatchObject({ outcome: "completed", summary: { final_message: "A stock represents an ownership share in a company." } });
  });

  it("finishes with the held answer when the housekeeping complete_session is broken (venice/qwen-3-7-plus)", async () => {
    const tools = reflection();
    const provider = { complete: vi.fn().mockResolvedValueOnce({ content: "A stock represents an ownership share in a company.", toolCalls: [] })
      .mockResolvedValueOnce({ content: "", finishReason: "tool_calls",
        toolCalls: [{ id: "c", name: "complete_session", arguments: {}, invalidArguments: '{"final_message": "}"Acknowledged.' }] }) };
    const result = await runAgentTaskDetailed(await session(), "What is a stock?", { provider, dynamicTools: tools, completionGate: tools.completionGate, knowledge: false });
    expect(result).toMatchObject({ outcome: "completed", summary: { final_message: "A stock represents an ownership share in a company." } });
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });
});

/** A fake run_shell; every other built-in tool is the real one. */
const shell = (run: (args: Record<string, unknown>) => ReturnType<ToolExecutor>): ToolExecutor =>
  async (name, args, context) => name === "run_shell" ? run(args) : executeTool(name, args, context);

type Step = (messages: LlmMessage[], context?: { operationId?: string }) => Promise<LlmResponse>;
/** One hosted run through the real worker, with the reflection gate on unless told otherwise. */
async function hostedRun(steps: Step[], options: { gate?: boolean } = {}) {
  const events: Event[] = [];
  let call = 0;
  const economy = {
    definitions: () => [{ name: "request_service", description: "Request a missing service", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, data: { enabled: true } }),
    hasPendingRequiredReviews: async () => false,
  } as unknown as EconomyGateway;
  const worker = new MachineWorker({ agentHome: await tempRoot(), output: (line: string) => { events.push(JSON.parse(line)); },
    provider: () => ({ complete: async (messages, context) => steps[Math.min(call++, steps.length - 1)](messages, context) }),
    ...(options.gate === false ? {} : { economy: () => economy }) });
  await worker.initialize();
  const start: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-11-02T00:00:00Z", type: "run.start",
    payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Compute the hash", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };
  await worker.handleLine(JSON.stringify(start));
  await worker.drain();
  return { events };
}
