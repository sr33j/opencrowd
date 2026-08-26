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
  /** Persisted schema version for deterministic upgrades. */
  configVersion: 2;
  /** Vendor MCP servers (AgentCash, CrowdCode). Pin versions. */
  mcpServers: Record<string, McpServerConfig>;
  /** Default LLM provider for new sessions. */
  provider: "blockrun" | "openrouter-x402-proxy" | "venice" | "openrouter";
  blockrun: ProviderModelDefaults;
  "openrouter-x402-proxy": ProviderModelDefaults;
  venice: ProviderModelDefaults;
  openrouter: ProviderModelDefaults;
  /** OpenAI-compatible, x402-metered proxy fronting OpenRouter-grade serving. */
  openrouterX402ProxyUrl: string;
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
  configVersion: 2,
  mcpServers: {
    agentcash: { command: "npx", args: ["--yes", "agentcash@0.17"] },
    crowdcode: { command: "npx", args: ["--yes", "crowdcode-mcp@0.5"] }
  },
  // GAIA provider benchmark (2026-08-25): same-model BlockRun matched the
  // current route's accuracy and completed the sample 6.7x faster. The
  // current x402 route remains the bounded per-call rescue provider.
  provider: "blockrun",
  blockrun: { model: "openai/gpt-5.6-sol", submodel: "openai/gpt-5.6-luna" },
  "openrouter-x402-proxy": { model: "openai/gpt-5.6-sol", submodel: "openai/gpt-5.6-luna" },
  // Venice defaults are benchmark-informed (GAIA smoke, 2026-08): sonnet led
  // answered-accuracy at 4-11c/question; deepseek-v4-flash subagents were
  // near-free with high cache-hit rates.
  venice: { model: "claude-sonnet-4-6", submodel: "deepseek-v4-flash" },
  openrouter: { model: "auto", submodel: "auto" },
  openrouterX402ProxyUrl: "https://x402-tokens.fly.dev/v1",
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
    return normalizeConfig(JSON.parse(text));
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

function normalizeConfig(value: unknown): OpenCrowdConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const legacyProvider = raw.provider === "x402";
  // An `x402` config with no BlockRun section predates 0.3.0, when x402 was
  // the shipped default. Upgrade that default to BlockRun. A later config
  // that explicitly selected the legacy alias already contains BlockRun
  // defaults and is normalized to the proxy's canonical name instead.
  const provider = legacyProvider && raw.blockrun === undefined
    ? "blockrun"
    : normalizeConfigProvider(raw.provider) ?? DEFAULT_CONFIG.provider;
  const proxyDefaults = providerDefaults(
    raw["openrouter-x402-proxy"] ?? raw.x402,
    DEFAULT_CONFIG["openrouter-x402-proxy"]
  );
  const mcpServers = recordValue(raw.mcpServers);
  return {
    configVersion: 2,
    mcpServers: mcpServers ? mcpServers as OpenCrowdConfig["mcpServers"] : DEFAULT_CONFIG.mcpServers,
    provider,
    blockrun: providerDefaults(raw.blockrun, DEFAULT_CONFIG.blockrun),
    "openrouter-x402-proxy": proxyDefaults,
    venice: providerDefaults(raw.venice, DEFAULT_CONFIG.venice),
    openrouter: providerDefaults(raw.openrouter, DEFAULT_CONFIG.openrouter),
    openrouterX402ProxyUrl: stringValue(raw.openrouterX402ProxyUrl)
      ?? stringValue(raw.x402ProxyUrl)
      ?? DEFAULT_CONFIG.openrouterX402ProxyUrl,
    llmTimeoutMs: numberValue(raw.llmTimeoutMs) ?? DEFAULT_CONFIG.llmTimeoutMs,
    llmMaxCostCentsPerCall: numberValue(raw.llmMaxCostCentsPerCall) ?? DEFAULT_CONFIG.llmMaxCostCentsPerCall,
    veniceMaxTopUpCents: numberValue(raw.veniceMaxTopUpCents) ?? DEFAULT_CONFIG.veniceMaxTopUpCents,
    defaultBudgetCents: numberValue(raw.defaultBudgetCents) ?? DEFAULT_CONFIG.defaultBudgetCents,
    approval: raw.approval === "auto" || raw.approval === "off" ? raw.approval : "ask"
  };
}

function normalizeConfigProvider(value: unknown): OpenCrowdConfig["provider"] | undefined {
  if (value === "x402") return "openrouter-x402-proxy";
  return value === "blockrun" || value === "openrouter-x402-proxy" || value === "venice" || value === "openrouter"
    ? value
    : undefined;
}

function providerDefaults(value: unknown, fallback: ProviderModelDefaults): ProviderModelDefaults {
  const record = recordValue(value);
  return {
    model: stringValue(record?.model) ?? fallback.model,
    submodel: stringValue(record?.submodel) ?? fallback.submodel
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
