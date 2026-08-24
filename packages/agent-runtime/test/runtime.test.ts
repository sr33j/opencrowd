import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSession, readLedger } from "../../core/src/index.js";
import { VeniceError } from "venice-x402-client";
import {
  BudgetedLlmProvider,
  createOpenCrowdRuntime,
  createMockToolExecutor,
  MOCK_X402_SERVICES,
  MockLlmProvider,
  normalizeProviderModels,
  OpenRouterProvider,
  renderCompactPurchaseSummary,
  renderProgress,
  resolveSessionModels,
  runAgentTask,
  runAgentTaskDetailed,
  toWireChatMessage,
  VeniceProvider,
  X402ProxyProvider,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type ProviderCompletion,
  type ProviderModel,
  type TypedLlmProvider
} from "../src/index.js";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencrowd-runtime-test-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.OPENCROWD_CONFIG_DIR;
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("typed providers and budget accounting", () => {
  function fakeTypedProvider(overrides: Partial<ProviderCompletion> = {}, id: "venice" | "openrouter" = "venice"): TypedLlmProvider {
    return {
      id,
      async listModels() {
        return [{ id: "test-model", outputCostCentsPer1k: 2, inputCostCentsPer1k: 1 }];
      },
      async complete() {
        return {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 5, costCents: 4 },
          ...overrides
        };
      }
    };
  }

  it("reserves budget, finalizes actual cost, and writes llm_call ledger rows with cache metrics", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 25 });
    const provider = new BudgetedLlmProvider(session, fakeTypedProvider(), {
      model: "test-model",
      maxCostCentsPerCall: 10
    });

    await expect(provider.complete([{ role: "user", content: "hi" }])).resolves.toEqual({ content: "done", toolCalls: [] });
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(4);
    const rows = await readLedger(session.ledgerPath);
    expect(rows).toContainEqual(expect.objectContaining({
      type: "llm_call",
      endpoint: "venice",
      model: "test-model",
      status: "charged",
      charged_cost_cents: "4",
      input_tokens: "11",
      output_tokens: "3"
    }));
    const row = rows.find((candidate) => candidate.type === "llm_call");
    expect(JSON.parse(row?.notes ?? "{}")).toMatchObject({ cached_input_tokens: 5 });
  });

  it("estimates cost from catalog pricing when the provider reports none", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 25 });
    const provider = new BudgetedLlmProvider(session, fakeTypedProvider({
      usage: { inputTokens: 1_000, outputTokens: 2_000 }
    }), {
      model: "test-model",
      maxCostCentsPerCall: 10,
      catalog: [{ id: "test-model", inputCostCentsPer1k: 1, outputCostCentsPer1k: 2 }]
    });

    await provider.complete([{ role: "user", content: "hi" }]);
    expect(session.spentCents).toBe(5);
  });

  it("rejects over-budget LLM calls before calling the provider", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 5 });
    let called = false;
    const typed: TypedLlmProvider = {
      id: "venice",
      async listModels() { return []; },
      async complete() {
        called = true;
        return { content: "", toolCalls: [], usage: {} };
      }
    };
    const provider = new BudgetedLlmProvider(session, typed, { model: "m", maxCostCentsPerCall: 10 });

    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("budget exceeded");
    expect(called).toBe(false);
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(0);
  });

  it("releases reserved budget and writes failed ledger rows when the provider fails", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 25 });
    const typed: TypedLlmProvider = {
      id: "openrouter",
      async listModels() { return []; },
      async complete() {
        throw new Error("network down");
      }
    };
    const provider = new BudgetedLlmProvider(session, typed, { model: "m", maxCostCentsPerCall: 10 });

    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("network down");
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(0);
    const rows = await readLedger(session.ledgerPath);
    expect(rows).toContainEqual(expect.objectContaining({
      type: "llm_call",
      endpoint: "openrouter",
      status: "failed",
      charged_cost_cents: "0"
    }));
  });

  it("filters tool calls the current tool surface does not include", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 25 });
    const provider = new BudgetedLlmProvider(session, fakeTypedProvider({
      toolCalls: [
        { id: "a", name: "get_budget_status", arguments: {} },
        { id: "b", name: "made_up_tool", arguments: {} }
      ],
      usage: {}
    }), { model: "m", maxCostCentsPerCall: 10, tools: ["get_budget_status"] });

    const response = await provider.complete([{ role: "user", content: "hi" }]);
    expect(response.toolCalls).toEqual([{ id: "a", name: "get_budget_status", arguments: {} }]);
  });
});

