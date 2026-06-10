import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  addAllowedService,
  assertServiceAllowed,
  blockService,
  callPaidService,
  chooseFruitLabel,
  clearConversation,
  compactConversationIfNeeded,
  appendConversationMessage,
  readConversationMessages,
  confirmWalletDraft,
  createTestWallet,
  createWalletDraft,
  createOpenCrowdSession,
  createSession,
  ensureVeniceCreditTopUp,
  exportWalletSecret,
  FRUIT_LABELS,
  fundActiveTestWallet,
  listArtifacts,
  listStoredWallets,
  normalizeLlmModels,
  AgenticWalletPaidHttpClient,
  appendLedgerEntry,
  compatiblePaymentHeader,
  VeniceWalletPaidHttpClient,
  normalizeBazaarResponse,
  OwsPaymentAdapter,
  readLedger,
  removeAllowedService,
  reserveBudget,
  searchServices,
  finalizeReservation,
  saveArtifact,
  setPreferredLlmModel,
  updateConfig,
  walletList,
  walletAddress,
  walletBalance,
  runShell,
  type OpenCrowdConfig,
  type PaymentAdapter
} from "../src/index.js";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencrowd-test-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.OPENCROWD_CONFIG_DIR;
  delete process.env.OPENCROWD_WALLET_SECRET_STORE;
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("budget accounting", () => {
  it("reserves and finalizes spend without overspending", async () => {
    const session = await createSession({ workspaceRoot: await tempRoot(), budgetCents: 100 });
    const reservation = await reserveBudget(session, 40);
    expect(session.reservedCents).toBe(40);
    await finalizeReservation(session, reservation, 25);
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(25);
    await expect(reserveBudget(session, 80)).rejects.toThrow("budget exceeded");
  });
});

describe("OpenCrowd session defaults", () => {
  it("defaults to ask_first mode, CLI shell access, and wallet-balance budget", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await createTestWallet("mango", 1234);

    const session = await createOpenCrowdSession({ workspaceRoot: root, surface: "cli" });

    expect(session.permissionMode).toBe("ask_first");
    expect(session.shellEnabled).toBe(true);
    expect(session.budgetCents).toBe(1234);
  });

  it("caps the default budget at $20 even when the wallet balance is larger", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await createTestWallet("papaya", 50_000);

    const session = await createOpenCrowdSession({ workspaceRoot: root, surface: "cli" });

    expect(session.budgetCents).toBe(2000);
  });
});

describe("wallet registry", () => {
  it("assigns unused fruit labels and falls back after fruit exhaustion", () => {
    expect(FRUIT_LABELS.length).toBeGreaterThanOrEqual(100);
    expect(chooseFruitLabel(["durian", "mango"])).not.toMatch(/^(durian|mango)$/);
    expect(chooseFruitLabel([...FRUIT_LABELS])).toBe("fruit-1");
  });

  it("creates confirmed wallets without writing secrets into wallets.json", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    process.env.OPENCROWD_WALLET_SECRET_STORE = "file";

    const draft = await createWalletDraft("dragonfruit");
    const wallet = await confirmWalletDraft(draft);
    const exported = await exportWalletSecret("dragonfruit");
    const walletFile = await readFile(join(root, "config", "wallets.json"), "utf8");

    expect(wallet.label).toBe("dragonfruit");
    expect(exported.mnemonic).toBe(draft.mnemonic);
    expect(walletFile).not.toContain(draft.mnemonic);
    expect(await walletAddress()).toMatchObject({ account: "dragonfruit", address: draft.address });
  });

  it("lists and funds active test wallets", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await createTestWallet("passionfruit", 100);
    await fundActiveTestWallet(25);

    await expect(walletBalance()).resolves.toMatchObject({
      account: "passionfruit",
      spendable_balance_cents: 125
    });
    await expect(walletList()).resolves.toContainEqual(expect.objectContaining({
      label: "passionfruit",
      active: true,
      spendable_balance_cents: 125
    }));
    await expect(listStoredWallets()).resolves.toHaveLength(1);
  });
});

