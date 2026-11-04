import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import { BASE_USDC, TEMPO_USDC } from "@opencrowd/economy";
import { createHostedEconomy, hostedDynamicTools, parsePaymentRequired } from "../src/hosted-economy.js";

/**
 * SRI-88, end to end in the runtime: one seller, two networks, one task.
 *
 * The stub seller is Drip's shape: posts are sold with x402 on Base only;
 * search is free but signed (a zero-amount MPP challenge on Tempo); a paid
 * post carries `paymentInfo.unlockToken`, and its OpenAPI documents the
 * `X-Drip-Unlock` header that re-reads a post for free. The supervisor stub
 * plays the gateway and control by their rules: a proof needs no funds, a
 * payment needs that network's spendable balance, and a run moves into a
 * network once and never back.
 */
const discovery = vi.hoisted(() => ({ check: vi.fn(), discover: vi.fn() }));
vi.mock("@agentcash/discovery", () => ({ checkEndpointSchema: discovery.check, discoverOriginSchema: discovery.discover }));
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function root() { const dir = await mkdtemp(join(tmpdir(), "two-rail-")); roots.push(dir); return dir; }

const SELLER = "https://drip.test";
const SEARCH = `${SELLER}/api/x402/search?q=semiconductors`;
const post = (slug: string) => `${SELLER}/api/x402/sources/research.substack.com/${slug}`;
const PRICE = 700_000;
const OPENAPI = { openapi: "3.1.0", paths: { "/api/x402/sources/{sourceSlug}/{postSlug}": { get: { parameters: [
  { name: "PAYMENT-SIGNATURE", in: "header", description: "x402 payment" },
  { name: "X-Drip-Unlock", in: "header", description: "Unlock token from a prior settle (`unlockToken` in the JSON body). Returns the summary with no charge." },
] } } } };

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const zeroChallenge = () => `Payment id="free-1", realm="drip.test", method="tempo", intent="charge", description="Topic search (free, wallet identity)", request="${Buffer.from(JSON.stringify({ amount: "0", currency: TEMPO_USDC, recipient: "0xseller", methodDetails: { chainId: 4217 } })).toString("base64url")}"`;
const baseOffer = (url: string) => Buffer.from(JSON.stringify({ x402Version: 2, resource: { url },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(PRICE), asset: BASE_USDC, payTo: "0xseller", maxTimeoutSeconds: 300, extra: {} }] })).toString("base64");

/** The seller, unpaid: what a probe, the gateway's first request and a free re-read see. */
function seller(tokens: Set<string>) {
  const calls: { url: string; unlock?: string }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers);
    calls.push({ url, unlock: headers.get("x-drip-unlock") ?? undefined });
    if (url === `${SELLER}/openapi.json`) return json(OPENAPI);
    if (url.startsWith("https://crowdcode.test/")) return json({ services: [] });
    if (url === SEARCH) return new Response("{}", { status: 402, headers: { "www-authenticate": zeroChallenge() } });
    if (url.startsWith(`${SELLER}/api/x402/sources/`)) {
      const unlock = headers.get("x-drip-unlock");
      if (unlock && tokens.has(`${unlock}|${url}`))
        return json({ title: url.split("/").pop(), synthesizedSummary: "the same summary", unlocked: true, paymentInfo: { amountUsd: "0.00", protocol: "unlock" } });
      return new Response("{}", { status: 402, headers: { "payment-required": baseOffer(url) } });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  discovery.check.mockImplementation(async ({ url }: { url: string }) => {
    const response = await fetcher(url, { method: "GET" });
    const header = response.headers.get("payment-required");
    const x402 = header ? JSON.parse(Buffer.from(header, "base64").toString()).accepts.map((a: any) => ({ ...a, protocol: "x402" })) : [];
    const mpp = (parsePaymentRequired(null, "", response.headers.get("www-authenticate"))?.offers ?? [])
      .map((o) => ({ protocol: "mpp", paymentMethod: "tempo", intent: "charge", network: o.network, asset: TEMPO_USDC, amount: String(Math.round(o.price_usd! * 1e6)), payTo: o.pay_to }));
    return { found: true, advisories: [{ method: "GET", authMode: "paid", summary: "Drip", inputSchema: {}, outputSchema: {}, paymentOptions: [...x402, ...mpp] }] };
  });
  return { fetcher, calls };
}

