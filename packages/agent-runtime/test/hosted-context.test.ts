import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Command, Event } from "@opencrowd/protocol";
import { MachineWorker } from "../src/worker.js";
import { createHostedProvider, trimHostedMessages, HostedRequestError } from "../src/hosted-provider.js";
import type { LlmMessage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "hosted-context-")); roots.push(dir); return dir; }
const bytes = (list: LlmMessage[]) => Buffer.byteLength(JSON.stringify(list));
const clone = (list: LlmMessage[]) => JSON.parse(JSON.stringify(list)) as LlmMessage[];

/** system, task, then `turns` assistant+tool pairs of ~`toolChars` output, then a follow-up and a short exchange. */
function conversation(turns: number, toolChars = 3000): LlmMessage[] {
  const list: LlmMessage[] = [{ role: "system", content: "You are the agent." }, { role: "user", content: "Build the thing." }];
  for (let i = 0; i < turns; i++) {
    list.push({ role: "assistant", content: `step ${i}`, toolCalls: [{ id: `c${i}`, name: "run_shell", arguments: { command: `ls ${i}` } }] });
    list.push({ role: "tool", content: `output ${i} `.padEnd(toolChars, "x"), toolCallId: `c${i}` });
  }
  list.push({ role: "user", content: "Now do the follow-up." }, { role: "assistant", content: "Sure.", toolCalls: [{ id: "last", name: "list_files", arguments: {} }] },
    { role: "tool", content: "[]", toolCallId: "last" }, { role: "assistant", content: "Done." });
  return list;
}

function orphans(list: LlmMessage[]): string[] {
  const ids = new Set(list.flatMap(m => m.toolCalls?.map(c => c.id) ?? []));
  return list.filter(m => m.role === "tool" && !ids.has(m.toolCallId!)).map(m => m.toolCallId!);
}

describe("trimHostedMessages", () => {
  it("returns small input unchanged and never mutates its argument", () => {
    const small = conversation(2, 100), before = clone(small);
    expect(trimHostedMessages(small)).toEqual(before);
    const large = conversation(40), snapshot = clone(large);
    const trimmed = trimHostedMessages(large, 20_000);
    expect(large).toEqual(snapshot);
    expect(trimmed).not.toBe(large);
    expect(trimHostedMessages(clone(trimmed), 20_000)).toEqual(trimmed);
    expect(trimHostedMessages(large, 20_000)).toEqual(trimmed);
  });

  it("blanks older tool outputs first so every turn stays visible when that is enough", () => {
    const input = conversation(6, 3000);
    expect(bytes(input)).toBeGreaterThan(12_000);
    const trimmed = trimHostedMessages(input, 12_000);
    expect(bytes(trimmed)).toBeLessThanOrEqual(12_000);
    expect(trimmed).toHaveLength(input.length);
    expect(trimmed.filter(m => m.role === "assistant").map(m => m.content)).toEqual(input.filter(m => m.role === "assistant").map(m => m.content));
    const blanked = trimmed.filter(m => m.role === "tool" && m.content.startsWith("{"));
    expect(blanked.length).toBeGreaterThan(0);
    expect(JSON.parse(blanked[0].content)).toMatchObject({ truncated: true });
    expect(trimmed[2]).toEqual(input[2]); // oldest assistant untouched
    expect(trimmed[3].content).not.toBe(input[3].content); // oldest tool output blanked first
  });

  it("keeps the system prompt, first task and last four messages while dropping assistant+tool pairs together", () => {
    const input = conversation(60, 1500);
    const trimmed = trimHostedMessages(input, 8_000);
    expect(bytes(trimmed)).toBeLessThanOrEqual(8_000);
    expect(trimmed[0]).toEqual(input[0]);
    expect(trimmed[1]).toEqual(input[1]);
    expect(trimmed.slice(-4)).toEqual(input.slice(-4));
    expect(trimmed.length).toBeLessThan(input.length);
    expect(orphans(trimmed)).toEqual([]);
    for (const m of trimmed) for (const call of m.toolCalls ?? []) expect(trimmed.some(t => t.role === "tool" && t.toolCallId === call.id)).toBe(true);
    // Whole oldest turns are gone, and the survivors are still in order.
    expect(trimmed.some(m => m.toolCallId === "c0")).toBe(false);
    const kept = trimmed.filter(m => m.role === "tool").map(m => m.toolCallId);
    expect(kept).toEqual(input.filter(m => m.role === "tool" && kept.includes(m.toolCallId)).map(m => m.toolCallId));
  });

  it("truncates one oversized message as a last resort, sparing the system prompt and the latest user message", () => {
    const input: LlmMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" },
      { role: "assistant", content: "A".repeat(30_000) }, { role: "user", content: "follow-up " + "u".repeat(7000) }, { role: "assistant", content: "ok" }];
    const trimmed = trimHostedMessages(input, 14_000);
    expect(bytes(trimmed)).toBeLessThanOrEqual(14_000);
    expect(trimmed[2].content.startsWith("[…trimmed…]")).toBe(true);
    expect(trimmed[2].content.length).toBe("[…trimmed…]".length + 6000);
    expect(trimmed[0]).toEqual(input[0]); expect(trimmed[3]).toEqual(input[3]);
  });
});

