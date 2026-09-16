import { budgetStatus, createSession } from "./session.js";
import { listArtifacts, readArtifact, saveArtifact } from "./artifacts.js";
import { readLedger, appendLedgerEntry } from "./ledger.js";
import { runShell } from "./shell.js";
import type { ToolName } from "./tool-definitions.js";
import type { ProgressEvent, SessionState, ToolResult } from "./types.js";

export interface ToolContext {
  signal?: AbortSignal;
  session: SessionState;
  onProgress?: (event: ProgressEvent) => void;
}

/** Execute one built-in local tool. Paid tools live in the economy gateway. */
export async function executeTool(name: ToolName, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    context.signal?.throwIfAborted();
    switch (name) {
      case "get_budget_status":
        return ok(budgetStatus(context.session));
      case "save_file":
        return ok(await saveArtifact(context.session, requiredString(args.path, "path"), requiredString(args.content, "content"), objectValue(args.metadata)));
      case "read_file":
        return ok({ content: await readArtifact(context.session, requiredString(args.path, "path")) });
      case "list_files":
        return ok(await listArtifacts(context.session, optionalString(args.prefix, "prefix") ?? ""));
      case "run_shell":
        context.onProgress?.({ type: "running_shell", message: "Running gated shell command" });
        return ok(await runShell(
          context.session,
          requiredString(args.command, "command"),
          optionalString(args.cwd, "cwd") ?? context.session.workspaceRoot,
          shellTimeoutMs(args.timeout_ms),
          { signal: context.signal }
        ));
      case "spawn_subagent":
      case "check_subagents":
        return {
          ok: false,
          error: `${name} is only available inside the agent runtime main loop; it cannot be called through this surface`
        };
      case "complete_session":
        return ok(await completeSession(context.session, requiredString(args.final_message, "final_message")));
      case "deploy_service":
        return { ok: false, error: "deploy_service is only available to hosted OpenCrowd agents; this run has no hosting supervisor" };
      case "request_secret":
        return { ok: false, error: "request_secret is only available to hosted OpenCrowd agents" };
    }
  } catch (error) {
    context.signal?.throwIfAborted();
    return { ok: false, error: (error as Error).message };
  }
}

export async function completeSession(session: SessionState, finalMessage: string): Promise<Record<string, unknown>> {
  await appendLedgerEntry(session.ledgerPath, {
    session_id: session.sessionId,
    type: "session",
    status: "ok",
    approval_mode: session.approvalMode,
    notes: finalMessage
  });
  const rows = await readLedger(session.ledgerPath);
  const purchases = rows.filter((row) => row.type === "service_call");
  const llmCalls = rows.filter((row) => row.type === "llm_call");
  const walletTopUps = rows.filter((row) => row.type === "wallet_top_up");
  const llmSpendCents = sumCents(llmCalls);
  const externalServiceSpendCents = sumCents(purchases);
  const walletTopUpSpendCents = sumCents(walletTopUps);
  return {
    final_message: finalMessage,
    budget: {
      ...budgetStatus(session),
      llm_spend_cents: llmSpendCents,
      external_service_spend_cents: externalServiceSpendCents,
      wallet_top_up_spend_cents: walletTopUpSpendCents,
      total_spent_cents: session.spentCents
    },
    llm_calls: llmCalls,
    wallet_top_ups: walletTopUps,
    service_calls: purchases,
    purchases,
    artifacts: [...new Set(rows.filter((row) => row.artifact_path).map((row) => row.artifact_path))]
  };
}

export async function createToolSession(options?: Parameters<typeof createSession>[0]): Promise<SessionState> {
  return createSession(options);
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
const MAX_SHELL_TIMEOUT_MS = 30_000;

/** Models routinely ask for longer timeouts than the shell allows; clamp instead of failing the call. */
function shellTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  return Math.min(MAX_SHELL_TIMEOUT_MS, Math.max(1, value));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("value must be an object");
  }
  return value as Record<string, unknown>;
}

function sumCents(rows: Record<string, string>[]): number {
  return rows.reduce((total, row) => {
    const value = Number(row.charged_cost_cents || 0);
    return total + (Number.isFinite(value) ? Math.round(value) : 0);
  }, 0);
}