describe("conversation clearing", () => {
  it("archives prior messages and starts the context fresh", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 100 });
    await appendConversationMessage(session, { role: "user", content: "first task" });
    await appendConversationMessage(session, { role: "assistant", content: "done" });

    const result = await clearConversation(session);

    expect(result.cleared).toBe(true);
    expect(result.messagesCleared).toBe(2);
    expect(result.archivePath).toMatch(/^context\/cleared-/);
    await expect(readConversationMessages(session)).resolves.toEqual([]);
    const archived = await readFile(join(session.sessionDir, result.archivePath ?? ""), "utf8");
    expect(archived).toContain("first task");

    await expect(clearConversation(session)).resolves.toMatchObject({ cleared: false, messagesCleared: 0 });
  });
});

describe("conversation compaction", () => {
  it("archives older messages and keeps a compacted continuation", async () => {
    const session = await createSession({ workspaceRoot: await tempRoot() });
    for (let index = 0; index < 10; index += 1) {
      await appendConversationMessage(session, { role: "user", content: `message ${index} ${"x".repeat(200)}` });
    }

    const result = await compactConversationIfNeeded(session, {
      contextWindowTokens: 1_000,
      thresholdRatio: 0.2,
      keepRecentTokens: 120
    });

    expect(result.compacted).toBe(true);
    expect(result.archivePath).toMatch(/^context\//);
    expect(result.messages[0]?.content).toContain("Original transcript archive:");
  });
});

describe("permission gates", () => {
  it("blocks paid calls to unknown services in ask_first mode", async () => {
    const root = await tempRoot();
    const permissionPath = join(root, "permissions.json");
    const session = await createSession({ workspaceRoot: root, budgetCents: 100, permissionMode: "ask_first" });

    await expect(assertServiceAllowed(session, "https://unknown.example/api", "POST", 5, permissionPath))
      .rejects.toThrow("permission required before paid call");
  });

  it("enforces per-call cost caps", async () => {
    const root = await tempRoot();
    const permissionPath = join(root, "permissions.json");
    const session = await createSession({ workspaceRoot: root, budgetCents: 100, permissionMode: "ask_first" });
    await addAllowedService("https://svc.example/api", { max_cost_cents: 10 }, "yolo", permissionPath);

    await expect(assertServiceAllowed(session, "https://svc.example/api", "POST", 11, permissionPath))
      .rejects.toThrow("quoted cost exceeds service cap");
    await expect(assertServiceAllowed(session, "https://svc.example/api", "POST", 10, permissionPath))
      .resolves.toMatchObject({ resource_url: "https://svc.example/api" });
  });

  it("enforces per-session service spend caps from the ledger", async () => {
    const root = await tempRoot();
    const permissionPath = join(root, "permissions.json");
    const session = await createSession({ workspaceRoot: root, budgetCents: 100, permissionMode: "ask_first" });
    await addAllowedService("https://svc.example/api", { session_max_cents: 15 }, "yolo", permissionPath);
    await appendLedgerEntry(session.ledgerPath, {
      session_id: session.sessionId,
      type: "service_call",
      resource_url: "https://svc.example/api",
      charged_cost_cents: 10,
      status: "charged",
      permission_mode: "yolo"
    });

    await expect(assertServiceAllowed(session, "https://svc.example/api", "POST", 6, permissionPath))
      .rejects.toThrow("quoted cost exceeds session cap");
    await expect(assertServiceAllowed(session, "https://svc.example/api", "POST", 5, permissionPath))
      .resolves.toMatchObject({ resource_url: "https://svc.example/api" });
  });

  it("blocks everything when the session mode is blocked", async () => {
    const root = await tempRoot();
    const permissionPath = join(root, "permissions.json");
    const session = await createSession({ workspaceRoot: root, budgetCents: 100, permissionMode: "blocked" });
    await addAllowedService("https://svc.example/api", {}, "yolo", permissionPath);

    await expect(assertServiceAllowed(session, "https://svc.example/api", "POST", 1, permissionPath))
      .rejects.toThrow("session permission mode is blocked");
  });
});

describe("permissions", () => {
  it("allows, blocks, and removes services", async () => {
    const root = await tempRoot();
    const path = join(root, "permissions.json");
    const url = "https://service.example/x402";
    const session = await createSession({ workspaceRoot: root, budgetCents: 100, permissionMode: "ask_first" });

    await expect(assertServiceAllowed(session, url, "POST", 1, path)).rejects.toThrow("permission required");
    await addAllowedService(url, { max_cost_cents: 10, methods: ["POST"] }, "yolo", path);
    await expect(assertServiceAllowed(session, url, "POST", 5, path)).resolves.toMatchObject({ resource_url: url });
    await expect(assertServiceAllowed(session, url, "GET", 5, path)).rejects.toThrow("method not allowed");
    await blockService(url, path);
    await expect(assertServiceAllowed(session, url, "POST", 5, path)).rejects.toThrow("blocked");
    await removeAllowedService(url, path);
    await expect(assertServiceAllowed(session, url, "POST", 5, path)).rejects.toThrow("permission required");
  });
});

describe("Bazaar normalization", () => {
  it("normalizes common result shapes", () => {
    const normalized = normalizeBazaarResponse({
      results: [
        {
          url: "https://a.example/tool",
          name: "A",
          summary: "first",
          method: "POST",
          cost_cents: "7",
          categories: ["data"],
          rank: 3
        },
        { endpoint: "https://b.example/tool", methods: ["GET"], price_cents: 1, score: 10 }
      ]
    });
    expect(normalized).toEqual([
      expect.objectContaining({ resource_url: "https://a.example/tool", title: "A", price_cents: 7, methods: ["POST"] }),
      expect.objectContaining({ resource_url: "https://b.example/tool", price_cents: 1, methods: ["GET"] })
    ]);
	  });

	  it("normalizes Coinbase Bazaar resources with x402 payment requirements", () => {
	    const normalized = normalizeBazaarResponse({
	      resources: [
	        {
	          resource: "https://orbisapi.com/proxy/stock-price-api-d847a6/:endpoint",
	          serviceName: "Stock Price API",
	          description: "Get real-time stock prices",
	          tags: ["stocks", "x402"],
	          accepts: [
	            {
	              amount: "5000",
	              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	              extra: { name: "USD Coin", version: "2" },
	              network: "eip155:8453",
	              resource: { url: "https://orbisapi.com/proxy/stock-price-api-d847a6/quote" },
	              scheme: "exact"
	            }
	          ],
	          extensions: {
	            bazaar: {
	              info: {
	                input: { method: "GET", type: "http" }
	              }
	            }
	          }
	        }
	      ]
	    });
	    expect(normalized).toEqual([
	      expect.objectContaining({
	        resource_url: "https://orbisapi.com/proxy/stock-price-api-d847a6/quote",
	        title: "Stock Price API",
	        methods: ["GET"],
	        price_cents: 1,
	        price_display: "0.005 USDC",
	        currency: "USDC",
	        tags: ["stocks", "x402"]
	      })
	    ]);
	  });

	  it("uses Coinbase Bazaar query params for CDP discovery search", async () => {
	    const seen: string[] = [];
	    const fetchImpl = (async (input: RequestInfo | URL) => {
	      seen.push(String(input));
	      return new Response(JSON.stringify({ resources: [] }), {
	        status: 200,
	        headers: { "content-type": "application/json" }
	      });
	    }) as typeof fetch;

	    await expect(searchServices("stock price", {
	      bazaarUrl: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search",
	      fetchImpl,
	      limit: 3,
	      maxBudgetCents: 25
	    })).resolves.toEqual([]);

	    const url = new URL(seen[0]);
	    expect(url.searchParams.get("query")).toBe("stock price");
	    expect(url.searchParams.get("network")).toBe("eip155:8453");
	    expect(url.searchParams.get("limit")).toBe("3");
	    expect(url.searchParams.get("maxUsdPrice")).toBe("0.25");
	    expect(url.searchParams.has("q")).toBe(false);
	  });
	});

describe("x402 LLM models", () => {
  it("normalizes common model list shapes and persists selection", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    const models = normalizeLlmModels({
      data: [
        { id: "gpt-5.5", display_name: "GPT 5.5", max_cost_cents: "12" },
        "small-model"
      ]
    });
    expect(models).toEqual([
      expect.objectContaining({ id: "gpt-5.5", name: "GPT 5.5", max_cost_cents: 12 }),
      expect.objectContaining({ id: "small-model" })
    ]);
    await expect(setPreferredLlmModel("small-model")).resolves.toEqual({ model: "small-model" });
  });
});

