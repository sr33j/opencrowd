import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, loadSession } from "@opencrowd/core";
import type { Command, Event } from "@opencrowd/protocol";
import { HostedAgentCashAdapter, createHostedEconomy, hostedDynamicTools, parsePaymentRequired } from "../src/hosted-economy.js";
import { MachineWorker } from "../src/worker.js";

const discovery = vi.hoisted(() => ({ check: vi.fn(), discover: vi.fn() }));
vi.mock("@agentcash/discovery", () => ({ checkEndpointSchema: discovery.check, discoverOriginSchema: discovery.discover }));
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() { const dir = await mkdtemp(join(tmpdir(), "hosted-economy-")); roots.push(dir); return dir; }

const CROWDCODE = "https://crowdcode.test";
const SEARCH = "https://stableenrich.dev/api/search";
const SOCIAL = "https://stablesocial.dev/api/social";
const WEATHER = "https://weather.example/api/forecast";
const LISTING = {
  services: [
    { service_id: "svc_search", name: "Exa web search", canonical_endpoint: SEARCH, directory_slug: "stableenrich-search", payment_provider: "x402", score: 4.6, n_eff: 12, unproven: false, num_reviews: 15 },
    { service_id: "svc_social", name: "Social web data", canonical_endpoint: SOCIAL, directory_slug: "stablesocial", payment_provider: "mppx", score: 4.1, n_eff: 3, unproven: false, num_reviews: 4 },
    { service_id: "svc_weather", name: "Weather forecast", canonical_endpoint: WEATHER, directory_slug: "weather", payment_provider: "x402", score: 3.2, n_eff: 1, unproven: true, num_reviews: 1 }
  ]
};
const DETAIL = { ok: true, service: LISTING.services[0], score: 4.6, n_eff: 12, unproven: false, num_reviews: 15,
  summary: { strengths: ["Fast, relevant results."], caveats: ["Occasional stale snippets."] } };

function offer(network: string, amount = "10000", extra: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: "exact", network, amount, asset: "0xusdc", payTo: "0xpayee", maxTimeoutSeconds: 60, extra: {} }],
    resource: { url: SEARCH, description: "Web search over the live index" },
    extensions: { bazaar: { info: { input: { type: "object", properties: { query: { type: "string" } } }, output: { results: [] } } } },
    ...extra
  })).toString("base64");
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

