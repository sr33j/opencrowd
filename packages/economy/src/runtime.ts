import { execFileSync } from "node:child_process";
import { loadConfig, type McpServerConfig } from "@opencrowd/core";
import { McpConnection } from "./mcp.js";
import { McpAgentCashAdapter, type AgentCashAdapter } from "./agentcash.js";
import { McpCrowdCodeAdapter, type CrowdCodeAdapter } from "./crowdcode.js";

/**
 * Process-wide economy runtime: one long-lived AgentCash connection and one
 * long-lived CrowdCode connection, shared by every session in the process.
 */

export interface EconomyRuntime {
  agentcash: AgentCashAdapter;
  crowdcode: CrowdCodeAdapter;
  /** Vendor-published usage instructions for the prompt (stable text only). */
  instructions(): string[];
  close(): Promise<void>;
}

let shared: EconomyRuntime | undefined;
let sharedPromise: Promise<EconomyRuntime> | undefined;

export async function sharedEconomyRuntime(log?: (message: string) => void): Promise<EconomyRuntime> {
  if (shared) {
    return shared;
  }
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const config = await loadConfig();
      const agentcashConfig = config.mcpServers.agentcash;
      const crowdcodeConfig = config.mcpServers.crowdcode;
      if (!agentcashConfig || !crowdcodeConfig) {
        throw new Error("config.mcpServers must define both `agentcash` and `crowdcode`");
      }
      const agentcashConnection = new McpConnection("agentcash", resolvePinnedCommand(agentcashConfig, "agentcash"), { log });
      const crowdcodeConnection = new McpConnection("crowdcode", resolvePinnedCommand(crowdcodeConfig, "crowdcode-mcp"), { log });
      await Promise.all([agentcashConnection.connect(), crowdcodeConnection.connect()]);
      shared = {
        agentcash: new McpAgentCashAdapter(agentcashConnection),
        crowdcode: new McpCrowdCodeAdapter(crowdcodeConnection),
        instructions: () => [agentcashConnection, crowdcodeConnection]
          .map((connection) => connection.instructions())
          .filter((text): text is string => Boolean(text))
          .map((text, index) => `Instructions from the ${index === 0 ? "agentcash" : "crowdcode"} vendor:\n${text.slice(0, 2400)}`),
        close: async () => {
          await Promise.all([agentcashConnection.close(), crowdcodeConnection.close()]);
          shared = undefined;
          sharedPromise = undefined;
        }
      };
      return shared;
    })();
    sharedPromise.catch(() => {
      sharedPromise = undefined;
    });
  }
  return sharedPromise;
}

/**
 * Prefer a pinned installed binary over running `npx` on every startup:
 * `npx` re-resolves the package (and may hit the network) each launch. When
 * the vendor binary is already installed on PATH, spawn it directly.
 */
export function resolvePinnedCommand(config: McpServerConfig, binaryName: string): McpServerConfig {
  if (config.command !== "npx") {
    return config;
  }
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    const resolved = execFileSync(lookup, [binaryName], { encoding: "utf8" }).trim().split("\n")[0];
    if (resolved) {
      return { command: resolved, args: [] };
    }
  } catch {
    // Not installed globally; fall back to the pinned npx invocation.
  }
  return config;
}

export async function closeSharedEconomyRuntime(): Promise<void> {
  const runtime = shared;
  shared = undefined;
  sharedPromise = undefined;
  await runtime?.close();
}
