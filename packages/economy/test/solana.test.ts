import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createSession, parsePaymentNetwork, resolvePaymentNetwork } from "@opencrowd/core";

const check = vi.hoisted(() => vi.fn());
vi.mock("@agentcash/discovery", () => ({ checkEndpointSchema: check, discoverOriginSchema: vi.fn() }));

import {
  BASE_USDC, BaseServiceDiscovery, classifyOffer, EconomyGateway, HOSTED_RAILS, listPurchases, localRails, McpAgentCashAdapter,
  McpConnection, McpCrowdCodeAdapter, MockCrowdCodeAdapter, MONAD_NETWORK, MONAD_USDC, parsePaidFetchResult, selectOffer,
  SOLANA_NETWORK, SOLANA_USDC, TEMPO_USDC
} from "../src/index.js";

const SIG = "5wHu1qwD7q5ifaN5nwdcDqNFo53GJqa7nLp2BeeEpcHCusb4GzARz4GjgzsEHMkBMgCJMGa6GSQ1VG96Exv8kt2W";
const SOLANA_PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const PAY_TO = "HvpQjp1KgZnzYugwdHBw3DoYjZbjrMkxAJdbD8T5LyFu";
const BASE = { protocol: "x402", version: 2, scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "20000", payTo: "0xpayee" };
const SOLANA = { protocol: "x402", version: 2, scheme: "exact", network: SOLANA_NETWORK, asset: SOLANA_USDC, amount: "10000", payTo: PAY_TO };
const TEMPO = { protocol: "mpp", paymentMethod: "tempo", intent: "charge", realm: "svc", network: "tempo:4217", asset: TEMPO_USDC, amount: "15000", decimals: 6, payTo: "0xtempo" };
const MONAD = { protocol: "x402", version: 2, scheme: "exact", network: MONAD_NETWORK, asset: MONAD_USDC, amount: "10000", payTo: "0xmonad" };

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  delete process.env.OPENCROWD_PAYMENT_NETWORK;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  check.mockReset();
});
const advertise = (paymentOptions: unknown[]) => check.mockImplementation(async () => ({ found: true, advisories: [{ method: "POST", authMode: "paid", paymentOptions }] }));

describe("offer classification", () => {
  it("maps each network's USDC offer to its rail and rejects other tokens, schemes and chains", () => {
    expect([BASE, SOLANA, TEMPO, MONAD].map((offer) => classifyOffer(offer).rail)).toEqual(["x402-base", "x402-solana", "mppx", "x402-monad"]);
    expect(classifyOffer(SOLANA)).toMatchObject({ network_name: "solana", protocol: "x402", price_usd: 0.01, pay_to: PAY_TO });
    expect(classifyOffer(TEMPO)).toMatchObject({ network_name: "tempo", protocol: "mpp", price_usd: 0.015 });
    expect(classifyOffer({ ...SOLANA, scheme: "upto" }).rail).toBe("unsupported");
    expect(classifyOffer({ ...SOLANA, asset: "So11111111111111111111111111111111111111112" }).rail).toBe("unsupported");
    expect(classifyOffer({ ...TEMPO, intent: "session" }).rail).toBe("unsupported");
    expect(classifyOffer({ ...TEMPO, asset: "0x20c0000000000000000000000000000000000000" }).rail).toBe("unsupported");
    expect(classifyOffer({ ...BASE, network: "eip155:1" }).rail).toBe("unsupported");
  });

  it("keeps the preferred network whenever offered and otherwise falls back by balance in Base, Solana, Tempo order", () => {
    const offers = [BASE, SOLANA, TEMPO].map(classifyOffer);
    const rails = localRails();
    expect(selectOffer(offers, { rails })?.rail).toBe("x402-base");
    expect(selectOffer(offers, { rails, balances: { base: 0, solana: 5 } })?.rail).toBe("x402-base");
    expect(selectOffer(offers, { preferred: "solana", rails })?.rail).toBe("x402-solana");
    const noBase = [SOLANA, TEMPO].map(classifyOffer);
    expect(selectOffer(noBase, { rails, balances: { solana: 0.001, tempo: 1 } })?.rail).toBe("mppx");
    expect(selectOffer(noBase, { rails, balances: { solana: 1, tempo: 1 } })?.rail).toBe("x402-solana");
    // Nothing covers the price: the first payable network, so the payer reports the shortfall.
    expect(selectOffer(noBase, { rails, balances: {} })?.rail).toBe("x402-solana");
    expect(selectOffer([classifyOffer(MONAD)], { rails })).toBeUndefined();
    expect(selectOffer([classifyOffer(MONAD)], { preferred: "monad", rails: localRails("monad") })?.rail).toBe("x402-monad");
    expect(selectOffer([classifyOffer(MONAD), classifyOffer(TEMPO)], { rails: HOSTED_RAILS })?.rail).toBe("mppx");
  });

  it("accepts solana as a payment network preference from config, CAIP-2 and the environment", () => {
    expect(parsePaymentNetwork("solana")).toBe("solana");
    expect(parsePaymentNetwork(SOLANA_NETWORK)).toBe("solana");
    process.env.OPENCROWD_PAYMENT_NETWORK = "Solana";
    expect(resolvePaymentNetwork({ paymentNetwork: "base" })).toBe("solana");
    process.env.OPENCROWD_PAYMENT_NETWORK = "polygon";
    expect(() => resolvePaymentNetwork()).toThrow(/base, solana, monad/);
  });
});

