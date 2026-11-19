import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createSession } from "@opencrowd/core";
import { atomicUsdc, costTriggerTokens, CONTEXT_MIN_HISTORY_TOKENS, type FinancialState } from "@opencrowd/protocol";
import { BlockRunProvider } from "../src/blockrun.js";
import { X402ProxyProvider } from "../src/x402-proxy.js";
import { normalizeUsage } from "../src/providers.js";
import { compactContext, completeWithContext, type ContextState } from "../src/context.js";
import { runAgentTaskDetailed, type LlmMessage, type LoopCheckpoint } from "../src/index.js";

/**
 * A long chat's whole cost is its prefix, resent every turn. These cover the
 * two halves of making that cheap: a prefix stable enough for a seller to
 * cache, and a compaction trigger that knows what a turn costs.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function session() {
  const dir = await mkdtemp(join(tmpdir(), "prompt-cache-")); roots.push(dir);
  return createSession({ workspaceRoot: dir, budgetCents: 1000, approvalMode: "auto", shellEnabled: true });
}
const runId = randomUUID();
const financial = (spent: bigint): FinancialState => ({
  status: "available", run_id: runId, currency: "USDC", observed_at: new Date().toISOString(),
  wallet: { balance_status: "available", balance_usdc: atomicUsdc(2_000_000n - spent), reserved_usdc: "0.000000", available_usdc: atomicUsdc(2_000_000n - spent) },
  current_run: { inference_spent_usdc: atomicUsdc(spent), service_spent_usdc: "0.000000", total_spent_usdc: atomicUsdc(spent),
    reserved_usdc: "0.000000", budget_limit_usdc: "1.000000", remaining_budget_usdc: atomicUsdc(1_000_000n - spent),
    per_call_approval_threshold_usdc: "0.100000", approval_mode: "auto" } });

it("keeps every turn's prefix byte-identical while the balance changes, and the snapshot out of history", async () => {
  const calls: LlmMessage[][] = [], history: LlmMessage[] = [], checkpoints: LoopCheckpoint[] = [];
  await runAgentTaskDetailed(await session(), "Summarise this.\n" + "Stable context.\n".repeat(400), {
    hosted: true, runId, knowledge: false,
    financialState: async () => financial(BigInt(calls.length) * 7_000n),
    onMessage: async message => { history.push(message); },
    onCheckpoint: async checkpoint => { checkpoints.push(structuredClone(checkpoint)); },
    provider: { complete: async messages => {
      calls.push(structuredClone(messages));
      return { content: "", toolCalls: [{ id: `call-${calls.length}`,
        name: calls.length === 1 ? "get_budget_status" : "complete_session",
        arguments: calls.length === 1 ? {} : { final_message: "Done" } }] };
    } },
  });
  expect(calls.length).toBeGreaterThan(1);
  // Everything before the latest user message is the prefix a seller caches;
  // it has to be the same bytes on turn two as on turn one, however much the
  // balance moved in between.
  const prefix = calls[0].slice(0, -1);
  expect(JSON.stringify(calls[1].slice(0, prefix.length))).toBe(JSON.stringify(prefix));
  // The snapshot rides on the owner's own message, before their words, and is
  // never a message of its own that a model could answer instead (SRI-65).
  expect(calls[0].at(-1)).toMatchObject({ role: "user" });
  expect(calls[0].at(-1)!.content).toMatch(/^\[Automatic note from CrowdCode, not written by the user; do not reply to it\. Money: wallet \$/);
  expect(calls[0].at(-1)!.content.endsWith("Stable context.\n")).toBe(true);
  // After a tool result the request is the history itself: the result already
  // carries the snapshot read after the tool ran, so nothing at all moves.
  expect(calls[1].at(-1)).toMatchObject({ role: "tool" });
  expect(JSON.parse(calls[1].at(-1)!.content).money).toContain("this run spent $0.0070 over 1 model call");
  expect(calls[1].some(m => m.role === "user" && m.content.includes("Money: "))).toBe(false);
  for (const messages of calls) expect(messages.some(m => m.content.startsWith("Money: "))).toBe(false);
  expect(history.some(m => m.role === "user" && m.content.includes("Money: "))).toBe(false);
  // It still has to be replayable: a paused payment is re-sent byte for byte.
  expect(checkpoints.some(c => c.context?.prepared && c.context.note)).toBe(true);
  expect(checkpoints.every(c => !c.messages.some(m => m.role === "user" && m.content.includes("Money: ")))).toBe(true);
});

it("replays a 0.16.0 checkpoint's standalone snapshot exactly as it was sent", async () => {
  const sent: LlmMessage[][] = [];
  const trailing: LlmMessage = { role: "user", content: "Current hosted financial snapshot: {}" };
  const messages: LlmMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
  await completeWithContext(await session(), messages, {
    provider: { complete: async request => { sent.push(structuredClone(request)); return { content: "ok", toolCalls: [] }; } },
    tools: [], state: { prepared: true, trailingMessage: trailing },
  });
  expect(sent[0]).toEqual([...messages, trailing]);
});

it("drops a snapshot an older runtime left in the history rather than keeping two", async () => {
  const calls: LlmMessage[][] = [];
  await runAgentTaskDetailed(await session(), "continue", {
    hosted: true, runId, knowledge: false,
    financialState: async () => financial(0n),
    history: [{ role: "system", content: "Current hosted financial snapshot: {\"status\":\"stale\"}" }],
    provider: { complete: async messages => {
      calls.push(structuredClone(messages));
      return { content: "", toolCalls: [{ id: "done", name: "complete_session", arguments: { final_message: "Done" } }] };
    } },
  });
  expect(calls[0].some(m => m.content.includes("Current hosted financial snapshot: "))).toBe(false);
  const snapshots = calls[0].filter(m => m.role === "user" && m.content.includes("Money: "));
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toBe(calls[0].at(-1));
  expect(snapshots[0].content.endsWith("\n\ncontinue")).toBe(true);
});

it.each(["blockrun", "x402"])("%s asks Claude to cache and keys the conversation", async adapter => {
  const bodies: Record<string, any>[] = [];
  const completion = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
  const provider = adapter === "blockrun"
    ? new BlockRunProvider({ clientFactory: async () => ({
        getSpending: () => ({ totalUsd: 0, calls: 0 }),
        async *stream(_path: string, body?: Record<string, unknown>) { bodies.push(body!); yield completion as never; },
      }) as never })
    : new X402ProxyProvider({ baseUrl: "https://proxy.test/v1", fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(completion);
      } });
  for (const model of ["anthropic/claude-sonnet-5-5", "venice/claude-opus-5-5", "openai/gpt-5.6-luna"])
    await provider.complete({ model, messages: [{ role: "user", content: "hi" }], tools: [], promptCacheKey: "session-1" });
  expect(bodies).toHaveLength(3);
  expect(bodies.map(body => body.prompt_cache_key)).toEqual(["session-1", "session-1", "session-1"]);
  // Claude is the one family that caches only when asked; nothing else needs it.
  expect(bodies.map(body => body.prompt_cache)).toEqual([true, true, undefined]);
});

it("reads a cache hit under every name a seller reports it by", () => {
  expect(normalizeUsage({ prompt_tokens: 4096, prompt_tokens_details: { cached_tokens: 3072, cache_creation_input_tokens: 1024 } }))
    .toMatchObject({ inputTokens: 4096, cachedInputTokens: 3072, cacheWriteTokens: 1024 });
  expect(normalizeUsage({ cache_read_input_tokens: 3072, cache_creation_input_tokens: 1024 }))
    .toMatchObject({ cachedInputTokens: 3072, cacheWriteTokens: 1024 });
  expect(normalizeUsage({})).toMatchObject({ cachedInputTokens: undefined, cacheWriteTokens: undefined });
});

it("turns two cents a turn into a token budget, per price and per cache hit rate", () => {
  // Venice's $0.33 plus the reseller's margin: about the 60,000 tokens a long
  // working conversation runs to.
  expect(costTriggerTokens({ inputPriceUsdPerMillion: 0.396 })).toBeCloseTo(50_505, -2);
  expect(costTriggerTokens({ inputPriceUsdPerMillion: 0.12 })).toBeCloseTo(166_666, -2);
  // Two cents of the dearest models is a few thousand tokens, which is not a
  // conversation; the floor holds.
  expect(costTriggerTokens({ inputPriceUsdPerMillion: 4.8 })).toBe(CONTEXT_MIN_HISTORY_TOKENS);
  // A cache that is hitting makes a long history cheap, so it may stay.
  const cold = costTriggerTokens({ inputPriceUsdPerMillion: 0.396, cachedInputPriceUsdPerMillion: 0.0099 })!;
  const warm = costTriggerTokens({ inputPriceUsdPerMillion: 0.396, cachedInputPriceUsdPerMillion: 0.0099, cachedFraction: 0.95 })!;
  expect(cold).toBeCloseTo(50_505, -2);
  expect(warm).toBeGreaterThan(cold * 5);
  // A seller that discounts without saying by how much is no discount at all.
  expect(costTriggerTokens({ inputPriceUsdPerMillion: 0.396, cachedFraction: 0.95 })).toBe(cold);
  // No price: the window is the only limit, which is where this started.
  expect(costTriggerTokens({})).toBeUndefined();
  expect(costTriggerTokens(undefined)).toBeUndefined();
});

/**
 * A chat far inside its window but well past two cents a turn, and one whose
 * bulk is the model's own prose: that cannot be externalized to a file the way
 * a long tool result can, so compaction has to remove whole exchanges and the
 * running summary is the only thing left of them.
 */
