import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createSession, type SessionState } from "@opencrowd/core";
import {
  appendPurchase,
  EconomyGateway,
  GATEWAY_TOOL_NAMES,
  listPurchases,
  McpAgentCashAdapter,
  McpConnection,
  MockAgentCashAdapter,
  MockCrowdCodeAdapter,
  pendingRequiredReviews,
  redactPurchase,
  summarizeEvidence,
  type ApprovalAnswer,
  type ApprovalRequest,
  type PaidFetchResult
} from "../src/index.js";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencrowd-economy-test-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ENDPOINT = "https://svc.example/api/lookup";

interface GatewaySetupOptions {
  budgetCents?: number;
  approvalMode?: "ask" | "auto" | "off";
  approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
  agentcash?: MockAgentCashAdapter;
  crowdcode?: MockCrowdCodeAdapter;
}

async function setup(options: GatewaySetupOptions = {}): Promise<{
  session: SessionState;
  gateway: EconomyGateway;
  agentcash: MockAgentCashAdapter;
  crowdcode: MockCrowdCodeAdapter;
  rulesPath: string;
}> {
  const root = await tempRoot();
  const session = await createSession({ workspaceRoot: root, budgetCents: options.budgetCents ?? 100 });
  const agentcash = options.agentcash ?? new MockAgentCashAdapter();
  const crowdcode = options.crowdcode ?? new MockCrowdCodeAdapter();
  const rulesPath = join(root, "approvals.json");
  const gateway = new EconomyGateway({
    session,
    agentcash,
    crowdcode,
    approvalMode: options.approvalMode ?? "auto",
    approvalHandler: options.approvalHandler,
    approvalRulesPath: rulesPath
  });
  return { session, gateway, agentcash, crowdcode, rulesPath };
}

async function inspect(gateway: EconomyGateway, url = ENDPOINT): Promise<void> {
  const result = await gateway.execute("inspect_paid_service", { url, method: "POST" });
  expect(result.ok).toBe(true);
}

describe("gateway surface", () => {
  it("exposes exactly the six stable tools with no proof/identity inputs", async () => {
    const { gateway } = await setup();
    const definitions = gateway.definitions();
    expect(definitions.map((tool) => tool.name)).toEqual([...GATEWAY_TOOL_NAMES]);
    const schemaText = JSON.stringify(definitions.map(tool => tool.parameters));
    expect(schemaText).not.toMatch(/payment_proof|tx_hash|signature|private/i);
  });
});