const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-09-05T00:00:00Z", type: "run.start",
  payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "hello", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };

async function bridge(handler: (res: import("node:http").ServerResponse) => void) {
  const home = await root(), socketPath = join(home, "bridge.sock");
  const server = createServer(async (req, res) => { for await (const _ of req) { /* drain */ } handler(res); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  const run = async () => {
    const events: Event[] = [];
    const worker = new MachineWorker({ agentHome: join(home, "data"), output: line => { events.push(JSON.parse(line)); },
      provider: () => createHostedProvider({ socketPath, runId: "run-1", sessionId: "session-1" }) });
    await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    return events.filter(e => e.type === "run.finished").at(-1)!.payload as { outcome: string; summary?: string; pendingOperationId?: string };
  };
  return { socketPath, close, run };
}

describe("hosted bridge failure classification", () => {
  it("fails the run with the bridge's message when the request was rejected unpaid", async () => {
    const b = await bridge(res => { res.statusCode = 400; res.end(JSON.stringify({ error: "context_too_large", message: "The conversation is too long for this model.", status: 400, paid: false })); });
    try {
      await expect(createHostedProvider({ socketPath: b.socketPath, runId: "run-1", sessionId: "session-1" }).complete([{ role: "user", content: "hi" }], { operationId: "run-1:llm:0" }))
        .rejects.toMatchObject({ name: "HostedRequestError", code: "context_too_large", status: 400, message: "The conversation is too long for this model." });
      expect(await b.run()).toMatchObject({ outcome: "failed", summary: "The conversation is too long for this model." });
    } finally { await b.close(); }
  });

  it("uses a generic message when the unpaid rejection carries none", async () => {
    const b = await bridge(res => { res.statusCode = 422; res.end(JSON.stringify({ error: "bad_request", paid: false })); });
    try {
      const error = await createHostedProvider({ socketPath: b.socketPath, runId: "run-1", sessionId: "session-1" })
        .complete([{ role: "user", content: "hi" }], { operationId: "run-1:llm:0" }).catch(e => e);
      expect(error).toBeInstanceOf(HostedRequestError);
      expect(error.message).toBe("The model request was rejected (bad_request)");
    } finally { await b.close(); }
  });

  it("still pauses for payment reconciliation on ambiguous failures", async () => {
    for (const handler of [
      (res: import("node:http").ServerResponse) => { res.statusCode = 503; res.end(JSON.stringify({ error: "upstream_unavailable" })); },
      (res: import("node:http").ServerResponse) => { res.statusCode = 400; res.end(JSON.stringify({ error: "x", paid: true })); },
      (res: import("node:http").ServerResponse) => { res.statusCode = 502; res.end("<html>bad gateway</html>"); },
      (res: import("node:http").ServerResponse) => { res.destroy(); }
    ]) {
      const b = await bridge(handler);
      try { expect(await b.run()).toMatchObject({ outcome: "payment_unknown", pendingOperationId: "run-1:llm:0" }); }
      finally { await b.close(); }
    }
  });

  it("sends the trimmed history over the bridge", async () => {
    let received: LlmMessage[] = [];
    const home = await root(), socketPath = join(home, "bridge.sock");
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString()).messages;
      res.end(JSON.stringify({ status: "complete", response: { content: "ok", toolCalls: [] } }));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      const input = conversation(40);
      expect(bytes(input)).toBeGreaterThan(64_000);
      await createHostedProvider({ socketPath, runId: "run-1", sessionId: "session-1" }).complete(input, { operationId: "run-1:llm:0" });
      expect(received).toEqual(trimHostedMessages(input));
      expect(bytes(received)).toBeLessThanOrEqual(48_000);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