function longChat(turns = 80): LlmMessage[] {
  const messages: LlmMessage[] = [
    { role: "system", content: "System rules must survive." },
    { role: "user", content: "Write the book's third chapter." },
  ];
  for (let i = 0; i < turns; i++)
    messages.push(
      { role: "assistant", content: `Chapter note ${i}: the lighthouse keeper. ` + "She watched the water. ".repeat(130),
        toolCalls: [{ id: `c${i}`, name: "save_file", arguments: { path: `ch3-${i}.md` } }] },
      { role: "tool", toolCallId: `c${i}`, content: JSON.stringify({ ok: true, data: { path: `ch3-${i}.md`, bytes: 2048 } }) });
  messages.push({ role: "user", content: "Current task: tighten the ending." });
  return messages;
}

it("compacts a chat that costs too much inside a window it fits easily", async () => {
  const s = await session();
  const window = { contextWindowTokens: 1_000_000, maxOutputTokens: 4096, tools: [] };
  const free = await compactContext(s, structuredClone(longChat()), { ...window, state: {} });
  expect(free.archivePath).toBeUndefined();
  expect(free.tokensBefore).toBeGreaterThan(60_000);

  const messages = longChat(), state: ContextState = {};
  const priced = await compactContext(s, messages, { ...window, state, prices: { inputPriceUsdPerMillion: 0.396 } });
  expect(priced.archivePath).toBeTruthy();
  expect(priced.tokensAfter).toBeLessThan(priced.tokensBefore / 2);
  // What the owner asked, what it is working on now, and the rules: kept whole.
  expect(messages[0].content).toBe("System rules must survive.");
  expect(messages.some(m => m.content === "Write the book's third chapter.")).toBe(true);
  expect(messages.at(-1)!.content).toBe("Current task: tighten the ending.");
});

