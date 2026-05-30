import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { appendLedgerEntry, createSession, readLedger, updateConfig, type PaymentAdapter, type PaymentRequest } from "../../core/src/index.js";
import { renderLedgerSummary, renderProgress, runAgentTask, X402LlmProvider, type LlmMessage, type LlmProvider, type LlmResponse } from "../src/index.js";

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
      x402LlmModel: "gpt-5.5",
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
          return jsonResponse({ data: [{ id: "gpt-5.5", max_cost_cents: 10 }] });
        }
        expect(url).toBe("https://llm.example/v1/chat/completions");
        expect((init?.headers as Record<string, string>)["x-payment"]).toBe("signed");
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-5.5" });
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
      model: "gpt-5.5",
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
      x402LlmModel: "gpt-5.5",
      x402LlmMaxCostCents: 1
    });
    const session = await createSession({ workspaceRoot: root, budgetCents: 10 });
    const provider = new X402LlmProvider(session, {
      fetchImpl: async () => jsonResponse({ data: [{ id: "available" }] })
    });
    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("Default model `gpt-5.5` is not available");
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

describe("CLI rendering helpers", () => {
  it("renders tool results with a pithy summary and budget state", () => {
    const text = renderProgress({
      type: "tool_result",
      message: "Tool result: found 2 services; top Example Data (0.01 USDC)",
      data: {
        budget_before: { budget_cents: 100, spent_cents: 0, remaining_cents: 100 },
        budget_after: { budget_cents: 100, spent_cents: 7, remaining_cents: 93 }
      }
    });

    expect(text).toContain("Done found 2 services");
    expect(text).toContain("budget $1.00 | remaining $0.93 | spent $0.07 | delta $0.07");
    expect(text.split("\n")[0].length).toBeLessThanOrEqual(118);
  });

  it("renders a compact ledger summary table", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 100, permissionMode: "yolo" });
    await appendLedgerEntry(session.ledgerPath, {
      session_id: session.sessionId,
      type: "llm_call",
      model: "openai-gpt-55",
      charged_cost_cents: 4,
      status: "charged",
      permission_mode: "yolo"
    });
    session.spentCents = 4;

    const summary = await renderLedgerSummary(session);

    expect(summary).toContain("Budget $1.00 | remaining $0.96 | spent $0.04");
    expect(summary).toContain("Recent ledger:");
    expect(summary).toContain("llm_call/charged");
    expect(summary).toContain("openai-gpt-55");
  });
});

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}
