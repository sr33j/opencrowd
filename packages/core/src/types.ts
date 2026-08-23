export type PermissionMode = "ask_first" | "yolo" | "blocked";

export type LedgerType =
  | "service_call"
  | "llm_call"
  | "wallet_top_up"
  | "artifact"
  | "shell"
  | "session";

export type LedgerStatus =
  | "ok"
  | "reserved"
  | "charged"
  | "blocked"
  | "rejected"
  | "failed"
  | "refunded"
  | "unknown";

export interface SessionOptions {
  workspaceRoot?: string;
  sessionId?: string;
  budgetCents?: number;
  permissionMode?: PermissionMode;
  shellEnabled?: boolean;
}

export interface SessionState {
  sessionId: string;
  workspaceRoot: string;
  sessionDir: string;
  artifactsDir: string;
  ledgerPath: string;
  budgetCents: number;
  reservedCents: number;
  spentCents: number;
  permissionMode: PermissionMode;
  shellEnabled: boolean;
  /**
   * Provider and exact model IDs resolved at session start; persisted so
   * `run --session` reproduces the same provider/model choices.
   */
  models?: SessionModels;
  createdAt: string;
  updatedAt: string;
}

export interface SessionModels {
  provider: string;
  main: string;
  subagent?: string;
  resolvedAt: string;
}

export interface BudgetStatus {
  session_id: string;
  budget_cents: number;
  spent_cents: number;
  reserved_cents: number;
  remaining_cents: number;
  permission_mode: PermissionMode;
}

export interface LedgerEntry {
  timestamp?: string;
  session_id: string;
  type: LedgerType;
  endpoint?: string;
  model?: string;
  resource_url?: string;
  method?: string;
  quoted_cost_cents?: number;
  charged_cost_cents?: number;
  status: LedgerStatus;
  permission_mode: PermissionMode;
  payment_id?: string;
  tx_hash?: string;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  artifact_path?: string;
  notes?: string;
}

export interface ArtifactRecord {
  path: string;
  bytes: number;
  metadata?: Record<string, unknown>;
}

export interface ProgressEvent {
  type:
    | "requesting_permission"
    | "reserving_spend"
    | "calling_llm"
    | "assistant_delta"
    | "calling_tool"
    | "tool_result"
    | "calling_service"
    | "saving_artifact"
    | "running_shell"
    | "complete";
  message: string;
  data?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

