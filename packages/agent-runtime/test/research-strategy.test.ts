import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import type { FinancialState } from "@opencrowd/protocol";
import {
  countShortfall, deliveredCount, earlyStopNudge, emptyServiceLog, isEmptyServiceData, recordServiceResult, taskTarget,
  runAgentTaskDetailed, type DynamicToolsOption, type LlmMessage, type LlmResponse
} from "../src/index.js";

/**
 * SRI-119. Two GTM-leads runs on 2026-11-17: one stopped at 32 of 100 leads
 * with $2.56 of $3 left; the next called a Reddit user-search endpoint eight
 * times, every answer `{"data":{}}`, never tried the content search it had
 * inspected, and stopped at 29 rows with $2.26 of $2.50 left.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function session() {
  const root = await mkdtemp(join(tmpdir(), "research-strategy-"));
  roots.push(root);
  return createSession({ workspaceRoot: root, budgetCents: 1000, approvalMode: "auto" });
}

const runId = randomUUID();
function financial(spent = "0.236199", limit = "2.500000"): FinancialState {
  const remaining = (Number(limit) - Number(spent)).toFixed(6);
  return {
    status: "available", run_id: runId, currency: "USDC", observed_at: new Date().toISOString(),
    wallet: { balance_status: "available", balance_usdc: "5.000000", reserved_usdc: "0.000000", available_usdc: "5.000000" },
    current_run: { inference_spent_usdc: spent, service_spent_usdc: "0.000000", total_spent_usdc: spent, reserved_usdc: "0.000000",
      budget_limit_usdc: limit, remaining_budget_usdc: remaining, per_call_approval_threshold_usdc: "0.100000", approval_mode: "auto" }
  };
}

const USER_SEARCH = "https://reddit.fetcher.sh/api/search/user";
const CONTENT_SEARCH = "https://stablesocial.dev/api/sc/reddit/search";
const EMPTY = { status: 200, message: "OK", data: {} };

/** The paid tools as the run saw them: inspect works, every user search is empty. */
function paidTools(answers: Record<string, unknown> = {}): DynamicToolsOption & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    definitions: [
      { name: "inspect_paid_service", description: "inspect", parameters: { type: "object" } },
      { name: "call_paid_service", description: "call", parameters: { type: "object" } }
    ],
    execute: async (name, args) => {
      const method = String(args.method ?? "POST").toUpperCase();
      if (name === "inspect_paid_service") return { ok: true, data: { endpoint: args.url, method, rail: "x402", price_ceiling_cents: 1 } };
      calls.push(String(args.url));
      return { ok: true, data: { purchase_id: randomUUID(), outcome: "paid_success", status: 200, charged_cost_cents: 1,
        data: answers[String(args.url)] ?? EMPTY } };
    }
  };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
const done = (text: string): LlmResponse => ({ content: "", toolCalls: [call(`done-${text.length}`, "complete_session", { final_message: text })] });

describe("what counts as an empty answer", () => {
  it.each([
    [EMPTY, true],
    [JSON.stringify(EMPTY), true],
    [{ results: [], total: 0 }, true],
    [{ data: { children: [] }, kind: "Listing" }, true],
    ["", true],
    [{ data: { users: [{ name: "alice" }] } }, false],
    [{ job_id: "abc", status: "pending" }, false],
    [{ artifact_path: "artifacts/a.mp3", bytes: 10 }, false],
    ["plain text answer", false],
  ])("%j is empty: %s", (data, expected) => {
    expect(isEmptyServiceData(data)).toBe(expected);
  });
});

