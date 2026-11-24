import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvePendingSpending, createSession, loadSession } from "@opencrowd/core";
import { BlockRunProvider, createOpenCrowdRuntime, type TypedLlmProvider } from "../src/index.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("pauses before BlockRun signs or submits an over-limit quote", async () => {
  const fetcher = vi.fn(async () => new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({
    x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1500000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]
  })).toString("base64") } }));
  const provider = new BlockRunProvider({ fetchImpl: fetcher as typeof fetch });
  const authorize = vi.fn(async () => { throw new Error("pending human approval"); });
  await expect(provider.complete({ model: "test", messages: [{ role: "user", content: "hi" }], tools: [], authorizePayment: authorize })).rejects.toThrow("pending human approval");
  expect(authorize.mock.calls[0][0]).toBe(150);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("resumes a saved query after approval without repeating a completed model or tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "resume-spending-")); roots.push(root);
  const session = await createSession({ workspaceRoot: root, budgetCents: 1000, perCallCents: 100 });
  let paid = 0, toolCalls = 0;
  const provider: TypedLlmProvider = { id: "blockrun", quotesPayments: true, listModels: async () => [], complete: async request => {
    const afterTool = request.messages.some(m => m.role === "tool");
    await request.authorizePayment!(afterTool ? 150 : 50, afterTool ? "second" : "first");
    paid++;
    return { content: afterTool ? "Done: the test tool ran once." : "", toolCalls: afterTool ? [] : [{ id: "tool-1", name: "test_tool", arguments: {} }], usage: { costCents: afterTool ? 150 : 50 } };
  } };
  const runtime = createOpenCrowdRuntime({ workspace: root,
    llmProvider: async () => ({ kind: "typed", main: { provider, model: "test", maxCostCentsPerCall: 100 } }),
    economy: async () => ({ definitions: () => [{ name: "test_tool", description: "test", parameters: {} }], execute: async () => { toolCalls++; return { ok: true }; } }) });
  const result = await runtime.runTask(session, "Do the task");
  expect(result.outcome).toBe("waiting_for_approval"); expect(paid).toBe(1); expect(toolCalls).toBe(1);
  const restored = await loadSession(root, session.sessionId);
  expect(restored.query?.pending?.amountCents).toBe(150);
  await approvePendingSpending(restored, { decision: "approve", queryBudgetCents: 2000 });
  const finished = await runtime.runTask(restored, "");
  expect(finished.outcome).toBe("completed"); expect(paid).toBe(2); expect(toolCalls).toBe(1);
  expect(restored.spentCents).toBe(200); expect(restored.budgetCents).toBe(1000); expect(restored.query?.limitCents).toBe(2000);
  await expect(runtime.runTask(restored, "A new query")).resolves.toMatchObject({ outcome: "waiting_for_approval" });
  expect(restored.query?.limitCents).toBe(1000);
});


it("checkpoints parallel subagents and shares the parent query budget across an approval restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "sub-spending-")); roots.push(root);
  const session = await createSession({ workspaceRoot: root });
  let mainCalls = 0, subPayments = 0;
  const main: TypedLlmProvider = { id: "blockrun", quotesPayments: true, listModels: async () => [], complete: async request => {
    await request.authorizePayment!(1, "main"); mainCalls++;
    return request.messages.some(m => m.role === "tool") ? { content: "Done: out.txt is saved.", toolCalls: [], usage: { costCents: 1 } }
      : { content: "", toolCalls: ["a", "b"].map(id => ({ id, name: "spawn_subagent", arguments: { task: id, background: true } })), usage: { costCents: 1 } };
  } };
  const sub: TypedLlmProvider = { id: "blockrun", quotesPayments: true, listModels: async () => [], complete: async request => {
    const name = request.messages.find(m => m.role === "user")!.content;
    const second = request.messages.some(m => m.role === "tool");
    await request.authorizePayment!(second && name.includes("Task: a") ? 150 : 1, `${name}:${second}`);
    subPayments++;
    return second ? { content: "Finished", toolCalls: [], usage: { costCents: name.includes("Task: a") ? 150 : 1 } }
      : { content: "", toolCalls: [{ id: "write", name: "save_file", arguments: { path: "out.txt", content: "done" } }], usage: { costCents: 1 } };
  } };
  const runtime = createOpenCrowdRuntime({ workspace: root, llmProvider: async () => ({ kind: "typed",
    main: { provider: main, model: "test", maxCostCentsPerCall: 100 },
    subagent: { model: "sub", llm: { provider: sub, model: "sub", maxCostCentsPerCall: 100 } } }) });
  const result = await runtime.runTask(session, "Delegate");
  expect(result.outcome).toBe("waiting_for_approval");
  const restored = await loadSession(root, session.sessionId);
  const paidBefore = subPayments;
  await approvePendingSpending(restored, { decision: "approve" });
  expect((await runtime.runTask(restored, "")).outcome).toBe("completed");
  expect(mainCalls).toBe(2); expect(subPayments).toBe(4); expect(subPayments - paidBefore).toBeLessThanOrEqual(2);
  expect(restored.spentCents).toBe(155);
});