describe("Venice provider", () => {
  interface FakeVeniceCall {
    path: string;
    body: Record<string, unknown>;
  }

  function fakeVeniceClient(options: {
    responses?: Array<Response | Error>;
    balances?: number[];
  } = {}) {
    const calls: FakeVeniceCall[] = [];
    const topUps: number[] = [];
    let balanceCalls = 0;
    let requestIndex = 0;
    const balances = options.balances ?? [];
    const client = {
      get balance() {
        return balances[Math.min(requestIndex, Math.max(balances.length - 1, 0))] ?? 0;
      },
      async requestRaw(path: string, init?: RequestInit): Promise<Response> {
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
        const scripted = options.responses?.[requestIndex];
        requestIndex += 1;
        if (scripted instanceof Error) {
          throw scripted;
        }
        return scripted ?? new Response(JSON.stringify({
          choices: [{ message: { content: "done" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 }
        }), { status: 200 });
      },
      async getBalance() {
        balanceCalls += 1;
        return { balanceUsd: 1, canConsume: true, minimumTopUpUsd: 1, suggestedTopUpUsd: 5 };
      },
      async topUp(amountUsd: number) {
        topUps.push(amountUsd);
      }
    };
    return { client, calls, topUps, remoteBalanceCalls: () => balanceCalls };
  }

  it("reuses one long-lived client and never checks remote balance per call", async () => {
    let built = 0;
    const fake = fakeVeniceClient();
    const provider = new VeniceProvider({
      clientFactory: async () => {
        built += 1;
        return fake.client;
      }
    });

    await provider.complete({ model: "m", messages: [{ role: "user", content: "one" }], tools: [] });
    await provider.complete({ model: "m", messages: [{ role: "user", content: "two" }], tools: [] });

    expect(built).toBe(1);
    expect(fake.remoteBalanceCalls()).toBe(0);
    // Steady state: one network inference request per turn, nothing else.
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((call) => call.path.endsWith("/chat/completions"))).toBe(true);
  });

  it("keeps the per-session prompt_cache_key stable across turns", async () => {
    const fake = fakeVeniceClient();
    const provider = new VeniceProvider({ clientFactory: async () => fake.client });

    await provider.complete({ model: "m", messages: [], tools: [], promptCacheKey: "session-1" });
    await provider.complete({ model: "m", messages: [], tools: [], promptCacheKey: "session-1" });

    expect(fake.calls.map((call) => call.body.prompt_cache_key)).toEqual(["session-1", "session-1"]);
  });

  it("streams deltas, surfaces time-to-first-token, and normalizes cached token metrics", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_budget_status","arguments":"{}"}}]}}]}',
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":7}}}',
      "data: [DONE]"
    ].join("\n") + "\n";
    const fake = fakeVeniceClient({ responses: [new Response(sse, { status: 200 })] });
    const provider = new VeniceProvider({ clientFactory: async () => fake.client });
    const deltas: string[] = [];

    const completion = await provider.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onTextDelta: (delta) => deltas.push(delta)
    });

    expect(fake.calls[0].body.stream).toBe(true);
    expect(deltas.join("")).toBe("Hello");
    expect(completion.content).toBe("Hello");
    expect(completion.toolCalls).toEqual([{ id: "call_1", name: "get_budget_status", arguments: {} }]);
    expect(completion.usage).toMatchObject({ inputTokens: 9, outputTokens: 4, cachedInputTokens: 7 });
    expect(completion.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("performs at most one bounded top-up and one retry on insufficient credit", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 500 });
    const insufficient = new VeniceError("INSUFFICIENT_BALANCE", "Insufficient balance", { minimumTopUpUsd: 1 });
    const fake = fakeVeniceClient({
      responses: [insufficient, new Response(JSON.stringify({
        choices: [{ message: { content: "recovered" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      }), { status: 200 })]
    });
    const provider = new VeniceProvider({ clientFactory: async () => fake.client });
    const budgeted = new BudgetedLlmProvider(session, provider, {
      model: "m",
      maxCostCentsPerCall: 10,
      maxTopUpCentsPerAction: 200
    });

    const response = await budgeted.complete([{ role: "user", content: "hi" }]);

    expect(response.content).toBe("recovered");
    // Bounded by the per-top-up ceiling ($2), not the session allowance ($5).
    expect(fake.topUps).toEqual([2]);
    const rows = await readLedger(session.ledgerPath);
    expect(rows).toContainEqual(expect.objectContaining({ type: "wallet_top_up", status: "charged", charged_cost_cents: "200" }));
    // Top-ups are cash flow, not budget spend: only usage enters spentCents.
    expect(session.spentCents).toBe(0);
  });

  it("never loops: a second insufficient-credit failure propagates", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 500 });
    const insufficient = () => new VeniceError("INSUFFICIENT_BALANCE", "Insufficient balance", {});
    const fake = fakeVeniceClient({ responses: [insufficient(), insufficient()] });
    const provider = new VeniceProvider({ clientFactory: async () => fake.client });
    const budgeted = new BudgetedLlmProvider(session, provider, {
      model: "m",
      maxCostCentsPerCall: 10,
      maxTopUpCentsPerAction: 200
    });

    await expect(budgeted.complete([{ role: "user", content: "hi" }])).rejects.toThrow("credit is exhausted");
    expect(fake.topUps).toHaveLength(1);
    expect(session.reservedCents).toBe(0);
  });

  it("refuses a top-up beyond the remaining session allowance", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50 });
    const fake = fakeVeniceClient({
      responses: [new VeniceError("INSUFFICIENT_BALANCE", "Insufficient balance", { minimumTopUpUsd: 1 })]
    });
    const provider = new VeniceProvider({ clientFactory: async () => fake.client });
    // Reservation of 10 leaves a 40-cent allowance; the $1 minimum cannot fit.
    const budgeted = new BudgetedLlmProvider(session, provider, {
      model: "m",
      maxCostCentsPerCall: 10,
      maxTopUpCentsPerAction: 1000
    });

    await expect(budgeted.complete([{ role: "user", content: "hi" }])).rejects.toThrow("session allowance");
    expect(fake.topUps).toHaveLength(0);
  });
});

