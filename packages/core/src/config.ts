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
  provider: "venice" | "openrouter";
  venice: ProviderModelDefaults;
  openrouter: ProviderModelDefaults;
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

const DEFAULT_CONFIG: OpenCrowdConfig = {
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
  veniceMaxTopUpCents: 1000,
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
  return config;
}
