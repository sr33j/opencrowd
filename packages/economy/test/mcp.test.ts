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
