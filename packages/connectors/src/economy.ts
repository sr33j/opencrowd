import { loadConfig, type ToolResult } from "@opencrowd/core";
import { ConnectorManager, type ConnectorToolDefinition } from "./manager.js";

/**
 * Builds the runtime-facing economy context from live facts: connector tool
 * definitions for the model, vendor-published instructions for the prompt,
 * and current balances when the wallet vendor exposes them. This is the
 * harness's entire contribution to economic behavior — context, not
 * enforcement (integration spec).
 */

const INSTRUCTIONS_CHAR_CAP = 2400;

export interface EconomyContext {
  dynamicTools: {
    definitions: ConnectorToolDefinition[];
    execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  };
  promptSections: string[];
}

let sharedManager: ConnectorManager | undefined;
let sharedManagerPromise: Promise<ConnectorManager> | undefined;

/**
 * Close the shared manager's vendor processes. Call when a CLI command
 * finishes: the stdio children otherwise keep the Node event loop alive and
 * the process never exits.
 */
export async function closeSharedConnectorManager(): Promise<void> {
  const manager = sharedManager;
  sharedManager = undefined;
  sharedManagerPromise = undefined;
  await manager?.close();
}

/** One connector manager per process; vendors are spawned once and reused. */
export async function sharedConnectorManager(log?: (message: string) => void): Promise<ConnectorManager> {
  if (sharedManager) {
    return sharedManager;
  }
  if (!sharedManagerPromise) {
    sharedManagerPromise = (async () => {
      const config = await loadConfig();
      const manager = await ConnectorManager.connect(config.mcpServers, { log });
      sharedManager = manager;
      return manager;
    })();
    sharedManagerPromise.catch(() => {
      sharedManagerPromise = undefined;
    });
  }
  return sharedManagerPromise;
}

export async function buildEconomyContext(manager: ConnectorManager): Promise<EconomyContext> {
  const promptSections: string[] = [];
  const balances = await liveBalances(manager);
  if (balances) {
    promptSections.push(`Current wallet state (live): ${balances}`);
  }
  promptSections.push(HOUSE_RULES);
  for (const { server, text } of manager.instructions()) {
    promptSections.push(`Instructions from the ${server} MCP server:\n${truncate(text, INSTRUCTIONS_CHAR_CAP)}`);
  }
  return {
    dynamicTools: {
      definitions: manager.definitions(),
      execute: (name, args) => manager.execute(name, args)
    },
    promptSections
  };
}

const HOUSE_RULES = [
  "Paid capability comes from the connector tools above, not from a built-in marketplace.",
  "Prefer local files and shell when they solve the task.",
  "Inspect an endpoint's schema and price before paying for it.",
  "Check crowdcode_get_service_score before the first payment to a service, and submit a CrowdCode review after every uniquely paid call — success or failure; a broken paid call IS the review.",
  "Only x402 USDC on Base and MPP USDC on Tempo are review-verifiable rails.",
  "Never request, display, or invent wallet secrets or payment proof."
].join(" ");

async function liveBalances(manager: ConnectorManager): Promise<string | undefined> {
  if (!manager.hasTool("agentcash_get_balance")) {
    return undefined;
  }
  const result = await manager.execute("agentcash_get_balance", {});
  if (!result.ok) {
    return undefined;
  }
  return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