describe("OpenRouter provider", () => {
  it("requires an API key with remediation", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const provider = new OpenRouterProvider({});
      await expect(provider.complete({ model: "m", messages: [], tools: [] })).rejects.toThrow("OPENROUTER_API_KEY");
    } finally {
      if (saved !== undefined) {
        process.env.OPENROUTER_API_KEY = saved;
      }
    }
  });

  it("sends the bearer key, requests usage accounting, and normalizes cost and cache metrics", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    const provider = new OpenRouterProvider({
      apiKey: "sk-test",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenAuth = (init?.headers as Record<string, string>).authorization;
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "hello", tool_calls: [] } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 6 },
            cost: 0.012
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    });

    const completion = await provider.complete({
      model: "openai/gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: []
    });

    expect(seenUrl).toContain("openrouter.ai/api/v1/chat/completions");
    expect(seenAuth).toBe("Bearer sk-test");
    expect(seenBody.usage).toEqual({ include: true });
    expect(completion.content).toBe("hello");
    expect(completion.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 6,
      costCents: 1.2
    });
  });

  it("never falls back to another provider on failure", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "sk-test",
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 })) as typeof fetch
    });
    await expect(provider.complete({ model: "m", messages: [], tools: [] }))
      .rejects.toThrow("OpenRouter account credit is exhausted");
  });
});

