import { budgetStatus, createSession } from "./session.js";
import { isArtifactDirectory, listArtifacts, listOtherChatArtifacts, readArtifact, saveArtifact } from "./artifacts.js";
import { readLedger, appendLedgerEntry } from "./ledger.js";
import { maxShellTimeoutMs, runShell } from "./shell.js";
import { recordLocalHarnessFeedback } from "./harness-feedback.js";
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
    async function listing(prefix: string, rawScope: unknown): Promise<ToolResult> {
        const files = await listArtifacts(context.session, prefix.replace(/^artifacts\/?/, ""));
        const scope = optionalString(rawScope, "scope") ?? "chat";
        if (scope !== "chat" && scope !== "all") throw new Error("scope must be chat or all");
        if (scope === "chat") return ok(files);
        const other = await listOtherChatArtifacts(context.session);
        return ok({
          files,
          other_chats: other.chats,
          ...(other.truncated ? { truncated: true } : {}),
          note: other.chats.length
            ? "Files from other chats are already the owner's and already in their Files view. Read one with run_shell at <shell_dir>/<file> (run_shell starts in this chat's session directory). To attach or upload one from this chat, copy it into artifacts/ first; never re-buy or regenerate a file you already hold."
            : "No other chat of this agent has files."
        });
    }
    switch (name) {
      case "get_budget_status":
        return ok(budgetStatus(context.session));
      case "save_file":
        return ok(await saveArtifact(context.session, requiredString(args.path, "path"), requiredString(args.content, "content"), objectValue(args.metadata)));
      case "read_file": {
        // A folder (or "") lists its files: list_files folded in, so a hosted run
        // keeps within its 32 tools with publish_site added (SRI-166).
        const path = optionalString(args.path, "path") ?? "";
        if (!path || path.endsWith("/") || await isArtifactDirectory(context.session, path))
          return await listing(path, args.scope);
        // A scope names where to list, so a file this chat holds is read
        // whatever the scope. Listing a file as a folder failed with ENOTDIR
        // on every retry until the run was stopped (SRI-213).
        if (args.scope !== undefined) {
          try {
            return ok({ content: await readArtifact(context.session, path) });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return await listing(path, args.scope);
          }
        }
        return ok({ content: await readArtifact(context.session, path) });
      }
      case "list_files":
        return await listing(optionalString(args.prefix, "prefix") ?? "", args.scope);
      case "run_shell": {
        context.onProgress?.({ type: "running_shell", message: "Running gated shell command" });
        const result = await runShell(
          context.session,
          requiredString(args.command, "command"),
          optionalString(args.cwd, "cwd") ?? context.session.sessionDir,
          shellTimeoutMs(args.timeout_ms),
          { signal: context.signal }
        );
        if (result.timed_out || result.exit_code !== 0) return {
          ok: false,
          error: result.timed_out ? "Shell command timed out; inspect partial output before retrying."
            : result.exit_code === null ? "Shell command was terminated; inspect stderr and resource limits before retrying."
            : `Shell command exited with code ${result.exit_code}; inspect stderr and partial output before choosing the next approach.`,
          data: result
        };
        return ok(result);
      }
      case "spawn_subagent":
      case "check_subagents":
        return {
          ok: false,
          error: `${name} is only available inside the agent runtime main loop; it cannot be called through this surface`
        };
      case "complete_session":
        return ok(await completeSession(context.session, requiredString(args.final_message, "final_message")));
      case "deploy_service":
      case "publish_site":
        return { ok: false, error: `${name} is only available to hosted OpenCrowd agents; this run has no hosting supervisor` };
      case "request_secret":
      case "vault_request":
        return { ok: false, error: `${name} is only available to hosted OpenCrowd agents` };
      case "automations":
        return { ok: false, error: `${name} is only available to hosted OpenCrowd agents` };
      case "submit_harness_feedback":
        // Hosted runs send it to CrowdCode through the supervisor; here it stays on this machine.
        return ok(await recordLocalHarnessFeedback(context.session, args));
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
/** Models routinely ask for longer timeouts than the shell allows; clamp instead of failing the call. */
function shellTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  return Math.min(maxShellTimeoutMs(), Math.max(1, value));
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
  // Fractional cents kept: a per-call model charge is usually well under a
  // cent, and rounding each row reported a run's model spend as zero.
  const total = rows.reduce((sum, row) => {
    const value = Number(row.charged_cost_cents || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  return Math.round(total * 10_000) / 10_000;
}
