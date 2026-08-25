import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ApprovalMode } from "./types.js";

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
  /** Vendor MCP servers (AgentCash, CrowdCode). Pin versions. */
  mcpServers: Record<string, McpServerConfig>;
  /** Default LLM provider for new sessions. */
  provider: "x402" | "venice" | "openrouter";
  x402: ProviderModelDefaults;
  venice: ProviderModelDefaults;
  openrouter: ProviderModelDefaults;
  /** OpenAI-compatible x402-metered proxy route for the `x402` provider. */
  x402ProxyUrl: string;
  /** Per-request LLM timeout; reasoning models can think for minutes. */
  llmTimeoutMs: number;
  /** Local budget reservation ceiling per LLM request, reconciled to actual cost. */
  llmMaxCostCentsPerCall: number;
  /** Ceiling for one automatic Venice credit top-up; also bounded by session allowance. */
  veniceMaxTopUpCents: number;
  /** Default cumulative session spend cap in cents; local policy, not funds. */
  defaultBudgetCents: number;
  /** Default external-service approval mode for new sessions. */
  approval: ApprovalMode;
}

export const DEFAULT_CONFIG: OpenCrowdConfig = {
  mcpServers: {
    agentcash: { command: "npx", args: ["--yes", "agentcash@0.17"] },
    crowdcode: { command: "npx", args: ["--yes", "crowdcode-mcp@0.5"] }
  },
  // Owner decision (2026-08-24): the x402 token proxy is the default for its
  // OpenRouter-grade serving latency; Venice stays as the wallet-native,
  // explicitly selectable backup (no automatic fallback between them).
  provider: "x402",
  x402: { model: "openai/gpt-5.6-sol", submodel: "openai/gpt-5.6-luna" },
  // Venice defaults are benchmark-informed (GAIA smoke, 2026-08): sonnet led
  // answered-accuracy at 4-11c/question; deepseek-v4-flash subagents were
  // near-free with high cache-hit rates.
  venice: { model: "claude-sonnet-4-6", submodel: "deepseek-v4-flash" },
  openrouter: { model: "auto", submodel: "auto" },
  x402ProxyUrl: "https://x402-tokens.fly.dev/v1",
  llmTimeoutMs: 300_000,
  llmMaxCostCentsPerCall: 100,
  // Venice credit is deposit-only (no withdrawals), so keep single top-ups
  // small; in ask mode each top-up additionally requires user confirmation.
  veniceMaxTopUpCents: 500,
  defaultBudgetCents: 2000,
  approval: "ask"
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
  return config;
}