// Properties (SRI-175). The examples above are the regression seeds.
describe("properties: BlockRun quotes", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const quote = (offer: Record<string, unknown>, x402Version = 2) => async () => new Response("", { status: 402, headers: { "payment-required":
    Buffer.from(JSON.stringify({ x402Version, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...offer }] })).toString("base64") } });
  const ask = async (offer: Record<string, unknown>, x402Version?: number) => {
    const fetcher = vi.fn(quote(offer, x402Version));
    const authorize = vi.fn(async (_cents: number, _identity: string) => { throw new Error("pending human approval"); });
    const outcome = await new BlockRunProvider({ fetchImpl: fetcher as typeof fetch })
      .complete({ model: "test", messages: [{ role: "user", content: "hi" }], tools: [], authorizePayment: authorize }).catch((error: Error) => error.message);
    return { outcome, authorize, fetcher };
  };
  const caseOf = (text: string, upper: boolean[]) => [...text].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join("");

  it("asks the owner for exactly the quoted amount, and signs and submits nothing until they answer", async () => {
    // T5 found: the approval carries cents as a float (amount / 10000), so above about 2.25e15 atomic
    // units ($2.25 billion) the owner is asked for one atomic unit more or less than is signed
    // (counterexample 7671387206000351n, seed -1693856282). Kept to 10^15 atomic ($1 billion).
    const amount = fc.oneof(fc.constantFrom(1n, 9_999n, 10_000n, 1_500_000n, 10n ** 15n), fc.bigInt({ min: 1n, max: 10_000_000n }),
      fc.bigInt({ min: 1n, max: 10n ** 15n }));
    await fc.assert(fc.asyncProperty(amount, fc.array(fc.boolean(), { minLength: 42, maxLength: 42 }), async (atomic, upper) => {
      const { outcome, authorize, fetcher } = await ask({ amount: String(atomic), asset: `0x${caseOf(USDC.slice(2), upper.slice(2))}` });
      expect(outcome).toBe("pending human approval");
      expect(authorize).toHaveBeenCalledTimes(1);
      const cents = authorize.mock.calls[0][0];
      expect(BigInt(Math.round(cents * 10_000))).toBe(atomic);
      expect(JSON.parse(authorize.mock.calls[0][1]).offer.amount).toBe(String(atomic));
      expect(fetcher).toHaveBeenCalledTimes(1); // the unpaid request only
    }));
  });

  it("refuses, before asking anyone, a quote that is not a positive canonical amount of Base USDC under x402 v2", async () => {
    const bad = fc.oneof(
      fc.constantFrom("0", "00", "01", "-1", "1.5", "1e6", " 1", "1 ", "+1", "0x10", "", "١٢").map(amount => ({ offer: { amount }, version: 2 })),
      fc.string().filter(amount => !/^[1-9][0-9]*$/.test(amount)).map(amount => ({ offer: { amount }, version: 2 })),
      fc.constantFrom({ network: "eip155:1" }, { network: "eip155:84532" }, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, { scheme: "upto" },
        { asset: "0x0000000000000000000000000000000000000000" }, { asset: USDC.slice(0, -1) }).map(change => ({ offer: { amount: "1000", ...change }, version: 2 })),
      fc.constantFrom(1, 3).map(version => ({ offer: { amount: "1000" }, version }))
    );
    await fc.assert(fc.asyncProperty(bad, async ({ offer, version }) => {
      const { outcome, authorize, fetcher } = await ask(offer, version);
      expect(outcome).toBe("Unsupported BlockRun payment quote");
      expect(authorize).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }));
  });
});
