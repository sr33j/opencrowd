import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetExhaustedError, createSession } from "@opencrowd/core";
import { ContextWindowExceeded, contextLimits, estimateContextTokens, isContextWindowError, isRequestTooLargeError, upstreamRefusalSummary, MODEL_REQUEST_MAX_BYTES, MODEL_SELLER_REQUEST_MAX_BYTES } from "@opencrowd/protocol";
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
  const raw = await readFile(join(s.sessionDir, result.archivePath!), "utf8");
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
  expect(await readFile(join(s.sessionDir, file), "utf8")).toBe(text);
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
  expect(await readFile(join(s.sessionDir, second.archivePath!), "utf8")).toContain(first.archivePath);
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
  // The first attempt compacts, and asks for its summary as the turn's own operation; a retry does not.
  expect(calls.map(c => c.id)).toEqual(["run:llm:0:summary", "run:llm:0", "run:llm:0:context:1", "run:llm:0:context:2"]);
  expect(calls[2].messages).not.toEqual(calls[1].messages);
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

it("recognizes a seller's body-size refusal separately from a context window one", () => {
  // Bytes, not tokens, and told apart from a window refusal because the
  // gateway relays the seller's status beside its code.
  expect(isRequestTooLargeError({ code: "request_too_large", message: "The request body must be at most 524288 bytes" })).toBe(true);
  expect(isRequestTooLargeError({ error: { code: "payload_too_large" } })).toBe(true);
  expect(isRequestTooLargeError({ code: "invalid_request" }, 413)).toBe(true);
  expect(isRequestTooLargeError({ code: "unknown_model", message: "This service does not sell gpt-9" }, 404)).toBe(false);
  expect(isRequestTooLargeError({ code: "context_length_exceeded" })).toBe(false);
  expect(isRequestTooLargeError(undefined)).toBe(false);
  // A hosted run's byte budget is the seller's, far below the transport's.
  expect(MODEL_SELLER_REQUEST_MAX_BYTES).toBeLessThan(MODEL_REQUEST_MAX_BYTES);
});

it("names a seller's pre-payment refusal for the owner and leaves every other failure generic", () => {
  expect(upstreamRefusalSummary({ name: "HostedRequestError", code: "upstream_refused", message: "request_too_large: too big" }))
    .toBe("The model provider refused this request before any payment, so nothing was charged: request_too_large: too big You can retry or send another message.");
  expect(upstreamRefusalSummary({ name: "HostedRequestError", code: "model_failed", message: "paid and broken" })).toBeUndefined();
  expect(upstreamRefusalSummary(new Error("anything else"))).toBeUndefined();
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

// Compaction summaries the model writes (compaction-summary.ts).
/** Short results, so trimming has to remove whole exchanges rather than save results to files. */
function chatty(turns = 60): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: "System rules must survive." }, { role: "user", content: "Original task and constraints." }];
  for (let i = 0; i < turns; i++)
    messages.push({ role: "assistant", content: `step ${i}`, toolCalls: [{ id: `c${i}`, name: "run_shell", arguments: { command: "echo ok" } }] },
      { role: "tool", content: JSON.stringify({ ok: true, data: `Result ${i} ` + "word ".repeat(90) }), toolCallId: `c${i}` });
  messages.push({ role: "user", content: "Current task: find the result." });
  return messages;
}
const SUMMARY = "- [goal] find the result the user asked for\n- [fact] Result 3 was orchid-731\n- [open] report the result";
function summarizer(reply: string | Error = SUMMARY) {
  const calls: LlmMessage[][] = [];
  const provider = { complete: vi.fn(async (m: LlmMessage[]) => {
    calls.push(structuredClone(m));
    if (m.at(-1)?.content.startsWith("[Context compaction.")) {
      if (reply instanceof Error) throw reply;
      return { content: reply, toolCalls: [], usage: { inputTokens: 9000, cachedInputTokens: 8000, outputTokens: 40, costCents: 0.01 } };
    }
    return { content: "done", toolCalls: [] };
  }) };
  return { provider, calls };
}

it("with summary=llm, asks the model once for a summary of the history as last sent, and sends it in place of the digest", async () => {
  const s = await session(), messages = chatty(85), before = structuredClone(messages);
  const { provider, calls } = summarizer();
  await completeWithContext(s, messages, { ...options(24000), state: {}, provider, operationId: "run:llm:4" });
  expect(calls).toHaveLength(2);
  // The summary request is the conversation unchanged plus one instruction, so the seller's cached prefix holds.
  expect(calls[0].slice(0, -1)).toEqual(before);
  expect(provider.complete.mock.calls[0][1]).toMatchObject({ operationId: "run:llm:4:summary" });
  const reference = calls[1].find(m => m.contextArchive)!.content;
  expect(reference).toContain("Result 3 was orchid-731");
  expect(reference).not.toContain("run_shell ok");
  // A second compaction carries the summary, even where it falls back to the digest.
  const carried = await compactContext(s, [...calls[1], ...chatty(85).slice(2)], options(24000));
  expect(carried.summary).toBeUndefined();
});

