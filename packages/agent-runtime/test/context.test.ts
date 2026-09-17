import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import { ContextWindowExceeded, contextLimits, estimateContextTokens, isContextWindowError } from "@opencrowd/protocol";
import { compactContext, completeWithContext, type ContextState } from "../src/context.js";
import { runAgentTaskDetailed, type LlmMessage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function session() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "context test ")); roots.push(workspaceRoot);
  return createSession({ workspaceRoot, shellEnabled: true });
}
function history(turns = 15): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: "System rules must survive." }, { role: "user", content: "Original task and constraints." }];
  for (let i = 0; i < turns; i++) {
    // Reused tool IDs across different turns are legal.
    messages.push({ role: "assistant", content: `step ${i}`, toolCalls: [{ id: "call", name: "run_shell", arguments: { command: "echo ok" } }] },
      { role: "tool", content: `Result ${i}\n` + "data\n".repeat(1500), toolCallId: "call" });
  }
  messages.push({ role: "user", content: "Current task: find the result." });
  return messages;
}
const options = (contextWindowTokens = 16000) => ({ contextWindowTokens, maxOutputTokens: 1024, tools: [], state: {} });

it("triggers at 80%, targets 40%, archives exact input, and leaves room for future turns", async () => {
  const s = await session(), messages = history(), original = structuredClone(messages);
  const result = await compactContext(s, messages, options());
  expect(result.tokensBefore).toBeGreaterThan(12800);
  expect(result.tokensAfter).toBeLessThanOrEqual(6400);
  expect(messages[0]).toEqual(original[0]);
  expect(messages).toContainEqual(original[1]);
  expect(messages.at(-1)).toEqual(original.at(-1));
  const raw = await readFile(join(s.workspaceRoot, result.archivePath!), "utf8");
  expect(raw.trim().split("\n").map(line => JSON.parse(line))).toEqual(original);
  expect(messages.find(m => m.contextArchive)?.content).toContain("rg/grep");
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") expect(messages[i - 1].toolCalls?.[0].id).toBe(messages[i].toolCallId);
  }
  expect(await compactContext(s, messages, options())).not.toHaveProperty("archivePath");
  expect(await readdir(join(s.sessionDir, "context"))).toHaveLength(1);
});

it("keeps input below 80% byte-for-byte and includes tool definitions in the budget", async () => {
  const s = await session(), messages: LlmMessage[] = [{ role: "user", content: "a".repeat(30000) }];
  const before = structuredClone(messages);
  expect(await compactContext(s, messages, options())).not.toHaveProperty("archivePath");
  expect(messages).toEqual(before);
  const result = await compactContext(s, messages, { ...options(), tools: [{ description: "b".repeat(9000) }] });
  expect(result.archivePath).toBeTruthy();
  expect(result.tokensAfter).toBeLessThanOrEqual(6400);
});

it("externalizes an oversized Unicode user message verbatim and preserves the short task", async () => {
  const s = await session();
  const text = "Find invoice 731.\n" + "日本語の資料 🧪\n".repeat(15000);
  const messages: LlmMessage[] = [{ role: "system", content: "Keep rules." }, { role: "user", content: "Audit invoices." }, { role: "assistant", content: "Ready." }, { role: "user", content: text }];
  const result = await compactContext(s, messages, options());
  expect(result.tokensAfter).toBeLessThanOrEqual(6400);
  const file = messages.at(-1)!.content.match(/saved verbatim to (.*?)\. Use/s)![1];
  expect(await readFile(join(s.workspaceRoot, file), "utf8")).toBe(text);
  expect(messages).toContainEqual({ role: "user", content: "Audit invoices." });
  expect(estimateContextTokens("漢".repeat(100))).toBeGreaterThan(estimateContextTokens("a".repeat(100)));
});

it("rechecks on a large-to-small model switch and preserves older archive references transitively", async () => {
  const s = await session(), messages = history();
  expect(await compactContext(s, messages, options(1_000_000))).not.toHaveProperty("archivePath");
  const first = await compactContext(s, messages, options());
  messages.push({ role: "user", content: "New document " + "x".repeat(100000) });
  const second = await compactContext(s, messages, options(8000));
  expect(second.tokensAfter).toBeLessThanOrEqual(3200);
  expect(await readFile(join(s.workspaceRoot, second.archivePath!), "utf8")).toContain(first.archivePath);
});

it("fails finitely without changing context when protected instructions and tools cannot fit", async () => {
  const s = await session(), messages: LlmMessage[] = [{ role: "system", content: "s".repeat(100000) }, { role: "user", content: "Help." }];
  const original = structuredClone(messages);
  await expect(compactContext(s, messages, options())).rejects.toThrow("Context cannot fit");
  expect(messages).toEqual(original);
  const archives = await readdir(join(s.sessionDir, "context"));
  expect(archives).toHaveLength(1);
  expect(await readFile(join(s.sessionDir, "context", archives[0], "transcript.jsonl"), "utf8")).toContain("s".repeat(100000));
});