describe("purchase lifecycle", () => {
  it("runs CrowdCode pre-check before payment and records a paid receipt with adapter evidence", async () => {
    const { session, gateway, agentcash, crowdcode } = await setup();
    await inspect(gateway);
    const before = crowdcode.scoreQueries.length;

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, method: "POST", body: { q: "x" }, max_cost_cents: 10 });

    expect(result.ok).toBe(true);
    // The reputation check re-ran at call time, before the fetch.
    expect(crowdcode.scoreQueries.length).toBe(before + 1);
    expect(agentcash.fetchCalls).toHaveLength(1);
    const data = result.data as Record<string, unknown>;
    expect(data.outcome).toBe("paid_success");
    expect(data.review_required).toBe(true);
    // Receipt evidence comes from the adapter, never the model.
    const purchases = await listPurchases(session);
    expect(purchases[0].record.evidence?.reference).toMatch(/^0xmock/);
    expect(session.spentCents).toBeGreaterThan(0);
  });

  it("honours an inspection made before a pause when the run resumes on a fresh gateway", async () => {
    const { session, gateway, agentcash, crowdcode } = await setup();
    await inspect(gateway);

    // A funds pause or worker restart rebuilds the gateway for the same session.
    const resumed = new EconomyGateway({ session, agentcash, crowdcode, approvalMode: "auto" });
    const result = await resumed.execute("call_paid_service", { url: ENDPOINT, method: "POST", body: { q: "x" }, max_cost_cents: 10 });

    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).outcome).toBe("paid_success");
  });

  it("still requires an inspection when none was stored for the session", async () => {
    const { gateway } = await setup();
    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, method: "POST", max_cost_cents: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("inspect_paid_service must run");
  });

  it("records claimed payment without a settlement receipt as unknown, never paid_success", async () => {
    const agentcash = new MockAgentCashAdapter({
      defaultFetchResult: {
        ok: true,
        ambiguous: true,
        ambiguityReason: "missing_receipt",
        status: 200,
        data: { transcript: "done" },
        error: "the service indicated payment but supplied no verifiable settlement receipt"
      }
    });
    const { session, gateway } = await setup({ agentcash });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("without a verifiable settlement receipt");
    expect(result.error).toContain("NOT retried");
    const purchases = await listPurchases(session);
    expect(purchases[0].record).toMatchObject({ outcome: "unknown", review_required: false });
    expect(purchases[0].record.artifact_path).toBeTruthy();
  });

  it("prevents payment when CrowdCode is unavailable", async () => {
    const { gateway, agentcash } = await setup({ crowdcode: new MockCrowdCodeAdapter({ outage: true }) });
    // Inspection succeeds even with a reputation outage (evidence marked unavailable)...
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    // ...but payment is blocked.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("CrowdCode reputation check is unavailable");
    expect(agentcash.fetchCalls).toHaveLength(0);
  });

  it("represents unproven evidence accurately and does not auto-reject it", async () => {
    const { gateway, agentcash } = await setup({
      crowdcode: new MockCrowdCodeAdapter({ evidence: { ok: true, score: 1.2, nEff: 0.4, unproven: true } })
    });
    const inspection = await gateway.execute("inspect_paid_service", { url: ENDPOINT });
    const reputation = (inspection.data as { reputation: Record<string, unknown> }).reputation;
    expect(reputation).toMatchObject({ unproven: true, score: 1.2 });

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(result.ok).toBe(true);
    expect(agentcash.fetchCalls).toHaveLength(1);
  });

  it("rejects proven low-score services", async () => {
    const { gateway, agentcash } = await setup({
      crowdcode: new MockCrowdCodeAdapter({ evidence: { ok: true, score: 1.2, nEff: 30, unproven: false } })
    });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("below the 2 floor");
    expect(agentcash.fetchCalls).toHaveLength(0);
  });

  it("requires inspection before calling", async () => {
    const { gateway } = await setup();
    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("inspect_paid_service must run");
  });

  it("reserves budget before payment and refuses over-budget calls", async () => {
    const { gateway, agentcash } = await setup({ budgetCents: 5 });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("budget exceeded");
    expect(agentcash.fetchCalls).toHaveLength(0);
  });
});

describe("outcome reconciliation", () => {
  function scriptedFetch(result: Partial<PaidFetchResult>): MockAgentCashAdapter {
    return new MockAgentCashAdapter({
      defaultFetchResult: {
        ok: true,
        ambiguous: false,
        status: 200,
        data: { ok: true },
        authMode: "free",
        ...result
      }
    });
  }

  it("creates no paid receipt or review for free results and releases the reservation", async () => {
    const { session, gateway } = await setup({ agentcash: scriptedFetch({ authMode: "free", payment: undefined }) });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).outcome).toBe("free");
    expect((result.data as Record<string, unknown>).review_required).toBe(false);
    expect(session.spentCents).toBe(0);
    expect(session.reservedCents).toBe(0);
    await expect(pendingRequiredReviews(session)).resolves.toHaveLength(0);
  });

  it("creates no paid receipt for SIWX-authenticated results", async () => {
    const { session, gateway } = await setup({ agentcash: scriptedFetch({ authMode: "siwx", payment: undefined }) });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    expect((result.data as Record<string, unknown>).outcome).toBe("siwx");
    expect(session.spentCents).toBe(0);
    await expect(pendingRequiredReviews(session)).resolves.toHaveLength(0);
  });

  it("records paid failures as reviewable receipts", async () => {
    const { session, gateway } = await setup({
      agentcash: scriptedFetch({
        ok: false,
        status: 500,
        error: "HTTP 500",
        authMode: "paid",
        payment: { paidUsd: 0.05, rail: "x402-base", reference: "0xfail", proof: "cHJvb2Y=" }
      })
    });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    expect(result.ok).toBe(false);
    const purchases = await listPurchases(session);
    expect(purchases[0].record.outcome).toBe("paid_failure");
    expect(purchases[0].reviewStatus).toBe("pending");
    expect(session.spentCents).toBe(5);
  });

  it("records ambiguous transport failures as unknown, finalizes conservatively, and never auto-retries", async () => {
    let calls = 0;
    const agentcash = new MockAgentCashAdapter({
      fetchResults: {
        [ENDPOINT]: () => {
          calls += 1;
          return { ok: false, ambiguous: true, data: undefined, error: "socket closed mid-flight" };
        }
      }
    });
    const { session, gateway } = await setup({ agentcash });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("payment state is unknown");
    expect(result.error).toContain("NOT retried");
    expect(calls).toBe(1);
    const purchases = await listPurchases(session);
    expect(purchases[0].record.outcome).toBe("unknown");
    // Conservative: the quoted ceiling is treated as spent until resolved.
    expect(session.spentCents).toBe(10);
  });

  it("rejects endpoints on unsupported automatic payment rails", async () => {
    const agentcash = new MockAgentCashAdapter({
      schemas: { [ENDPOINT]: { url: ENDPOINT, auth: "paid", network: "solana only", price: 0.05 } }
    });
    const { gateway } = await setup({ agentcash });
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not support for automatic payment");
    expect(agentcash.fetchCalls).toHaveLength(0);
  });
});