describe("failure hardening", () => {
  it("retries a transient provider failure exactly once", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50 });
    let attempts = 0;
    const flaky: TypedLlmProvider = {
      id: "venice",
      async listModels() { return []; },
      async complete() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Venice inference failed (TIMEOUT): Request timed out after 180000ms");
        }
        return { content: "recovered", toolCalls: [], usage: { costCents: 2 } };
      }
    };
    const provider = new BudgetedLlmProvider(session, flaky, { model: "m", maxCostCentsPerCall: 10 });

    await expect(provider.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({ content: "recovered" });
    expect(attempts).toBe(2);
    expect(session.spentCents).toBe(2);
  });

  it("does not retry twice or on non-transient failures", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50 });
    let attempts = 0;
    const dead: TypedLlmProvider = {
      id: "venice",
      async listModels() { return []; },
      async complete() {
        attempts += 1;
        throw new Error("Venice inference failed (TIMEOUT): still down");
      }
    };
    const provider = new BudgetedLlmProvider(session, dead, { model: "m", maxCostCentsPerCall: 10 });
    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("TIMEOUT");
    expect(attempts).toBe(2);

    attempts = 0;
    const badRequest: TypedLlmProvider = {
      id: "venice",
      async listModels() { return []; },
      async complete() {
        attempts += 1;
        throw new Error("model `nope` is not in the venice catalog");
      }
    };
    const provider2 = new BudgetedLlmProvider(session, badRequest, { model: "m", maxCostCentsPerCall: 10 });
    await expect(provider2.complete([{ role: "user", content: "hi" }])).rejects.toThrow("catalog");
    expect(attempts).toBe(1);
  });

  it("stops the loop gracefully when the budget is exhausted instead of erroring the run", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 5 });
    const typed: TypedLlmProvider = {
      id: "venice",
      async listModels() { return []; },
      async complete() {
        return { content: "unreachable", toolCalls: [], usage: {} };
      }
    };
    // Reservation ceiling exceeds the budget: the first reserve throws
    // BudgetExhaustedError, and the loop must stop deterministically.
    const provider = new BudgetedLlmProvider(session, typed, { model: "m", maxCostCentsPerCall: 10 });
    const result = await runAgentTaskDetailed(session, "do something", { provider });
    expect(result.outcome).toBe("stopped");
    expect(String(result.summary.final_message)).toContain("budget is exhausted");
  });

  it("only attributes balance-delta cost to calls with an exclusive client window", async () => {
    let balance = 10;
    let concurrent = 0;
    const client = {
      get balance() { return balance; },
      async requestRaw() {
        concurrent += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        balance -= 0.01;
        concurrent -= 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      },
      async getBalance() { return { balanceUsd: balance, canConsume: true, minimumTopUpUsd: 5, suggestedTopUpUsd: 10 }; },
      async topUp() {}
    };
    const provider = new VeniceProvider({ clientFactory: async () => client });

    const [a, b] = await Promise.all([
      provider.complete({ model: "m", messages: [], tools: [] }),
      provider.complete({ model: "m", messages: [], tools: [] })
    ]);
    // Concurrent lanes must not claim each other's spend.
    expect(a.usage.costCents).toBeUndefined();
    expect(b.usage.costCents).toBeUndefined();

    const solo = await provider.complete({ model: "m", messages: [], tools: [] });
    expect(solo.usage.costCents).toBeCloseTo(1, 5);
  });

  it("auto subagent resolution skips zero-priced stealth models when priced ones exist", () => {
    const resolved = resolveSessionModels("venice", [
      { id: "stealth-free", inputCostCentsPer1k: 0, outputCostCentsPer1k: 0, contextWindowTokens: 1_000_000, supportsTools: true },
      { id: "cheap-priced", inputCostCentsPer1k: 0.01, outputCostCentsPer1k: 0.02, contextWindowTokens: 256_000, supportsTools: true },
      { id: "frontier", inputCostCentsPer1k: 2, outputCostCentsPer1k: 8, contextWindowTokens: 200_000, supportsTools: true }
    ], { main: "auto", subagent: "auto" });
    expect(resolved.subagent).toBe("cheap-priced");
  });
});

describe("x402 proxy provider", () => {
  const TEST_KEY = "0x59c6995e998f97a5a0044966f094538f89d8f907357e22278c4cfeabf7c5d1c6";
  const CHALLENGE = {
    x402Version: 2,
    resource: { url: "https://proxy.test/v1/chat/completions", method: "POST" },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      amount: "5000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x06dFF3c8380b5D1799874adA903fc3422882FD6f",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" }
    }]
  };
  const COMPLETION = { choices: [{ message: { content: "paid ok" } }], usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.0002 } };

  it("passes unchallenged requests through with no payment overhead and reads usage cost", async () => {
    const seen: Array<{ headers: Record<string, string> }> = [];
    const provider = new X402ProxyProvider({
      baseUrl: "https://proxy.test/v1",
      privateKey: TEST_KEY,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(JSON.stringify(COMPLETION), { status: 200 });
      }) as typeof fetch
    });

    const completion = await provider.complete({ model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(completion.content).toBe("paid ok");
    expect(completion.usage.costCents).toBeCloseTo(0.02, 5);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers["x-payment"]).toBeUndefined();
  });

  it("signs a 402 challenge, retries once, and pre-signs subsequent calls", async () => {
    const calls: Array<{ paid: boolean }> = [];
    const provider = new X402ProxyProvider({
      baseUrl: "https://proxy.test/v1",
      privateKey: TEST_KEY,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("x-payment");
        calls.push({ paid });
        if (!paid) {
          return new Response(JSON.stringify(CHALLENGE), { status: 402 });
        }
        const decoded = JSON.parse(Buffer.from(headers.get("x-payment") ?? "", "base64").toString("utf8"));
        expect(decoded).toMatchObject({ x402Version: 2, accepted: { amount: "5000", network: "eip155:8453" } });
        expect(decoded.payload?.authorization?.to).toBe("0x06dFF3c8380b5D1799874adA903fc3422882FD6f");
        return new Response(JSON.stringify(COMPLETION), { status: 200, headers: { "x402-charged-cost-cents": "3" } });
      }) as typeof fetch
    });

    const first = await provider.complete({ model: "m", messages: [{ role: "user", content: "a" }], tools: [] });
    expect(first.content).toBe("paid ok");
    // Settled-cost header wins over body usage.
    expect(first.usage.costCents).toBe(3);
    // unpaid probe -> 402 -> paid retry
    expect(calls.map((call) => call.paid)).toEqual([false, true]);

    const second = await provider.complete({ model: "m", messages: [{ role: "user", content: "b" }], tools: [] });
    expect(second.content).toBe("paid ok");
    // Cached challenge: the payment header is attached preemptively, no extra round trip.
    expect(calls.map((call) => call.paid)).toEqual([false, true, true]);
  });

  it("streams SSE responses with deltas", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"to"}}]}',
      'data: {"choices":[{"delta":{"content":"kens"}}]}',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.0001}}',
      "data: [DONE]"
    ].join("\n") + "\n";
    const provider = new X402ProxyProvider({
      baseUrl: "https://proxy.test/v1",
      privateKey: TEST_KEY,
      fetchImpl: (async () => new Response(sse, { status: 200 })) as typeof fetch
    });
    const deltas: string[] = [];
    const completion = await provider.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onTextDelta: (delta) => deltas.push(delta)
    });
    expect(deltas.join("")).toBe("tokens");
    expect(completion.usage.costCents).toBeCloseTo(0.01, 5);
  });
});