it("bounds context-error retries, changes operation IDs only for new requests, and checkpoints them", async () => {
  const s = await session(), messages = history(), state: ContextState = {};
  const calls: { id?: string; messages: LlmMessage[] }[] = [];
  const checkpoint = vi.fn(async () => { expect(state.prepared || state.retry).toBeTruthy(); });
  const provider = { complete: vi.fn(async (m: LlmMessage[], c?: { operationId?: string }) => {
    calls.push({ id: c?.operationId, messages: structuredClone(m) });
    throw new ContextWindowExceeded("maximum context length exceeded");
  }) };
  await expect(completeWithContext(s, messages, { ...options(), state, provider, operationId: "run:llm:0", hosted: true, checkpoint })).rejects.toThrow("maximum context");
  expect(calls.map(c => c.id)).toEqual(["run:llm:0", "run:llm:0:context:1", "run:llm:0:context:2"]);
  expect(calls[1].messages).not.toEqual(calls[0].messages);
  expect(checkpoint).toHaveBeenCalledTimes(5);
});

it("replays a paused request exactly even if limits change across restart", async () => {
  const s = await session(), messages = history(), state: ContextState = {};
  let sent: LlmMessage[] = [];
  const provider = { complete: vi.fn(async (m: LlmMessage[]) => { sent = structuredClone(m); throw new Error("payment unknown"); }) };
  await expect(completeWithContext(s, messages, { ...options(), state, provider, hosted: true })).rejects.toThrow("payment unknown");
  expect(state.prepared).toBe(true);
  const restored = JSON.parse(JSON.stringify({ messages, state }));
  const resumed = { complete: vi.fn(async (m: LlmMessage[]) => { expect(m).toEqual(sent); return { content: "done", toolCalls: [] }; }) };
  await completeWithContext(s, restored.messages, { ...options(1024), state: restored.state, provider: resumed, hosted: true });
  expect(resumed.complete).toHaveBeenCalledTimes(1);
});

it("only recognizes context failures, not generic HTTP/body-size or output-limit failures", () => {
  expect(isContextWindowError({ status: 413, message: "body too large" })).toBe(false);
  expect(isContextWindowError({ finish_reason: "length" })).toBe(false);
  expect(isContextWindowError({ error: { code: "context_length_exceeded" } })).toBe(true);
  expect(contextLimits(8000, 1000)).toMatchObject({ trigger: 6400, target: 3200, outputTokens: 1000 });
});

it("bounds many short messages even when they fit the token window", async () => {
  const s = await session();
  const messages: LlmMessage[] = [{ role: "system", content: "rules" }, ...Array.from({ length: 1200 }, (_, i): LlmMessage => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}` }))];
  messages.push({ role: "user", content: "current request" });
  const result = await compactContext(s, messages, options(1_000_000));
  expect(result.archivePath).toBeTruthy();
  expect(messages.length).toBeLessThanOrEqual(500);
  expect(messages.at(-1)?.content).toBe("current request");
});

it("calibrates estimates with total provider input usage, including cached input", async () => {
  const s = await session(), state: ContextState = {};
  const provider = { complete: async () => ({ content: "ok", toolCalls: [], usage: { inputTokens: 200, cachedInputTokens: 180 } }) };
  await completeWithContext(s, [{ role: "user", content: "hi" }], { ...options(), provider, state });
  expect(state.scale).toBeGreaterThan(1);
  expect(state.prepared).toBe(false);
});

it("keeps parallel tool calls paired and archives deterministically after a crash before replacement", async () => {
  const s = await session();
  const messages: LlmMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "original" }];
  for (let i = 0; i < 80; i++) {
    messages.push({ role: "assistant", content: "plan ".repeat(100), toolCalls: [
      { id: "a", name: "read_file", arguments: { path: "a" } }, { id: "b", name: "read_file", arguments: { path: "b" } }
    ] }, { role: "tool", toolCallId: "a", content: "alpha" }, { role: "tool", toolCallId: "b", content: "beta" });
  }
  messages.push({ role: "user", content: "current" });
  const oldCheckpoint = structuredClone(messages);
  const first = await compactContext(s, messages, options(8000));
  const replay = await compactContext(s, oldCheckpoint, options(8000));
  expect(replay.archivePath).toBe(first.archivePath);
  expect(oldCheckpoint).toEqual(messages);
  expect(await readdir(join(s.sessionDir, "context"))).toHaveLength(1);
  for (let i = 0; i < messages.length; i++) if (messages[i].toolCalls) {
    expect(messages.slice(i + 1, i + 3).map(m => m.toolCallId)).toEqual(["a", "b"]);
  }
});

it("runs the real agent loop and bash tool to retrieve a detail from an oversized input archive", async () => {
  const s = await session();
  const task = "Find the launch code in this document.\n" + "ordinary line\n".repeat(10000) + "LAUNCH_CODE=orchid-731\n";
  let calls = 0;
  const result = await runAgentTaskDetailed(s, task, { contextWindowTokens: 16000, tools: ["run_shell"], provider: {
    complete: async (messages) => {
      calls++;
      if (calls === 1) {
        const pointer = messages.find(m => m.role === "user" && m.content.includes("saved verbatim"))!.content;
        const path = pointer.match(/saved verbatim to (.*?)\. Use/s)![1];
        return { content: "I will search the saved input.", toolCalls: [{ id: "lookup", name: "run_shell", arguments: { command: `grep -n LAUNCH_CODE '${path}'` } }] };
      }
      expect(messages.at(-1)?.content).toContain("LAUNCH_CODE=orchid-731");
      return { content: "The launch code is orchid-731.", toolCalls: [] };
    }
  } });
  expect(result.outcome).toBe("completed");
  expect(result.summary.final_message).toContain("orchid-731");
  expect(calls).toBe(2);
});