describe("change strategy after empty results", () => {
  it("hints on the second empty answer in a row and names what was already inspected", () => {
    const log = emptyServiceLog();
    recordServiceResult(log, "inspect_paid_service", { url: USER_SEARCH, method: "GET" }, { ok: true, data: { endpoint: USER_SEARCH, method: "GET" } });
    recordServiceResult(log, "inspect_paid_service", { url: CONTENT_SEARCH, method: "POST" }, { ok: true, data: { endpoint: CONTENT_SEARCH, method: "POST" } });
    const args = { url: USER_SEARCH, method: "GET" };
    expect(recordServiceResult(log, "call_paid_service", args, { ok: true, data: { data: EMPTY } })).toBeUndefined();
    const hint = recordServiceResult(log, "call_paid_service", args, { ok: true, data: { data: EMPTY } });
    expect(hint).toBe(`2 empty results in a row from GET ${USER_SEARCH}: inspect its parameters, or try a different service or mode you already inspected (POST ${CONTENT_SEARCH}), before calling it again.`);
    // A real answer resets the streak.
    recordServiceResult(log, "call_paid_service", args, { ok: true, data: { data: { users: [{ name: "a" }] } } });
    expect(recordServiceResult(log, "call_paid_service", args, { ok: true, data: { data: EMPTY } })).toBeUndefined();
  });

  it("keys by endpoint, not by query string, and ignores failed calls", () => {
    const log = emptyServiceLog();
    expect(recordServiceResult(log, "call_paid_service", { url: `${USER_SEARCH}?q=a`, method: "GET" }, { ok: true, data: { data: {} } })).toBeUndefined();
    expect(recordServiceResult(log, "call_paid_service", { url: USER_SEARCH, method: "GET" }, { ok: false })).toBeUndefined();
    expect(recordServiceResult(log, "call_paid_service", { url: `${USER_SEARCH}?q=b`, method: "GET" }, { ok: true, data: { data: {} } }))
      .toMatch(/^2 empty results in a row from GET https:\/\/reddit\.fetcher\.sh\/api\/search\/user: .*find_paid_service/);
  });

  it("puts the hint on the run's own tool result, without blocking the call", async () => {
    const tools = paidTools();
    const requests: LlmMessage[][] = [];
    const responses: LlmResponse[] = [
      { content: "", toolCalls: [call("i1", "inspect_paid_service", { url: USER_SEARCH, method: "GET" }), call("i2", "inspect_paid_service", { url: CONTENT_SEARCH, method: "POST" })] },
      { content: "", toolCalls: [1, 2, 3].map(n => call(`c${n}`, "call_paid_service", { url: USER_SEARCH, method: "GET", body: { q: `user${n}` } })) },
      done("Nothing found.")
    ];
    const result = await runAgentTaskDetailed(await session(), "Look up some Reddit users.", {
      provider: { complete: async messages => { requests.push(structuredClone(messages)); return responses.shift() ?? done("Nothing found.") } },
      dynamicTools: tools, knowledge: false
    });
    expect(result.outcome).toBe("completed");
    expect(tools.calls).toHaveLength(3);
    const results = requests[2].filter(m => m.role === "tool" && m.toolCallId?.startsWith("c")).map(m => JSON.parse(m.content).result.data);
    expect(results[0].strategy_hint).toBeUndefined();
    expect(results[1].strategy_hint).toContain(`2 empty results in a row from GET ${USER_SEARCH}`);
    expect(results[1].strategy_hint).toContain(`POST ${CONTENT_SEARCH}`);
    expect(results[2].strategy_hint).toContain("3 empty results in a row");
  });
});

describe("a seller that is down", () => {
  it("counts one endpoint failing a parallel batch as one failure, so the run can try another service", async () => {
    const DOWN = "https://reddit.apitoll.cloud/v1/reddit/search";
    const tools: DynamicToolsOption = {
      definitions: [{ name: "call_paid_service", description: "call", parameters: { type: "object" } }],
      execute: async (_name, args) => args.url === DOWN
        ? { ok: false, error: `the call to ${DOWN} failed in transport and its payment state is unknown` }
        : { ok: true, data: { outcome: "paid_success", status: 200, data: { posts: [{ author: "alice" }] } } }
    };
    const responses: LlmResponse[] = [
      { content: "", toolCalls: ["a", "b", "c"].map(q => call(`d-${q}`, "call_paid_service", { url: DOWN, method: "GET", body: { q } })) },
      { content: "", toolCalls: [call("ok", "call_paid_service", { url: CONTENT_SEARCH, method: "POST", body: { q: "x402" } })] },
      done("Found u/alice.")
    ];
    const result = await runAgentTaskDetailed(await session(), "Find people on Reddit.", {
      provider: { complete: async () => responses.shift() ?? done("Found u/alice.") }, dynamicTools: tools, knowledge: false
    });
    expect(result).toMatchObject({ outcome: "completed", summary: { final_message: "Found u/alice." } });
  });
});