describe("model resolution", () => {
  const catalog: ProviderModel[] = [
    { id: "frontier", inputCostCentsPer1k: 2, outputCostCentsPer1k: 8, contextWindowTokens: 200_000, supportsTools: true },
    { id: "mid", inputCostCentsPer1k: 0.5, outputCostCentsPer1k: 1, contextWindowTokens: 128_000, supportsTools: true },
    { id: "tiny", inputCostCentsPer1k: 0.05, outputCostCentsPer1k: 0.1, contextWindowTokens: 8_000, supportsTools: true },
    { id: "no-tools", inputCostCentsPer1k: 9, outputCostCentsPer1k: 9, contextWindowTokens: 200_000, supportsTools: false }
  ];

  it("auto-resolves the priciest tool-capable main model and the cheapest viable subagent", () => {
    const resolved = resolveSessionModels("venice", catalog, { main: "auto", subagent: "auto" });
    expect(resolved).toMatchObject({ provider: "venice", main: "frontier", subagent: "mid" });
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it("supports disabling subagents and validates explicit IDs against the catalog", () => {
    expect(resolveSessionModels("venice", catalog, { main: "frontier", subagent: "off" }).subagent).toBeUndefined();
    expect(() => resolveSessionModels("venice", catalog, { main: "missing", subagent: "auto" }))
      .toThrow("not in the venice catalog");
  });

  it("normalizes provider catalog shapes", () => {
    const models = normalizeProviderModels({
      data: [
        { id: "or-model", context_length: 128_000, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
        { id: "venice-model", model_spec: { availableContextTokens: 65_536, capabilities: { supportsFunctionCalling: true }, pricing: { input: { usd: 0.5 }, output: { usd: 2 } } } },
        "bare-model"
      ]
    });
    expect(models[0]).toMatchObject({ id: "or-model", contextWindowTokens: 128_000, inputCostCentsPer1k: 0.1, outputCostCentsPer1k: 0.2, supportsTools: true });
    expect(models[1]).toMatchObject({ id: "venice-model", contextWindowTokens: 65_536, supportsTools: true, inputCostCentsPer1k: 0.05, outputCostCentsPer1k: 0.2 });
    expect(models[2]).toMatchObject({ id: "bare-model" });
  });

  it("serializes assistant tool-call history without content", () => {
    const wire = toWireChatMessage({
      role: "assistant",
      content: "I'll check available services.",
      toolCalls: [{ id: "call_1", name: "search_services", arguments: { query: "all services", limit: 20 } }]
    });
    expect(wire).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "search_services", arguments: JSON.stringify({ query: "all services", limit: 20 }) }
      }]
    });
    expect(wire).not.toHaveProperty("content");
  });
});

describe("agent loop transcript", () => {
  it("advertises the gateway lifecycle when paid tools exist, and says paid services are unavailable otherwise", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    let systemPrompt = "";
    const capture: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
        return { content: "done", toolCalls: [] };
      }
    };

    await runAgentTask(session, "host an app", { provider: capture });
    expect(systemPrompt).toContain("personal machine");
    expect(systemPrompt).toContain("Paid external services are unavailable in this run");

    const session2 = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    await runAgentTask(session2, "host an app", {
      provider: capture,
      dynamicTools: { definitions: [], execute: async () => ({ ok: true, data: {} }) }
    });
    expect(systemPrompt).toContain("inspect_paid_service");
    expect(systemPrompt).toContain("review_paid_service");
    expect(systemPrompt).toContain("enforced in code");
  });

  it("includes budget snapshots on every tool result message", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    const persisted: LlmMessage[] = [];
    const provider: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", name: "get_budget_status", arguments: {} }]
          };
        }
        const parsed = JSON.parse(toolResult.content) as Record<string, unknown>;
        expect(parsed).toMatchObject({
          budget_before_tool_call: { remaining_cents: 50 },
          budget_after_tool_call: { remaining_cents: 50 }
        });
        return { content: "done", toolCalls: [] };
      }
    };

    await runAgentTask(session, "check budget", {
      provider,
      onMessage: (message) => {
        persisted.push(message);
      }
    });

    const toolMessage = persisted.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "{}")).toMatchObject({
      result: { ok: true, data: { remaining_cents: 50 } }
    });
  });
});