describe("discovery across networks", () => {
  it("reports every offered network with its price and picks the preferred one", async () => {
    advertise([BASE, SOLANA, TEMPO]);
    const base = (await new BaseServiceDiscovery(vi.fn()).inspect({ url: "https://svc.example/a" })).data as Record<string, unknown>;
    expect(base).toMatchObject({ rail: "x402-base", network: "eip155:8453", price_usd: 0.02, payable: true, offers: [
      { network: "base", protocol: "x402", price_usd: 0.02, payable: true },
      { network: "solana", protocol: "x402", price_usd: 0.01, payable: true },
      { network: "tempo", protocol: "mpp", price_usd: 0.015, payable: true }] });
    const solana = (await new BaseServiceDiscovery(vi.fn(), { paymentNetwork: "solana" }).inspect({ url: "https://svc.example/b" })).data;
    expect(solana).toMatchObject({ rail: "x402-solana", network: SOLANA_NETWORK, price_usd: 0.01, note: expect.stringContaining("x402 USDC on Solana") });
  });

  it("reads balances only when the preferred network is missing and several networks are payable", async () => {
    const balances = vi.fn(async () => ({ solana: 0, tempo: 2 }));
    advertise([BASE, SOLANA]);
    await new BaseServiceDiscovery(vi.fn(), { balances }).inspect({ url: "https://svc.example/c" });
    expect(balances).not.toHaveBeenCalled();
    advertise([SOLANA, TEMPO]);
    const fallback = (await new BaseServiceDiscovery(vi.fn(), { balances }).inspect({ url: "https://svc.example/d" })).data;
    expect(fallback).toMatchObject({ rail: "mppx", network: "eip155:4217", price_usd: 0.015, note: expect.stringContaining("base is not offered") });
    expect(balances).toHaveBeenCalledTimes(1);
    advertise([MONAD, { ...BASE, network: "eip155:137" }]);
    const none = (await new BaseServiceDiscovery(vi.fn(), { balances }).inspect({ url: "https://svc.example/e" })).data;
    expect(none).toMatchObject({ rail: "unsupported", payable: false, note: expect.stringMatching(/offers x402 USDC on Monad, x402 on eip155:137; payable here: x402 USDC on Base, x402 USDC on Solana or MPP USDC.e on Tempo/) });
  });

  it("quotes the ceiling across payable networks when the hosted gateway negotiates", async () => {
    advertise([BASE, SOLANA, TEMPO, MONAD]);
    const hosted = (await new BaseServiceDiscovery(vi.fn(), { rails: HOSTED_RAILS, negotiated: true }).inspect({ url: "https://svc.example/f" })).data;
    expect(hosted).toMatchObject({ rail: "x402-base", price_usd: 0.02, payable: true, offers: expect.arrayContaining([{ network: "monad", protocol: "x402", price_usd: 0.01, payable: false }]),
      note: expect.stringContaining("cheapest of x402 USDC on Base, x402 USDC on Solana, MPP USDC.e on Tempo") });
  });
});