describe("approval policy", () => {
  it("prohibits purchases in off mode while leaving inspection available", async () => {
    const { gateway, agentcash } = await setup({ approvalMode: "off" });
    await inspect(gateway);
    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disabled");
    expect(agentcash.fetchCalls).toHaveLength(0);
  });

  it("denies un-ruled services in ask mode without a handler", async () => {
    const { gateway, agentcash } = await setup({ approvalMode: "ask" });
    await inspect(gateway);
    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("approval required");
    expect(agentcash.fetchCalls).toHaveLength(0);
  });

  it("supports allow-once, always-allow with caps, deny-once, and block decisions", async () => {
    const answers: ApprovalAnswer[] = [
      { decision: "deny_once" },
      { decision: "allow_once" },
      { decision: "always_allow", caps: { maxCostCents: 8 } },
      { decision: "block" }
    ];
    const seen: ApprovalRequest[] = [];
    const { gateway, agentcash } = await setup({
      approvalMode: "ask",
      approvalHandler: async (request) => {
        seen.push(request);
        return answers.shift() ?? { decision: "deny_once" };
      }
    });
    await inspect(gateway);

    const denied = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("denied");
    expect(agentcash.fetchCalls).toHaveLength(0);

    const once = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(once.ok).toBe(true);
    await gateway.execute("review_paid_service", {
      purchase_id: ((once.data as Record<string, unknown>).purchase_id as string),
      rating: 5,
      reason: "mock worked"
    });

    // always_allow stores a rule; the next call needs no prompt but caps bind.
    const always = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(always.ok).toBe(false);
    expect(always.error).toContain("per-call cap");

    const withinCap = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 8 });
    expect(withinCap.ok).toBe(true);
    expect(seen).toHaveLength(3); // deny, allow-once, always-allow — no prompt for the ruled calls
  });

  it("enforces stored per-call and session caps in auto mode too", async () => {
    const { gateway, rulesPath } = await setup({ approvalMode: "auto" });
    const { upsertApprovalRule } = await import("../src/approvals.js");
    await upsertApprovalRule("https://svc.example", "allow", { maxCostCents: 6, sessionMaxCents: 9 }, rulesPath);
    await inspect(gateway);

    const overPerCall = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 7 });
    expect(overPerCall.ok).toBe(false);
    expect(overPerCall.error).toContain("per-call cap");

    const first = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 6 });
    expect(first.ok).toBe(true);
    await gateway.execute("review_paid_service", {
      purchase_id: ((first.data as Record<string, unknown>).purchase_id as string),
      rating: 5,
      reason: "mock worked"
    });

    const overSession = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 6 });
    expect(overSession.ok).toBe(false);
    expect(overSession.error).toContain("session cap");
  });

  it("enforces stored blocks in auto mode", async () => {
    const { gateway, rulesPath, agentcash } = await setup({ approvalMode: "auto" });
    const { upsertApprovalRule } = await import("../src/approvals.js");
    await upsertApprovalRule("https://svc.example", "block", {}, rulesPath);
    await inspect(gateway);

    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 5 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("blocked");
    expect(agentcash.fetchCalls).toHaveLength(0);
  });
});

