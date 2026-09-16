import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, executeTool, saveArtifact, HOSTED_ONLY_TOOL_NAMES, OPEN_CROWD_TOOLS, TOOL_NAMES } from "@opencrowd/core";
import { MachineWorker } from "../src/worker.js";
import { createHostedProvider, createHostedToolExecutor } from "../src/hosted-provider.js";
import { runAgentTaskDetailed } from "../src/index.js";
import type { Command, Event } from "@opencrowd/protocol";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "hosted-tools-")); roots.push(dir); return dir; }
const deployArgs = { slug: "hash-echo", name: "Hash echo", description: "Returns a hash", price_usd: "0.001", entry: "service/index.js",
  routes: [{ method: "GET", path: "/hash", description: "Hash of the secret" }], secrets: ["FAKE_KEY"], allowed_hosts: [] };
const secretArgs = { name: "FAKE_KEY", allowed_hosts: ["api.example.com"], reason: "The hash service signs requests with it." };

describe("hosted-only tools", () => {
  it("is defined once and never advertised or executable in local runs", async () => {
    expect(HOSTED_ONLY_TOOL_NAMES).toEqual(["deploy_service", "request_secret"]);
    expect(TOOL_NAMES).toContain("deploy_service"); expect(TOOL_NAMES).toContain("request_secret");
    expect(OPEN_CROWD_TOOLS.find(t => t.name === "deploy_service")?.parameters.required).toContain("entry");
    expect(OPEN_CROWD_TOOLS.find(t => t.name === "request_secret")?.parameters).toMatchObject({ required: ["name", "allowed_hosts", "reason"],
      properties: { name: { pattern: "^[A-Z][A-Z0-9_]{1,63}$" }, allowed_hosts: { type: "array" } } });
    const session = await createSession({ workspaceRoot: await root(), budgetCents: 100, approvalMode: "off" });
    const local = await executeTool("deploy_service", deployArgs, { session });
    expect(local.ok).toBe(false); expect(local.error).toMatch(/hosted/);
    const secret = await executeTool("request_secret", secretArgs, { session });
    expect(secret.ok).toBe(false); expect(secret.error).toMatch(/hosted/);
    // A local run that asks for deploy_service by name is refused by the local executor, and the
    // default local tool set never includes it (see runAgentTaskDetailed's enabledTools).
    let turn = 0;
    const result = await runAgentTaskDetailed(session, "hello", { provider: { complete: async () => turn++ === 0
      ? { content: "", toolCalls: [{ id: "d", name: "deploy_service", arguments: deployArgs }] }
      : { content: "done", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "ok" } }] } } });
    expect(result.outcome).toBe("completed");
    expect(JSON.stringify(result.summary)).not.toContain("live");
  });

  it("advertises deploy_service to the hosted model and inlines the entry artifact over the credential-free socket", async () => {
    const home = await root(), socketPath = join(home, "bridge.sock");
    const requests: { url: string; body: any; auth?: string }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ url: req.url!, body, auth: req.headers.authorization });
      if (req.url === "/model") res.end(JSON.stringify({ status: "complete", response: { content: "", toolCalls: [] } }));
      else res.end(JSON.stringify({ ok: true, data: { url: "https://svc.example/s/hash-echo", service_id: "svc-1", status: "live" } }));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      await createHostedProvider({ socketPath, runId: "run-1", sessionId: "session-1" }).complete([{ role: "user", content: "hi" }], { operationId: "run-1:llm:0" });
      expect(requests[0].body.tools.map((t: { name: string }) => t.name)).toContain("deploy_service");
      const session = await createSession({ workspaceRoot: join(home, "ws"), sessionId: "session-1", budgetCents: 100, approvalMode: "off" });
      await saveArtifact(session, "service/index.js", "export default { fetch: () => new Response('hi') }");
      const execute = createHostedToolExecutor({ socketPath, runId: "run-1", sessionId: "session-1" });
      const result = await execute("deploy_service", deployArgs, { session });
      expect(result).toEqual({ ok: true, data: { url: "https://svc.example/s/hash-echo", service_id: "svc-1", status: "live" } });
      const tool = requests.find(r => r.url === "/tool")!;
      expect(tool.auth).toBeUndefined();
      expect(tool.body).toMatchObject({ runId: "run-1", sessionId: "session-1", name: "deploy_service", arguments: { slug: "hash-echo", source: expect.stringContaining("new Response('hi')") } });
      const missing = await execute("deploy_service", { ...deployArgs, entry: "service/nope.js" }, { session });
      expect(missing.ok).toBe(false); expect(missing.error).toMatch(/entry could not be read/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("forwards request_secret arguments untouched over the tool socket and returns the supervisor's status", async () => {
    const home = await root(), socketPath = join(home, "bridge.sock");
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end(JSON.stringify({ ok: true, data: { status: "requested", placeholder: "vault://FAKE_KEY" } }));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      const session = await createSession({ workspaceRoot: join(home, "ws"), sessionId: "session-1", budgetCents: 100, approvalMode: "off" });
      const result = await createHostedToolExecutor({ socketPath, runId: "run-1", sessionId: "session-1" })("request_secret", secretArgs, { session });
      expect(result).toEqual({ ok: true, data: { status: "requested", placeholder: "vault://FAKE_KEY" } });
      expect(requests).toEqual([{ runId: "run-1", sessionId: "session-1", name: "request_secret", arguments: secretArgs }]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("routes deploy_service through the worker's hosted executor and memoizes the result across restarts", async () => {
    const home = await root(); const events: Event[] = []; const hosted = vi.fn(async () => ({ ok: true, data: { url: "https://svc.example/s/hash-echo" } }));
    let turn = 0;
    const provider = { complete: vi.fn(async () => turn++ === 0
      ? { content: "deploying", toolCalls: [{ id: "d", name: "deploy_service", arguments: deployArgs }] }
      : { content: "done", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "deployed" } }] }) };
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-09-05T00:00:00Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Deploy", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };
    const options = { agentHome: home, provider: () => provider, hostedTools: () => hosted, output: (line: string) => { events.push(JSON.parse(line)); } };
    const worker = new MachineWorker(options); await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
    expect(hosted).toHaveBeenCalledTimes(1);
    expect(hosted.mock.calls[0][0]).toBe("deploy_service");
    expect(events.filter(e => e.type === "tool.finished").map(e => [e.payload.toolName, e.payload.status])).toEqual([["deploy_service", "ok"], ["complete_session", "ok"]]);
    // tool.started carries a redacted summary: identifiers only, never the routes, secrets or entry source.
    expect(events.filter(e => e.type === "tool.started").map(e => e.payload.input)).toEqual([
      { slug: "hash-echo", name: "Hash echo", price_usd: "0.001" }, { summary: "deployed" }]);
    const restarted = new MachineWorker(options); await restarted.initialize(); await restarted.handleLine(JSON.stringify(command)); await restarted.drain();
    expect(hosted).toHaveBeenCalledTimes(1);
  });

  it("routes request_secret through the worker's hosted executor and summarizes only its name and hosts", async () => {
    const home = await root(); const events: Event[] = []; let turn = 0;
    const hosted = vi.fn(async () => ({ ok: true, data: { status: "active" } }));
    const provider = { complete: vi.fn(async () => turn++ === 0
      ? { content: "", toolCalls: [{ id: "s", name: "request_secret", arguments: secretArgs }] }
      : { content: "done", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "secret ready" } }] }) };
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-09-05T00:00:00Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Need a key", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };
    const worker = new MachineWorker({ agentHome: home, provider: () => provider, hostedTools: () => hosted, output: line => { events.push(JSON.parse(line)); } });
    await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    expect(hosted).toHaveBeenCalledTimes(1); expect(hosted.mock.calls[0].slice(0, 2)).toEqual(["request_secret", secretArgs]);
    expect(events.find(e => e.type === "tool.started")?.payload).toMatchObject({ toolName: "request_secret", input: { name: "FAKE_KEY", allowed_hosts: ["api.example.com"] } });
    expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
  });

  it("reports deploy_service unavailable when no hosted executor is wired", async () => {
    const home = await root(); const events: Event[] = []; let turn = 0;
    const provider = { complete: vi.fn(async () => turn++ === 0
      ? { content: "deploying", toolCalls: [{ id: "d", name: "deploy_service", arguments: deployArgs }] }
      : { content: "done", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "gave up" } }] }) };
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-09-05T00:00:00Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Deploy", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };
    const worker = new MachineWorker({ agentHome: home, provider: () => provider, output: line => { events.push(JSON.parse(line)); } });
    await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    const finished = events.filter(e => e.type === "tool.finished").find(e => e.payload.toolName === "deploy_service")!;
    expect(finished.payload.status).toBe("error"); expect(finished.payload.error).toMatch(/hosted/);
  });
});