describe("honest early stops", () => {
  const task1 = "Find 100 useful individual GTM prospects for crowdcode.app.\n\nCustomer: indie AI-agent builders.";
  const answer1 = "Completed a new workspace with 32 unique prospect records (a verified subset, not padded to 100). Costs: 15 paid searches at $0.01.";
  const task2 = "Continue the benchmark. Additional run cap is $2.50.\n\nGoal remains 100 useful, deduplicated individual prospects: indie AI-agent builders.";
  const answer2 = "Stopped at the tested evidence boundary: 29 deduplicated candidate rows, 4 public accounts, 8 explicit crypto signal rows. Eight focused Reddit probes cost $0.016.";

  it("reads the target and the delivered count from the production runs", () => {
    expect(taskTarget(task1)).toEqual({ target: 100, noun: "prospects" });
    expect(taskTarget(task2)).toEqual({ target: 100, noun: "prospects" });
    expect(countShortfall(task1, answer1)).toEqual({ delivered: 32, target: 100, noun: "prospects" });
    expect(countShortfall(task2, answer2)).toEqual({ delivered: 29, target: 100, noun: "prospects" });
  });

  it.each([
    ["Summarize this in 3 sentences within 10 minutes.", undefined],
    ["Find trends for 2026 companies.", undefined],
    ["List 15 Reddit threads about x402.", { target: 15, noun: "threads" }],
    ["Find 20 companies hiring.", { target: 20, noun: "companies" }],
  ])("target of %j", (task, expected) => { expect(taskTarget(task)).toEqual(expected); });

  it.each([
    ["Found 7 of 20.", 7],
    ["Here are the 20 companies.", 20],
    ["I found 12 company profiles and 3 rows of notes.", 12],
    ["Everything is in leads.csv.", undefined],
    ["Spent 5 dollars on 2 searches.", undefined],
  ])("delivered count in %j", (answer, expected) => {
    expect(deliveredCount(answer, { target: 20, noun: "companies" })).toBe(expected);
  });

  it("asks once with the numbers, and only when most of the budget is left", () => {
    const log = emptyServiceLog();
    expect(earlyStopNudge({ task: task1, finalMessage: answer1, financial: financial("0.437639", "3.000000"), log }))
      .toBe("You delivered 32 of 100 prospects with $2.56 of $3.00 left and services you have not tried yet (find_paid_service). Either try the most promising one, or state exactly why stopping is justified. An honest partial result is allowed; when you call complete_session again, give the complete answer, saying what you delivered against the target.");
    // More than half spent: an early stop is not the problem.
    expect(earlyStopNudge({ task: task1, finalMessage: answer1, financial: financial("1.600000", "3.000000"), log })).toBeUndefined();
    // Target met.
    expect(earlyStopNudge({ task: task1, finalMessage: "All 100 prospects are in leads.csv.", financial: financial(), log })).toBeUndefined();
    // No count and no empty answers: nothing to ask.
    expect(earlyStopNudge({ task: "What is x402?", finalMessage: "A payment protocol.", financial: financial(), log })).toBeUndefined();
    expect(earlyStopNudge({ task: task1, finalMessage: answer1, financial: { status: "unavailable", reason: "x" }, log })).toBeUndefined();
  });

  it("names services inspected but never called after empty answers, with no count in the task", () => {
    const log = { inspected: [`GET ${USER_SEARCH}`, `POST ${CONTENT_SEARCH}`], called: [`GET ${USER_SEARCH}`], emptyStreaks: { [`GET ${USER_SEARCH}`]: 8 }, emptyResults: 8 };
    expect(earlyStopNudge({ task: "Find people on Reddit discussing paid AI agents.", finalMessage: "The provider returned nothing.", financial: financial(), log }))
      .toMatch(/^Your paid calls returned 8 empty results with \$2\.26 of \$2\.50 left and untested options POST https:\/\/stablesocial\.dev\/api\/sc\/reddit\/search\. Either try/);
  });

  it("asks once in a hosted run, then accepts an honest partial answer", async () => {
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce(done("I found 3 prospects."))
      .mockResolvedValueOnce(done("I found 3 of the 10 prospects; the only other source needs a login, so I stopped.")) };
    const result = await runAgentTaskDetailed(await session(), "Find 10 prospects on Reddit.", {
      provider, dynamicTools: paidTools(), hosted: true, runId, knowledge: false, financialState: async () => financial("0.010000", "1.000000")
    });
    expect(result).toMatchObject({ outcome: "completed", summary: { final_message: "I found 3 of the 10 prospects; the only other source needs a login, so I stopped." } });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const nudge = (provider.complete.mock.calls[1][0] as LlmMessage[]).filter(m => m.role === "user").at(-1)!;
    expect(nudge.content).toContain("You delivered 3 of 10 prospects with $0.99 of $1.00 left");
  });

  it("does not ask a run that spent most of its budget", async () => {
    const provider = { complete: vi.fn().mockResolvedValueOnce(done("I found 3 prospects.")) };
    const result = await runAgentTaskDetailed(await session(), "Find 10 prospects on Reddit.", {
      provider, dynamicTools: paidTools(), hosted: true, runId, knowledge: false, financialState: async () => financial("0.900000", "1.000000")
    });
    expect(result.summary.final_message).toBe("I found 3 prospects.");
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});
