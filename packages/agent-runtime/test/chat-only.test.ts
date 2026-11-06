import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import { ModelPolicySchema, type Command, type Event } from "@opencrowd/protocol";
import { MachineWorker } from "../src/worker.js";
import { createHostedProvider } from "../src/hosted-provider.js";
import { CHAT_ONLY_SYSTEM_PROMPT, chatOnlyMessages, runAgentTaskDetailed, type LlmMessage } from "../src/index.js";

// SRI-91: venice-uncensored-1-2 and venice-uncensored-role-play wrote their
// run_shell calls as text and made up the output. They are offered again as
// chat-only models, whose runs must carry no tools at all.

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "chat-only-")); roots.push(dir); return dir; }

const TOOL_WORDS = /run_shell|complete_session|find_paid_service|call_paid_service|save_file|automations|deploy_service/;

describe("chat-only runs", () => {
  it("accepts chatOnly in the model policy", () => {
    expect(ModelPolicySchema.parse({ provider: "hosted", model: "venice/venice-uncensored-1-2", chatOnly: true }).chatOnly).toBe(true);
  });

  it("sends the chat-only prompt with no tool instructions, and never executes a tool call", async () => {
    const session = await createSession({ workspaceRoot: await root(), budgetCents: 100, approvalMode: "off" });
    const seen: LlmMessage[][] = [];
    const toolExecutor = vi.fn(async () => ({ ok: true, data: { stdout: "made up" } }));
    const result = await runAgentTaskDetailed(session, "Run `ls` for me", {
      hosted: true, chatOnly: true, toolExecutor,
      provider: { complete: async (messages) => {
        seen.push(structuredClone(messages));
        // A seller that returns a call anyway: the words reach the owner, the call does not run.
        return { content: "This agent is on a chat-only model, so I can't run commands.", toolCalls: [{ id: "x", name: "run_shell", arguments: { command: "ls" } }] };
      } },
    });
    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toBe("This agent is on a chat-only model, so I can't run commands.");
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toEqual({ role: "system", content: CHAT_ONLY_SYSTEM_PROMPT });
    expect(seen[0][0].content).not.toMatch(TOOL_WORDS);
    expect(seen[0][0].content).toMatch(/chat-only model/);
  });

  it("strips tool calls and tool results from the history it sends, and leaves what was said", () => {
    const history: LlmMessage[] = [
      { role: "user", content: "hash it" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "run_shell", arguments: { command: "sha256sum" } }] },
      { role: "tool", toolCallId: "a", content: "{\"ok\":true}" },
      { role: "assistant", content: "Running it now.", toolCalls: [{ id: "b", name: "complete_session", arguments: {} }] },
      { role: "user", content: "thanks" },
    ];
    expect(chatOnlyMessages(history)).toEqual([
      { role: "user", content: "hash it" },
      { role: "assistant", content: "Running it now." },
      { role: "user", content: "thanks" },
    ]);
  });

  it("sends the gateway no tools and no tool history", async () => {
    const home = await root(), socketPath = join(home, "bridge.sock");
    const bodies: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end(JSON.stringify({ status: "complete", response: { content: "hi", toolCalls: [] } }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await createHostedProvider({ socketPath, runId: "run-1", sessionId: "session-1", chatOnly: true }).complete([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "run_shell", arguments: {} }] },
        { role: "tool", toolCallId: "a", content: "out" },
      ], { operationId: "run-1:llm:0" });
      expect(bodies[0].tools).toEqual([]);
      expect(bodies[0].messages).toEqual([{ role: "user", content: "hi" }]);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("builds no hosted tools, economy or financial reads for a chat-only run", async () => {
    const home = await root(); const events: Event[] = [];
    const hostedTools = vi.fn(), economy = vi.fn(), financialState = vi.fn();
    const extra: unknown[] = [];
    const provider = { complete: vi.fn(async () => ({ content: "Once upon a time…", toolCalls: [] })) };
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-11-06T00:00:00Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Tell me a story", budget: { limit: "1000000" }, approvalMode: "auto",
        modelPolicy: { provider: "hosted", model: "venice/venice-uncensored-role-play", chatOnly: true } } };
    const worker = new MachineWorker({ agentHome: home, hostedTools, economy, financialState,
      provider: (_run, _session, extraTools) => { extra.push(extraTools); return provider; },
      output: (line: string) => { events.push(JSON.parse(line)); } } as never);
    await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    const finished = events.filter((e) => e.type === "run.finished").at(-1);
    expect(finished?.payload).toMatchObject({ outcome: "completed", summary: "Once upon a time…" });
    expect(hostedTools).not.toHaveBeenCalled();
    expect(economy).not.toHaveBeenCalled();
    expect(financialState).not.toHaveBeenCalled();
    expect(extra).toEqual([[]]);
    expect(events.some((e) => e.type === "tool.started")).toBe(false);
  });
});