/** A fetch double serving the CrowdCode API plus one x402 endpoint; records every call. */
function fakeFetch(options: { endpointStatus?: number; header?: string; detailStatus?: number } = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === `${CROWDCODE}/api/services`) return json(LISTING);
    if (url === `${CROWDCODE}/api/services/svc_search`) return options.detailStatus === 404 ? json({ ok: false }, { status: 404 }) : json(DETAIL);
    if (url.startsWith(`${CROWDCODE}/api/services/`)) return json({ ok: false, error: "not found" }, { status: 404 });
    if (url === SEARCH || url === SOCIAL || url === WEATHER) {
      const status = options.endpointStatus ?? 402;
      if (status === 402) return new Response("payment required", { status: 402, headers: { "payment-required": options.header ?? offer("eip155:8453") } });
      return json({ results: ["free result"] }, { status });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch & { mock: { calls: unknown[] } };
  discovery.check.mockImplementation(async ({ url, sampleInputBody }) => {
    const method = url === WEATHER ? "GET" : "POST";
    const r = await fetcher(url, { method, ...(sampleInputBody ? { body: JSON.stringify(sampleInputBody) } : {}) });
    if (r.status >= 400 && r.status !== 402) return { found: false, message: `HTTP ${r.status}` };
    const p = r.status === 402 ? JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString()) : undefined;
    return { found: true, advisories: [{ method, authMode: p ? "paid" : "unprotected", summary: "Web search over the live index",
      inputSchema: { type: "object" }, outputSchema: { results: [] }, paymentOptions: p?.accepts.map((a: any) => ({ ...a, protocol: "x402", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" })) }] };
  });
  discovery.discover.mockResolvedValue({ found: true, origin: "https://weather.example", endpoints: [{ path: "/api/forecast", method: "GET", protocols: ["x402"] }] });
  return { fetcher, calls };
}

/** A fake supervisor socket answering `POST /tool`. */
async function bridge(handler: (name: string, args: Record<string, unknown>) => unknown) {
  const socketPath = join(await root(), "bridge.sock");
  const requests: { name: string; arguments: Record<string, unknown>; runId: string; sessionId: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    res.end(JSON.stringify(handler(body.name, body.arguments)));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { socketPath, requests };
}

async function economy(fetcher: typeof fetch, socketPath: string) {
  const session = await createSession({ workspaceRoot: await root(), sessionId: "session-1", budgetCents: 100, approvalMode: "auto" });
  const gateway = createHostedEconomy({ socketPath, runId: "run-1", sessionId: "session-1", session, fetcher, crowdcodeBase: CROWDCODE });
  return { session, gateway };
}

describe("hosted economy: discovery and inspection", () => {
  it("uses authenticated AgentCash search and verifies Base endpoints", async () => {
    const { fetcher } = fakeFetch();
    const { socketPath } = await bridge(() => ({ ok: true, data: { status: 200, body: JSON.stringify({ results: [{ origin: { url: "https://stableenrich.dev" }, path: "/api/search", method: "POST", summary: "Web search" }] }) } }));
    const { gateway } = await economy(fetcher, socketPath);
    const result = await gateway.execute("find_paid_service", { query: "web search", limit: 2 });
    expect(result.ok).toBe(true);
    expect((result.data as any).services).toEqual([expect.objectContaining({ endpoint: SEARCH, network: "eip155:8453", payable: true })]);
  });

  it("decodes an x402 v2 payment-required header into rail, price, payee and schema", () => {
    const base = parsePaymentRequired(offer("eip155:8453", "50000"), "")!;
    expect(base).toMatchObject({ rail: "x402-base", priceUsd: 0.05, payTo: "0xpayee", network: "eip155:8453", description: "Web search over the live index" });
    expect(base.inputSchema).toEqual({ type: "object", properties: { query: { type: "string" } } });
    expect(base.outputExample).toEqual({ results: [] });
    expect(parsePaymentRequired(offer("tempo:mainnet"), "")?.rail).toBe("mppx");
    expect(parsePaymentRequired(offer("solana:mainnet"), "")?.rail).toBe("unsupported");
    expect(parsePaymentRequired(null, JSON.stringify({ accepts: [{ network: "eip155:8453", amount: "1000" }] }))).toMatchObject({ rail: "x402-base", priceUsd: 0.001 });
    expect(parsePaymentRequired(null, "not an offer")).toBeUndefined();
  });

  it("inspects a 402 endpoint into a Base x402 rail with a 1-cent ceiling and CrowdCode reputation", async () => {
    const { fetcher, calls } = fakeFetch();
    const { gateway } = await economy(fetcher, "/nonexistent/bridge.sock");
    const result = await gateway.execute("inspect_paid_service", { url: SEARCH, method: "POST", sample_body: { query: "x" } });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      endpoint: SEARCH, method: "POST", rail: "x402-base", price_ceiling_cents: 1,
      schema: { rail: "x402-base", payable: true, price_usd: 0.01,
        input_schema: { type: "object" }, output_schema: { results: [] }, description: "Web search over the live index" },
      reputation: { score: 4.6, n_eff: 12, unproven: false, summary: "Fast, relevant results. Occasional stale snippets." }
    });
    const probe = calls.find(c => c.url === SEARCH)!;
    expect(probe).toMatchObject({ method: "POST", body: JSON.stringify({ query: "x" }) });
    expect(calls.some(c => c.url === `${CROWDCODE}/api/services/svc_search`)).toBe(true);
  });

  it("reports MPP/Tempo and free endpoints honestly and treats an unlisted service as unproven", async () => {
    const tempo = fakeFetch({ header: offer("tempo:mainnet") });
    const { gateway } = await economy(tempo.fetcher, "/nonexistent/bridge.sock");
    const social = await gateway.execute("inspect_paid_service", { url: SOCIAL });
    expect(social.data).toMatchObject({ rail: "unsupported", schema: { rail: "unsupported", payable: false } });
    const free = fakeFetch({ endpointStatus: 200 });
    const unlisted = await economy(free.fetcher, "/nonexistent/bridge.sock");
    const result = await unlisted.gateway.execute("inspect_paid_service", { url: "https://weather.example/api/forecast", method: "GET" });
    expect(result.data).toMatchObject({ schema: { authMode: "unprotected", rail: "x402-base" }, reputation: { unproven: true, summary: "not yet reviewed on CrowdCode" } });
    const broken = fakeFetch({ endpointStatus: 500 });
    const failing = await economy(broken.fetcher, "/nonexistent/bridge.sock");
    const error = await failing.gateway.execute("inspect_paid_service", { url: SEARCH });
    expect(error).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 500") });
  });
});

describe("hosted economy: payment over the bridge", () => {
  it("pays through economy.pay, records the receipt on a real session, and reviews through economy.review", async () => {
    const { fetcher } = fakeFetch();
    const { socketPath, requests } = await bridge((name) => name === "economy.pay"
      ? { ok: true, data: { outcome: "paid_success", status: 200, body: JSON.stringify({ results: ["paid result"] }), content_type: "application/json",
        amount_atomic: "10000", transaction: "0xtx", network: "eip155:8453", payer: "0xagent", pay_to: "0xpayee", attempt_id: "att_1" } }
      : { ok: true, data: { review: "submitted" } });
    const { session, gateway } = await economy(fetcher, socketPath);
    await gateway.execute("inspect_paid_service", { url: SEARCH, method: "POST" });
    const call = await gateway.execute("call_paid_service", { url: SEARCH, method: "POST", body: { query: "opencrowd" } });
    expect(call.ok).toBe(true);
    expect(call.data).toMatchObject({ outcome: "paid_success", status: 200, charged_cost_cents: 1, review_required: true, data: { results: ["paid result"] } });
    const pay = requests.find(r => r.name === "economy.pay")!;
    expect(pay).toMatchObject({ runId: "run-1", sessionId: "session-1", arguments: { service_id: "svc_search", url: SEARCH, method: "POST",
      body: JSON.stringify({ query: "opencrowd" }), max_cost_cents: 1 } });
    expect(pay.arguments.purchase_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const reloaded = await loadSession(session.workspaceRoot, session.sessionId);
    expect(reloaded.spentCents).toBe(1); expect(reloaded.reservedCents).toBe(0);
    expect(await gateway.hasPendingRequiredReviews()).toBe(true);
    const blocked = await gateway.execute("call_paid_service", { url: SEARCH, method: "POST" });
    expect(blocked.error).toMatch(/review_paid_service/);
    const purchaseId = (call.data as any).purchase_id;
    const review = await gateway.execute("review_paid_service", { purchase_id: purchaseId, rating: 5, reason: "exactly what I needed", task_context: "research" });
    expect(review).toEqual({ ok: true, data: { purchase_id: purchaseId, review: "submitted", rating: 5 } });
    expect(requests.find(r => r.name === "economy.review")!.arguments).toEqual({ api_endpoint: SEARCH, payment_provider: "x402", payment_target_ref: "0xpayee",
      payment_reference: "0xtx", rating: 5, reason: "exactly what I needed", task_context: "research" });
    expect(await gateway.hasPendingRequiredReviews()).toBe(false);
  });

  it("fetches the endpoint itself when the supervisor reports expected_payment_required", async () => {
    const { fetcher, calls } = fakeFetch({ endpointStatus: 200 });
    const { socketPath } = await bridge(() => ({ ok: false, error: "the endpoint did not require payment", code: "expected_payment_required" }));
    const { gateway } = await economy(fetcher, socketPath);
    await gateway.execute("inspect_paid_service", { url: SEARCH, method: "POST" });
    const call = await gateway.execute("call_paid_service", { url: SEARCH, method: "POST", body: { query: "free" }, max_cost_cents: 1 });
    expect(call.ok).toBe(true);
    expect(call.data).toMatchObject({ outcome: "free", status: 200, charged_cost_cents: 0, review_required: false, data: { results: ["free result"] } });
    expect(calls.filter(c => c.url === SEARCH && c.body === JSON.stringify({ query: "free" }))).toHaveLength(1);
  });

  it("records payment_unknown and transport failures as ambiguous purchases that are never retried", async () => {
    const { fetcher } = fakeFetch();
    const { socketPath } = await bridge(() => ({ ok: false, error: "settlement receipt not confirmed", code: "payment_unknown" }));
    const { gateway } = await economy(fetcher, socketPath);
    await gateway.execute("inspect_paid_service", { url: SEARCH, method: "POST" });
    const call = await gateway.execute("call_paid_service", { url: SEARCH, method: "POST" });
    expect(call.ok).toBe(false); expect(call.error).toMatch(/payment state is unknown/);
    expect((await gateway.listPurchasesRedacted())[0]).toMatchObject({ outcome: "unknown", charged_cost_cents: 1 });
    const dead = await economy(fetcher, join(await root(), "missing.sock"));
    await dead.gateway.execute("inspect_paid_service", { url: SEARCH, method: "POST" });
    const lost = await dead.gateway.execute("call_paid_service", { url: SEARCH, method: "POST" });
    expect(lost.ok).toBe(false); expect(lost.error).toMatch(/failed in transport/);
  });

  it("submits an unpaid failure through the shared review tool and hosted signer", async () => {
    const { fetcher } = fakeFetch();
    const { socketPath, requests } = await bridge(name => name === "economy.review"
      ? { ok: true, data: { accepted: true, payment_verified: false } }
      : { ok: false, error: "invalid payment requirements", code: "invalid_payment_requirements" });
    const { gateway } = await economy(fetcher, socketPath);
    await gateway.execute("inspect_paid_service", { url: SEARCH, method: "POST" });
    const call = await gateway.execute("call_paid_service", { url: SEARCH, method: "POST" });
    expect(call.ok).toBe(false);
    const purchaseId = (call.data as Record<string, unknown>).purchase_id;
    const review = await gateway.execute("review_paid_service", {
      purchase_id: purchaseId, rating: 3, reason: "Handshake rejected by the client; cause uncertain"
    });
    expect(review.ok).toBe(true);
    const args = requests.find(request => request.name === "economy.review")!.arguments;
    expect(args.review_nonce).toBe(purchaseId);
    expect(args.payment_reference).toBeUndefined();
    expect(args.payment_provider).toBeUndefined();
    expect(requests.filter(request => request.name === "economy.pay")).toHaveLength(1);
  });

  it("surfaces supervisor refusals with their code, refuses MPP rails and unlisted services without touching the bridge", async () => {
    const { fetcher } = fakeFetch();
    const { socketPath, requests } = await bridge(() => ({ ok: false, error: "the per-call cap is $0.05", code: "per_call_cap" }));
    const { gateway } = await economy(fetcher, socketPath);
    await gateway.execute("inspect_paid_service", { url: SEARCH, method: "POST" });
    const capped = await gateway.execute("call_paid_service", { url: SEARCH, method: "POST", max_cost_cents: 10 });
    expect(capped.ok).toBe(false); expect(capped.error).toContain("(per_call_cap)");
    expect((await gateway.listPurchasesRedacted())[0]).toMatchObject({ outcome: "free", charged_cost_cents: 0 });
    const directory = (gateway as any).options.agentcash as HostedAgentCashAdapter;
    const mpp = await directory.fetch({ url: SOCIAL, method: "POST", maxAmountUsd: 0.01, rail: "mppx" });
    expect(mpp).toMatchObject({ ok: false, ambiguous: false, error: expect.stringMatching(/MPP\/Tempo/) });
    const unlisted = await directory.fetch({ url: "https://unknown.example/api", method: "POST", maxAmountUsd: 0.01, rail: "x402-base" });
    expect(unlisted).toMatchObject({ ok: false, ambiguous: false, error: expect.stringContaining("per_call_cap") });
    expect(requests.filter(r => r.name === "economy.pay")).toHaveLength(2);
    expect(requests.at(-1)?.arguments.service_id).toMatch(/^url:/);
    expect(await directory.bridge()).toMatchObject({ ok: false, error: expect.stringContaining("not available for hosted agents") });
  });

  it("reads the wallet through economy.balance", async () => {
    const { fetcher } = fakeFetch();
    const { socketPath } = await bridge(() => ({ ok: true, data: { address: "0xagent", network: "eip155:8453", balance_atomic: "2500000", balance_usd: 2.5 } }));
    const { gateway } = await economy(fetcher, socketPath);
    expect(await gateway.execute("get_wallet_status", {})).toEqual({ ok: true, data: { address: "0xagent", network: "eip155:8453", balance_atomic: "2500000", balance_usd: 2.5 } });
  });
});

describe("hosted economy: worker wiring", () => {
  it("advertises the economy tools to the hosted model, records their calls, and prompts for hosted paid services", async () => {
    const home = await root(); const events: Event[] = []; let turn = 0; let advertised: string[] = []; let systemPrompt = "";
    const { fetcher } = fakeFetch();
    const provider = { complete: vi.fn(async (messages: { role: string; content: string }[]) => {
      systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
      return turn++ === 0
        ? { content: "", toolCalls: [{ id: "f", name: "find_paid_service", arguments: { query: "web search" } }] }
        : { content: "done", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "found it" } }] };
    }) };
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-09-16T00:00:00Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Find a search API", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };
    const { socketPath: awaitBridgePath } = await bridge(() => ({ ok: true, data: { status: 200, body: JSON.stringify({ results: [{ endpoint: SEARCH, method: "POST" }] }) } }));
    const worker = new MachineWorker({ agentHome: home, output: line => { events.push(JSON.parse(line)); },
      provider: (_run, _session, extraTools) => { advertised = extraTools.map(t => t.name); return provider; },
      economy: (run, session) => createHostedEconomy({ socketPath: awaitBridgePath, runId: run.runId, sessionId: session.sessionId, session, fetcher, crowdcodeBase: CROWDCODE }) });
    await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    expect(advertised).toEqual(["read_service", "find_paid_service", "inspect_paid_service", "call_paid_service", "review_paid_service"]);
    expect(systemPrompt).toContain("hosted OpenCrowd agent running in the cloud with your own USDC wallet on Base");
    expect(systemPrompt).toContain("Only x402 USDC on Base is payable");
    expect(systemPrompt).not.toContain("Paid external services are unavailable");
    expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
    expect(events.filter(e => e.type === "tool.started").map(e => [e.payload.toolName, e.payload.input])).toEqual([
      ["find_paid_service", { query: "web search" }], ["complete_session", { summary: "found it" }]]);
    expect(events.filter(e => e.type === "tool.finished").map(e => e.payload.status)).toEqual(["ok", "ok"]);
    const toolMessage = provider.complete.mock.calls[1][0].find((m: { role: string }) => m.role === "tool")!;
    expect(JSON.parse(toolMessage.content).result.data.services[0].endpoint).toBe(SEARCH);
  });

  it("keeps the model from finishing while a paid purchase still needs its review", async () => {
    const home = await root(); const events: Event[] = []; let turn = 0;
    const { fetcher } = fakeFetch();
    const { socketPath } = await bridge((name) => name === "economy.pay"
      ? { ok: true, data: { outcome: "paid_success", status: 200, body: "ok", content_type: "text/plain", amount_atomic: "10000", transaction: "0xtx", pay_to: "0xpayee" } }
      : { ok: true, data: { review: "submitted" } });
    const provider = { complete: vi.fn(async () => {
      switch (turn++) {
        case 0: return { content: "", toolCalls: [{ id: "i", name: "inspect_paid_service", arguments: { url: SEARCH, method: "POST" } }] };
        case 1: return { content: "", toolCalls: [{ id: "p", name: "call_paid_service", arguments: { url: SEARCH, method: "POST", body: { query: "q" } } }] };
        case 2: return { content: "all done", toolCalls: [] };
        default: return { content: "", toolCalls: [{ id: "r", name: "review_paid_service", arguments: { purchase_id: purchaseId, rating: 4, reason: "worked" } }, { id: "c", name: "complete_session", arguments: { final_message: "reviewed" } }] };
      }
    }) };
    let purchaseId = "";
    const worker = new MachineWorker({ agentHome: home, output: line => {
      const event = JSON.parse(line) as Event; events.push(event);
    }, provider: () => provider,
      economy: (run, session) => createHostedEconomy({ socketPath, runId: run.runId, sessionId: session.sessionId, session, fetcher, crowdcodeBase: CROWDCODE }) });
    await worker.initialize();
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-09-16T00:00:00Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Search", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } };
    const pending = worker.handleLine(JSON.stringify(command));
    // The review turn needs the purchase id from the call result; read it from the checkpointed tool message.
    const original = provider.complete.getMockImplementation()!;
    provider.complete.mockImplementation(async (messages: any) => {
      const paid = messages.find((m: any) => m.role === "tool" && m.toolCallId === "p");
      if (paid) purchaseId = JSON.parse(paid.content).result.data.purchase_id;
      return original(messages);
    });
    await pending; await worker.drain();
    expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
    // The loop mutates one messages array; the completion-gate nudge is the only user message after the prompt.
    const nudges = (provider.complete.mock.calls[3][0] as { role: string; content: string }[]).filter(m => m.role === "user").slice(1);
    expect(nudges).toEqual([{ role: "user", content: "You cannot finish yet: a paid purchase still needs its required review; submit it with review_paid_service" }]);
    expect(provider.complete).toHaveBeenCalledTimes(4);
    expect(events.filter(e => e.type === "tool.started").map(e => e.payload.input)).toEqual([
      { url: SEARCH, method: "POST" }, { url: SEARCH, method: "POST" }, { purchase_id: purchaseId, rating: "4" }, { summary: "reviewed" }]);
    const dynamic = hostedDynamicTools(createHostedEconomy({ socketPath, runId: "r", sessionId: "s", session: await createSession({ workspaceRoot: await root() }), fetcher }));
    expect(dynamic.definitions.map(d => d.name)).not.toContain("bridge_usdc");
  });
});

describe("hosted economy: review gate", () => {
  it("uses durable per-purchase review decisions even across wrappers and subsequent purchases", async () => {
    let pending = true, attempts = 0;
    const economy = {
      definitions: () => [{ name: "review_paid_service", description: "", parameters: {} }],
      execute: async () => { if (++attempts === 2) pending = false; return { ok: false, error: "Registry rejected the review" }; },
      hasPendingRequiredReviews: async () => pending
    } as unknown as Parameters<typeof hostedDynamicTools>[0];
    const tools = hostedDynamicTools(economy);
    expect(await tools.completionGate()).toMatch(/review_paid_service/);
    await tools.execute("review_paid_service", { purchase_id: "p", rating: 4, reason: "x" });
    expect(await tools.completionGate()).toMatch(/review_paid_service/);
    await tools.execute("review_paid_service", { purchase_id: "p", rating: 4, reason: "x" });
    expect(await tools.completionGate()).toBeUndefined();
    expect(await hostedDynamicTools(economy).completionGate()).toBeUndefined();
    pending = true; // A new purchase has its own review requirement.
    expect(await tools.completionGate()).toMatch(/review_paid_service/);
  });
});


it("resumes an approved paid tool after worker restart with the same purchase ID", async () => {
  const home = await root(); const events: Event[] = []; let approved = false; let turn = 0;
  const { fetcher } = fakeFetch();
  const { socketPath, requests } = await bridge(() => approved
    ? { ok: true, data: { outcome: "paid_success", status: 200, body: "ok", content_type: "text/plain", amount_atomic: "10000", transaction: "0xtx", pay_to: "0xpayee" } }
    : { ok: false, code: "approval_required", error: "Approve this call" });
  const provider = { complete: vi.fn(async () => {
    switch (turn++) {
      case 0: return { content: "", toolCalls: [{ id: "i", name: "inspect_paid_service", arguments: { url: SEARCH, method: "POST" } }] };
      case 1: return { content: "", toolCalls: [{ id: "p", name: "call_paid_service", arguments: { url: SEARCH, method: "POST", body: { query: "q" } } }] };
      default: return { content: "done", toolCalls: [] };
    }
  }) };
  const options = { agentHome: home, output: (line: string) => { events.push(JSON.parse(line)); }, provider: () => provider,
    economy: (run: any, session: any) => {
      const gateway = createHostedEconomy({ socketPath, runId: run.runId, sessionId: session.sessionId, session, fetcher, crowdcodeBase: CROWDCODE });
      gateway.hasPendingRequiredReviews = async () => false;
      return gateway;
    } };
  const worker = new MachineWorker(options); await worker.initialize();
  await worker.handleLine(JSON.stringify({ protocolVersion: 1, id: "start", runId: "run-1", seq: 1, emittedAt: "2026-09-16T00:00:00Z", type: "run.start",
    payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Search", modelPolicy: {}, budget: { limit: "10000000" }, approvalMode: "auto" } }));
  await worker.drain();
  const waiting = events.filter(e => e.type === "run.finished").at(-1)!;
  expect(waiting.payload.outcome).toBe("waiting_for_approval"); expect(provider.complete).toHaveBeenCalledTimes(2);
  approved = true;
  const restarted = new MachineWorker(options); await restarted.initialize();
  await restarted.handleLine(JSON.stringify({ protocolVersion: 1, id: "resume", runId: "run-1", seq: 2, emittedAt: "2026-09-16T00:01:00Z", type: "run.resume",
    payload: { sessionId: "session-1", cause: "approval_granted", operationId: waiting.payload.pendingOperationId } }));
  await restarted.drain();
  expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
  const payments = requests.filter(r => r.name === "economy.pay");
  expect(payments).toHaveLength(2);
  expect(payments[0].arguments.purchase_request_id).toBe(payments[1].arguments.purchase_request_id);
  expect(provider.complete).toHaveBeenCalledTimes(3);
});