it("falls back to the digest when the summary call fails or does not return a summary, and never fails the turn", async () => {
  for (const reply of [new Error("seller refused"), "Sure! Here is the result: done."]) {
    const s = await session(), messages = chatty(85);
    const { provider, calls } = summarizer(reply);
    const events: unknown[] = [];
    await completeWithContext(s, messages, { ...options(24000), state: {}, provider,
      onCompaction: async (r) => { events.push(r.summary); } });
    expect(calls.at(-1)!.find(m => m.contextArchive)!.content).toContain("run_shell ok");
    expect(events).toEqual([expect.objectContaining({ mode: "fallback" })]);
  }
});

it("asks for no summary when nothing is compacted", async () => {
  const s = await session(), { calls, provider } = summarizer();
  const short: LlmMessage[] = [{ role: "user", content: "hi" }];
  await completeWithContext(s, short, { ...options(), state: {}, provider });
  expect(calls).toHaveLength(1);
});

it("on a hosted run, asks for the summary as the turn's own operation, and lets a pause or a budget stop travel", async () => {
  const s = await session(), { calls, provider } = summarizer();
  await completeWithContext(s, chatty(85), { ...options(24000), state: {}, provider, hosted: true, operationId: "run:llm:3" });
  expect(provider.complete.mock.calls.map(c => (c[1] as { operationId?: string })?.operationId)).toEqual(["run:llm:3:summary", "run:llm:3"]);
  expect(calls[1].find(m => m.contextArchive)!.content).toContain("orchid-731");
  for (const stop of [Object.assign(new Error("waiting for funds"), { name: "RuntimePause" }), new BudgetExhaustedError("budget")]) {
    const paused = { complete: vi.fn(async () => { throw stop; }) };
    await expect(completeWithContext(await session(), chatty(85), { ...options(24000), state: {}, provider: paused, hosted: true, operationId: "run:llm:3" }))
      .rejects.toBe(stop);
    expect(paused.complete).toHaveBeenCalledTimes(1);
  }
});

it("runs the real agent loop: a fact the summary kept is still in the request after the history that held it is gone", async () => {
  const s = await session();
  let turn = 0, summaries = 0;
  const result = await runAgentTaskDetailed(s, "Read the logs one at a time, then tell me the code in log 1.", {
    contextWindowTokens: 20000, maxTurns: 200, tools: ["run_shell"], provider: {
      complete: async (messages) => {
        if (messages.at(-1)?.content.startsWith("[Context compaction.")) {
          summaries++;
          return { content: "- [goal] read the logs, report log 1's code\n- [fact] log 1 code: heron-42\n- [open] read the rest", toolCalls: [] };
        }
        turn++;
        if (!messages.some(m => m.contextArchive))
          return { content: "", toolCalls: [{ id: `c${turn}`, name: "run_shell", arguments: { command: `echo 'log ${turn}${turn === 1 ? " code heron-42" : ""} ${"entry ".repeat(60)}'` } }] };
        expect(messages.some(m => m.role === "tool" && m.content.includes("code heron-42"))).toBe(false);
        expect(messages.find(m => m.contextArchive)?.content).toContain("log 1 code: heron-42");
        return { content: "Log 1's code is heron-42.", toolCalls: [] };
      }
    } });
  expect(summaries).toBe(1);
  expect(result.outcome).toBe("completed");
  expect(result.summary.final_message).toContain("heron-42");
});

it("when the newest result pushes the history past the window, summarises the longest cached prefix that ends on a whole exchange", async () => {
  const s = await session(), messages = chatty(80);
  messages.splice(-1, 0, { role: "assistant", content: "", toolCalls: [{ id: "big", name: "run_shell", arguments: {} }] },
    { role: "tool", toolCallId: "big", content: "log line\n".repeat(2500) });
  const before = structuredClone(messages);
  const { provider, calls } = summarizer();
  const events: unknown[] = [];
  await completeWithContext(s, messages, { ...options(24000), state: {}, provider, onCompaction: async (r) => { events.push(r.summary); } });
  const sent = calls[0].slice(0, -1);
  expect(sent.length).toBeLessThan(before.length);
  expect(sent).toEqual(before.slice(0, sent.length));
  expect(before[sent.length].role).not.toBe("tool");
  expect(events).toEqual([expect.objectContaining({ mode: "llm", prefixOf: { sent: sent.length, of: before.length } })]);
  expect(calls[1].find(m => m.contextArchive)!.content).toContain("orchid-731");
});