/** The supervisor: gateway and control, by their rules, over the worker socket. */
async function supervisor(start: { base: number; solana: number; tempo: number }, owed: number, tokens: Set<string>) {
  const balances = { ...start };
  const moves: { from: string; to: string; amount: number }[] = [];
  const paid: string[] = [], proofs: string[] = [];
  const CAIP: Record<string, string> = { base: "eip155:8453", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tempo: "eip155:4217" };
  const handle = (name: string, args: Record<string, any>) => {
    if (name === "economy.balance")
      return { ok: true, data: { hosting_owed_usd: owed.toFixed(6), hosting_reserve_usd: "0.100000", networks: (["base", "solana", "tempo"] as const).map((network) => ({
        network, caip2: CAIP[network], balance_usd: balances[network].toFixed(6),
        // Base's holds include what is owed for hosting, as control's openHolds does.
        available_usd: Math.max(0, balances[network] - (network === "base" ? owed : 0)).toFixed(6),
        ...(network === "base" ? { hosting_owed_usd: owed.toFixed(6) } : {}) })) } };
    if (name === "economy.pay") {
      if (args.url === SEARCH) { proofs.push(args.url); return { ok: true, data: { outcome: "free_proof", status: 200, body: JSON.stringify({ items: [{ slug: "a" }, { slug: "b" }] }), content_type: "application/json", amount_atomic: "0", network: "tempo" } }; }
      const spendable = balances.base - owed;
      if (spendable + 1e-9 < PRICE / 1e6)
        return { ok: false, code: "funding_required", error: `Not enough USDC on the networks this service accepts: base needs 0.700000 USDC (can spend ${spendable.toFixed(6)})` };
      balances.base -= PRICE / 1e6; paid.push(args.url);
      const token = `tok-${paid.length}`; tokens.add(`${token}|${args.url}`);
      return { ok: true, data: { outcome: "paid_success", status: 200, content_type: "application/json", amount_atomic: String(PRICE),
        body: JSON.stringify({ title: args.url.split("/").pop(), synthesizedSummary: "the summary", paymentInfo: { amountUsd: "0.7", protocol: "x402", unlockToken: token } }),
        transaction: `0x${paid.length}`, network: CAIP.base, payer: "0xagent", pay_to: "0xseller", attempt_id: `att-${paid.length}` } };
    }
    if (name === "economy.transfer") {
      const from = args.from as keyof typeof balances, to = args.to as keyof typeof balances;
      // control's assertPlannedMove
      if (moves.some((m) => m.from === to && m.to === from)) return { ok: false, code: "round_trip", error: `This run already moved funds ${to}→${from}` };
      if (moves.some((m) => m.to === to)) return { ok: false, code: "already_moved", error: `This run has already moved funds to ${to} once` };
      const amount = Number(args.amount_atomic) / 1e6;
      if (args.action === "quote") return { ok: true, data: { quote: { feeAtomic: "25000", expectedReceivedAtomic: String(Number(args.amount_atomic) - 25000) }, approval: { required: false } } };
      if (balances[from] + 1e-9 < amount) return { ok: false, code: "insufficient_funds", error: "not enough on the origin" };
      balances[from] -= amount; balances[to] += amount - 0.025; moves.push({ from, to, amount });
      return { ok: true, data: { transfer: { id: `t-${moves.length}`, state: "confirmed", from, to, amount_atomic: args.amount_atomic, fee_atomic: "25000", received_atomic: String(Number(args.amount_atomic) - 25000) } } };
    }
    if (name === "economy.review") return { ok: true, data: { review: "submitted" } };
    return { ok: false, error: `unexpected ${name}` };
  };
  const socketPath = join(await root(), "bridge.sock");
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.end(JSON.stringify(handle(body.name, body.arguments)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, balances, moves, paid, proofs };
}

/** The task as an agent following the tools' own words would do it. */
async function task(start: { base: number; solana: number; tempo: number }, owed: number) {
  const tokens = new Set<string>();
  const { fetcher, calls } = seller(tokens);
  const stub = await supervisor(start, owed, tokens);
  const session = await createSession({ workspaceRoot: await root(), sessionId: "s-1", budgetCents: 500, approvalMode: "auto" });
  const tools = hostedDynamicTools(createHostedEconomy({ socketPath: stub.socketPath, runId: "r-1", sessionId: "s-1", session, fetcher, crowdcodeBase: "https://crowdcode.test", reconcileDelayMs: 10, transferWait: { totalMs: 500, pollMs: 10 } }));
  const run = (name: string, args: Record<string, unknown>, id = `${name}-${Math.random()}`) => tools.execute(name, args, id);
  const log: { tool: string; ok: boolean; data?: any; error?: string }[] = [];
  const step = async (name: string, args: Record<string, unknown>) => { const result = await run(name, args); log.push({ tool: name, ok: result.ok, data: result.data, error: result.error }); return result; };

  const plan = await step("plan_funding", { calls: [{ url: SEARCH }, { url: post("a"), count: 1 }, { url: post("b"), count: 1 }] });
  for (const move of (plan.data as any)?.moves ?? []) await step("bridge_usdc", move);
  for (const url of [SEARCH, post("a"), post("b")]) {
    await step("inspect_paid_service", { url, method: "GET" });
    const call = await step("call_paid_service", { url, method: "GET" });
    if ((call.data as any)?.review_required) await step("review_paid_service", { purchase_id: (call.data as any).purchase_id, rating: 4, reason: "a summary as described" });
  }
  // The owner asks for the first piece again: it was bought, so it is free.
  const reread = await step("call_paid_service", { url: post("a"), method: "GET" });
  return { stub, calls, log, plan: plan.data as any, reread };
}

describe("one seller, two networks, one task (SRI-88)", () => {
  it("funded on Base: the free search moves nothing, both posts pay on Base, the re-read is free", async () => {
    const { stub, log, plan, reread, calls } = await task({ base: 2.2, solana: 0, tempo: 0 }, 0.1);
    expect(plan).toMatchObject({ outcome: "no_move", moves: [] });
    expect(plan.steps[0]).toMatch(/free \(a signed wallet-identity proof on tempo/);
    expect(stub.moves).toEqual([]);
    expect(stub.proofs).toEqual([SEARCH]);
    expect(stub.paid).toEqual([post("a"), post("b")]);
    const inspected = log.find((l) => l.tool === "inspect_paid_service")!.data;
    expect(inspected).toMatchObject({ free: true, price_ceiling_cents: 0, note: expect.stringContaining("never move funds for it"), schema: { price_usd: 0 } });
    const search = log.find((l) => l.tool === "call_paid_service")!.data;
    expect(search).toMatchObject({ outcome: "free", charged_cost_cents: 0, review_required: false });
    const first = log.filter((l) => l.tool === "call_paid_service")[1].data;
    expect(first.follow_up).toMatchObject({ header: "X-Drip-Unlock", token_field: "paymentInfo.unlockToken", saved: true });
    expect(reread.data).toMatchObject({ outcome: "free", charged_cost_cents: 0, note: expect.stringContaining("Free re-read") });
    expect(calls.filter((c) => c.unlock)).toEqual([{ url: post("a"), unlock: "tok-1" }]);
    expect(stub.balances.base).toBeCloseTo(0.8, 6);
  });

  it("funded on Tempo: exactly one move, sized to the task, and none back", async () => {
    const { stub, plan } = await task({ base: 0.4, solana: 0, tempo: 1.8 }, 0.1);
    expect(plan).toMatchObject({ outcome: "one_move", moves: [{ from: "tempo", to: "base" }] });
    expect(stub.moves).toHaveLength(1);
    expect(stub.paid).toEqual([post("a"), post("b")]);
    // Nothing stranded: what moved is what the posts needed, what Base keeps, and the bridge's cut.
    // Base could spend 0.30 against 0.35 kept: 1.40 + 0.05 + 0.05 = 1.50.
    expect(plan.moves[0].amount_usd).toBe(1.5);
    expect(stub.moves[0].amount).toBe(1.5);
    expect(stub.balances.base - 0.1).toBeGreaterThanOrEqual(0.35 - 0.03);
    expect(stub.balances.tempo).toBeCloseTo(0.3, 6);
  });

  it("refuses the round trip that run d95fef50 made", async () => {
    const tokens = new Set<string>();
    const { fetcher } = seller(tokens);
    const stub = await supervisor({ base: 2.0, solana: 0, tempo: 0 }, 0.257, tokens);
    const session = await createSession({ workspaceRoot: await root(), sessionId: "s-2", budgetCents: 500, approvalMode: "auto" });
    const tools = hostedDynamicTools(createHostedEconomy({ socketPath: stub.socketPath, runId: "r-2", sessionId: "s-2", session, fetcher, crowdcodeBase: "https://crowdcode.test", transferWait: { totalMs: 500, pollMs: 10 } }));
    expect((await tools.execute("bridge_usdc", { from: "base", to: "tempo", amount_usd: 1 }, "m1")).ok).toBe(true);
    const back = await tools.execute("bridge_usdc", { from: "tempo", to: "base", amount_usd: 0.8 }, "m2");
    expect(back).toMatchObject({ ok: false, error: expect.stringContaining("round_trip") });
    expect(stub.moves).toHaveLength(1);
  });
});
