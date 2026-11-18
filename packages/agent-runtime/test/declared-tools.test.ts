import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeToolInput } from "@opencrowd/core";
import { HOSTED_CONTROL_TOOL_TIMEOUT_MS, RunStartCommandSchema, type Event } from "@opencrowd/protocol";
import { toolDeadlineMs } from "../src/tool-deadlines.js";
import { MachineWorker, RuntimePause, declaredToolDefinitions } from "../src/worker.js";
import { createHostedProvider, createHostedToolExecutor } from "../src/hosted-provider.js";
import type { DynamicToolDefinition, LlmMessage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "declared-tools-")); roots.push(dir); return dir; }

const whoami = { name: "control.whoami", description: "Your agent's name, org and role.", parameters: { type: "object", properties: {}, additionalProperties: false } };
const rules = "Org rules: never use example.com.";
const basePayload = { session: { kind: "create", sessionId: "session-1" }, prompt: "Who are you?", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" };
function start(extra: Record<string, unknown> = {}, id = "command-1") {
  return { protocolVersion: 1, id, runId: "run-1", seq: 1, emittedAt: "2026-11-18T00:00:00Z", type: "run.start", payload: { ...basePayload, ...extra } };
}
const systemOf = (messages: LlmMessage[]) => messages.find(m => m.role === "system")!.content;

describe("run.start tools and instructions (C2)", () => {
  it("keeps old payloads valid and bounds the new fields", () => {
    expect(RunStartCommandSchema.safeParse(start()).success).toBe(true);
    expect(RunStartCommandSchema.safeParse(start({ tools: [whoami], instructions: [rules] })).success).toBe(true);
    const invalid = [
      { tools: [{ ...whoami, name: "whoami" }] },
      { tools: [{ ...whoami, name: "control.WhoAmI" }] },
      { tools: [{ ...whoami, name: `control.${"a".repeat(41)}` }] },
      { tools: [whoami, whoami] },
      { tools: Array.from({ length: 17 }, (_, i) => ({ ...whoami, name: `control.t_${"abcdefghijklmnopq"[i]}` })) },
      { tools: [{ ...whoami, parameters: "none" }] },
      { instructions: Array.from({ length: 9 }, () => "x") },
      { instructions: ["a".repeat(8 * 1024), "b".repeat(8 * 1024 + 1)] },
      { instructions: [""] }
    ];
    for (const extra of invalid) expect(RunStartCommandSchema.safeParse(start(extra)).success, JSON.stringify(extra).slice(0, 80)).toBe(false);
    expect(RunStartCommandSchema.safeParse(start({ instructions: ["a".repeat(8 * 1024), "b".repeat(8 * 1024)] })).success).toBe(true);
  });

  it("advertises declared tools without the prefix and never lets one shadow a runtime tool", () => {
    const parsed = RunStartCommandSchema.parse(start({ tools: [whoami, { ...whoami, name: "control.run_shell" }, { ...whoami, name: "control.find_paid_service" }] }));
    expect(declaredToolDefinitions(parsed as never, [{ name: "find_paid_service", description: "", parameters: {} }]))
      .toEqual([{ name: "whoami", description: whoami.description, parameters: whoami.parameters }]);
    expect(declaredToolDefinitions(RunStartCommandSchema.parse(start({ tools: [whoami], modelPolicy: { chatOnly: true } })) as never)).toEqual([]);
    expect(summarizeToolInput("control.org_todos", { action: "file", title: "Pick a host", body: "long private text" }))
      .toEqual({ action: "file" });
    // Control answers within its own timeout; the backstop sits above it.
    expect(toolDeadlineMs("control.whoami")).toBeGreaterThan(HOSTED_CONTROL_TOOL_TIMEOUT_MS);
  });

  it("leaves a run without tools or instructions exactly as before", async () => {
    const seen: { tools: DynamicToolDefinition[]; system: string }[] = [];
    const hosted = vi.fn(async () => ({ ok: true, data: {} }));
    async function run(extra: Record<string, unknown>) {
      const events: Event[] = [];
      const worker = new MachineWorker({ agentHome: await root(), hostedTools: () => hosted, output: line => { events.push(JSON.parse(line)); },
        provider: (_run, _session, extraTools) => ({ complete: async (messages: LlmMessage[]) => {
          seen.push({ tools: extraTools, system: systemOf(messages) });
          return { content: "", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "I am an agent." } }] };
        } }) });
      await worker.initialize(); await worker.handleLine(JSON.stringify(start(extra))); await worker.drain();
      expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
    }
    await run({});
    await run({ tools: [], instructions: [] });
    expect(seen[0].tools).toEqual([]);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0].system).not.toContain("\n\n");
    expect(hosted).not.toHaveBeenCalled();
  });

  it("routes a declared tool over the supervisor socket as control.<name> and appends the instructions", async () => {
    const home = await root(), socketPath = join(home, "bridge.sock"); const events: Event[] = [];
    const requests: { url: string; body: any }[] = []; let model = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ url: req.url!, body });
      if (req.url === "/tool") return void res.end(JSON.stringify(body.name === "control.whoami"
        ? { ok: true, data: { name: "testing", org: "Personal", role: "personal" } }
        : { ok: false, error: "This tool is not available to this agent.", code: "tool_unavailable" }));
      const response = [
        { content: "", toolCalls: [{ id: "w", name: "whoami", arguments: {} }, { id: "x", name: "org_agents", arguments: { action: "list" } }] },
        { content: "", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "I am testing." } }] }
      ][model++];
      res.end(JSON.stringify({ status: "complete", response }));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      const worker = new MachineWorker({ agentHome: join(home, "data"), output: line => { events.push(JSON.parse(line)); },
        provider: (run, session, extraTools) => createHostedProvider({ socketPath, runId: run.runId, sessionId: session.sessionId, extraTools }),
        hostedTools: (run, session) => createHostedToolExecutor({ socketPath, runId: run.runId, sessionId: session.sessionId }) });
      await worker.initialize();
      await worker.handleLine(JSON.stringify(start({ tools: [whoami, { ...whoami, name: "control.org_agents", description: "Org agents." }], instructions: [rules, "Second section."] })));
      await worker.drain();
      expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
      const models = requests.filter(r => r.url === "/model");
      expect(models[0].body.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["whoami", "org_agents"]));
      expect(models[0].body.tools.find((t: { name: string }) => t.name === "whoami")).toEqual({ name: "whoami", description: whoami.description, parameters: whoami.parameters });
      expect(systemOf(models[0].body.messages)).toMatch(/\n\nOrg rules: never use example\.com\.\n\nSecond section\.$/);
      expect(requests.filter(r => r.url === "/tool").map(r => r.body)).toEqual([
        { runId: "run-1", sessionId: "session-1", name: "control.whoami", arguments: {} },
        { runId: "run-1", sessionId: "session-1", name: "control.org_agents", arguments: { action: "list" } }
      ]);
      const results = (models[1].body.messages as LlmMessage[]).filter(m => m.role === "tool").map(m => m.content);
      expect(JSON.parse(results[0]).result).toEqual({ ok: true, data: { name: "testing", org: "Personal", role: "personal" } });
      expect(results[1]).toContain("This tool is not available to this agent.");
      expect(events.filter(e => e.type === "tool.started").map(e => [e.payload.toolName, e.payload.input]))
        .toEqual([["control.whoami", {}], ["control.org_agents", { action: "list" }], ["complete_session", { summary: "I am testing." }]]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("keeps the same tools and instructions when a paused run resumes on a restarted worker", async () => {
    const home = await root(); const events: Event[] = []; let turn = 0;
    const offered: string[][] = []; const systems: string[] = [];
    const hosted = vi.fn(async (name: string) => ({ ok: true, data: { name: "testing", tool: name } }));
    const options = { agentHome: home, hostedTools: () => hosted, output: (line: string) => { events.push(JSON.parse(line)); },
      provider: (_run: unknown, _session: unknown, extraTools: DynamicToolDefinition[]) => {
        offered.push(extraTools.map(tool => tool.name));
        return { complete: async (messages: LlmMessage[]) => {
          systems.push(systemOf(messages));
          switch (turn++) {
            case 0: return { content: "", toolCalls: [{ id: "w1", name: "whoami", arguments: {} }] };
            case 1: throw new RuntimePause("waiting_for_funds", "run-1:llm:1", "Add funds");
            case 2: return { content: "", toolCalls: [{ id: "w2", name: "whoami", arguments: {} }] };
            default: return { content: "", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "I am testing." } }] };
          }
        } };
      } };
    const worker = new MachineWorker(options); await worker.initialize();
    await worker.handleLine(JSON.stringify(start({ tools: [whoami], instructions: [rules] }))); await worker.drain();
    const waiting = events.filter(e => e.type === "run.finished").at(-1)!;
    expect(waiting.payload).toMatchObject({ outcome: "waiting_for_funds", pendingOperationId: "run-1:llm:1" });
    const restarted = new MachineWorker(options); await restarted.initialize();
    await restarted.handleLine(JSON.stringify({ protocolVersion: 1, id: "resume", runId: "run-1", seq: 2, emittedAt: "2026-11-18T00:01:00Z", type: "run.resume",
      payload: { sessionId: "session-1", cause: "funds_available", operationId: "run-1:llm:1" } }));
    await restarted.drain();
    expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
    expect(offered).toEqual([["whoami"], ["whoami"]]);
    expect(hosted.mock.calls.map(call => call[0])).toEqual(["control.whoami", "control.whoami"]);
    expect(systems.every(system => system.endsWith(`\n\n${rules}`))).toBe(true);
  });

  it("gives a chat-only model neither the tools nor the instructions", async () => {
    let tools: DynamicToolDefinition[] | undefined; let system = "";
    const worker = new MachineWorker({ agentHome: await root(), hostedTools: () => vi.fn(), output: () => undefined,
      provider: (_run, _session, extraTools) => { tools = extraTools; return { complete: async (messages: LlmMessage[]) => {
        system = systemOf(messages); return { content: "Hello.", toolCalls: [] };
      } }; } });
    await worker.initialize();
    await worker.handleLine(JSON.stringify(start({ tools: [whoami], instructions: [rules], modelPolicy: { chatOnly: true } }))); await worker.drain();
    expect(tools).toEqual([]); expect(system).not.toContain(rules);
  });
});
