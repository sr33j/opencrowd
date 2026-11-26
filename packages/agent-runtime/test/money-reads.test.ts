import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createSession } from "@opencrowd/core";
import { atomicUsdc, type FinancialState } from "@opencrowd/protocol";
import { runAgentTaskDetailed, type LlmMessage } from "../src/index.js";
import { tierOf, usd } from "../src/money-line.js";
import { MONEY_READ_MAX_AGE_MS, moneyReader, type MoneyReads } from "../src/money-reads.js";

/**
 * w124: `on_change` reads the hosted money less often. These are the
 * properties that make that safe to show a model:
 *
 * 1. With nothing moving money outside the run, the model is shown exactly
 *    what `every_step` shows it, byte for byte, with no more reads.
 * 2. With money moving outside the run (a top-up, a sibling spending from a
 *    shared wallet), every line still counts every payment this run made,
 *    and the wallet figure it shows is one the wallet had at most
 *    MONEY_READ_MAX_AGE_MS before the line was written.
 *
 * Overspending and paying twice are the gateway's to refuse, whatever the
 * runtime read (app/test/sim/scenarios/w124-stale-money-view.sim.test.ts).
 */

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
async function session() {
  const dir = await mkdtemp(join(tmpdir(), "money-reads-")); roots.push(dir);
  return createSession({ workspaceRoot: dir, budgetCents: 1000, approvalMode: "auto" });
}

const MODEL_ATOMIC = 20_000n, PAID_ATOMIC = 50_000n;
type Tool = { name: "browse_services" | "read_service" | "call_paid_service" | "mystery_tool" | "list_files"; external?: number; ms?: number };
type Turn = { tools: Tool[] };

/** One run of `turns` under `mode`, against a fake control whose figures move as this run and the outside world spend. */
async function run(mode: MoneyReads, turns: Turn[]) {
  const runId = randomUUID();
  let inference = 0n, services = 0n, wallet = 5_000_000n, reads = 0;
  // Every figure the wallet has had, and when: what a line may show.
  const walletHistory: { at: number; atomic: bigint }[] = [{ at: Date.now(), atomic: wallet }];
  const toolEnded = new Map<string, { at: number; spent: bigint }>();
  const state = (): FinancialState => {
    const free = wallet - inference - services;
    const callsLeft = Math.min(999, Number(free / MODEL_ATOMIC));
    const { tier, action } = tierOf(callsLeft);
    return { status: "available", run_id: runId, currency: "USDC", observed_at: new Date().toISOString(),
      wallet: { balance_status: "available", balance_usdc: atomicUsdc(free), reserved_usdc: "0.000000", available_usdc: atomicUsdc(free) },
      current_run: { inference_spent_usdc: atomicUsdc(inference), service_spent_usdc: atomicUsdc(services), total_spent_usdc: atomicUsdc(inference + services),
        reserved_usdc: "0.000000", budget_limit_usdc: "10.000000", remaining_budget_usdc: atomicUsdc(10_000_000n - inference - services),
        per_call_approval_threshold_usdc: "0.000000", approval_mode: "auto" },
      runway: { model: "m", next_call_usdc: atomicUsdc(MODEL_ATOMIC), per_call_usdc: atomicUsdc(MODEL_ATOMIC), calls_left: callsLeft,
        low: tier === "LOW" || tier === "CRITICAL", tier, ...(action ? { action } : {}) } };
  };
  const free = () => wallet - inference - services;
  const moved = () => walletHistory.push({ at: Date.now(), atomic: free() });
  const seen: LlmMessage[][] = [];
  let turn = 0;
  const result = await runAgentTaskDetailed(await session(), "Research three sellers and buy the best report", {
    hosted: true, runId, knowledge: false, moneyReads: mode,
    financialState: async () => { reads += 1; return state(); },
    dynamicTools: {
      definitions: ["browse_services", "read_service", "call_paid_service", "mystery_tool"].map(name => ({ name, description: name, parameters: {} })),
      execute: async (name, args) => {
        const tool = args as Tool & { id: string };
        // Outside money moves as the tool starts; the tool then takes its time.
        if (tool.external) { wallet += BigInt(tool.external); moved(); }
        if (tool.ms) vi.setSystemTime(Date.now() + tool.ms);
        if (name === "call_paid_service") { services += PAID_ATOMIC; moved(); }
        toolEnded.set(tool.id, { at: Date.now(), spent: inference + services });
        return { ok: true, data: { name } };
      },
    },
    provider: { complete: async (messages) => {
      seen.push(structuredClone(messages));
      inference += MODEL_ATOMIC; moved();
      const script = turns[turn];
      const id = (i: number) => `t${turn}-${i}`;
      turn += 1;
      if (!script) return { content: "", toolCalls: [{ id: `done-${turn}`, name: "complete_session", arguments: { final_message: "Bought the best report: seller B." } }] };
      return { content: "", toolCalls: script.tools.map((tool, i) => ({ id: id(i), name: tool.name, arguments: { ...tool, id: id(i) } })) };
    } },
  });
  return { reads, seen, result, walletHistory, toolEnded };
}

