import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSession, readLedger, updateConfig, type PaymentAdapter, type PaymentRequest } from "../../core/src/index.js";
import {
  createMockToolExecutor,
  MOCK_X402_SERVICES,
  MockLlmProvider,
  renderCompactPurchaseSummary,
  renderProgress,
  runAgentTask,
  X402LlmProvider,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse
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

describe("x402 LLM provider", () => {
  it("reserves budget, signs upto, calls chat completions, and writes llm_call ledger rows", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await updateConfig({
      x402LlmBaseUrl: "https://llm.example/v1",
      x402LlmModel: "claude-opus-4-6",
      x402LlmMaxCostCents: 10
    });
    const session = await createSession({ workspaceRoot: root, budgetCents: 25 });
    let signedRequest: PaymentRequest | undefined;
    const signer: PaymentAdapter = {
      async sign(request) {
        signedRequest = request;
        return { headers: { "x-payment": "signed" }, paymentId: "pay_1", txHash: "0xtx" };
      }
    };
    const provider = new X402LlmProvider(session, {
      paymentAdapter: signer,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === "https://llm.example/v1/models") {
          return jsonResponse({ data: [{ id: "claude-opus-4-6", max_cost_cents: 10 }] });
        }
        expect(url).toBe("https://llm.example/v1/chat/completions");
        expect((init?.headers as Record<string, string>)["x-payment"]).toBe("signed");
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-opus-4-6" });
        return jsonResponse({
          choices: [{ message: { content: "done" } }],
          usage: { prompt_tokens: 11, completion_tokens: 3 }
        }, {
          "x402-charged-cost-cents": "4",
          "x402-payment-id": "pay_header"
        });
      }
    });

    await expect(provider.complete([{ role: "user", content: "hi" }])).resolves.toEqual({ content: "done", toolCalls: [] });
    expect(signedRequest).toMatchObject({
      resourceUrl: "https://llm.example/v1/chat/completions",
      method: "POST",
      quotedCostCents: 10,
      paymentKind: "upto"
    });
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(4);
    const rows = await readLedger(session.ledgerPath);
    expect(rows).toContainEqual(expect.objectContaining({
      type: "llm_call",
      model: "claude-opus-4-6",
      status: "charged",
      charged_cost_cents: "4",
      payment_id: "pay_header",
      input_tokens: "11",
      output_tokens: "3"
    }));
  });

  it("fails clearly when default model is unavailable", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await updateConfig({
      x402LlmBaseUrl: "https://llm.example/v1",
      x402LlmModel: "claude-opus-4-6",
      x402LlmMaxCostCents: 1
    });
    const session = await createSession({ workspaceRoot: root, budgetCents: 10 });
    const provider = new X402LlmProvider(session, {
      fetchImpl: async () => jsonResponse({ data: [{ id: "available" }] })
    });
    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("Default model `claude-opus-4-6` is not available");
  });

  it("uses explicit model override instead of the stored preferred model", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await updateConfig({
      x402LlmBaseUrl: "https://llm.example/v1",
      x402LlmModel: "gpt-5.5",
      x402LlmMaxCostCents: 3
    });
    const session = await createSession({ workspaceRoot: root, budgetCents: 10 });
    let calledModel: string | undefined;
    const provider = new X402LlmProvider(session, {
      model: "available",
      paymentAdapter: {
        async sign() {
          return { headers: { "x-payment": "signed" } };
        }
      },
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return jsonResponse({ data: [{ id: "available", max_cost_cents: 3 }] });
        }
        calledModel = JSON.parse(String(init?.body)).model;
        return jsonResponse({ choices: [{ message: { content: "done" } }] }, { "x402-charged-cost-cents": "2" });
      }
    });

    await expect(provider.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({ content: "done" });
    expect(calledModel).toBe("available");
  });

  it("omits assistant content when serializing tool-call history", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await updateConfig({
      x402LlmBaseUrl: "https://llm.example/v1",
      x402LlmModel: "gpt-5.5",
      x402LlmMaxCostCents: 3
    });
    const session = await createSession({ workspaceRoot: root, budgetCents: 10 });
    let assistantMessage: Record<string, unknown> | undefined;
    const provider = new X402LlmProvider(session, {
      paymentAdapter: {
        async sign() {
          return { headers: { "x-payment": "signed" } };
        }
      },
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return jsonResponse({ data: [{ id: "gpt-5.5", max_cost_cents: 3 }] });
        }
        const body = JSON.parse(String(init?.body)) as { messages: Record<string, unknown>[] };
        assistantMessage = body.messages.find((message) => message.role === "assistant");
        return jsonResponse({ choices: [{ message: { content: "done" } }] }, { "x402-charged-cost-cents": "1" });
      }
    });

    await provider.complete([
      { role: "user", content: "show services" },
      {
        role: "assistant",
        content: "I'll check available services.",
        toolCalls: [{ id: "call_1", name: "search_services", arguments: { query: "all services", limit: 20 } }]
      },
      { role: "tool", toolCallId: "call_1", content: "{}" }
    ]);

    expect(assistantMessage).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "search_services",
          arguments: JSON.stringify({ query: "all services", limit: 20 })
        }
      }]
    });
    expect(assistantMessage).not.toHaveProperty("content");
  });

  it("rejects over-budget LLM calls before OWS signing", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await updateConfig({
      x402LlmBaseUrl: "https://llm.example/v1",
      x402LlmModel: "gpt-5.5",
      x402LlmMaxCostCents: 10
    });
    const session = await createSession({ workspaceRoot: root, budgetCents: 5 });
    let signed = false;
    const provider = new X402LlmProvider(session, {
      paymentAdapter: {
        async sign() {
          signed = true;
          return { headers: {} };
        }
      },
      fetchImpl: async () => jsonResponse({ data: [{ id: "gpt-5.5", max_cost_cents: 10 }] })
    });

    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("budget exceeded");
    expect(signed).toBe(false);
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(0);
  });

  it("releases reserved budget and writes failed ledger rows when the LLM call fails", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await updateConfig({
      x402LlmBaseUrl: "https://llm.example/v1",
      x402LlmModel: "gpt-5.5",
      x402LlmMaxCostCents: 10
    });
    const session = await createSession({ workspaceRoot: root, budgetCents: 25 });
    const provider = new X402LlmProvider(session, {
      paymentAdapter: {
        async sign() {
          return { headers: { "x-payment": "signed" } };
        }
      },
      fetchImpl: async (input) => {
        if (String(input).endsWith("/models")) {
          return jsonResponse({ data: [{ id: "gpt-5.5", max_cost_cents: 10 }] });
        }
        throw new Error("network down");
      }
    });

    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("network down");
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(0);
    const rows = await readLedger(session.ledgerPath);
    expect(rows).toContainEqual(expect.objectContaining({
      type: "llm_call",
      model: "gpt-5.5",
      status: "failed",
      charged_cost_cents: "0"
    }));
  });
});

