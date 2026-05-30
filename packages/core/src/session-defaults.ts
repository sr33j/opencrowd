import { loadConfig } from "./config.js";
import { createSession } from "./session.js";
import { walletBalance } from "./ows.js";
import type { PermissionMode, SessionOptions, SessionState } from "./types.js";

export type OpenCrowdSurface = "cli" | "mcp" | "local-api";

export interface OpenCrowdSessionOptions extends SessionOptions {
  surface?: OpenCrowdSurface;
  useWalletBalanceBudget?: boolean;
}

export async function createOpenCrowdSession(options: OpenCrowdSessionOptions = {}): Promise<SessionState> {
  const config = await loadConfig();
  const surface = options.surface ?? "cli";
  const budgetCents = options.budgetCents ?? envCents("OPENCROWD_BUDGET_CENTS") ?? (
    options.useWalletBalanceBudget === false ? 0 : await activeWalletBudgetCents()
  );
  return createSession({
    ...options,
    budgetCents,
    permissionMode: options.permissionMode ?? defaultPermissionMode(),
    shellEnabled: options.shellEnabled ?? defaultShellEnabled(surface, config)
  });
}

function defaultPermissionMode(): PermissionMode {
  const value = process.env.OPENCROWD_PERMISSION_MODE;
  if (value === "ask_first" || value === "yolo" || value === "blocked") {
    return value;
  }
  return "yolo";
}

function defaultShellEnabled(surface: OpenCrowdSurface, config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  const env = process.env.OPENCROWD_SHELL_ENABLED;
  if (env === "1" || env === "true") {
    return true;
  }
  if (env === "0" || env === "false") {
    return false;
  }
  if (surface === "mcp") {
    return config.mcpShellEnabled;
  }
  if (surface === "local-api") {
    return config.localApiShellEnabled;
  }
  return true;
}

async function activeWalletBudgetCents(): Promise<number> {
  try {
    const balance = await walletBalance();
    if (balance.spendable_balance_cents !== undefined) {
      return Math.max(0, balance.spendable_balance_cents);
    }
    const parsed = Number(balance.spendable_balance);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed * 100)) : 0;
  } catch {
    return 0;
  }
}

function envCents(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer number of cents`);
  }
  return Math.round(parsed);
}