const tool = (external: boolean) => fc.record({
  name: fc.constantFrom<Tool["name"]>("browse_services", "read_service", "call_paid_service", "mystery_tool", "list_files"),
  ...(external ? { external: fc.option(fc.constantFrom(-30_000, 10_000, 250_000), { nil: undefined }) } : {}),
  // Time passes only where outside money moves: the read counts below assume a still clock.
  ...(external ? { ms: fc.option(fc.integer({ min: 0, max: 45_000 }), { nil: undefined }) } : {}),
}, { requiredKeys: ["name"] }) as fc.Arbitrary<Tool>;
const turns = (external: boolean) => fc.array(fc.record({ tools: fc.array(tool(external), { minLength: 0, maxLength: 4 }) }), { minLength: 0, maxLength: 6 })
  // A turn without tools is a final answer; the script's tool turns come first.
  .map(list => list.filter(t => t.tools.length));

it("shows the model exactly what every_step shows it, with fewer reads, when nothing outside the run moves money", async () => {
  await fc.assert(fc.asyncProperty(turns(false), async (script) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
    const every = await run("every_step", script);
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
    const change = await run("on_change", script);
    vi.useRealTimers();
    // observed_at and the run id differ; nothing the model is shown does.
    const shown = (s: LlmMessage[][]) => JSON.stringify(s).replace(/"observed_at":"[^"]*"/g, "");
    expect(shown(change.seen)).toBe(shown(every.seen));
    expect(change.result.summary.budget).toMatchObject({ current_run: (every.result.summary.budget as any).current_run });
    expect(change.reads).toBeLessThanOrEqual(every.reads);
    // A turn of free tools reads once, where every_step reads 2 + k times.
    const tools = script.reduce((n, t) => n + t.tools.length, 0);
    const notFree = script.reduce((n, t) => n + t.tools.filter(x => x.name === "call_paid_service" || x.name === "mystery_tool").length, 0);
    // Both modes: complete_session reads, and so does the held-money check at completion.
    expect(change.reads).toBe(1 + script.length + notFree - script.filter(t => t.tools[0].name === "call_paid_service" || t.tools[0].name === "mystery_tool").length + 2);
    expect(every.reads).toBe(2 * (script.length + 1) + tools + 2);
  }), { numRuns: 40 });
});

it("counts every payment of the run on every line, and shows outside money at most 30 s old", async () => {
  await fc.assert(fc.asyncProperty(turns(true), async (script) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
    const { seen, walletHistory, toolEnded } = await run("on_change", script);
    vi.useRealTimers();
    const last = seen.at(-1)!;
    for (const message of last.filter(m => m.role === "tool")) {
      const { money } = JSON.parse(message.content) as { money: string };
      const ended = toolEnded.get(message.toolCallId!);
      if (!ended) continue; // complete_session and built-ins
      // Own spending: exact.
      expect(money).toContain(`this run spent ${usd(Number(atomicUsdc(ended.spent)))}`);
      // Outside money: a figure the wallet had within the allowed staleness.
      const figure = /wallet (\$[0-9.]+) free/.exec(money)![1];
      const had = walletHistory.filter((h, i) => {
        const until = walletHistory[i + 1]?.at ?? Number.POSITIVE_INFINITY;
        return until >= ended.at - MONEY_READ_MAX_AGE_MS && h.at <= ended.at;
      }).map(h => usd(Number(atomicUsdc(h.atomic))));
      expect(had, money).toContain(figure);
    }
  }), { numRuns: 40 });
});

it("reads again after a failed read, and while a background subagent spends", () => {
  let now = 0;
  const reader = moneyReader("on_change", () => now);
  expect(reader.beforeModel(false)).toBe(true);
  reader.read(false);
  expect(reader.afterTool("read_file", false)).toBe(true); // the failed read left it due
  reader.read(true);
  expect(reader.afterTool("read_file", false)).toBe(false);
  expect(reader.afterTool("read_file", true)).toBe(true); // something else is spending
  expect(reader.afterTool("call_paid_service", false)).toBe(true);
  expect(reader.afterTool("get_budget_status", false)).toBe(true);
  expect(reader.afterTool("complete_session", false)).toBe(true);
  now += MONEY_READ_MAX_AGE_MS + 1;
  expect(reader.beforeModel(false)).toBe(true);
  reader.read(true);
  expect(reader.afterModel()).toBe(false);
  expect(reader.afterTool("read_file", false)).toBe(true); // the model call's payment
  // every_step reads at every point, as before.
  const every = moneyReader("every_step", () => now);
  every.read(true);
  expect([every.beforeModel(false), every.afterModel(), every.afterTool("read_file", false)]).toEqual([true, true, true]);
});
