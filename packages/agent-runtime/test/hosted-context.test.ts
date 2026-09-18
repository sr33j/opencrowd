import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_FAILURE_MESSAGE, type Command, type Event } from "@opencrowd/protocol";
import { MachineWorker } from "../src/worker.js";
import { createHostedProvider, HostedRequestError } from "../src/hosted-provider.js";
import type { LlmMessage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "hosted-context-")); roots.push(dir); return dir; }
const bytes = (list: LlmMessage[]) => Buffer.byteLength(JSON.stringify(list));

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
  it("ends a failed paid response with generic user-facing copy", async () => {
    const message = "The paid model returned an error; its receipt is saved";
    const b = await bridge(res => { res.statusCode = 502; res.end(JSON.stringify({ error: "model_failed", message, paid: true })); });
    try { expect(await b.run()).toMatchObject({ outcome: "failed", summary: RUN_FAILURE_MESSAGE }); }
    finally { await b.close(); }
  });

  it("keeps the internal unpaid rejection while showing a generic run failure", async () => {
    const b = await bridge(res => { res.statusCode = 400; res.end(JSON.stringify({ error: "context_too_large", message: "The conversation is too long for this model.", status: 400, paid: false })); });
    try {
      await expect(createHostedProvider({ socketPath: b.socketPath, runId: "run-1", sessionId: "session-1" }).complete([{ role: "user", content: "hi" }], { operationId: "run-1:llm:0" }))
        .rejects.toMatchObject({ name: "HostedRequestError", code: "context_too_large", status: 400, message: "The conversation is too long for this model." });
      expect(await b.run()).toMatchObject({ outcome: "failed", summary: RUN_FAILURE_MESSAGE });
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

  it("ends ambiguous failures without locking the conversation", async () => {
    for (const handler of [
      (res: import("node:http").ServerResponse) => { res.statusCode = 503; res.end(JSON.stringify({ error: "upstream_unavailable" })); },
      (res: import("node:http").ServerResponse) => { res.statusCode = 400; res.end(JSON.stringify({ error: "x", paid: true })); },
      (res: import("node:http").ServerResponse) => { res.statusCode = 502; res.end("<html>bad gateway</html>"); },
      (res: import("node:http").ServerResponse) => { res.destroy(); }
    ]) {
      const b = await bridge(handler);
      try { expect(await b.run()).toMatchObject({ outcome: "failed", summary: RUN_FAILURE_MESSAGE, pendingOperationId: "run-1:llm:0" }); }
      finally { await b.close(); }
    }
  });

  it("sends preflighted history unchanged beyond the old 64 KB limit", async () => {
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
      expect(received).toEqual(input);
      expect(bytes(received)).toBeGreaterThan(64_000);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
