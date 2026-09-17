import { afterEach, expect, it, vi } from "vitest";
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
    return { content: afterTool ? "Done" : "", toolCalls: afterTool ? [] : [{ id: "tool-1", name: "test_tool", arguments: {} }], usage: { costCents: afterTool ? 150 : 50 } };
  } };
  const runtime = createOpenCrowdRuntime({ workspace: root,
    llmProvider: async () => ({ kind: "typed", main: { provider, model: "test", maxCostCentsPerCall: 100 } }),
    economy: async () => ({ definitions: () => [{ name: "test_tool", description: "test", parameters: {} }], execute: async () => { toolCalls++; return { ok: true }; }, hasPendingRequiredReviews: async () => false }) });
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
    return request.messages.some(m => m.role === "tool") ? { content: "Done", toolCalls: [], usage: { costCents: 1 } }
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
