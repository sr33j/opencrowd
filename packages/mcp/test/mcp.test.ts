import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@opencrowd/core";

const tmpRoots: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../..");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencrowd-mcp-test-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP stdio server", () => {
  it("exposes the core tool contract without requiring an in-process LLM loop", async () => {
    const workspaceRoot = await tempRoot();
    const configRoot = await tempRoot();
    const client = new Client({ name: "opencrowd-mcp-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), join(repoRoot, "apps/cli/src/index.ts"), "mcp"],
      cwd: workspaceRoot,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        OPENCROWD_BUDGET_CENTS: "123",
        OPENCROWD_CONFIG_DIR: configRoot
      },
      stderr: "pipe"
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(tools.tools.find((tool) => tool.name === "search_services")?.inputSchema).toMatchObject({
        type: "object",
        required: ["query"]
      });

      const budget = await client.callTool({ name: "get_budget_status", arguments: {} });
      expect(parseToolResult(budget)).toMatchObject({
        ok: true,
        data: {
          budget_cents: 123,
          spent_cents: 0,
          reserved_cents: 0,
          remaining_cents: 123,
          permission_mode: "yolo"
        }
      });
    } finally {
      await client.close();
    }
  }, 15_000);
});

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = result.content.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}
