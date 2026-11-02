import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAYMENT_RECONCILING_MESSAGE, RUN_FAILURE_MESSAGE, type Command, type Event } from "@opencrowd/protocol";
import { createSession } from "@opencrowd/core";
import { MachineWorker } from "../src/worker.js";
import { completeWithContext, type ContextState } from "../src/context.js";
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

  it("pauses an interrupted paid call for reconciliation instead of failing the run (SRI-58)", async () => {
    // Run bdf636cf on 2026-11-01: a gateway deploy reset the connection 62
    // seconds into a Venice call whose answer the gateway had already saved,
    // and the run ended "failed" while its payment settled.
    for (const handler of [
      (res: import("node:http").ServerResponse) => { res.statusCode = 503; res.end(JSON.stringify({ error: "upstream_unavailable" })); },
      (res: import("node:http").ServerResponse) => { res.statusCode = 400; res.end(JSON.stringify({ error: "x", paid: true })); },
      (res: import("node:http").ServerResponse) => { res.statusCode = 502; res.end("<html>bad gateway</html>"); },
      (res: import("node:http").ServerResponse) => { res.destroy(); }
    ]) {
      const b = await bridge(handler);
      try { expect(await b.run()).toMatchObject({ outcome: "payment_unknown", summary: PAYMENT_RECONCILING_MESSAGE, pendingOperationId: "run-1:llm:0" }); }
      finally { await b.close(); }
    }
  });

  it("resumes the paused operation once its payment is reconciled, and replays the saved answer", async () => {
    const home = await root(), socketPath = join(home, "bridge.sock");
    const operations: string[] = [];
    let interrupted = false;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      operations.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).operationId);
      // The first attempt is cut off mid-call; the resume gets the ledger's replay.
      if (!interrupted) { interrupted = true; res.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "complete", response: { content: "the saved answer", toolCalls: [] } }));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const events: Event[] = [];
    const worker = new MachineWorker({ agentHome: join(home, "data"), output: line => { events.push(JSON.parse(line)); },
      provider: () => createHostedProvider({ socketPath, runId: "run-1", sessionId: "session-1" }) });
    const finished = () => events.filter(e => e.type === "run.finished").at(-1)!.payload as { outcome: string; summary?: string; checkpointId?: string; pendingOperationId?: string };
    try {
      await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
      const paused = finished();
      expect(paused).toMatchObject({ outcome: "payment_unknown", pendingOperationId: "run-1:llm:0" });
      // A different run cannot start while this one is paused on its payment.
      await worker.handleLine(JSON.stringify({ ...command, id: "command-other", runId: "run-2", seq: 2 }));
      expect(events.some(e => e.type === "command.rejected" && e.commandId === "command-other")).toBe(true);
      await worker.handleLine(JSON.stringify({ protocolVersion: 1, id: "command-2", runId: "run-1", seq: 3, emittedAt: "2026-09-05T00:00:00Z", type: "run.resume",
        payload: { sessionId: "session-1", cause: "payment_reconciled", operationId: "run-1:llm:0", checkpointId: paused.checkpointId } }));
      await worker.drain();
      expect(finished()).toMatchObject({ outcome: "completed" });
      // The same operation both times: a resume never buys a fresh call.
      expect(operations).toEqual(["run-1:llm:0", "run-1:llm:0"]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("lets a new message supersede a run paused on its payment", async () => {
    const b = await bridge(res => { res.destroy(); });
    const home = await root();
    const events: Event[] = [];
    const worker = new MachineWorker({ agentHome: join(home, "data"), output: line => { events.push(JSON.parse(line)); },
      provider: () => createHostedProvider({ socketPath: b.socketPath, runId: "run-1", sessionId: "session-1" }) });
    try {
      await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
      // Control cancels a waiting run before it starts the owner's next one.
      await worker.handleLine(JSON.stringify({ protocolVersion: 1, id: "cancel-1", runId: "run-1", seq: 2, emittedAt: "2026-09-05T00:00:00Z", type: "run.cancel",
        payload: { reason: "Superseded by a new message." } }));
      await worker.drain();
      expect(events.filter(e => e.type === "run.finished").at(-1)!.payload).toMatchObject({ outcome: "cancelled" });
      await worker.handleLine(JSON.stringify({ ...command, id: "command-next", runId: "run-2", seq: 3 }));
      expect(events.some(e => e.type === "command.accepted" && e.commandId === "command-next")).toBe(true);
      await worker.drain();
    } finally { await b.close(); }
  });

  it("compacts and retries when a seller refuses the body's size, and never pays for the refusal", async () => {
    const bodies: number[] = [];
    const home = await root(), socketPath = join(home, "bridge.sock");
    // The live reseller's cap on 2026-11-01. The catalogue said the model held
    // a million tokens, so nothing compacted until the seller said no.
    const cap = 512 * 1024;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      bodies.push(body.length);
      if (body.length > cap) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_refused", message: "request_too_large: The request body must be at most 524288 bytes",
          status: 413, paid: false, upstream: { status: 413, code: "request_too_large" } }));
        return;
      }
      res.end(JSON.stringify({ status: "complete", response: { content: "Done.", toolCalls: [] } }));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      // About 180,000 estimated tokens: well inside the window the catalogue
      // claims, well outside the body the seller takes.
      const input = conversation(60, 9000);
      expect(bytes(input)).toBeGreaterThan(cap);
      const provider = createHostedProvider({ socketPath, runId: "run-1", sessionId: "session-1" });
      const workspaceRoot = join(home, "workspace");
      const session = await createSession({ workspaceRoot, sessionId: "session-1" });
      const messages = structuredClone(input);
      const state: ContextState = {};
      const response = await completeWithContext(session, messages, { provider, tools: [], state, hosted: true,
        contextWindowTokens: 1_000_000, maxOutputTokens: 4096, operationId: "run-1:llm:0" });
      expect(response.content).toBe("Done.");
      expect(bodies[0]).toBeGreaterThan(cap);
      expect(bodies.at(-1)).toBeLessThanOrEqual(cap);
      // Bulky old tool output went to files first, so the turns themselves,
      // the original request and the current task all survive.
      expect(bytes(messages)).toBeLessThan(bytes(input) / 2);
      expect(messages.some(m => m.contextArchive)).toBe(true);
      expect(messages[0]).toEqual(input[0]);
      expect(messages).toContainEqual(input[1]);
      expect(messages.at(-1)).toEqual(input.at(-1));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("ends a seller's other pre-payment refusals with the reason, not generic copy", async () => {
    const b = await bridge(res => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "upstream_refused", message: "unknown_model: This service does not sell gpt-9.",
        status: 404, paid: false, upstream: { status: 404, code: "unknown_model" } }));
    });
    try {
      const error = await createHostedProvider({ socketPath: b.socketPath, runId: "run-1", sessionId: "session-1" })
        .complete([{ role: "user", content: "hi" }], { operationId: "run-1:llm:0" }).catch(e => e);
      expect(error).toBeInstanceOf(HostedRequestError);
      expect(error.upstream).toEqual({ status: 404, code: "unknown_model" });
      expect(await b.run()).toMatchObject({ outcome: "failed", summary:
        "The model provider refused this request before any payment, so nothing was charged: unknown_model: This service does not sell gpt-9. You can retry or send another message." });
    } finally { await b.close(); }
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
