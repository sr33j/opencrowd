import { loadConfig } from "./config.js";
import { createSession } from "./session.js";
import type { PermissionMode, SessionOptions, SessionState } from "./types.js";

export type OpenCrowdSessionOptions = SessionOptions;

/**
 * Session creation is local-only: the default budget cap comes from
 * configuration, never from a live wallet-balance lookup.
 */
export async function createOpenCrowdSession(options: OpenCrowdSessionOptions = {}): Promise<SessionState> {
  const budgetCents = options.budgetCents
    ?? envCents("OPENCROWD_BUDGET_CENTS")
    ?? (await loadConfig()).defaultBudgetCents;
  return createSession({
    ...options,
    budgetCents,
    permissionMode: options.permissionMode ?? defaultPermissionMode(),
    shellEnabled: options.shellEnabled ?? defaultShellEnabled()
  });
}

function defaultPermissionMode(): PermissionMode {
  const value = process.env.OPENCROWD_PERMISSION_MODE;
  if (value === "ask_first" || value === "yolo" || value === "blocked") {
    return value;
  }
  return "ask_first";
}

function defaultShellEnabled(): boolean {
  const env = process.env.OPENCROWD_SHELL_ENABLED;
  if (env === "0" || env === "false") {
    return false;
  }
  return true;
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
