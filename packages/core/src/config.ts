import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface McpServerConfig {
  command: string;
  args: string[];
  /** Optional tool allowlist; empty/absent means every vendor tool is exposed. */
  allow?: string[];
}

/** Per-provider default model preferences: exact ID, "auto", or "off" (submodel only). */
export interface ProviderModelDefaults {
  model: string;
  submodel: string;
}

export interface OpenCrowdConfig {
  bazaarUrl: string;
  /** Connector MCP servers; tools are ingested verbatim with a name prefix. Pin versions. */
  mcpServers: Record<string, McpServerConfig>;
  /** Default LLM provider for new sessions. */
  provider: "venice" | "openrouter";
  venice: ProviderModelDefaults;
  openrouter: ProviderModelDefaults;
  /** Per-request LLM timeout; reasoning models can think for minutes. */
  llmTimeoutMs: number;
  /** Local budget reservation ceiling per LLM request, reconciled to actual cost. */
  llmMaxCostCentsPerCall: number;
  /** Default cumulative session spend cap in cents; local policy, not funds. */
  defaultBudgetCents: number;
  x402PaymentAsset: string;
  x402PaymentNetwork: string;
}

const COINBASE_BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
const AGENTIC_MARKET_DEFAULT_URL = "https://api.agentic.market/v1/services";

const DEFAULT_CONFIG: OpenCrowdConfig = {
  bazaarUrl: COINBASE_BAZAAR_URL,
  mcpServers: {
    agentcash: { command: "npx", args: ["--yes", "agentcash@0.17"] },
    crowdcode: { command: "npx", args: ["--yes", "crowdcode-mcp@0.5"] }
  },
  provider: "venice",
  // Provider catalogs change; "auto" resolves from the live catalog at
  // session start and the resolved IDs are persisted for reproducibility.
  venice: { model: "auto", submodel: "auto" },
  openrouter: { model: "auto", submodel: "auto" },
  llmTimeoutMs: 600_000,
  llmMaxCostCentsPerCall: 100,
  defaultBudgetCents: 2000,
  x402PaymentAsset: "USDC",
  x402PaymentNetwork: "base"
};

export function configDir(): string {
  if (process.env.OPENCROWD_CONFIG_DIR) {
    return process.env.OPENCROWD_CONFIG_DIR;
  }
  return join(homedir(), ".config", "opencrowd");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function permissionsPath(): string {
  return join(configDir(), "permissions.json");
}

export async function loadConfig(): Promise<OpenCrowdConfig> {
  try {
    const text = await readFile(configPath(), "utf8");
    return normalizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(text) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: OpenCrowdConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function updateConfig(patch: Partial<OpenCrowdConfig>): Promise<OpenCrowdConfig> {
  const next = { ...(await loadConfig()), ...patch };
  await saveConfig(next);
  return next;
}

function normalizeConfig(config: OpenCrowdConfig): OpenCrowdConfig {
  if (config.bazaarUrl === AGENTIC_MARKET_DEFAULT_URL) {
    return { ...config, bazaarUrl: COINBASE_BAZAAR_URL };
  }
  return config;
}