describe("agent loop transcript", () => {
  it("includes budget snapshots on every tool result message", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, permissionMode: "yolo" });
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

describe("mock test mode", () => {
  it("counts mock tool turns from the latest user prompt instead of all history", async () => {
    const provider = new MockLlmProvider({
      seed: "history-seed",
      tools: ["get_budget_status"],
      endProbability: 1
    });
    const response = await provider.complete([
      { role: "user", content: "old task" },
      { role: "assistant", content: "", toolCalls: [{ id: "old_call", name: "get_budget_status", arguments: {} }] },
      { role: "tool", toolCallId: "old_call", content: "{}" },
      { role: "user", content: "new task" }
    ]);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ name: "get_budget_status" });
  });

  it("runs the full agent loop with mock service search and zero spend", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, permissionMode: "yolo" });
    const persisted: LlmMessage[] = [];
    const toolExecutor = createMockToolExecutor();

    const rawSearch = await toolExecutor("search_services", { query: "mock", limit: 10 }, { session });
    expect(rawSearch.data).toHaveLength(10);

    const output = await runAgentTask(session, "find a mock service", {
      provider: new MockLlmProvider({
        seed: "search-seed",
        tools: ["search_services"],
        endProbability: 1
      }),
      toolExecutor,
      onMessage: (message) => {
        persisted.push(message);
      }
    });

    expect(output).toContain("Total spent: $0.02");
    expect(output).toContain("External service spend: $0.00");
    const toolMessage = persisted.find((message) => message.role === "tool");
    const payload = JSON.parse(toolMessage?.content ?? "{}") as Record<string, unknown>;
    const result = payload.result as { data?: unknown[] } | undefined;
    expect(result?.data).toHaveLength(8);
    expect(result?.data?.[0]).toMatchObject({
      resource_url: MOCK_X402_SERVICES[0].resource_url,
      title: MOCK_X402_SERVICES[0].title
    });
    const rows = await readLedger(session.ledgerPath);
    expect(rows.filter((row) => row.type === "llm_call")).toHaveLength(2);
    expect(rows.filter((row) => row.type === "service_call")).toHaveLength(0);
  });

  it("mocks call_service output and records a charged service ledger row", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, permissionMode: "yolo" });

    const output = await runAgentTask(session, "call a mock service", {
      provider: new MockLlmProvider({
        seed: "call-service-seed",
        tools: ["call_service"],
        endProbability: 1
      }),
      toolExecutor: createMockToolExecutor()
    });

    expect(output).toContain("Total spent:");
    expect(output).toContain("Purchased services:");
    const rows = await readLedger(session.ledgerPath);
    expect(rows).toContainEqual(expect.objectContaining({
      type: "service_call",
      status: "charged",
      notes: "mock test mode service call"
    }));
    const serviceRow = rows.find((row) => row.type === "service_call");
    expect(Number(serviceRow?.charged_cost_cents ?? 0)).toBeGreaterThan(0);
    expect(session.spentCents).toBeGreaterThan(0);
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

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}
