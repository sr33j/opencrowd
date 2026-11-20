import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, afterEach, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import { economyTools, endedShort, reflectionTrigger, REFLECTION_MIN_TURNS, SHORT_RUN_NUDGE } from "../src/economy-tools.js";
import { completionSignals, type CompletionSignals } from "../src/index.js";
import { runAgentTaskDetailed, type LlmResponse, type LoopCheckpoint } from "../src/index.js";
import { FileSteeringInbox } from "../src/inbox.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function session() {
  const root = await mkdtemp(join(tmpdir(), "opencrowd-completion-"));
  roots.push(root);
  return createSession({ workspaceRoot: root, approvalMode: "auto" });
}
const answer = "Target neural decoding roles. Build a streaming decoder and seek feedback from BCI engineers.";
const complete = (text = answer): LlmResponse => ({ content: "", toolCalls: [{ id: "done", name: "complete_session", arguments: { final_message: text } }] });
const empty: LlmResponse = { content: "", toolCalls: [] };
/** The reflection gate on a run that earned it (as if it had bought something). */
function reflection(enabled = true, definitions = ["request_service"]) {
  return qualifying(economyTools({
    definitions: () => definitions.map(name => ({ name, description: name, parameters: { type: "object" } })),
    execute: async () => ({ ok: true, data: { enabled } })
  }));
}
function qualifying<T extends { completionGate: (nudged?: boolean, run?: CompletionSignals) => Promise<string | undefined> }>(tools: T): T {
  return { ...tools, completionGate: (nudged?: boolean, run?: CompletionSignals) =>
    tools.completionGate(nudged, run ? { ...run, paidCalls: Math.max(run.paidCalls, 1) } : run) };
}

it("finishes immediately when a service request already satisfied reflection", async () => {
  const tools = reflection();
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "request", name: "request_service", arguments: { input: "a target role and a public profile", output: "ranked current openings", problem: "stale listings", price_per_call: 0.5 } }] })
    .mockResolvedValueOnce(complete())
    .mockResolvedValue(empty) };
  const result = await runAgentTaskDetailed(await session(), "Find a role and project", { provider, dynamicTools: tools, completionGate: tools.completionGate, knowledge: false });
  expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
  expect(provider.complete).toHaveBeenCalledTimes(2);
});

it.each(["tool", "text"])("preserves a %s answer when reflection ends with an empty response", async kind => {
  const tools = reflection();
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce(kind === "tool" ? complete() : { content: answer, toolCalls: [] })
    .mockResolvedValue({ content: " \n", toolCalls: [] }) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider, completionGate: tools.completionGate });
  expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
  expect(provider.complete).toHaveBeenCalledTimes(2);
  // Each tool call receives exactly one tool response, followed by an ordinary nudge.
  const messages = provider.complete.mock.calls[1][0];
  expect(messages.filter((m: { role: string }) => m.role === "tool")).toHaveLength(kind === "tool" ? 1 : 0);
  expect(messages.filter((m: { role: string }) => m.role === "user").at(-1))
    .toMatchObject({ role: "user", content: expect.stringContaining("reflect once") });
});

it("retains the answer and does not repeat reflection after a checkpoint restart", async () => {
  const current = await session();
  const tools = reflection();
  let saved: LoopCheckpoint | undefined;
  await expect(runAgentTaskDetailed(current, "Find a role", {
    provider: { complete: async () => complete() }, completionGate: tools.completionGate,
    onCheckpoint: async cp => {
      saved = cp;
      if (cp.completionNudges === 1) throw new Error("simulated restart");
    }
  })).rejects.toThrow("simulated restart");
  expect(saved).toMatchObject({ turn: 1, pendingFinalMessage: answer });
  const restarted = reflection();
  const provider = { complete: vi.fn(async () => empty) };
  const result = await runAgentTaskDetailed(current, "Find a role", { resume: saved, provider, completionGate: restarted.completionGate });
  expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
  expect(provider.complete).toHaveBeenCalledTimes(1);
});