it("leaves the same chat alone while the seller's cache is paying for it", async () => {
  const s = await session(), messages = longChat();
  const result = await compactContext(s, messages, {
    contextWindowTokens: 1_000_000, maxOutputTokens: 4096, tools: [],
    state: { cachedFraction: 0.97 },
    prices: { inputPriceUsdPerMillion: 0.396, cachedInputPriceUsdPerMillion: 0.0099 },
  });
  expect(result.archivePath).toBeUndefined();
  expect(result.tokensAfter).toBe(result.tokensBefore);
});

it("records the hit rate from the turn just served, not the best one seen", async () => {
  const s = await session(), state: ContextState = {};
  const usages = [
    { inputTokens: 1000, cachedInputTokens: 900 },
    { inputTokens: 1000, cachedInputTokens: 0 },
  ];
  const provider = { complete: async () => ({ content: "ok", toolCalls: [], usage: usages.shift()! }) };
  const options = { contextWindowTokens: 16000, maxOutputTokens: 1024, tools: [], provider, state };
  await completeWithContext(s, [{ role: "user", content: "hi" }], options);
  expect(state.cachedFraction).toBeCloseTo(0.9, 5);
  await completeWithContext(s, [{ role: "user", content: "hi" }], options);
  expect(state.cachedFraction).toBe(0);
});

