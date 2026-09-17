import { loadConfig } from "./config.js";
import { createSession } from "./session.js";
import type { ApprovalMode, SessionOptions, SessionState } from "./types.js";

export type OpenCrowdSessionOptions = SessionOptions;

/**
 * Session creation is local-only: the default budget cap comes from
 * configuration, never from a live wallet-balance lookup.
 */
export async function createOpenCrowdSession(options: OpenCrowdSessionOptions = {}): Promise<SessionState> {
  const config = await loadConfig();
  const budgetCents = options.budgetCents
    ?? envCents("OPENCROWD_BUDGET_CENTS")
    ?? config.defaultBudgetCents;
  return createSession({
    ...options,
    budgetCents,
    perCallCents: options.perCallCents ?? config.llmMaxCostCentsPerCall,
    approvalMode: options.approvalMode ?? envApprovalMode() ?? config.approval,
    shellEnabled: options.shellEnabled ?? defaultShellEnabled()
  });
}

function envApprovalMode(): ApprovalMode | undefined {
  const value = process.env.OPENCROWD_APPROVAL_MODE;
  if (value === "ask" || value === "auto" || value === "off") {
    return value;
  }
  return undefined;
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