describe("artifacts", () => {
  it("stores artifacts inside the session and rejects traversal", async () => {
    const session = await createSession({ workspaceRoot: await tempRoot() });
    const artifact = await saveArtifact(session, "reports/out.txt", "hello");
    expect(artifact.path).toBe("artifacts/reports/out.txt");
    await expect(readFile(join(session.sessionDir, artifact.path), "utf8")).resolves.toBe("hello");
    await expect(saveArtifact(session, "../outside.txt", "no")).rejects.toThrow("artifact path");
    await expect(listArtifacts(session)).resolves.toEqual(["reports/out.txt"]);
  });
});

describe("shell policy", () => {
  it("rejects disabled shell, unsafe cwd, and excessive timeout", async () => {
    const root = await tempRoot();
    const disabled = await createSession({ workspaceRoot: root, shellEnabled: false });
    await expect(runShell(disabled, "echo hi")).rejects.toThrow("disabled");

    const enabled = await createSession({ workspaceRoot: root, shellEnabled: true });
    await expect(runShell(enabled, "echo hi", "/", 1000)).rejects.toThrow("workspace");
    await expect(runShell(enabled, "echo hi", root, 60_000)).rejects.toThrow("timeout_ms");
  });

  it("resolves artifact cwd and returns spawn failures as tool results", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, shellEnabled: true });

    await expect(runShell(session, "pwd", "artifacts", 1000)).resolves.toMatchObject({
      cwd: session.artifactsDir,
      exit_code: 0
    });
    await expect(runShell(session, "pwd", "missing-dir", 1000)).resolves.toMatchObject({
      cwd: join(root, "missing-dir"),
      exit_code: null
    });
  });
});