it("leaves a running summary of what it removed, and carries it into the next compaction", async () => {
  const s = await session(), messages = longChat();
  const window = { contextWindowTokens: 1_000_000, maxOutputTokens: 4096, tools: [], prices: { inputPriceUsdPerMillion: 0.396 } };
  await compactContext(s, messages, { ...window, state: {} });
  const summary = messages.find(m => m.contextArchive)!;
  expect(summary.content).toContain("What has already happened, oldest first:");
  expect(summary.content).toContain("save_file ok");
  expect(summary.content).toContain("lighthouse keeper");
  const firstLines = summary.content.split("\n").filter(line => line.startsWith("- "));
  expect(firstLines.length).toBeGreaterThan(5);

  // A second compaction must not forget the first half of the chat.
  messages.push(...longChat().slice(2));
  await compactContext(s, messages, { ...window, state: {} });
  const second = messages.find(m => m.contextArchive)!;
  expect(second.content).toContain(firstLines[0].slice(2));
  expect(second.content.split("\n").filter(line => line.startsWith("- ")).length).toBeGreaterThanOrEqual(firstLines.length);
});

it("budgets for the snapshot note without letting compaction remove it", async () => {
  const s = await session();
  const note = `Current hosted financial snapshot: ${"x".repeat(60_000)}`;
  const messages = longChat();
  const withSnapshot = await compactContext(s, structuredClone(messages), {
    contextWindowTokens: 1_000_000, maxOutputTokens: 4096, tools: [], state: { note },
  });
  const without = await compactContext(s, structuredClone(messages), {
    contextWindowTokens: 1_000_000, maxOutputTokens: 4096, tools: [], state: {},
  });
  expect(withSnapshot.tokensBefore).toBeGreaterThan(without.tokensBefore);
});

/**
 * The hosted run of 2026-11-13, at its real sizes: `moonshot/kimi-k3.1-pro` at
 * $2 a million inside a million-token window, system instructions and tool
 * definitions that come to about 15,000 estimated tokens between them, a
 * 4,164-character request, and a tool result of a couple of thousand tokens
 * every turn.
 */
const DEAR = { contextWindowTokens: 1_048_576, maxOutputTokens: 4096, prices: { inputPriceUsdPerMillion: 2 } };
const DEAR_TOOLS = [{ name: "run_shell", description: "d".repeat(30_000) }];
const DEAR_TASK = "complete this task end to end\n---\n" + "I'm offering a reward for pre-2020 human text a detector flags. ".repeat(64);
const dearRun = (): LlmMessage[] => [
  { role: "system", content: "Hosted rules. " + "r".repeat(14_000) },
  { role: "user", content: DEAR_TASK },
];
const dearStep = (i: number): LlmMessage[] => [
  { role: "assistant", content: `Step ${i}: testing candidate ${i} against the detector.`,
    toolCalls: [{ id: `s${i}`, name: "run_shell", arguments: { command: `./score candidate-${i}.txt` } }] },
  { role: "tool", toolCallId: `s${i}`, content: JSON.stringify({ ok: true, data: { candidate: i, output: `score ${i}% ` + "line of output\n".repeat(400) } }) },
];

it("does not count a dear model's instructions and tools as history it may remove", async () => {
  const s = await session(), messages = dearRun(), state: ContextState = {};
  expect(DEAR_TASK.length).toBeGreaterThan(4096);
  let compactions = 0;
  for (let turn = 0; turn < 60; turn++) {
    messages.push(...dearStep(turn));
    const result = await compactContext(s, messages, { ...DEAR, tools: DEAR_TOOLS, state });
    if (!result.archivePath) continue;
    compactions++;
    // The request is still the request, not a pointer to a file holding it.
    expect(messages.some(m => m.content === DEAR_TASK)).toBe(true);
    // What it has just done is still in front of it, word for word…
    expect(messages.some(m => m.content.startsWith(`Step ${turn}:`))).toBe(true);
    expect(messages.some(m => m.role === "tool" && m.content.includes(`score ${turn}% `))).toBe(true);
    expect(messages.filter(m => m.role === "assistant").length).toBeGreaterThanOrEqual(3);
    // …and what it did before that is a file it can search, not nothing.
    expect(messages.some(m => m.role === "tool" && m.content.includes("saved verbatim to context/"))).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  }
  // It compacted once every two or three turns, 35 times in 91 calls.
  expect(compactions).toBeGreaterThan(0);
  expect(compactions).toBeLessThanOrEqual(12);
});