describe("Solana receipts", () => {
  const receipt = Buffer.from(JSON.stringify({ success: true, transaction: SIG, network: SOLANA_NETWORK, payer: SOLANA_PAYER })).toString("base64");
  const metadata = { protocol: "x402", network: "solana", price: "$0.01", payment: { success: true, transactionHash: SIG }, headers: { "payment-response": receipt } };

  it("records a chain-qualified reference with the Solana payer", () => {
    expect(parsePaidFetchResult([{ ok: 1 }, metadata], "x402-solana")).toMatchObject({ ok: true, ambiguous: false, authMode: "paid",
      payment: { rail: "x402-solana", reference: `x402:solana:${SIG}`, payer: SOLANA_PAYER, paidUsd: 0.01, proof: receipt } });
    // A network-less x402 receipt is the network AgentCash was pinned to.
    expect(parsePaidFetchResult([{ ok: 1 }, { protocol: "x402", price: "$0.01", payment: { transactionHash: SIG } }], "x402-solana").payment)
      .toMatchObject({ rail: "x402-solana", reference: `x402:solana:${SIG}` });
    // A receipt on an unexpected chain is never reviewed as Base.
    expect(parsePaidFetchResult([{ ok: 1 }, { ...metadata, network: "eip155:1", payment: { transactionHash: "0xabc", network: "eip155:1" } }], "x402-base"))
      .toMatchObject({ ambiguous: true, ambiguityReason: "unsupported_receipt" });
  });
});

