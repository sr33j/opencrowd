import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import {
  BlockRunProvider,
  createOpenCrowdRuntime,
  normalizeProviderModels,
  parseChatCompletionResponse,
  readSseCompletion,
  resolveSessionModels,
  type BlockRunLikeClient
} from "../src/index.js";

/**
 * qwen/qwen3.8-max on BlockRun, fully mocked: no network, no real wallet.
 * The catalog entry below is copied from GET https://blockrun.ai/api/v1/models.
 */
const QWEN = "qwen/qwen3.8-max";
const QWEN_CATALOG_ENTRY = {
  id: QWEN,
  object: "model",
  created: 1700000000,
  owned_by: "qwen",
  name: "Qwen3.8 Max",
  description: "Alibaba's Qwen3.8 Max — current flagship of the Qwen line. 1M context, 131K output.",
  context_window: 1000000,
  max_output: 131072,
  categories: ["chat", "reasoning", "coding"],
  billing_mode: "paid",
  available: true,
  pricing: { input: 2, output: 6 }
};
const TOOLS = [
  { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "get_budget_status", description: "Budget", parameters: { type: "object", properties: {} } }
];

/** A Qwen/DashScope-style stream: reasoning deltas, "" ids and names on continuation chunks, split arguments, finish_reason "stop". */
function qwenToolCallChunks(): Record<string, unknown>[] {
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning_content: "Need to read " }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: null, reasoning_content: "the file." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "", tool_calls: [{ index: 0, id: "call_qwen_a", type: "function", function: { name: "read_file", arguments: "{\"path\":" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "", type: "function", function: { name: "", arguments: " \"notes" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ".md\"}" } }] }, finish_reason: null }] },
    // A second parallel call delivered whole in one chunk.
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_qwen_b", type: "function", function: { name: "get_budget_status", arguments: "{}" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 64 } } }
  ];
}

function sse(chunks: unknown[], done = true): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

function sseResponse(chunks: unknown[]): Response {
  return new Response(sse(chunks), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const PAY_TO = "0x1111111111111111111111111111111111111111";
function quote402(amount: string): Response {
  const envelope = {
    x402Version: 2,
    accepts: [{
      scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }
    }]
  };
  return new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(envelope)).toString("base64") } });
}

const roots: string[] = [];
let previousWalletPath: string | undefined;

beforeEach(async () => {
  // A throwaway key generated per test; the real ~/.agentcash wallet is never read.
  const root = await mkdtemp(join(tmpdir(), "qwen-blockrun-"));
  roots.push(root);
  const walletPath = join(root, "wallet.json");
  await writeFile(walletPath, JSON.stringify({
    address: "0x2222222222222222222222222222222222222222",
    privateKey: `0x${randomBytes(32).toString("hex")}`
  }));
  previousWalletPath = process.env.AGENTCASH_WALLET_PATH;
  process.env.AGENTCASH_WALLET_PATH = walletPath;
});