it.each(["tool", "text"])("keeps the delivered answer when reflection closes with a %s summary", async kind => {
  const tools = reflection();
  const reflectionText = "Reflection completed. I submitted one paid-service demand.";
  const provider = { complete: vi.fn().mockResolvedValueOnce(complete())
    .mockResolvedValueOnce(kind === "tool" ? complete(reflectionText) : { content: reflectionText, toolCalls: [] }) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider, completionGate: tools.completionGate });
  expect(result.summary.final_message).toBe(answer);
  // The reflection is kept for diagnostics, never as the user-facing answer.
  expect(result.summary.reflection_note).toBe(reflectionText);
  expect(provider.complete.mock.calls[1][0].filter((m: { role: string }) => m.role === "user").at(-1).content)
    .toContain("already saved");
});

it("keeps the answer while the model files an optional review after completing", async () => {
  const tools = reflection();
  await tools.execute("request_service", {});
  const provider = { complete: vi.fn().mockResolvedValueOnce(complete())
    .mockResolvedValueOnce(complete("Review submitted.")) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider, completionGate: async () => undefined });
  expect(result.summary.final_message).toBe(answer);
});

it("does not hold an answer the gate blocked before one existed", async () => {
  let blocked = false;
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce({ content: " ", toolCalls: [] })
    .mockResolvedValueOnce(complete()) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider,
    completionGate: async () => (blocked ? undefined : ((blocked = true), "Reflect once before finishing.")) });
  expect(result.summary.final_message).toBe(answer);
});

it("replaces a held answer once the user sends a new instruction", async () => {
  const current = await session();
  const inbox = new FileSteeringInbox(join(current.sessionDir, "inbox.json"));
  const revised = "Here is the company history instead.";
  let calls = 0;
  const tools = reflection();
  const result = await runAgentTaskDetailed(current, "Find a role", { inbox, completionGate: tools.completionGate,
    provider: { complete: async () => {
      if (++calls === 1) return complete();
      if (calls === 2) { await inbox.push({ id: "new", prompt: "Instead, explain the company history." }); return empty; }
      return complete(revised);
    } }
  });
  expect(result.summary.final_message).toBe(revised);
});

it("fails explicitly on an empty response without an answer", async () => {
  await expect(runAgentTaskDetailed(await session(), "Find a role", { provider: { complete: async () => empty } }))
    .rejects.toThrow("ended without an answer");
});

it("preserves the whole continued answer, not just its output-limit prefix", async () => {
  const tools = reflection();
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce({ content: "Target neural ", toolCalls: [], finishReason: "length" })
    .mockResolvedValueOnce(complete("decoding roles."))
    .mockResolvedValue(empty) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider, completionGate: tools.completionGate });
  expect(result.summary.final_message).toBe("Target neural decoding roles.");
});

it("does not reuse a saved answer after the user changes the task", async () => {
  const current = await session();
  const inbox = new FileSteeringInbox(join(current.sessionDir, "inbox.json"));
  let calls = 0;
  const tools = reflection();
  await expect(runAgentTaskDetailed(current, "Find a role", { inbox, completionGate: tools.completionGate,
    provider: { complete: async () => {
      if (++calls === 1) return complete();
      if (calls === 2) await inbox.push({ id: "new", prompt: "Instead, explain the company history." });
      return empty;
    } }
  })).rejects.toThrow("ended without an answer");
  expect(calls).toBe(3);
});

it("asks only for the one-time reflection, never for a review (SRI-115)", async () => {
  const tools = reflection(true, ["request_service", "call_paid_service", "review_paid_service"]);
  const prompt = await tools.completionGate();
  expect(prompt).toContain("reflect once");
  expect(prompt).not.toMatch(/review_paid_service|required review/);
  // Once asked, or once restored as already nudged, nothing holds the run open.
  expect(await tools.completionGate()).toBeUndefined();
  expect(await reflection().completionGate(true)).toBeUndefined();
  // A service request already made counts as the reflection.
  const requested = reflection();
  await requested.execute("request_service", {});
  expect(await requested.completionGate()).toBeUndefined();
  // CrowdCode off, or no request_service tool: no gate at all.
  expect(await reflection(false).completionGate()).toBeUndefined();
  expect(await reflection(true, ["call_paid_service", "review_paid_service"]).completionGate()).toBeUndefined();
});

