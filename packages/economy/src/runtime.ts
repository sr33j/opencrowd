import { loadConfig } from "@opencrowd/core";
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
      const agentcashConnection = new McpConnection("agentcash", agentcashConfig, { log });
      const crowdcodeConnection = new McpConnection("crowdcode", crowdcodeConfig, { log });
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

export async function closeSharedEconomyRuntime(): Promise<void> {
  const runtime = shared;
  shared = undefined;
  sharedPromise = undefined;
  await runtime?.close();
}