describe("required reviews", () => {
  it("reviews an unpaid failure with a stable identifier across retries", async () => {
    const crowdcode = new MockCrowdCodeAdapter();
    const agentcash = new MockAgentCashAdapter({ defaultFetchResult: {
      ok: false, ambiguous: false, status: 402, authMode: "free", error: "invalid payment requirements"
    } });
    const { session, gateway } = await setup({ crowdcode, agentcash });
    await inspect(gateway);
    const call = await gateway.execute("call_paid_service", { url: ENDPOINT });
    const purchaseId = (call.data as Record<string, unknown>).purchase_id;
    expect(call.ok).toBe(false);
    expect(call.data).toMatchObject({ review_available: true, review_required: false });
    const submit = crowdcode.reviewService.bind(crowdcode);
    let attempts = 0;
    const nonces: (string | undefined)[] = [];
    crowdcode.reviewService = async review => {
      nonces.push(review.reviewNonce);
      return attempts++ === 0 ? { ok: false, error: "temporary outage" } : submit(review);
    };
    const args = { purchase_id: purchaseId, rating: 3, reason: "Client rejected the handshake; cause uncertain" };
    expect((await gateway.execute("review_paid_service", args)).ok).toBe(false);
    expect((await gateway.execute("review_paid_service", args)).ok).toBe(true);
    expect(nonces).toEqual([purchaseId, purchaseId]);
    expect(crowdcode.reviews[0]).toMatchObject({ paymentReference: undefined, paymentProof: undefined });
    expect((await listPurchases(session))[0].reviewStatus).toBe("submitted");
    expect((await gateway.execute("review_paid_service", args)).ok).toBe(false);
    expect(agentcash.fetchCalls).toHaveLength(1);
  });

  it("includes fresh unpaid reports and failure summaries in product evidence", () => {
    const summary = summarizeEvidence({ summary: { strengths: ["Fast"], failure_modes: ["Sometimes returns 500"] },
      recent_reviews: [{ rating: 2, reason: "Request failed before payment", payment_verified: false }] });
    expect(summary).toContain("Sometimes returns 500");
    expect(summary).toContain("payment not verified");
    expect(summary).toContain("Request failed before payment");
  });
  it("reviews legacy outcomes without inventing a payment reference", async () => {
    const { session, gateway, crowdcode } = await setup();
    await appendPurchase(session, {
      purchase_id: "pur_legacy",
      session_id: session.sessionId,
      created_at: new Date().toISOString(),
      endpoint: ENDPOINT,
      method: "POST",
      rail: "x402-base",
      quoted_cost_cents: 10,
      charged_cost_cents: 10,
      outcome: "paid_success",
      review_required: false,
      evidence: { paidUsd: 0.1, rail: "x402-base" }
    });

    const review = await gateway.execute("review_paid_service", {
      purchase_id: "pur_legacy",
      rating: 5,
      reason: "completed"
    });

    expect(review.ok).toBe(true);
    expect(crowdcode.reviews[0]).toMatchObject({ reviewNonce: "pur_legacy", paymentReference: undefined });
  });

  it("blocks a second purchase until the pending review is submitted, using stored evidence", async () => {
    const { session, gateway, crowdcode } = await setup();
    await inspect(gateway);

    const first = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    const purchaseId = (first.data as Record<string, unknown>).purchase_id as string;

    const secondBlocked = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(secondBlocked.ok).toBe(false);
    expect(secondBlocked.error).toContain("requires its CrowdCode review");

    const review = await gateway.execute("review_paid_service", { purchase_id: purchaseId, rating: 4, reason: "good but slow" });
    expect(review.ok).toBe(true);
    // The adapter received evidence from the stored receipt, not model input.
    expect(crowdcode.reviews[0]).toMatchObject({
      rating: 4,
      paymentReference: "0xmock1",
      paymentProof: "bW9jay1wcm9vZg==",
      paymentProvider: "x402"
    });

    const secondAllowed = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(secondAllowed.ok).toBe(true);
    expect(session.spentCents).toBeGreaterThan(0);
  });

  it("keeps reviews pending across restarts (new gateway over the same session)", async () => {
    const { session, gateway, agentcash, crowdcode } = await setup();
    await inspect(gateway);
    await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    const restarted = new EconomyGateway({
      session,
      agentcash,
      crowdcode,
      approvalMode: "auto",
      approvalRulesPath: join(session.workspaceRoot, "approvals.json")
    });
    await expect(restarted.hasPendingRequiredReviews()).resolves.toBe(true);
    await inspect(restarted);
    const blocked = await restarted.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("review");
  });

  it("keeps the review pending when CrowdCode rejects the submission", async () => {
    const { gateway } = await setup({ crowdcode: new MockCrowdCodeAdapter({ failReviews: true }) });
    await inspect(gateway);
    const first = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    const purchaseId = (first.data as Record<string, unknown>).purchase_id as string;

    const review = await gateway.execute("review_paid_service", { purchase_id: purchaseId, rating: 5, reason: "ok" });
    expect(review.ok).toBe(false);
    expect(review.error).toContain("stays pending");
    await expect(gateway.hasPendingRequiredReviews()).resolves.toBe(true);
  });
});