describe("paid x402 calls", () => {
  it("checks permission, signs, calls, saves artifact, and writes ledger rows", async () => {
    const root = await tempRoot();
    const permissionPath = join(root, "permissions.json");
    const serviceUrl = "https://service.example/paid";
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, permissionMode: "ask_first" });
    await addAllowedService(serviceUrl, { max_cost_cents: 20 }, "yolo", permissionPath);
    const signer: PaymentAdapter = {
      async sign() {
        return { headers: { "x-payment": "signed" }, txHash: "0xtx" };
      }
    };
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "x402-charged-cost-cents": "9" }
    });
    const result = await callPaidService(session, {
      resource_url: serviceUrl,
      method: "POST",
      quoted_cost_cents: 10,
      body: { prompt: "hi" }
    }, {
      permissionPath,
      paymentAdapter: signer,
      fetchImpl: async () => response
    });

    expect(result.charged_cost_cents).toBe(9);
    expect(session.spentCents).toBe(9);
    expect(result.artifact_path).toContain("service-calls/");
    const rows = await readLedger(session.ledgerPath);
    expect(rows.some((row) => row.type === "service_call" && row.status === "charged" && row.tx_hash === "0xtx")).toBe(true);
  });

  it("sends string service bodies without JSON encoding", async () => {
    const root = await tempRoot();
    const permissionPath = join(root, "permissions.json");
    const serviceUrl = "https://service.example/upload";
    const session = await createSession({ workspaceRoot: root, budgetCents: 50, permissionMode: "ask_first" });
    await addAllowedService(serviceUrl, { max_cost_cents: 5 }, "yolo", permissionPath);
    let sentBody: string | undefined;
    let sentContentType: string | undefined;
    const result = await callPaidService(session, {
      resource_url: serviceUrl,
      method: "PUT",
      quoted_cost_cents: 5,
      content_type: "text/html",
      body: "<!doctype html><title>Pong</title>"
    }, {
      permissionPath,
      paymentAdapter: {
        async sign() {
          return { headers: { "x-payment": "signed" } };
        }
      },
      fetchImpl: async (_input, init) => {
        sentBody = String(init?.body);
        sentContentType = (init?.headers as Record<string, string>)["content-type"];
        return new Response("ok", { status: 200, headers: { "x402-charged-cost-cents": "5" } });
      }
    });

    expect(result.status).toBe(200);
    expect(sentContentType).toBe("text/html");
    expect(sentBody).toBe("<!doctype html><title>Pong</title>");
  });
});

