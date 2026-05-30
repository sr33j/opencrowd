import { searchServices } from "./bazaar.js";
import { budgetStatus, createSession } from "./session.js";
import { addAllowedService, blockService, listAllowedServices, removeAllowedService, requestServicePermission } from "./permissions.js";
import { callPaidService } from "./x402.js";
import { listArtifacts, readArtifact, saveArtifact } from "./artifacts.js";
import { readLedger, appendLedgerEntry } from "./ledger.js";
import { runShell } from "./shell.js";
import type { ToolName } from "./tool-definitions.js";
import type { ProgressEvent, ServiceCaps, SessionState, ToolResult } from "./types.js";

export interface ToolContext {
  session: SessionState;
  onProgress?: (event: ProgressEvent) => void;
}

export async function executeTool(name: ToolName, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "search_services":
        return ok(await searchServices(requiredString(args.query, "query"), {
          maxBudgetCents: optionalInteger(args.max_budget_cents, "max_budget_cents"),
          limit: optionalInteger(args.limit, "limit"),
          onProgress: context.onProgress
        }));
      case "get_budget_status":
        return ok(budgetStatus(context.session));
      case "list_allowed_services":
        return ok(await listAllowedServices());
      case "add_allowed_service":
        return ok(await addAllowedService(requiredString(args.resource_url, "resource_url"), caps(args.caps)));
      case "remove_allowed_service":
        await removeAllowedService(requiredString(args.resource_url, "resource_url"));
        return ok({ removed: true });
      case "block_service":
        return ok(await blockService(requiredString(args.resource_url, "resource_url")));
      case "request_service_permission":
        return ok(await requestServicePermission(requiredString(args.resource_url, "resource_url"), requiredString(args.reason, "reason"), caps(args.caps)));
      case "call_service":
        return ok(await callPaidService(context.session, {
          resource_url: requiredString(args.resource_url, "resource_url"),
          method: optionalString(args.method, "method") ?? "POST",
          quoted_cost_cents: requiredInteger(args.quoted_cost_cents, "quoted_cost_cents"),
          content_type: optionalString(args.content_type, "content_type"),
          body: args.body
        }, { onProgress: context.onProgress }));
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
          optionalInteger(args.timeout_ms, "timeout_ms") ?? 10_000
        ));
      case "complete_session":
        return ok(await completeSession(context.session, requiredString(args.final_message, "final_message")));
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function completeSession(session: SessionState, finalMessage: string): Promise<Record<string, unknown>> {
  await appendLedgerEntry(session.ledgerPath, {
    session_id: session.sessionId,
    type: "session",
    status: "ok",
    permission_mode: session.permissionMode,
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

function requiredInteger(value: unknown, label: string): number {
  const next = optionalInteger(value, label);
  if (next === undefined) {
    throw new Error(`${label} is required`);
  }
  return next;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function caps(value: unknown): ServiceCaps {
  if (value === undefined || value === null) {
    return {};
  }
  const object = objectValue(value);
  return {
    max_cost_cents: optionalInteger(object?.max_cost_cents, "caps.max_cost_cents"),
    session_max_cents: optionalInteger(object?.session_max_cents, "caps.session_max_cents"),
    methods: Array.isArray(object?.methods) ? object.methods.map(String) : undefined
  };
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
