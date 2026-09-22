import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createSession } from "@opencrowd/core";
import { atomicUsdc, type FinancialState } from "@opencrowd/protocol";
import { runAgentTaskDetailed, type LoopCheckpoint } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function session() {
  const dir = await mkdtemp(join(tmpdir(), "financial-state-")); roots.push(dir);
  return createSession({ workspaceRoot: dir, budgetCents: 1000, approvalMode: "auto" });
}
const runId = randomUUID();
function state(inference = 0n, services = 0n): FinancialState {
  const spent = inference + services;
  return { status: "available", run_id: runId, currency: "USDC", observed_at: new Date().toISOString(),
    wallet: { balance_status: "available", balance_usdc: atomicUsdc(2_000_000n - spent), reserved_usdc: "0.000000", available_usdc: atomicUsdc(2_000_000n - spent) },
    current_run: { inference_spent_usdc: atomicUsdc(inference), service_spent_usdc: atomicUsdc(services), total_spent_usdc: atomicUsdc(spent),
      reserved_usdc: "0.000000", budget_limit_usdc: "1.000000", remaining_budget_usdc: atomicUsdc(1_000_000n - spent),
      per_call_approval_threshold_usdc: "0.100000", approval_mode: "auto" } };
}

it("refreshes model and service spending, replaces local budgets and keeps one authoritative snapshot", async () => {
  let inference = 0n, services = 0n, calls = 0;
  const result = await runAgentTaskDetailed(await session(), "Build a paid utility for me", {
    hosted: true, runId, financialState: async () => state(inference, services), knowledge: false,
    dynamicTools: { definitions: [{ name: "call_paid_service", description: "test", parameters: {} }],
      execute: async () => { services += 50_000n; return { ok: true }; } },
    provider: { complete: async messages => {
      const snapshots = messages.filter(m => m.content.startsWith("Current hosted financial snapshot: "));
      expect(snapshots).toHaveLength(1);
      const snapshot = JSON.parse(snapshots[0].content.split(": ").slice(1).join(": "));
      expect(snapshot.current_run.inference_spent_usdc).toBe(atomicUsdc(inference));
      expect(snapshot.current_run.service_spent_usdc).toBe(atomicUsdc(services));
      expect(messages[0].content).toContain("You operate this service for its owner.");
      expect(messages[0].content).toContain("Inference and paid tools debit its USDC wallet.");
      if (calls === 1) {
        const tool = JSON.parse(messages.at(-1)!.content);
        expect(tool.budget_before_tool_call.current_run.inference_spent_usdc).toBe("0.000123");
        expect(tool.budget_after_tool_call.current_run.service_spent_usdc).toBe("0.050000");
      }
      if (calls === 2) expect(JSON.parse(messages.at(-1)!.content).result.data.current_run.inference_spent_usdc).toBe("0.000246");
      inference += 123n;
      const name = ["call_paid_service", "get_budget_status", "complete_session"][calls++];
      return { content: "", toolCalls: [{ id: `call-${calls}`, name, arguments: name === "complete_session" ? { final_message: "Done" } : {} }] };
    } },
  });
  expect(result.summary.budget).toMatchObject({ current_run: { inference_spent_usdc: "0.000369", service_spent_usdc: "0.050000", remaining_budget_usdc: "0.949631" } });
});

it("marks financial reads unavailable without retrying a paid response or returning local zero spending", async () => {
  let calls = 0;
  const result = await runAgentTaskDetailed(await session(), "hello", { hosted: true,
    financialState: async () => { throw new Error("control offline"); },
    provider: { complete: async messages => {
      calls++;
      expect(messages[1].content).toContain('"status":"unavailable"');
      return { content: "", toolCalls: [{ id: "done", name: "complete_session", arguments: { final_message: "Done" } }] };
    } },
  });
  expect(calls).toBe(1);
  expect(result.summary.budget).toMatchObject({ status: "unavailable" });
  expect(result.summary.budget).not.toHaveProperty("spent_cents");
});

it("does not change a frozen paid request on resume, even if financial state changed", async () => {
  const s = await session(); let saved: LoopCheckpoint | undefined; let original = "";
  await expect(runAgentTaskDetailed(s, "hello", { hosted: true, runId, financialState: async () => state(),
    onCheckpoint: async checkpoint => { saved = structuredClone(checkpoint); },
    provider: { complete: async messages => { original = JSON.stringify(messages); throw new Error("interrupted"); } },
  })).rejects.toThrow("interrupted");
  expect(saved?.context?.prepared).toBe(true);
  const result = await runAgentTaskDetailed(s, "hello", { hosted: true, runId, resume: saved,
    financialState: async () => state(123n), provider: { complete: async messages => {
      expect(JSON.stringify(messages)).toBe(original);
      return { content: "", toolCalls: [{ id: "done", name: "complete_session", arguments: { final_message: "Done" } }] };
    } },
  });
  expect(result.summary.budget).toMatchObject({ current_run: { inference_spent_usdc: "0.000123" } });
});

it("stops after three consecutive paid-service failures but a success resets the streak", async () => {
  const run = async (script: boolean[]) => {
    let calls = 0;
    return runAgentTaskDetailed(await session(), "buy things", {
      hosted: true, runId, financialState: async () => state(), knowledge: false,
      dynamicTools: { definitions: [{ name: "call_paid_service", description: "test", parameters: {} }],
        execute: async (_name, args) => script[(args as { n: number }).n] ? { ok: true, data: { outcome: "paid_success" } } : { ok: false, error: `provider ${(args as { n: number }).n} failed` } },
      provider: { complete: async () => {
        const n = calls++;
        return n < script.length
          ? { content: "", toolCalls: [{ id: `call-${n}`, name: "call_paid_service", arguments: { n } }] }
          : { content: "", toolCalls: [{ id: "done", name: "complete_session", arguments: { final_message: "Done" } }] };
      } },
    });
  };
  const recovered = await run([false, false, true, false, false]);
  expect(recovered.outcome).toBe("completed");
  const stopped = await run([false, false, false]);
  expect(stopped.outcome).toBe("stopped");
  expect(stopped.summary.final_message).toContain("Stopped after 3 service call failures");
});
