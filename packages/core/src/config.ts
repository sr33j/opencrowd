import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface OpenCrowdConfig {
  bazaarUrl: string;
  paymentWallet: "auto" | "local-evm" | "agentic-wallet";
  agenticWalletCommand: string;
  agenticWalletArgs: string[];
  owsCommand: string;
  owsAccount?: string;
  x402LlmBaseUrl: string;
  x402LlmModel: string;
  x402LlmMaxCostCents: number;
  veniceAutoTopUpEnabled: boolean;
  veniceAutoTopUpThresholdCents: number;
  veniceAutoTopUpTargetCents: number;
  veniceAutoTopUpMinimumCents: number;
  x402PaymentAsset: string;
  x402PaymentNetwork: string;
  mcpShellEnabled: boolean;
  localApiShellEnabled: boolean;
}

const COINBASE_BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
const AGENTIC_MARKET_DEFAULT_URL = "https://api.agentic.market/v1/services";

const DEFAULT_CONFIG: OpenCrowdConfig = {
  bazaarUrl: COINBASE_BAZAAR_URL,
  paymentWallet: "auto",
  agenticWalletCommand: "npx",
  agenticWalletArgs: ["--yes", "awal"],
  owsCommand: "ows",
  x402LlmBaseUrl: "https://api.venice.ai/api/v1",
  x402LlmModel: "openai-gpt-55",
  x402LlmMaxCostCents: 25,
  veniceAutoTopUpEnabled: true,
  veniceAutoTopUpThresholdCents: 200,
  veniceAutoTopUpTargetCents: 500,
  veniceAutoTopUpMinimumCents: 500,
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
