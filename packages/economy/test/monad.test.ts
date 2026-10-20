import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, verifyTypedData } from "viem";
import { createSession, parsePaymentNetwork, resolvePaymentNetwork } from "@opencrowd/core";

const check = vi.hoisted(() => vi.fn());
vi.mock("@agentcash/discovery", () => ({ checkEndpointSchema: check, discoverOriginSchema: vi.fn() }));

import {
  BASE_USDC,
  BaseServiceDiscovery,
  EconomyGateway,
  listPurchases,
  McpAgentCashAdapter,
  McpConnection,
  MockCrowdCodeAdapter,
  MONAD_NETWORK,
  MONAD_USDC,
  MonadX402Payer,
  monadUsdcBalance,
  type ApprovalAnswer
} from "../src/index.js";

const PAY_TO = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const TX = `0x${"ab".repeat(32)}`;
const PRIVATE_KEY = generatePrivateKey();
const PAYER = privateKeyToAccount(PRIVATE_KEY).address;

const BASE_OFFER = { scheme: "exact", network: "eip155:8453", amount: "200000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
const MONAD_OFFER = { scheme: "exact", network: MONAD_NETWORK, amount: "200000", asset: MONAD_USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
const POLYGON_OFFER = { ...BASE_OFFER, network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" };

interface ServiceBehaviour {
  accepts?: unknown[];
  /** What the "facilitator" does with a valid signed payment. */
  settle?: "ok" | "reject" | "no-receipt" | "wrong-network" | "settle-then-fail";
  /** Like agent402: read the body only when labelled JSON and require `prompt`. */
  requirePrompt?: boolean;
  /** The Monad RPC answers with an error. */
  rpcDown?: boolean;
}

const AUTHORIZATION_STATE_ABI = [{
  type: "function", name: "authorizationState", stateMutability: "view",
  inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ name: "", type: "bool" }]
}] as const;

/**
 * A local x402 v2 service whose facilitator verifies the EIP-3009 signature
 * exactly as the chain would, then reports a settlement receipt.
 */
async function startService(behaviour: ServiceBehaviour = {}) {
  const requests: Array<{ method?: string; headers: IncomingMessage["headers"]; body: string; payment?: any }> = [];
  const accepts = behaviour.accepts ?? [BASE_OFFER, POLYGON_OFFER, MONAD_OFFER];
  // On-chain EIP-3009 state of the fake Monad USDC: `${authorizer}:${nonce}` once used.
  const usedNonces = new Set<string>();
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/rpc") {
      const call = JSON.parse(body);
      if (behaviour.rpcDown) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "unavailable" } }));
        return;
      }
      const { args } = decodeFunctionData({ abi: AUTHORIZATION_STATE_ABI, data: call.params[0].data });
      const used = usedNonces.has(`${String(args[0]).toLowerCase()}:${args[1]}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: `0x${(used ? 1 : 0).toString(16).padStart(64, "0")}` }));
      return;
    }
    const signature = req.headers["payment-signature"];
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url}`;
    const challenge = { x402Version: 2, error: "Payment required", resource: { url, description: "video", mimeType: "application/json" }, accepts };
    if (typeof signature !== "string") {
      requests.push({ method: req.method, headers: req.headers, body });
      res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") });
      res.end(JSON.stringify(challenge));
      return;
    }
    const payment = JSON.parse(Buffer.from(signature, "base64").toString("utf8"));
    requests.push({ method: req.method, headers: req.headers, body, payment });
    const { authorization } = payment.payload;
    const valid = payment.x402Version === 2
      && JSON.stringify(payment.accepted) === JSON.stringify(MONAD_OFFER)
      && await verifyTypedData({
        address: authorization.from,
        domain: { name: "USDC", version: "2", chainId: 143, verifyingContract: MONAD_USDC },
        types: { TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }
        ] },
        primaryType: "TransferWithAuthorization",
        message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
        signature: payment.payload.signature
      });
    if (!valid || behaviour.settle === "reject") {
      res.writeHead(402, { "content-type": "application/json", "payment-response": Buffer.from(JSON.stringify({ success: false, errorReason: "insufficient_funds", network: MONAD_NETWORK })).toString("base64") });
      res.end(JSON.stringify(challenge));
      return;
    }
    if (behaviour.requirePrompt) {
      const input = req.headers["content-type"]?.includes("application/json") ? JSON.parse(body || "{}") : {};
      if (typeof input.prompt !== "string") {
        // Rejected before settlement: no receipt, nothing moved on-chain.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "\"prompt\" is required" }));
        return;
      }
    }
    usedNonces.add(`${String(authorization.from).toLowerCase()}:${authorization.nonce}`);
    if (behaviour.settle === "settle-then-fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream failed" }));
      return;
    }
    const receipt = { success: true, transaction: TX, network: behaviour.settle === "wrong-network" ? "eip155:8453" : MONAD_NETWORK, payer: authorization.from };
    res.writeHead(200, {
      "content-type": "application/json",
      ...(behaviour.settle === "no-receipt" ? {} : { "payment-response": Buffer.from(JSON.stringify(receipt)).toString("base64") })
    });
    res.end(JSON.stringify({ video: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/v1/videos/generations`, rpcUrl: `${origin}/rpc`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  delete process.env.OPENCROWD_PAYMENT_NETWORK;
  delete process.env.AGENTCASH_WALLET_PATH;
});

async function service(behaviour?: ServiceBehaviour) {
  const started = await startService(behaviour);
  cleanups.push(started.close);
  return started;
}

const payerFor = (svc: { rpcUrl: string }) => new MonadX402Payer({ privateKey: PRIVATE_KEY, rpcUrl: svc.rpcUrl, authorizationCheckDelayMs: 0 });

describe("MonadX402Payer", () => {
  it("signs EIP-3009 for the Monad offer and returns the settlement as x402:monad evidence", async () => {
    const svc = await service();
    const result = await payerFor(svc).fetch({ url: svc.url, method: "POST", body: { prompt: "a cat" }, maxAmountUsd: 0.2, rail: "x402-monad" });
    expect(result).toMatchObject({ ok: true, ambiguous: false, status: 200, authMode: "paid", data: { video: "ok" } });
    expect(result.payment).toMatchObject({ rail: "x402-monad", paidUsd: 0.2, reference: `x402:monad:${TX}`, payTo: PAY_TO });
    expect(JSON.parse(result.payment!.proof!)).toEqual({ success: true, transaction: TX, network: MONAD_NETWORK, payer: PAYER });
    expect(svc.requests).toHaveLength(2);
    const signed = svc.requests[1];
    expect(JSON.parse(signed.body)).toEqual({ prompt: "a cat" });
    expect(signed.payment.payload.authorization).toMatchObject({ from: PAYER, to: PAY_TO, value: "200000" });
    expect(signed.payment.resource.url).toBe(svc.url);
  });

  it("labels a JSON string body as JSON and sends the probe and the paid retry identically", async () => {
    const svc = await service({ requirePrompt: true });
    const body = JSON.stringify({ prompt: "a cat", aspect_ratio: "16:9" });
    const result = await payerFor(svc).fetch({ url: svc.url, method: "POST", body, maxAmountUsd: 0.2, rail: "x402-monad" });
    expect(result).toMatchObject({ ok: true, authMode: "paid" });
    const [probe, paid] = svc.requests;
    expect(probe.headers["content-type"]).toBe("application/json");
    expect({ method: paid.method, type: paid.headers["content-type"], body: paid.body }).toEqual({ method: probe.method, type: probe.headers["content-type"], body: probe.body });
    expect(paid.body).toBe(body);
  });

  it("leaves non-JSON strings and caller content types alone", async () => {
    const plain = await service({ accepts: [BASE_OFFER] });
    await payerFor(plain).fetch({ url: plain.url, method: "POST", body: "just text", maxAmountUsd: 1, rail: "x402-monad" });
    await payerFor(plain).fetch({ url: plain.url, method: "POST", body: "{\"a\":1}", headers: { "Content-Type": "text/plain" }, maxAmountUsd: 1, rail: "x402-monad" });
    // fetch's own default for a bare string, never JSON.
    expect(plain.requests.map((request) => request.headers["content-type"])).toEqual(["text/plain;charset=UTF-8", "text/plain"]);
  });

  it("records a failed paid retry as not charged when the signed nonce is unused on-chain", async () => {
    const svc = await service({ requirePrompt: true });
    const result = await payerFor(svc).fetch({ url: svc.url, method: "POST", body: { aspect_ratio: "16:9" }, maxAmountUsd: 0.2, rail: "x402-monad" });
    expect(result).toMatchObject({ ok: false, ambiguous: false, status: 400, data: { error: "\"prompt\" is required" } });
    expect(result.payment).toBeUndefined();
    expect(result.error).toMatch(/HTTP 400; not charged: authorization nonce 0x[0-9a-f]{64} is unused on eip155:143/);
    expect(result.error).toMatch(/stays valid until \d{4}-\d\d-\d\dT/);
  });

  it("keeps the payment state unknown when the nonce was used or the chain is unreadable", async () => {
    const consumed = await service({ settle: "settle-then-fail" });
    const used = await payerFor(consumed).fetch({ url: consumed.url, method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(used).toMatchObject({ ok: false, ambiguous: true, ambiguityReason: "missing_receipt", status: 500 });
    expect(used.error).toMatch(/was used on-chain/);
    const dark = await service({ requirePrompt: true, rpcDown: true });
    const unreadable = await payerFor(dark).fetch({ url: dark.url, method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(unreadable).toMatchObject({ ok: false, ambiguous: true, ambiguityReason: "missing_receipt", status: 400 });
    expect(unreadable.error).toMatch(/could not be read/);
  });

  it("never signs a quote above the approved ceiling", async () => {
    const svc = await service();
    const result = await payerFor(svc).fetch({ url: svc.url, method: "POST", body: {}, maxAmountUsd: 0.19, rail: "x402-monad" });
    expect(result).toMatchObject({ ok: false, ambiguous: false });
    expect(result.error).toMatch(/exceeds the approved ceiling/);
    expect(svc.requests).toHaveLength(1);
  });

  it("refuses services that do not offer Monad USDC", async () => {
    const svc = await service({ accepts: [BASE_OFFER, { ...MONAD_OFFER, asset: BASE_USDC }] });
    const result = await payerFor(svc).fetch({ url: svc.url, method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(result).toMatchObject({ ok: false, ambiguous: false });
    expect(svc.requests).toHaveLength(1);
  });

  it("treats a facilitator rejection as unpaid", async () => {
    const svc = await service({ settle: "reject" });
    const result = await payerFor(svc).fetch({ url: svc.url, method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(result).toMatchObject({ ok: false, ambiguous: false, status: 402 });
    expect(result.payment).toBeUndefined();
    expect(result.error).toMatch(/insufficient_funds/);
  });

  it("marks a signed call without a receipt, or with a foreign-network receipt, as ambiguous", async () => {
    const noReceipt = await service({ settle: "no-receipt" });
    const missing = await payerFor(noReceipt).fetch({ url: noReceipt.url, method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(missing).toMatchObject({ ok: false, ambiguous: true, ambiguityReason: "missing_receipt" });
    const wrongNetwork = await service({ settle: "wrong-network" });
    const foreign = await payerFor(wrongNetwork).fetch({ url: wrongNetwork.url, method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(foreign).toMatchObject({ ok: false, ambiguous: true, ambiguityReason: "unsupported_receipt" });
  });

  it("marks a transport failure after signing as ambiguous, and before signing as not paid", async () => {
    const challenge = { x402Version: 2, accepts: [MONAD_OFFER] };
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify(challenge), { status: 402, headers: { "content-type": "application/json" } });
      throw new TypeError("socket hang up");
    }) as typeof fetch;
    const after = await new MonadX402Payer({ privateKey: PRIVATE_KEY, fetchImpl }).fetch({ url: "https://svc.example/x", method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(after).toMatchObject({ ok: false, ambiguous: true, ambiguityReason: "transport" });
    const before = await new MonadX402Payer({ privateKey: PRIVATE_KEY, fetchImpl: (async () => { throw new TypeError("ECONNREFUSED"); }) as typeof fetch })
      .fetch({ url: "https://svc.example/x", method: "POST", body: {}, maxAmountUsd: 1, rail: "x402-monad" });
    expect(before).toMatchObject({ ok: false, ambiguous: false });
  });
});

describe("Monad preference in discovery", () => {
  const advisory = (paymentOptions: unknown[]) => check.mockImplementation(async () => ({
    found: true, advisories: [{ method: "POST", authMode: "paid", paymentOptions }]
  }));
  const offers = [BASE_OFFER, MONAD_OFFER].map((offer) => ({ protocol: "x402", version: 2, ...offer }));

  it("chooses Monad only when preferred and offered, otherwise Base as before", async () => {
    advisory(offers);
    const search = vi.fn();
    expect((await new BaseServiceDiscovery(search).inspect({ url: "https://a.example/1" })).data).toMatchObject({ rail: "x402-base", network: "eip155:8453", price_usd: 0.2 });
    expect((await new BaseServiceDiscovery(search, { paymentNetwork: "monad" }).inspect({ url: "https://a.example/2" })).data).toMatchObject({ rail: "x402-monad", network: MONAD_NETWORK, price_usd: 0.2, payable: true });
    advisory([offers[0]]);
    expect((await new BaseServiceDiscovery(search, { paymentNetwork: "monad" }).inspect({ url: "https://a.example/3" })).data).toMatchObject({ rail: "x402-base" });
    advisory([offers[1]]);
    expect((await new BaseServiceDiscovery(search).inspect({ url: "https://a.example/4" })).data).toMatchObject({ rail: "unsupported", payable: false });
  });

  it("reads the preference from OPENCROWD_PAYMENT_NETWORK over config", () => {
    expect(resolvePaymentNetwork({ paymentNetwork: "base" })).toBe("base");
    process.env.OPENCROWD_PAYMENT_NETWORK = "monad";
    expect(resolvePaymentNetwork({ paymentNetwork: "base" })).toBe("monad");
    process.env.OPENCROWD_PAYMENT_NETWORK = "polygon";
    expect(() => resolvePaymentNetwork()).toThrow(/base, solana, monad/);
    expect(parsePaymentNetwork("eip155:143")).toBe("monad");
  });
});

describe("Monad purchase lifecycle through the gateway", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opencrowd-monad-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    check.mockImplementation(async () => ({
      found: true,
      advisories: [{ method: "POST", authMode: "paid", paymentOptions: [BASE_OFFER, POLYGON_OFFER, MONAD_OFFER].map((offer) => ({ protocol: "x402", version: 2, ...offer })) }]
    }));
  });

  function vendor(): McpConnection {
    return new McpConnection("agentcash", { command: "unused", args: [] }, {
      transportFactory: () => {
        const server = new McpServer({ name: "agentcash", version: "0.0.0" });
        server.tool("get_balance", "Balance", {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ total_usd: 3, networks: { base: { usdc: 3 } } }) }] }));
        server.tool("fetch", "Fetch", {}, async () => { throw new Error("AgentCash must not be used for Monad payments"); });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        void server.connect(serverTransport);
        return clientTransport;
      }
    });
  }

  async function gatewayFor(options: { approvalMode?: "ask" | "auto"; answer?: ApprovalAnswer["decision"]; crowdcode?: MockCrowdCodeAdapter; svc?: { rpcUrl: string } } = {}) {
    const session = await createSession({ workspaceRoot: root, budgetCents: 100 });
    const connection = vendor();
    cleanups.push(() => connection.close());
    const agentcash = new McpAgentCashAdapter(connection, { paymentNetwork: "monad", monad: payerFor(options.svc ?? { rpcUrl: "http://127.0.0.1:9/rpc" }) });
    const crowdcode = options.crowdcode ?? new MockCrowdCodeAdapter();
    const gateway = new EconomyGateway({
      session, agentcash, crowdcode,
      approvalMode: options.approvalMode ?? "auto",
      approvalHandler: options.answer ? async () => ({ decision: options.answer! }) : undefined,
      approvalRulesPath: join(root, "approvals.json")
    });
    return { session, gateway, crowdcode };
  }

  it("pays on Monad, records the receipt and budget, and reviews with x402:monad evidence", async () => {
    const svc = await service();
    const { session, gateway, crowdcode } = await gatewayFor({ svc });
    const inspected = await gateway.execute("inspect_paid_service", { url: svc.url, method: "POST" });
    expect(inspected).toMatchObject({ ok: true, data: { rail: "x402-monad", price_ceiling_cents: 20 } });

    const result = await gateway.execute("call_paid_service", { url: svc.url, method: "POST", body: { prompt: "a cat" } });
    expect(result).toMatchObject({ ok: true, data: { outcome: "paid_success", charged_cost_cents: 20, review_required: true } });
    // Settlement evidence never reaches the model.
    expect(JSON.stringify(result)).not.toContain(TX.slice(2));
    expect(crowdcode.scoreQueries.some((query) => query.apiEndpoint === svc.url)).toBe(true);

    const [purchase] = await listPurchases(session);
    expect(purchase.record).toMatchObject({ rail: "x402-monad", outcome: "paid_success", charged_cost_cents: 20 });
    expect(purchase.record.evidence).toMatchObject({ reference: `x402:monad:${TX}`, payTo: PAY_TO });

    // A pending required review blocks the next purchase until it is submitted.
    expect((await gateway.execute("call_paid_service", { url: svc.url, method: "POST", body: {} })).error).toMatch(/requires its CrowdCode review/);

    const review = await gateway.execute("review_paid_service", { purchase_id: (result.data as any).purchase_id, rating: 5, reason: "clip delivered" });
    expect(review.ok).toBe(true);
    expect(crowdcode.reviews[0]).toMatchObject({ paymentReference: `x402:monad:${TX}`, paymentProvider: "x402", paymentTargetRef: PAY_TO, apiEndpoint: svc.url });
    expect(JSON.parse(crowdcode.reviews[0].paymentProof!)).toMatchObject({ transaction: TX, network: MONAD_NETWORK, success: true });
  });

  it("records a rejected paid retry as failed and uncharged, so a corrected call can proceed", async () => {
    const svc = await service({ requirePrompt: true });
    const { session, gateway } = await gatewayFor({ svc });
    await gateway.execute("inspect_paid_service", { url: svc.url, method: "POST" });

    const failed = await gateway.execute("call_paid_service", { url: svc.url, method: "POST", body: { aspect_ratio: "16:9" } });
    expect(failed.ok).toBe(false);
    expect(failed.data).toMatchObject({ outcome: "free", charged_cost_cents: 0, review_required: false, data: { error: "\"prompt\" is required" } });
    expect(session.spentCents).toBe(0);
    const [rejected] = await listPurchases(session);
    expect(rejected.record).toMatchObject({ outcome: "free", charged_cost_cents: 0, review_required: false });
    expect(rejected.record.notes).toMatch(/not charged.*stays valid until/);

    const fixed = await gateway.execute("call_paid_service", { url: svc.url, method: "POST", body: JSON.stringify({ prompt: "a cat", aspect_ratio: "16:9" }) });
    expect(fixed).toMatchObject({ ok: true, data: { outcome: "paid_success", charged_cost_cents: 20 } });
    expect(session.spentCents).toBe(20);
  });

  it("does not sign or contact the service when approval is denied or the reputation floor fails", async () => {
    const svc = await service();
    const denied = await gatewayFor({ approvalMode: "ask", answer: "deny_once" });
    await denied.gateway.execute("inspect_paid_service", { url: svc.url, method: "POST" });
    expect((await denied.gateway.execute("call_paid_service", { url: svc.url, method: "POST", body: {} })).ok).toBe(false);

    const lowScore = await gatewayFor({ crowdcode: new MockCrowdCodeAdapter({ evidence: { ok: true, score: 1, unproven: false } }) });
    await lowScore.gateway.execute("inspect_paid_service", { url: svc.url, method: "POST" });
    expect((await lowScore.gateway.execute("call_paid_service", { url: svc.url, method: "POST", body: {} })).error).toMatch(/below the 2 floor/);
    expect(svc.requests).toHaveLength(0);
    expect(await listPurchases(denied.session)).toHaveLength(0);
  });

  it("refuses a call over the per-call ceiling before signing", async () => {
    const svc = await service();
    const { gateway } = await gatewayFor();
    await gateway.execute("inspect_paid_service", { url: svc.url, method: "POST" });
    // The live 402 demands 20c, more than the 15c this call was approved and reserved for.
    const result = await gateway.execute("call_paid_service", { url: svc.url, method: "POST", body: {}, max_cost_cents: 15 });
    expect(result.ok).toBe(false);
    expect(svc.requests.filter((request) => request.payment)).toHaveLength(0);
  });

  it("reports Monad USDC for the AgentCash address alongside AgentCash balances", async () => {
    const walletPath = join(root, "wallet.json");
    await writeFile(walletPath, JSON.stringify({ address: PAYER, privateKey: PRIVATE_KEY }));
    process.env.AGENTCASH_WALLET_PATH = walletPath;
    const connection = vendor();
    cleanups.push(() => connection.close());
    const lookups: string[] = [];
    const adapter = new McpAgentCashAdapter(connection, { paymentNetwork: "monad", monadBalance: async (address) => { lookups.push(address); return 1.5; } });
    const balance = await adapter.getBalance();
    expect(balance).toMatchObject({ ok: true, data: { total_usd: 3, monad: { network: MONAD_NETWORK, address: PAYER, usdc: 1.5, preferred: true } } });
    expect(lookups).toEqual([PAYER]);
  });
});

describe("monadUsdcBalance", () => {
  it("reads balanceOf from the Monad RPC in 6-decimal USDC", async () => {
    let request: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${(2_500_000).toString(16).padStart(64, "0")}` }));
    }) as typeof fetch;
    expect(await monadUsdcBalance(PAYER, { fetchImpl, rpcUrl: "https://rpc.example" })).toBe(2.5);
    expect(request.params[0]).toEqual({ to: MONAD_USDC, data: `0x70a08231${PAYER.slice(2).toLowerCase().padStart(64, "0")}` });
  });
});
