import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpConnection } from "../src/mcp.js";
import { McpAgentCashAdapter, parsePaidFetchResult } from "../src/agentcash.js";

function vendorServer(): McpServer {
  const server = new McpServer(
    { name: "agentcash", version: "0.0.0" },
    { instructions: "AgentCash lets you call protected APIs with x402 payments." }
  );
  server.tool("get_balance", "Get your USDC balance", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ total_usd: 12.34 }) }]
  }));
  server.tool("fetch", "Fetch a paid endpoint", { url: z.string() }, async ({ url }) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, status: 200, data: { url }, payment: { price: 0.05, txHash: "0xabc", network: "base" } }) }]
  }));
  server.tool("broken", "Always errors", {}, async () => ({
    isError: true,
    content: [{ type: "text", text: "vendor exploded" }]
  }));
  return server;
}

function connection(): McpConnection {
  return new McpConnection("agentcash", { command: "unused", args: [] }, {
    transportFactory: () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      void vendorServer().connect(serverTransport);
      return clientTransport;
    }
  });
}

describe("McpConnection", () => {
  it("connects lazily, captures vendor instructions, and parses tool content", async () => {
    const mcp = connection();
    const result = await mcp.call("get_balance", {});
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ total_usd: 12.34 });
    expect(mcp.instructions()).toContain("x402");
    await mcp.close();
  });

  it("surfaces vendor errors without marking them as transport failures", async () => {
    const mcp = connection();
    const broken = await mcp.call("broken", {});
    expect(broken.ok).toBe(false);
    expect(broken.transportError).toBeUndefined();
    expect(broken.error).toContain("vendor exploded");
    await mcp.close();
  });
});

describe("McpAgentCashAdapter", () => {
  it("executes paid fetches and captures payment evidence out-of-band", async () => {
    const mcp = connection();
    const adapter = new McpAgentCashAdapter(mcp);
    const result = await adapter.fetch({
      url: "https://api.example/paid",
      method: "POST",
      maxAmountUsd: 0.1,
      rail: "x402-base"
    });
    expect(result.ok).toBe(true);
    expect(result.authMode).toBe("paid");
    expect(result.payment).toMatchObject({ paidUsd: 0.05, reference: "0xabc", rail: "x402-base" });
    await mcp.close();
  });
});

// Field note 001, issue 2: the real AgentCash fetch returns TWO text blocks —
// the vendor response body, then a payment-metadata object. The 402 challenge
// settles on-chain but the final HTTP response is a plain 200 with the
// receipt in the metadata block; that settlement must still surface as paid
// evidence, never as a "free" call.
const SETTLED_TX = "0x9d25ffca4635e391a1718e5d1e06ad8030c3ef6f2bb4a0c1a1585ba1be604cd6";
const SETTLED_BODY = { requestId: "f6afdc08566db7c6e545288b23285520", results: [{ id: "https://example.com/a" }] };
const SETTLED_RECEIPT = Buffer.from(
  JSON.stringify({ success: true, payer: "0xF5a65ae916474Da7fB", transaction: SETTLED_TX, network: "base" })
).toString("base64");
const SETTLED_METADATA = {
  protocol: "x402",
  network: "base",
  price: "$0.01",
  payment: { success: true, transactionHash: SETTLED_TX },
  headers: { "content-type": "application/json", "payment-response": SETTLED_RECEIPT }
};

function settledVendorServer(): McpServer {
  const server = new McpServer({ name: "agentcash", version: "0.0.0" });
  server.tool("fetch", "Fetch a paid endpoint", { url: z.string() }, async () => ({
    content: [
      { type: "text", text: JSON.stringify(SETTLED_BODY) },
      { type: "text", text: JSON.stringify(SETTLED_METADATA, null, 2) }
    ]
  }));
  return server;
}

describe("x402 settlement with a 200 response (field note 001)", () => {
  it("propagates the receipt from the separate metadata block as paid evidence", async () => {
    const mcp = new McpConnection("agentcash", { command: "unused", args: [] }, {
      transportFactory: () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        void settledVendorServer().connect(serverTransport);
        return clientTransport;
      }
    });
    const adapter = new McpAgentCashAdapter(mcp);
    const result = await adapter.fetch({
      url: "https://stableenrich.dev/api/exa/search",
      method: "POST",
      maxAmountUsd: 0.02,
      rail: "x402-base"
    });
    expect(result.ok).toBe(true);
    expect(result.authMode).toBe("paid");
    expect(result.payment).toMatchObject({
      rail: "x402-base",
      reference: SETTLED_TX,
      proof: SETTLED_RECEIPT,
      paidUsd: 0.01
    });
    // The model-visible body is the vendor response alone: no settlement
    // hashes or receipt headers leak into it.
    expect(result.data).toEqual(SETTLED_BODY);
    expect(JSON.stringify(result.data)).not.toContain(SETTLED_TX.slice(2));
    await mcp.close();
  });

  it("reconciles the same payload even when the blocks were pre-joined into one string", () => {
    const joined = `${JSON.stringify(SETTLED_BODY)}\n${JSON.stringify(SETTLED_METADATA, null, 2)}`;
    const result = parsePaidFetchResult(joined, "x402-base");
    expect(result.authMode).toBe("paid");
    expect(result.payment).toMatchObject({ reference: SETTLED_TX, rail: "x402-base", paidUsd: 0.01 });
    expect(result.data).toEqual(SETTLED_BODY);
  });

  it("fills the reference from the decoded receipt when the metadata omits it", () => {
    const result = parsePaidFetchResult([
      SETTLED_BODY,
      { protocol: "x402", network: "base", headers: { "payment-response": SETTLED_RECEIPT } }
    ], "x402-base");
    expect(result.payment).toMatchObject({ reference: SETTLED_TX, rail: "x402-base" });
  });
});

describe("parsePaidFetchResult", () => {
  it("reconciles free, SIWX, and MPP-paid vendor payloads", () => {
    expect(parsePaidFetchResult({ ok: true, status: 200, data: { hello: 1 } }, "x402-base"))
      .toMatchObject({ ok: true, authMode: "free" });
    expect(parsePaidFetchResult({ ok: true, status: 200, data: {}, authMode: "siwx" }, "x402-base"))
      .toMatchObject({ authMode: "siwx" });
    expect(parsePaidFetchResult({
      ok: true,
      status: 200,
      data: {},
      payment: { price: 0.02, network: "tempo", reference: "rcpt_1" },
      headers: { "Payment-Receipt": "cmVjZWlwdA==" }
    }, "mppx")).toMatchObject({
      authMode: "paid",
      payment: { rail: "mppx", reference: "rcpt_1", proof: "cmVjZWlwdA==" }
    });
  });
});