describe("OWS wallet helpers", () => {
  it("reads active test wallet address and balance", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    const wallet = await createTestWallet("lychee", 1234);

    await expect(walletAddress()).resolves.toEqual({
      account: "lychee",
      address: wallet.address,
      network: "mock-base",
      asset: "mock-USDC"
    });
    await expect(walletBalance()).resolves.toEqual({
      account: "lychee",
      address: wallet.address,
      network: "mock-base",
      asset: "mock-USDC",
      spendable_balance: "12.34",
      spendable_balance_cents: 1234
    });
  });

  it("auto tops up Venice credit below the configured threshold and records budget", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 1_000, permissionMode: "yolo" });
    let balanceUsd = 1.5;
    let topUpCents = 0;
    const wallet = {
      async walletAddress() {
        return "0xabc";
      },
      async walletBalance() {
        return { balanceUsd, canConsume: true, suggestedTopUpUsd: 3.5 };
      },
      async topUpVeniceCredit(amountCents: number) {
        topUpCents += amountCents;
        balanceUsd += amountCents / 100;
      }
    };
    const config = {
      veniceAutoTopUpEnabled: true,
      veniceAutoTopUpThresholdCents: 500,
      veniceAutoTopUpTargetCents: 750,
      veniceAutoTopUpMinimumCents: 500,
      x402LlmBaseUrl: "https://api.venice.ai/api/v1"
    } as OpenCrowdConfig;

    await expect(ensureVeniceCreditTopUp(session, wallet, config)).resolves.toMatchObject({
      top_up_required: true,
      before_balance_cents: 150,
      top_up_cents: 600,
      after_balance_cents: 750
    });
    expect(topUpCents).toBe(600);
    expect(session.spentCents).toBe(600);
    expect(session.reservedCents).toBe(0);
    const rows = await readLedger(session.ledgerPath);
    expect(rows).toContainEqual(expect.objectContaining({
      type: "wallet_top_up",
      status: "charged",
      quoted_cost_cents: "600",
      charged_cost_cents: "600"
    }));
  });

  it("wraps legacy signed payments in the Coinbase x402 v2 envelope", () => {
    const flatHeader = Buffer.from(JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: "base",
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0xfrom",
          to: "0xto",
          value: "1000",
          validAfter: "1",
          validBefore: "2",
          nonce: "0xnonce"
        }
      }
    })).toString("base64");
    const wrapped = compatiblePaymentHeader(flatHeader, 2, {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xpayto",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" }
    }, "https://service.example/stock/TSLA");

    expect(JSON.parse(Buffer.from(wrapped, "base64").toString("utf8"))).toEqual({
      x402Version: 2,
      // accepted must round-trip the offered requirement exactly; v2
      // middleware deep-matches it and rejects injected fields
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0xpayto",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" }
      },
      payload: expect.objectContaining({
        signature: "0xsig",
        authorization: expect.objectContaining({ value: "1000" })
      })
    });
  });

  it("fails clearly when no wallet exists and constructs upto signing requests", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await expect(walletAddress()).rejects.toThrow("No active wallet");

    const argsPath = join(root, "args.txt");
    const script = join(root, "ows-sign.sh");
    await writeFile(script, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > "${argsPath}"`,
      "echo '{\"headers\":{\"x-payment\":\"signed\"},\"payment_id\":\"pay_1\",\"tx_hash\":\"0xtx\"}'"
    ].join("\n"), "utf8");
    await chmod(script, 0o755);

    const signer = new OwsPaymentAdapter(script, "agent");
    await expect(signer.sign({
      resourceUrl: "https://llm.example/v1/chat/completions",
      method: "POST",
      quotedCostCents: 25,
      paymentKind: "upto",
      body: { prompt: "hi" }
    })).resolves.toMatchObject({ paymentId: "pay_1", txHash: "0xtx" });
    await expect(readFile(argsPath, "utf8")).resolves.toContain("--upto-cost-cents 25");
  });

  it("uses Agentic Wallet x402 pay for paid HTTP requests", async () => {
    const root = await tempRoot();
    const argsPath = join(root, "awal-args.txt");
    const script = join(root, "awal-pay.sh");
    await writeFile(script, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > "${argsPath}"`,
      "echo '{\"status\":200,\"body\":{\"ok\":true},\"charged_cost_cents\":3,\"payment_id\":\"pay_1\",\"tx_hash\":\"0xtx\"}'"
    ].join("\n"), "utf8");
    await chmod(script, 0o755);

    const client = new AgenticWalletPaidHttpClient({
      bazaarUrl: "https://bazaar.example",
      agenticWalletCommand: script,
      agenticWalletArgs: [],
      owsCommand: "ows",
      x402LlmBaseUrl: "https://llm.example/v1",
      x402LlmModel: "openai-gpt-55",
      x402LlmMaxCostCents: 25,
      x402PaymentAsset: "USDC",
      x402PaymentNetwork: "base",
      mcpShellEnabled: false,
      localApiShellEnabled: false
    });

    await expect(client.request({
      url: "https://llm.example/v1/chat/completions",
      method: "POST",
      maxCostCents: 25,
      body: { model: "openai-gpt-55" }
    })).resolves.toMatchObject({
      status: 200,
      ok: true,
      chargedCostCents: 3,
      paymentId: "pay_1",
      txHash: "0xtx",
      body: { ok: true }
    });
    const args = await readFile(argsPath, "utf8");
    expect(args).toContain("x402 pay https://llm.example/v1/chat/completions");
    expect(args).toContain("--method POST");
    expect(args).toContain("--max-amount 250000");
  });

  it("pays x402 challenges carried only in the Payment-Required header", async () => {
    let paymentHeader: string | undefined;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      paymentHeader = request.headers["x-payment"] as string | undefined;
      if (!paymentHeader) {
        response.writeHead(402, {
          "content-type": "application/json",
          "payment-required": Buffer.from(JSON.stringify({
            x402Version: 2,
            resource: {
              url: `http://127.0.0.1:${addressPort(server)}/api/site`,
              method: "POST",
              description: "Buy a site upload slot.",
              mimeType: "application/json"
            },
            accepts: [{
              scheme: "exact",
              network: "eip155:8453",
              amount: "5000",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              payTo: "0x06dFF3c8380b5D1799874adA903fc3422882FD6f",
              maxTimeoutSeconds: 300,
              extra: { name: "USD Coin", version: "2" }
            }]
          })).toString("base64")
        });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await listen(server);
    try {
      const url = `http://127.0.0.1:${addressPort(server)}/api/site`;
      const client = new VeniceWalletPaidHttpClient("0x59c6995e998f97a5a0044966f094538f89d8f907357e22278c4cfeabf7c5d1c6");
      await expect(client.request({
        url,
        method: "POST",
        maxCostCents: 1,
        body: { filename: "site.zip", tier: "short-10mb" }
      })).resolves.toMatchObject({
        status: 200,
        ok: true,
        body: { ok: true }
      });
      expect(paymentHeader).toBeTruthy();
      const decoded = JSON.parse(Buffer.from(paymentHeader ?? "", "base64").toString("utf8"));
      expect(decoded).toMatchObject({
        x402Version: 2,
        // accepted round-trips the offered requirement exactly (no injected resource)
        accepted: {
          network: "eip155:8453",
          amount: "5000"
        },
        payload: {
          authorization: {
            value: "5000",
            to: "0x06dFF3c8380b5D1799874adA903fc3422882FD6f"
          }
        }
      });
      expect((decoded as { accepted: Record<string, unknown> }).accepted.resource).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function addressPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address is not available");
  }
  return address.port;
}