describe("terminal rendering", () => {
  it("renders pretty progress rows with truncation and color disabled", () => {
    expect(renderProgress({
      type: "calling_llm",
      message: "Calling LLM provider (turn 3/100)"
    }, { style: "pretty", width: 80, color: false })).toBe("* turn 3/100");

    const toolRow = renderProgress({
      type: "calling_tool",
      message: "Tool call: call_service POST https://example.com/very/long/path/that/should/not/fill/the/terminal"
    }, { style: "pretty", width: 48, color: false });

    expect(toolRow).toMatch(/^  -> call_service POST ht/);
    expect(toolRow).toContain("…");
    expect(toolRow.length).toBeLessThanOrEqual(48);
  });

  it("renders compact purchase summaries without verbose sections", () => {
    const output = renderCompactPurchaseSummary({
      final_message: "Done.",
      budget: {
        total_spent_cents: 12,
        remaining_cents: 88
      },
      service_calls: [{ charged_cost_cents: "7" }],
      artifacts: ["sessions/demo/artifacts/result.json"]
    });

    expect(output).toBe("Done.\nsummary: spent $0.12, remaining $0.88, services 1, $0.07, artifacts 1");
  });
});

describe("connector dynamic tools", () => {
  it("advertises connector tools, dispatches to their executor, and retires the legacy surface", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    let systemPrompt = "";
    const provider: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return { content: "", toolCalls: [{ id: "call_1", name: "agentcash_fetch", arguments: { url: "https://api.paid.dev/x" } }] };
        }
        const parsed = JSON.parse(toolResult.content) as { result: { ok: boolean; data: Record<string, unknown> } };
        expect(parsed.result.ok).toBe(true);
        expect(parsed.result.data).toMatchObject({ body: "vendor data" });
        return { content: "", toolCalls: [{ id: "call_2", name: "complete_session", arguments: { final_message: "done" } }] };
      }
    };

    const result = await runAgentTaskDetailed(session, "use the vendor tool", {
      provider,
      dynamicTools: {
        definitions: [{ name: "agentcash_fetch", description: "Fetch a paid endpoint", parameters: { type: "object", properties: {} } }],
        execute: async (name, args) => {
          executed.push({ name, args });
          return { ok: true, data: { body: "vendor data" } };
        }
      },
      promptSections: ["HOUSE RULES MARKER"]
    });

    expect(result.outcome).toBe("completed");
    expect(executed).toEqual([{ name: "agentcash_fetch", args: { url: "https://api.paid.dev/x" } }]);
    expect(systemPrompt).toContain("HOUSE RULES MARKER");
    expect(systemPrompt).not.toContain("search_services");
  });
});

describe("dependency-injected runtime", () => {
  it("runs a task through injected storage, provider, and economy port", async () => {
    const root = await tempRoot();
    const persisted: LlmMessage[] = [];
    const executed: string[] = [];
    const runtime = createOpenCrowdRuntime({
      workspace: root,
      storage: {
        createSession: (options) => createSession({ ...options, budgetCents: 100 }),
        loadSession: async () => {
          throw new Error("not used");
        },
        appendMessage: async (_session, message) => {
          persisted.push(message);
        },
        history: async () => []
      },
      llmProvider: async () => ({
        kind: "scripted",
        provider: {
          async complete(messages: LlmMessage[]): Promise<LlmResponse> {
            const toolResult = messages.find((message) => message.role === "tool");
            if (!toolResult) {
              return { content: "", toolCalls: [{ id: "c1", name: "injected_tool", arguments: { a: 1 } }] };
            }
            return { content: "", toolCalls: [{ id: "c2", name: "complete_session", arguments: { final_message: "runtime done" } }] };
          }
        }
      }),
      economy: async () => ({
        definitions: () => [{ name: "injected_tool", description: "test", parameters: { type: "object", properties: {} } }],
        execute: async (name) => {
          executed.push(name);
          return { ok: true, data: { done: true } };
        },
        hasPendingRequiredReviews: async () => false
      })
    });

    const session = await runtime.createSession();
    expect(session.workspaceRoot).toBe(root);
    const result = await runtime.runTask(session, "do the thing");

    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toBe("runtime done");
    expect(executed).toEqual(["injected_tool"]);
    // Persistence went through the injected storage, not terminal globals.
    expect(persisted.some((message) => message.role === "assistant")).toBe(true);
  });

  it("blocks completion through the injected economy port's pending reviews", async () => {
    const root = await tempRoot();
    const runtime = createOpenCrowdRuntime({
      workspace: root,
      llmProvider: async () => ({
        kind: "scripted",
        provider: {
          async complete(): Promise<LlmResponse> {
            return { content: "finished", toolCalls: [] };
          }
        }
      }),
      economy: async () => ({
        definitions: () => [],
        execute: async () => ({ ok: true }),
        hasPendingRequiredReviews: async () => true
      })
    });
    const session = await runtime.createSession({ budgetCents: 100 });
    const result = await runtime.runTask(session, "finish");
    expect(result.outcome).toBe("stopped");
    expect(String(result.summary.final_message)).toContain("required review");
  });
});

