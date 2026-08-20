import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_MODEL_POLICY, type ModelPolicy } from "./model-policy.js";

export interface McpServerConfig {
  command: string;
  args: string[];
  /** Optional tool allowlist; empty/absent means every vendor tool is exposed. */
  allow?: string[];
}

export interface OpenCrowdConfig {
  bazaarUrl: string;
  /** Connector MCP servers; tools are ingested verbatim with a name prefix. Pin versions. */
  mcpServers: Record<string, McpServerConfig>;
  x402LlmBaseUrl: string;
  x402LlmModel: string;
  x402LlmMaxCostCents: number;
  /** Per-request LLM timeout; reasoning models can think for minutes. */
  x402LlmTimeoutMs: number;
  modelPolicy: ModelPolicy;
  x402PaymentAsset: string;
  x402PaymentNetwork: string;
  mcpShellEnabled: boolean;
  localApiShellEnabled: boolean;
}

const COINBASE_BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
const AGENTIC_MARKET_DEFAULT_URL = "https://api.agentic.market/v1/services";

export const DEFAULT_LLM_MODEL = "zai-org-glm-4.7-flash";

const DEFAULT_CONFIG: OpenCrowdConfig = {
  bazaarUrl: COINBASE_BAZAAR_URL,
  mcpServers: {
    agentcash: { command: "npx", args: ["--yes", "agentcash@0.17"] },
    crowdcode: { command: "npx", args: ["--yes", "crowdcode-mcp@0.5"] }
  },
  x402LlmBaseUrl: "https://api.venice.ai/api/v1",
  x402LlmModel: DEFAULT_LLM_MODEL,
  x402LlmMaxCostCents: 25,
  x402LlmTimeoutMs: 600_000,
  modelPolicy: DEFAULT_MODEL_POLICY,
  x402PaymentAsset: "USDC",
  x402PaymentNetwork: "base",
  mcpShellEnabled: false,
  localApiShellEnabled: false
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

export function walletsPath(): string {
  return join(configDir(), "wallets.json");
}

export function walletSecretsPath(): string {
  return join(configDir(), "wallet-secrets.json");
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
