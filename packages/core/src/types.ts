/**
 * External-service purchase approval policy for a session.
 * - ask: require approval unless a stored rule authorizes the service.
 * - auto: skip prompts; blocks, caps, reputation, lifecycle, budget still apply.
 * - off: prohibit external-service purchases entirely.
 */
export type ApprovalMode = "ask" | "auto" | "off";

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
  perCallCents?: number;
  approvalMode?: ApprovalMode;
  shellEnabled?: boolean;
}

export interface SessionState {
  sessionId: string;
  workspaceRoot: string;
  sessionDir: string;
  artifactsDir: string;
  ledgerPath: string;
  budgetCents: number;
  perCallCents?: number;
  /** A query is one user task; lifetime spend remains in spentCents/ledger. */
  query?: {
    id: string; limitCents: number; startSpentCents: number;
    pending?: import("./budget.js").SpendingApproval;
    approved?: Record<string, number>;
  };
  reservedCents: number;
  spentCents: number;
  approvalMode: ApprovalMode;
  shellEnabled: boolean;
  /**
   * Provider and exact model IDs resolved at session start; persisted so
   * `run --session` reproduces the same provider/model choices.
   */
  models?: SessionModels;
  /** Service knowledge tree loaded for this session (version + source), for reproducibility. */
  knowledge?: SessionKnowledge;
  createdAt: string;
  updatedAt: string;
}

export interface SessionKnowledge {
  version: string;
  source: string;
  loadedAt: string;
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
  approval_mode: ApprovalMode;
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
  approval_mode: ApprovalMode;
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