describe("completion gating", () => {
  it("nudges once, then stops deterministically while the completion gate blocks", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50 });
    let completions = 0;
    const provider: LlmProvider = {
      async complete(): Promise<LlmResponse> {
        completions += 1;
        return { content: "all done", toolCalls: [] };
      }
    };

    const result = await runAgentTaskDetailed(session, "finish up", {
      provider,
      completionGate: async () => "a confirmed paid purchase still needs its required review"
    });

    expect(completions).toBe(2); // initial attempt + one nudge
    expect(result.outcome).toBe("stopped");
    expect(String(result.summary.final_message)).toContain("required review");
  });

  it("completes normally once the gate clears", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50 });
    let gateCalls = 0;
    const provider: LlmProvider = {
      async complete(): Promise<LlmResponse> {
        return { content: "all done", toolCalls: [] };
      }
    };

    const result = await runAgentTaskDetailed(session, "finish up", {
      provider,
      completionGate: async () => {
        gateCalls += 1;
        return gateCalls === 1 ? "review pending" : undefined;
      }
    });

    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toBe("all done");
  });
});

describe("subagent delegation", () => {
  it("runs spawn_subagent locally, persists the trajectory, and preserves assistant text with tool calls", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    const persisted: LlmMessage[] = [];
    let mainSystemPrompt = "";
    let subagentSystemPrompt = "";
    const subagentScript: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        subagentSystemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return { content: "", toolCalls: [{ id: "sub_1", name: "list_files", arguments: {} }] };
        }
        return {
          content: "",
          toolCalls: [{ id: "sub_2", name: "complete_session", arguments: { final_message: "subagent report: 0 files" } }]
        };
      }
    };
    const mainScript: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        mainSystemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return {
            content: "Delegating the file inventory.",
            toolCalls: [{ id: "call_1", name: "spawn_subagent", arguments: { task: "list workspace files", expected_output: "a count" } }]
          };
        }
        const parsed = JSON.parse(toolResult.content) as { result: { ok: boolean; data: Record<string, unknown> } };
        expect(parsed.result.ok).toBe(true);
        expect(parsed.result.data.outcome).toBe("completed");
        expect(parsed.result.data.final_message).toBe("subagent report: 0 files");
        return {
          content: "",
          toolCalls: [{ id: "call_2", name: "complete_session", arguments: { final_message: "done via subagent" } }]
        };
      }
    };

    const result = await runAgentTaskDetailed(session, "inventory files", {
      provider: mainScript,
      subagent: { model: "cheap-model", provider: subagentScript },
      onMessage: (message) => {
        persisted.push(message);
      }
    });

    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toBe("done via subagent");
    expect(mainSystemPrompt).toContain("spawn_subagent runs a cheaper, faster model (cheap-model");
    expect(subagentSystemPrompt).toContain("no paid services");
    const assistant = persisted.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Delegating the file inventory.");
    expect(assistant?.toolCalls?.[0]?.name).toBe("spawn_subagent");
    const trajectory = await readFile(join(session.sessionDir, "subagents", "1", "messages.jsonl"), "utf8");
    expect(trajectory).toContain("list workspace files");
    expect(trajectory).toContain("subagent report: 0 files");
  });

  it("rejects spawn_subagent when subagents are not enabled and paid tools inside subagents", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    const mainScript: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return { content: "", toolCalls: [{ id: "call_1", name: "spawn_subagent", arguments: { task: "anything" } }] };
        }
        const parsed = JSON.parse(toolResult.content) as { result: { ok: boolean; error?: string } };
        expect(parsed.result.ok).toBe(false);
        expect(parsed.result.error).toContain("not enabled");
        return { content: "stopping", toolCalls: [] };
      }
    };
    await runAgentTaskDetailed(session, "try to delegate", { provider: mainScript });

    const subagentScript: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return { content: "", toolCalls: [{ id: "sub_1", name: "search_services", arguments: { query: "anything" } }] };
        }
        const parsed = JSON.parse(toolResult.content) as { result: { ok: boolean; error?: string } };
        expect(parsed.result.ok).toBe(false);
        expect(parsed.result.error).toContain("local tools only");
        return { content: "", toolCalls: [{ id: "sub_2", name: "complete_session", arguments: { final_message: "blocked as expected" } }] };
      }
    };
    const mainWithSubagent: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return { content: "", toolCalls: [{ id: "call_1", name: "spawn_subagent", arguments: { task: "search for services" } }] };
        }
        const parsed = JSON.parse(toolResult.content) as { result: { ok: boolean; data: Record<string, unknown> } };
        expect(parsed.result.data.final_message).toBe("blocked as expected");
        return { content: "", toolCalls: [{ id: "call_2", name: "complete_session", arguments: { final_message: "done" } }] };
      }
    };
    const session2 = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    const result = await runAgentTaskDetailed(session2, "delegate a search", {
      provider: mainWithSubagent,
      subagent: { model: "cheap-model", provider: subagentScript }
    });
    expect(result.outcome).toBe("completed");
  });
});

