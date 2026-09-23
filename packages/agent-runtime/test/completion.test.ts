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

it.each(["tool", "text"])("uses a revised %s answer after reflection", async kind => {
  const tools = reflection();
  const revised = "Updated recommendation based on the follow-up.";
  const provider = { complete: vi.fn().mockResolvedValueOnce(complete())
    .mockResolvedValueOnce(kind === "tool" ? complete(revised) : { content: revised, toolCalls: [] }) };
  const result = await runAgentTaskDetailed(await session(), "Find a role", { provider, completionGate: tools.completionGate });
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