it("keeps the summary and the request when a price target cannot be reached", async () => {
  const s = await session(), state: ContextState = {};
  // The model's own prose cannot be saved to a file, so exchanges are removed;
  // and what must be kept is, with the instructions and tools, over the target.
  const messages = dearRun();
  for (let i = 0; i < 12; i++)
    messages.push({ role: "assistant", content: `Finding ${i}: the 1911 almanac scored ${i}%. ` + "Reasoning in prose. ".repeat(160),
      toolCalls: [{ id: `p${i}`, name: "save_file", arguments: { path: `finding-${i}.md` } }] },
    { role: "tool", toolCallId: `p${i}`, content: JSON.stringify({ ok: true, data: { path: `finding-${i}.md` } }) });
  const current = "Now check these passages. " + "A pasted passage of ordinary prose. ".repeat(1_100);
  messages.push({ role: "user", content: current });

  const result = await compactContext(s, messages, { ...DEAR, tools: DEAR_TOOLS, state });
  expect(result.archivePath).toBeTruthy();
  expect(messages.some(m => m.content === DEAR_TASK)).toBe(true);
  expect(messages.at(-1)!.content).toBe(current);
  const summary = messages.find(m => m.contextArchive)!.content;
  expect(summary).toContain("What has already happened, oldest first:");
  expect(summary).toContain("the 1911 almanac scored");
});

it("does not compact for price again until there is room to work in", async () => {
  const s = await session(), state: ContextState = {};
  const messages = dearRun();
  for (let i = 0; i < 12; i++) messages.push(...dearStep(i));
  // A request large enough that everything else can go and the price is still not met.
  messages.push({ role: "user", content: "Check these. " + "A pasted passage of ordinary prose. ".repeat(2_000) });
  const request = messages.at(-1)!.content;
  const first = await compactContext(s, messages, { ...DEAR, tools: DEAR_TOOLS, state });
  expect(first.archivePath).toBeTruthy();
  expect(messages.at(-1)!.content).toBe(request);
  // Still over what this model's price triggers at: with no memory of having
  // just compacted, the very next turn would be compacted too.
  const forgetful = structuredClone([...messages, ...dearStep(99)]);
  expect((await compactContext(s, forgetful, { ...DEAR, tools: DEAR_TOOLS, state: {} })).archivePath).toBeTruthy();

  // The next turns are left alone, exchange and all…
  let quiet = 0;
  for (let turn = 100; ; turn++) {
    messages.push(...dearStep(turn));
    const next = await compactContext(s, messages, { ...DEAR, tools: DEAR_TOOLS, state });
    if (next.archivePath) break;
    expect(messages.some(m => m.content.startsWith(`Step ${turn}:`))).toBe(true);
    quiet++;
  }
  // …for half an allowance of new history, which is several turns of it.
  expect(quiet).toBeGreaterThanOrEqual(3);
});

it("still compacts a cheap model's chat at its price, counted over the instructions and tools", async () => {
  const s = await session(), state: ContextState = {};
  const messages = [...dearRun(), ...longChat().slice(2)];
  const window = { contextWindowTokens: 1_000_000, maxOutputTokens: 4096, tools: DEAR_TOOLS, prices: { inputPriceUsdPerMillion: 0.396 } };
  const result = await compactContext(s, messages, { ...window, state });
  expect(result.archivePath).toBeTruthy();
  // Half the 50,505-token allowance, beside about 15,000 tokens nothing can remove.
  expect(result.tokensAfter).toBeLessThanOrEqual(15_500 + 25_300);
  expect(result.tokensAfter).toBeGreaterThan(15_000);
});