describe("secrecy", () => {
  it("keeps payment proof, payer identity, and tx hashes out of model-visible results", async () => {
    const { session, gateway } = await setup();
    await inspect(gateway);
    const result = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });

    const visible = JSON.stringify(result);
    expect(visible).not.toContain("0xmock1");
    expect(visible).not.toContain("bW9jay1wcm9vZg==");
    expect(visible).not.toContain("0xmockpayee");

    const purchases = await listPurchases(session);
    const redacted = JSON.stringify(redactPurchase(purchases[0]));
    expect(redacted).not.toContain("0xmock1");
    expect(redacted).not.toContain("bW9jay1wcm9vZg==");
    // The full receipt retains evidence for the review path.
    expect(purchases[0].record.evidence?.proof).toBe("bW9jay1wcm9vZg==");

    // The session ledger row carries no payment proof either.
    const ledger = await readFile(session.ledgerPath, "utf8");
    expect(ledger).not.toContain("0xmock1");
    expect(ledger).not.toContain("bW9jay1wcm9vZg==");
  });
});

describe("x402 settlement through the real MCP adapter (field note 001)", () => {
  // The 402 challenge settles on-chain but the final HTTP response is a
  // plain 200 whose receipt arrives in a second MCP content block. The
  // purchase must be recorded as paid at the actual amount with the
  // settlement evidence retained and its review required.
  const TX = "0x3cab25e6f1349f8ae7b5c7f48d79e40bef53e9377fecc395bc176520b866f6c1";
  const RECEIPT = Buffer.from(
    JSON.stringify({ success: true, payer: "0xF5a65ae916474Da7fB", transaction: TX, network: "base" })
  ).toString("base64");

  function settledVendor(): McpServer {
    const server = new McpServer({ name: "agentcash", version: "0.0.0" });
    server.tool("check_endpoint_schema", "Schema", { url: z.string() }, async ({ url }) => ({
      content: [{ type: "text", text: JSON.stringify({ url, authMode: "paid", price: "0.002000 USD", protocols: ["x402", "mpp"] }) }]
    }));
    server.tool("fetch", "Fetch", { url: z.string() }, async () => ({
      content: [
        { type: "text", text: JSON.stringify({ requestId: "req-1", results: [] }) },
        {
          type: "text",
          text: JSON.stringify({
            protocol: "x402",
            network: "base",
            price: "$0.002",
            payment: { success: true, transactionHash: TX },
            headers: { "content-type": "application/json", "payment-response": RECEIPT }
          }, null, 2)
        }
      ]
    }));
    return server;
  }

  it("records a paid purchase with receipt evidence and submits the required review", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 100 });
    const mcp = new McpConnection("agentcash", { command: "unused", args: [] }, {
      transportFactory: () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        void settledVendor().connect(serverTransport);
        return clientTransport;
      }
    });
    const crowdcode = new MockCrowdCodeAdapter();
    const gateway = new EconomyGateway({
      session,
      agentcash: new McpAgentCashAdapter(mcp),
      crowdcode,
      approvalMode: "auto",
      approvalRulesPath: join(root, "approvals.json")
    });
    const endpoint = "https://stableenrich.dev/api/exa/contents";
    await inspect(gateway, endpoint);

    const result = await gateway.execute("call_paid_service", { url: endpoint, method: "POST", body: { urls: ["https://example.com"] } });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.outcome).toBe("paid_success");
    expect(data.charged_cost_cents).toBe(1);
    expect(data.review_required).toBe(true);
    // No settlement details leak into the model-visible result.
    expect(JSON.stringify(result)).not.toContain(TX.slice(2));
    expect(JSON.stringify(result)).not.toContain(RECEIPT);

    const purchases = await listPurchases(session);
    expect(purchases[0].record.outcome).toBe("paid_success");
    expect(purchases[0].record.evidence).toMatchObject({ reference: TX, proof: RECEIPT, rail: "x402-base" });

    const review = await gateway.execute("review_paid_service", {
      purchase_id: data.purchase_id,
      rating: 5,
      reason: "fast and relevant"
    });
    expect(review.ok).toBe(true);
    expect(crowdcode.reviews[0]).toMatchObject({
      paymentReference: TX,
      paymentProof: RECEIPT,
      paymentProvider: "x402",
      apiEndpoint: endpoint
    });
    await mcp.close();
  });
});