describe("Solana purchase lifecycle through AgentCash", () => {
  function agentcashServer(fetches: Record<string, unknown>[]) {
    const server = new McpServer({ name: "agentcash", version: "0.0.0" });
    server.tool("get_balance", "Balance", {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ balance: 7 }) }] }));
    server.tool("list_accounts", "Accounts", {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ totalBalance: 7, accounts: [
      { network: "base", address: "0xagent", balance: 0, depositLink: "https://agentcash.dev/deposit/base" },
      { network: "tempo", address: "0xagent", balance: 2 },
      { network: "solana", address: SOLANA_PAYER, balance: 5 }] }) }] }));
    server.tool("fetch", "Fetch", { url: z.string(), method: z.string(), body: z.any().optional(), maxAmount: z.number(), paymentNetwork: z.string(), paymentProtocol: z.string() }, async (args) => {
      fetches.push(args);
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: SIG, network: SOLANA_NETWORK, payer: SOLANA_PAYER })).toString("base64");
      return { content: [{ type: "text", text: JSON.stringify({ image: "a cat" }) }, { type: "text", text: JSON.stringify({
        protocol: "x402", network: "solana", price: "$0.01", payment: { success: true, transactionHash: SIG }, headers: { "payment-response": receipt } }) }] };
    });
    return server;
  }
  function connect(name: string, server: McpServer) {
    const connection = new McpConnection(name, { command: "unused", args: [] }, { transportFactory: () => {
      const [client, serverTransport] = InMemoryTransport.createLinkedPair(); void server.connect(serverTransport); return client;
    } });
    cleanups.push(() => connection.close());
    return connection;
  }
  async function gatewayFor(paymentNetwork?: "solana") {
    const root = await mkdtemp(join(tmpdir(), "opencrowd-solana-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fetches: Record<string, unknown>[] = [];
    const agentcash = new McpAgentCashAdapter(connect("agentcash", agentcashServer(fetches)), { paymentNetwork });
    const crowdcode = new MockCrowdCodeAdapter();
    const session = await createSession({ workspaceRoot: root, budgetCents: 100 });
    const gateway = new EconomyGateway({ session, agentcash, crowdcode, approvalMode: "auto", approvalRulesPath: join(root, "approvals.json") });
    return { gateway, crowdcode, session, fetches, agentcash };
  }

  it("pays a Solana-only service through AgentCash pinned to Solana and reviews it with the Solana payer", async () => {
    advertise([SOLANA, MONAD]);
    const { gateway, crowdcode, session, fetches } = await gatewayFor();
    const inspected = await gateway.execute("inspect_paid_service", { url: "https://svc.example/img", method: "POST" });
    expect(inspected).toMatchObject({ ok: true, data: { rail: "x402-solana", price_ceiling_cents: 1 } });
    const result = await gateway.execute("call_paid_service", { url: "https://svc.example/img", method: "POST", body: { prompt: "a cat" } });
    expect(result).toMatchObject({ ok: true, data: { outcome: "paid_success", charged_cost_cents: 1, review_required: true, data: { image: "a cat" } } });
    expect(fetches[0]).toMatchObject({ url: "https://svc.example/img", paymentNetwork: "solana", paymentProtocol: "x402", maxAmount: 0.01 });
    expect(JSON.stringify(result)).not.toContain(SIG);
    const [purchase] = await listPurchases(session);
    // The Solana receipt has no payee; the inspected offer's is kept so CrowdCode can verify a new service.
    expect(purchase.record).toMatchObject({ rail: "x402-solana", evidence: { reference: `x402:solana:${SIG}`, payer: SOLANA_PAYER, payTo: PAY_TO } });
    const review = await gateway.execute("review_paid_service", { purchase_id: (result.data as any).purchase_id, rating: 5, reason: "image delivered" });
    expect(review.ok).toBe(true);
    expect(crowdcode.reviews[0]).toMatchObject({ paymentReference: `x402:solana:${SIG}`, paymentProvider: "x402", payer: SOLANA_PAYER, paymentTargetRef: PAY_TO, apiEndpoint: "https://svc.example/img" });
    expect(crowdcode.reviews[0].payerSignature).toBeUndefined();
  });

  it("falls back from Base to the network the balance covers and reports per-network accounts", async () => {
    advertise([SOLANA, TEMPO]);
    const { gateway, agentcash } = await gatewayFor();
    expect(await gateway.execute("inspect_paid_service", { url: "https://svc.example/x", method: "POST" })).toMatchObject({ data: { rail: "x402-solana" } });
    expect(await agentcash.networkBalances()).toEqual({ base: 0, tempo: 2, solana: 5 });
    const balance = await agentcash.getBalance();
    expect(balance.data).toMatchObject({ balance: 7, accounts: expect.arrayContaining([{ network: "solana", address: SOLANA_PAYER, usdc: 5 }]) });
  });

  it("forwards the Solana payer and an optional payer signature to CrowdCode", async () => {
    const received: Record<string, unknown>[] = [];
    const server = new McpServer({ name: "crowdcode", version: "test" });
    server.tool("review_service", { rating: z.number(), reason: z.string(), payment_reference: z.string(), payer: z.string().optional(), payer_signature: z.string().optional() },
      async (args) => { received.push(args); return { content: [{ type: "text", text: JSON.stringify({ accepted: true }) }] }; });
    const adapter = new McpCrowdCodeAdapter(connect("crowdcode", server));
    expect(await adapter.reviewService({ rating: 4, reason: "ok", paymentReference: `x402:solana:${SIG}`, payer: SOLANA_PAYER, payerSignature: "sig58" })).toMatchObject({ ok: true });
    expect(await adapter.reviewService({ rating: 4, reason: "ok", paymentReference: "0xbase" })).toMatchObject({ ok: true });
    expect(received).toEqual([{ rating: 4, reason: "ok", payment_reference: `x402:solana:${SIG}`, payer: SOLANA_PAYER, payer_signature: "sig58" },
      { rating: 4, reason: "ok", payment_reference: "0xbase" }]);
  });
});
