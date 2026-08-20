import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ConnectorManager } from "../src/manager.js";
import { buildEconomyContext } from "../src/economy.js";

function vendorServer(): McpServer {
  const server = new McpServer(
    { name: "agentcash", version: "0.0.0" },
    { instructions: "AgentCash lets you call protected APIs with x402 payments." }
  );
  server.tool("get_balance", "Get your USDC balance", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ balance: 12.34 }) }]
  }));
  server.tool("fetch", "Fetch a paid endpoint", { url: z.string() }, async ({ url }) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, url, payment: { tx_hash: "0xabc" } }) }]
  }));
  server.tool("update_settings", "Change settings", {}, async () => ({
    content: [{ type: "text", text: "{}" }]
  }));
  server.tool("broken", "Always errors", {}, async () => ({
    isError: true,
    content: [{ type: "text", text: "vendor exploded" }]
  }));
  return server;
}

async function connectManager(allow?: string[]): Promise<ConnectorManager> {
  return ConnectorManager.connect(
    { agentcash: { command: "unused", args: [], allow } },
    {
      transportFactory: () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        void vendorServer().connect(serverTransport);
        return clientTransport;
      }
    }
  );
}

describe("ConnectorManager", () => {
  it("ingests vendor tools verbatim with a server prefix and captures instructions", async () => {
    const manager = await connectManager();
    const names = manager.toolNames();
    expect(names).toContain("agentcash_get_balance");
    expect(names).toContain("agentcash_fetch");
    const fetchDefinition = manager.definitions().find((tool) => tool.name === "agentcash_fetch");
    expect(fetchDefinition?.description).toBe("Fetch a paid endpoint");
    expect(fetchDefinition?.originalName).toBe("fetch");
    expect((fetchDefinition?.parameters as { properties?: Record<string, unknown> }).properties).toHaveProperty("url");
    expect(manager.instructions()[0]).toMatchObject({ server: "agentcash" });
    expect(manager.instructions()[0].text).toContain("x402");
    await manager.close();
  });

  it("executes tools and surfaces vendor errors without retrying", async () => {
    const manager = await connectManager();
    const ok = await manager.execute("agentcash_fetch", { url: "https://api.example/paid" });
    expect(ok.ok).toBe(true);
    expect((ok.data as { payment: { tx_hash: string } }).payment.tx_hash).toBe("0xabc");
    const broken = await manager.execute("agentcash_broken", {});
    expect(broken.ok).toBe(false);
    expect(broken.transportError).toBeUndefined();
    expect(broken.error).toContain("vendor exploded");
    const unknown = await manager.execute("agentcash_missing", {});
    expect(unknown.ok).toBe(false);
    await manager.close();
  });

  it("honors a per-server allowlist", async () => {
    const manager = await connectManager(["get_balance"]);
    expect(manager.toolNames()).toEqual(["agentcash_get_balance"]);
    await manager.close();
  });

  it("builds economy context with live balances, house rules, and vendor instructions", async () => {
    const manager = await connectManager();
    const economy = await buildEconomyContext(manager);
    expect(economy.dynamicTools.definitions.map((tool) => tool.name)).toContain("agentcash_fetch");
    const prompt = economy.promptSections.join("\n");
    expect(prompt).toContain("12.34");
    expect(prompt).toContain("crowdcode_get_service_score");
    expect(prompt).toContain("Instructions from the agentcash MCP server");
    const result = await economy.dynamicTools.execute("agentcash_get_balance", {});
    expect(result.ok).toBe(true);
    await manager.close();
  });
});