describe("durable review deferral", () => {
  it("retains receipts but does not let repeated registry rejections block a restarted gateway", async () => {
    const { session, gateway, agentcash, crowdcode } = await setup({ crowdcode: new MockCrowdCodeAdapter({ failReviews: true }) });
    await inspect(gateway);
    const paid = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    const purchaseId = (paid.data as any).purchase_id;
    for (let i=0; i<2; i++) await gateway.execute("review_paid_service", { purchase_id: purchaseId, rating: 5, reason: "Useful result" });
    const restarted = new EconomyGateway({ session, agentcash, crowdcode, approvalMode: "auto", approvalRulesPath: join(session.workspaceRoot, "approvals.json") });
    expect(await restarted.hasPendingRequiredReviews()).toBe(false);
    expect((await listPurchases(session))[0]).toMatchObject({ reviewStatus: "pending", reviewAttempts: 2, record: { evidence: { reference: "0xmock1" } } });
    await inspect(restarted);
    expect((await restarted.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 })).ok).toBe(true);
  });
  it("keeps a previous query's reviews available without blocking a new query, including legacy receipts", async () => {
    const { session, gateway } = await setup();
    await inspect(gateway);
    await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    const { beginQuery } = await import("@opencrowd/core");
    await beginQuery(session, "new-query");
    expect(await gateway.hasPendingRequiredReviews()).toBe(false);
    expect((await listPurchases(session))[0].reviewStatus).toBe("pending");
    await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 10 });
    expect(await gateway.hasPendingRequiredReviews()).toBe(true);
    expect((await listPurchases(session))[1].record.query_id).toBe("new-query");
    await beginQuery(session, "next-query");
    expect(await gateway.hasPendingRequiredReviews()).toBe(false);
  });
});

it("disabling CrowdCode drops pending review gates without changing spending policy", async () => {
  const { session, agentcash, crowdcode } = await setup();
  const gateway = new EconomyGateway({ session, agentcash, crowdcode, hostedSpending: true, approvalMode: "auto" });
  await inspect(gateway);
  const paid = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 5 });
  expect(paid.ok).toBe(true);
  expect(await gateway.hasPendingRequiredReviews()).toBe(true);
  await gateway.execute("set_crowdcode_enabled", { enabled: false });
  expect(await gateway.hasPendingRequiredReviews()).toBe(false);
  const before = crowdcode.scoreQueries.length;
  await inspect(gateway);
  const off = await gateway.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 5 });
  expect(off).toMatchObject({ ok: true, data: { review_required: false } });
  expect(crowdcode.scoreQueries).toHaveLength(before);
  await gateway.execute("set_crowdcode_enabled", { enabled: true });
  expect(await gateway.hasPendingRequiredReviews()).toBe(false);
  const blocked = new EconomyGateway({ session, agentcash, crowdcode, hostedSpending: true, approvalMode: "off" });
  await blocked.execute("set_crowdcode_enabled", { enabled: false });
  expect(await blocked.execute("call_paid_service", { url: ENDPOINT, max_cost_cents: 5 })).toMatchObject({ ok: false, error: expect.stringMatching(/purchases are disabled/) });
});