it("completes straight after an unreviewed paid purchase", async () => {
  const purchases: string[] = [];
  const tools = economyTools({
    definitions: () => ["call_paid_service", "review_paid_service"].map(name => ({ name, description: name, parameters: { type: "object" } })),
    execute: async name => { purchases.push(name); return { ok: true, data: { outcome: "paid_success", purchase_id: "pur_1", review: "automatic" } }; }
  });
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "buy", name: "call_paid_service", arguments: { url: "https://svc.example" } }] })
    .mockResolvedValueOnce(complete())
    .mockResolvedValue(empty) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider, dynamicTools: tools, completionGate: tools.completionGate, knowledge: false });
  expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
  expect(provider.complete).toHaveBeenCalledTimes(2);
  expect(purchases).toEqual(["call_paid_service"]);
});

it("allows a malformed completion tool call to be corrected", async () => {
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "bad", name: "complete_session", arguments: {} }] })
    .mockResolvedValueOnce(complete()) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider });
  expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
  expect(provider.complete).toHaveBeenCalledTimes(2);
});


describe("the reflection is asked only of runs that earned it (SRI-115 C6)", () => {
  const plain = { turns: 2, failedTools: 0, paidCalls: 0 };
  it("qualifies a purchase, a failed tool, many turns, or an answer waiting on the owner", () => {
    expect(reflectionTrigger(plain)).toBeUndefined();
    expect(reflectionTrigger({ ...plain, finalMessage: "A stock is a share of ownership in a company." })).toBeUndefined();
    expect(reflectionTrigger({ ...plain, paidCalls: 1 })).toBe("bought a service");
    expect(reflectionTrigger({ ...plain, failedTools: 1 })).toBe("a tool failed");
    expect(reflectionTrigger({ ...plain, turns: REFLECTION_MIN_TURNS - 1 })).toBeUndefined();
    expect(reflectionTrigger({ ...plain, turns: REFLECTION_MIN_TURNS })).toBe("many turns");
    expect(reflectionTrigger({ ...plain, finalMessage: "I found two fares; you'll need to book the 9:40 one on the airline's site." })).toBe("ended waiting on the owner");
    expect(reflectionTrigger({ ...plain, finalMessage: "Please sign in to your bank so I can read the statement." })).toBe("ended waiting on the owner");
  });

  it("does not nudge a short unpaid run, and nudges a purchase with both kinds of request", async () => {
    const tools = economyTools({
      definitions: () => [{ name: "request_service", description: "r", parameters: { type: "object" } }],
      execute: async () => ({ ok: true, data: { enabled: true } })
    });
    expect(await tools.completionGate(false, plain)).toBeUndefined();
    const prompt = await tools.completionGate(false, { ...plain, paidCalls: 1 });
    expect(prompt).toContain("fixed an observed failure, a poor result or excessive cost");
    expect(prompt).not.toMatch(/leverage|unlocks|kind,/);
    expect(prompt).toContain("builds_on");
    expect(await tools.completionGate(false, { ...plain, paidCalls: 1 })).toBeUndefined();
  });

  it("derives the signals from this run's messages only", () => {
    const tool = (id: string, ok: boolean) => ({ role: "tool" as const, toolCallId: id, content: JSON.stringify({ result: { ok } }) });
    const call = (id: string, name: string) => ({ role: "assistant" as const, content: "", toolCalls: [{ id, name, arguments: {} }] });
    const messages = [
      { role: "system" as const, content: "s" },
      { role: "user" as const, content: "earlier task" }, call("a", "call_paid_service"), tool("a", true), call("b", "run_shell"), tool("b", false),
      { role: "user" as const, content: "now" }, call("c", "call_paid_service"), tool("c", true), call("d", "web_fetch"), tool("d", true),
    ];
    expect(completionSignals(messages, "now", 3, "done")).toEqual({ turns: 3, failedTools: 0, paidCalls: 1, finalMessage: "done", task: "now" });
    expect(completionSignals(messages.slice(0, 6), "earlier task", 2)).toEqual({ turns: 2, failedTools: 1, paidCalls: 1 });
  });

  it("a one-question run finishes without the reflection turn", async () => {
    const tools = economyTools({
      definitions: () => [{ name: "request_service", description: "r", parameters: { type: "object" } }],
      execute: async () => ({ ok: true, data: { enabled: true } })
    });
    const provider = { complete: vi.fn().mockResolvedValueOnce(complete()).mockResolvedValue(empty) };
    const result = await runAgentTaskDetailed(await session(), "What should I study?", { provider, completionGate: tools.completionGate });
    expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});

describe("a run that ends short of its task asks for the service that would have finished it (SRI-122)", () => {
  const plain = { turns: 3, failedTools: 0, paidCalls: 0 };
  const gate = () => economyTools({
    definitions: () => [{ name: "request_service", description: "r", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, data: { enabled: true } })
  });

  it("reads a shortfall from the answer or the task's own count, not from ordinary prose", () => {
    expect(endedShort({ ...plain, finalMessage: "I couldn't find a service that returns 10-Q revenue tables, so this is incomplete." })).toBe(true);
    expect(endedShort({ ...plain, finalMessage: "We were unable to transcribe the voicemail: no service offers speaker labels." })).toBe(true);
    expect(endedShort({ ...plain, finalMessage: "Here is a partial list; the registry was down." })).toBe(true);
    expect(endedShort({ ...plain, finalMessage: "I'm unable to reach the registry today." })).toBe(true);
    expect(endedShort({ ...plain, finalMessage: "Done. The API can't take more than 100 rows, so I sent them in 3 batches; you cannot undo it." })).toBe(false);
    expect(endedShort({ ...plain, task: "Find 20 leads", finalMessage: "Here are 7 leads." })).toBe(true);
    expect(endedShort({ ...plain, finalMessage: "I was able to find all three filings. You cannot deduct the fee." })).toBe(false);
    expect(endedShort({ ...plain, task: "Find 20 leads", finalMessage: "Here are 20 leads." })).toBe(false);
    expect(endedShort(plain)).toBe(false);
    expect(reflectionTrigger({ ...plain, paidCalls: 2, finalMessage: "I could not get the tables." })).toBe("ended short of its task");
  });

  it("a task that fails for lack of a service ends with one request, and at most one review of an endpoint that fell short", async () => {
    const prompt = await gate().completionGate(false, { ...plain, finalMessage: "I couldn't find any service that does this." });
    expect(prompt).toBe(SHORT_RUN_NUDGE);
    expect(prompt).toContain("Call request_service once");
    expect(prompt).toContain("call review_paid_service once");
    // Asked once: the next completion goes through.
    const tools = gate();
    await tools.completionGate(false, { ...plain, finalMessage: "I couldn't do it." });
    expect(await tools.completionGate(false, { ...plain, finalMessage: "I couldn't do it." })).toBeUndefined();
  });

  it("a successful task with no paid calls produces neither", async () => {
    expect(await gate().completionGate(false, { ...plain, task: "Summarize this file", finalMessage: "Here is the summary: it covers three topics." })).toBeUndefined();
  });

  it("drives one request through a real run that ends short", async () => {
    const requests: string[] = [];
    const tools = economyTools({
      definitions: () => [{ name: "request_service", description: "r", parameters: { type: "object" } }],
      execute: async (name) => { if (name === "request_service") requests.push(name); return { ok: true, data: { enabled: true, accepted: true } }; }
    });
    const short = "I couldn't find a paid service that returns the tables, so I have no result.";
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "c1", name: "complete_session", arguments: { final_message: short } }] })
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "r1", name: "request_service", arguments: {} }] })
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "c2", name: "complete_session", arguments: { final_message: "Requested it." } }] })
      .mockResolvedValue(empty) };
    const result = await runAgentTaskDetailed(await session(), "Extract the revenue tables", { provider, dynamicTools: tools, completionGate: tools.completionGate, knowledge: false });
    expect(result.outcome).toBe("completed");
    expect(requests).toEqual(["request_service"]);
    // The second model call saw the short-run nudge.
    expect(JSON.stringify(provider.complete.mock.calls[1])).toContain("ending short of its task");
    expect(provider.complete).toHaveBeenCalledTimes(3);
  });
});
