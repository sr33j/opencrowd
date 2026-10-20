import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import { economyTools } from "../src/economy-tools.js";
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
function reflection(pendingReview = false) {
  return economyTools({
    definitions: () => [{ name: "request_service", description: "Request a missing service", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, data: { enabled: true } }),
    hasPendingRequiredReviews: async () => pendingReview
  });
}

it("finishes immediately when a service request already satisfied reflection", async () => {
  const tools = reflection();
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "request", name: "request_service", arguments: { service_description: "Authoritative career matching" } }] })
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

it("keeps the answer while the model files a required review after completing", async () => {
  const tools = reflection(true);
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
    completionGate: async () => (blocked ? undefined : ((blocked = true), "A paid purchase still needs its required review.")) });
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

it("keeps required reviews blocking even after a service request or a restored nudge", async () => {
  const tools = reflection(true);
  await tools.execute("request_service", {});
  expect(await tools.completionGate()).toContain("required review");
  expect(await reflection(true).completionGate(true)).toContain("required review");
});

it("allows a malformed completion tool call to be corrected", async () => {
  const provider = { complete: vi.fn()
    .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "bad", name: "complete_session", arguments: {} }] })
    .mockResolvedValueOnce(complete()) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider });
  expect(result).toMatchObject({ outcome: "completed", summary: { final_message: answer } });
  expect(provider.complete).toHaveBeenCalledTimes(2);
});