afterEach(async () => {
  if (previousWalletPath === undefined) delete process.env.AGENTCASH_WALLET_PATH;
  else process.env.AGENTCASH_WALLET_PATH = previousWalletPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("qwen/qwen3.8-max on BlockRun", () => {
  it("normalizes the live catalog entry with per-million pricing and a 1M context", () => {
    const [model] = normalizeProviderModels({ object: "list", data: [QWEN_CATALOG_ENTRY] });
    expect(model).toMatchObject({ id: QWEN, name: "Qwen3.8 Max", contextWindowTokens: 1_000_000, maxOutputTokens: 131_072 });
    // $2 / $6 per million tokens = 0.2¢ / 0.6¢ per 1k.
    expect(model.inputCostCentsPer1k).toBeCloseTo(0.2);
    expect(model.outputCostCentsPer1k).toBeCloseTo(0.6);
    // No capability flag in BlockRun's catalog: unknown, never "unsupported".
    expect(model.supportsTools).toBeUndefined();
    expect(resolveSessionModels("blockrun", [model], { main: QWEN, subagent: "off" })).toMatchObject({ provider: "blockrun", main: QWEN });
  });

  it("parses a Qwen-style streamed tool call through the BlockRun SDK stream path", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const client: BlockRunLikeClient = {
      async *stream<T>(_path: string, body?: Record<string, unknown>) {
        seenBody = body;
        for (const chunk of qwenToolCallChunks()) yield chunk as T;
      },
      getSpending: () => ({ totalUsd: 0.004, calls: 1 })
    };
    const provider = new BlockRunProvider({ clientFactory: async () => client });
    const deltas: string[] = [];
    const completion = await provider.complete({
      model: QWEN, messages: [{ role: "user", content: "read notes.md" }], tools: TOOLS, onTextDelta: (delta) => deltas.push(delta)
    });
    expect(seenBody).toMatchObject({ model: QWEN, stream: true, tool_choice: "auto" });
    expect(completion.toolCalls).toEqual([
      { id: "call_qwen_a", name: "read_file", arguments: { path: "notes.md" } },
      { id: "call_qwen_b", name: "get_budget_status", arguments: {} }
    ]);
    expect(completion.content).toBe("");
    expect(deltas).toEqual([]);
    expect(completion.finishReason).toBe("stop");
    expect(completion.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 64, costCents: 0.4 });
  });

  it("approves the 402 quote, signs with the local wallet, and parses the paid Qwen stream", async () => {
    const requests: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return requests.length === 1 ? quote402("4500") : sseResponse(qwenToolCallChunks());
    });
    const provider = new BlockRunProvider({ fetchImpl: fetcher as unknown as typeof fetch });
    const authorize = vi.fn(async () => undefined);
    const completion = await provider.complete({
      model: QWEN, messages: [{ role: "user", content: "read notes.md" }], tools: TOOLS, authorizePayment: authorize, maxOutputTokens: 4096
    });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][0]).toBe(0.45);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requests[0].headers["payment-signature"]).toBeUndefined();
    expect(requests[0].body).toMatchObject({ model: QWEN, stream: true, max_tokens: 4096, tool_choice: "auto" });
    expect((requests[0].body.tools as unknown[]).length).toBe(2);
    const payment = JSON.parse(Buffer.from(requests[1].headers["payment-signature"], "base64").toString());
    expect(payment).toMatchObject({ x402Version: 2, accepted: { amount: "4500", payTo: PAY_TO, network: "eip155:8453" } });
    expect(requests[1].body).toEqual(requests[0].body);
    expect(completion.toolCalls.map((call) => call.id)).toEqual(["call_qwen_a", "call_qwen_b"]);
    expect(completion.toolCalls[0].arguments).toEqual({ path: "notes.md" });
    expect(completion.usage.costCents).toBe(0.45);
  });

  it("runs a Qwen tool call end to end and echoes the tool call id back to BlockRun", async () => {
    const root = await mkdtemp(join(tmpdir(), "qwen-runtime-"));
    roots.push(root);
    const session = await createSession({ workspaceRoot: root, budgetCents: 1000, perCallCents: 100 });
    const bodies: Record<string, unknown>[] = [];
    let signed = 0;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (!headers["payment-signature"]) return quote402("2000");
      signed += 1;
      bodies.push(JSON.parse(String(init?.body)));
      return signed === 1
        ? sseResponse([
          { choices: [{ index: 0, delta: { reasoning_content: "check budget" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_q1", type: "function", function: { name: "budget_tool", arguments: "{\"scope\":" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "", function: { name: "", arguments: "\"query\"}" } }] }, finish_reason: "stop" }] }
        ])
        : sseResponse([
          { choices: [{ index: 0, delta: { content: "All " }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: "done." }, finish_reason: "stop" }] }
        ]);
    });
    const provider = new BlockRunProvider({ fetchImpl: fetcher as unknown as typeof fetch });
    const executed: unknown[] = [];
    const runtime = createOpenCrowdRuntime({
      workspace: root,
      llmProvider: async () => ({ kind: "typed", main: { provider, model: QWEN, maxCostCentsPerCall: 100 } }),
      economy: async () => ({
        definitions: () => [{ name: "budget_tool", description: "Budget", parameters: { type: "object", properties: { scope: { type: "string" } } } }],
        execute: async (_name: string, args: unknown) => { executed.push(args); return { ok: true }; },
        hasPendingRequiredReviews: async () => false
      })
    });

    const result = await runtime.runTask(session, "check my budget");
    expect(result.outcome).toBe("completed");
    expect(executed).toEqual([{ scope: "query" }]);
    expect(signed).toBe(2);
    const followUp = bodies[1].messages as Record<string, unknown>[];
    const assistant = followUp.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistant?.tool_calls).toEqual([{ id: "call_q1", type: "function", function: { name: "budget_tool", arguments: "{\"scope\":\"query\"}" } }]);
    expect(followUp.find((message) => message.role === "tool")).toMatchObject({ tool_call_id: "call_q1" });
    expect(session.spentCents).toBeCloseTo(0.4);
  });

  it("handles index-less deltas, object arguments, repeated names, and surfaces in-stream errors", async () => {
    const indexless = await readSseCompletion(new Response(sse([
      { choices: [{ delta: { tool_calls: [
        { id: "a", function: { name: "read_file", arguments: { path: "x" } } },
        { id: "b", function: { name: "get_budget_status", arguments: "{}" } }
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "get_budget_status" } }] }, finish_reason: "tool_calls" }] }
    ])), undefined, Date.now());
    expect(indexless.toolCalls).toEqual([
      { id: "a", name: "read_file", arguments: { path: "x" } },
      { id: "b", name: "get_budget_status", arguments: {} }
    ]);

    await expect(readSseCompletion(new Response(sse([
      { choices: [{ delta: { content: "partial" } }] },
      { error: { message: "upstream qwen error", code: "server_error" } }
    ])), undefined, Date.now())).rejects.toThrow("upstream qwen error");

    expect(parseChatCompletionResponse({
      choices: [{ message: { content: null, reasoning_content: "r", tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: { path: "y" } } }] }, finish_reason: "tool_calls" }]
    }).toolCalls).toEqual([{ id: "c", name: "read_file", arguments: { path: "y" } }]);
  });
});