describe("parallel and background subagents", () => {
  function slowSubagent(label: string, delayMs: number, events: string[]): LlmProvider {
    return {
      async complete(): Promise<LlmResponse> {
        events.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`end:${label}`);
        return { content: "", toolCalls: [{ id: "sub", name: "complete_session", arguments: { final_message: `${label} done` } }] };
      }
    };
  }

  it("runs spawns from one reply concurrently and namespaces their writes", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    const events: string[] = [];
    let subagentCalls = 0;
    const subagentProvider: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          subagentCalls += 1;
          const label = `sub${subagentCalls}`;
          events.push(`start:${label}`);
          await new Promise((resolve) => setTimeout(resolve, 80));
          events.push(`end:${label}`);
          return { content: "", toolCalls: [{ id: "s1", name: "save_file", arguments: { path: "notes.txt", content: label } }] };
        }
        return { content: "", toolCalls: [{ id: "s2", name: "complete_session", arguments: { final_message: "wrote notes" } }] };
      }
    };
    const mainProvider: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        const toolResult = messages.find((message) => message.role === "tool");
        if (!toolResult) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", name: "spawn_subagent", arguments: { task: "first" } },
              { id: "call_2", name: "spawn_subagent", arguments: { task: "second" } }
            ]
          };
        }
        const results = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as { result: { ok: boolean; data: { artifacts_written: string[] } } });
        for (const parsed of results) {
          expect(parsed.result.ok).toBe(true);
        }
        return { content: "", toolCalls: [{ id: "call_3", name: "complete_session", arguments: { final_message: "done" } }] };
      }
    };

    const result = await runAgentTaskDetailed(session, "parallel work", {
      provider: mainProvider,
      subagent: { model: "cheap-model", provider: subagentProvider }
    });

    expect(result.outcome).toBe("completed");
    // Both subagents started before either finished: concurrent, not serial.
    expect(events.slice(0, 2).every((event) => event.startsWith("start:"))).toBe(true);
    const written = await readFile(join(session.artifactsDir, "subagents", "1", "notes.txt"), "utf8").catch(() => undefined)
      ?? await readFile(join(session.artifactsDir, "subagents", "2", "notes.txt"), "utf8");
    expect(written).toMatch(/sub[12]/);
  });

  it("supports background spawns joined via check_subagents", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, approvalMode: "auto" });
    const events: string[] = [];
    const mainProvider: LlmProvider = {
      async complete(messages): Promise<LlmResponse> {
        const toolMessages = messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return { content: "", toolCalls: [{ id: "call_1", name: "spawn_subagent", arguments: { task: "long job", background: true } }] };
        }
        if (toolMessages.length === 1) {
          const parsed = JSON.parse(toolMessages[0].content) as { result: { data: { status: string } } };
          expect(parsed.result.data.status).toBe("running");
          return { content: "", toolCalls: [{ id: "call_2", name: "check_subagents", arguments: { wait: true } }] };
        }
        const parsed = JSON.parse(toolMessages[1].content) as { result: { data: { subagents: Array<{ final_message: string }> } } };
        expect(parsed.result.data.subagents[0].final_message).toBe("bg done");
        return { content: "", toolCalls: [{ id: "call_3", name: "complete_session", arguments: { final_message: "collected" } }] };
      }
    };
    const result = await runAgentTaskDetailed(session, "background work", {
      provider: mainProvider,
      subagent: { model: "cheap-model", provider: slowSubagent("bg", 60, events) }
    });
    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toBe("collected");
  });
});

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}
