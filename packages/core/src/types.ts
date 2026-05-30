export type PermissionMode = "ask_first" | "yolo" | "blocked";

export type LedgerType =
  | "search"
  | "permission"
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
  | "refunded";

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
  createdAt: string;
  updatedAt: string;
}

export interface BudgetStatus {
  session_id: string;
  budget_cents: number;
  spent_cents: number;
  reserved_cents: number;
  remaining_cents: number;
  permission_mode: PermissionMode;
}

export interface ServiceCaps {
  max_cost_cents?: number;
  session_max_cents?: number;
  methods?: string[];
}

export interface PermissionEntry {
  resource_url: string;
  mode: PermissionMode;
  caps: ServiceCaps;
  created_at: string;
  updated_at: string;
  notes?: string;
}

export interface ServiceCandidate {
  resource_url: string;
  title?: string;
  description?: string;
  methods: string[];
  price_cents?: number;
  price_display?: string;
  currency?: string;
  tags: string[];
  score: number;
  raw?: unknown;
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
    | "searching"
    | "ranking"
    | "checking_budget"
    | "checking_permission"
    | "requesting_permission"
    | "reserving_spend"
    | "signing_with_ows"
    | "calling_llm"
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

export interface CallServiceInput {
  resource_url: string;
  method: string;
  quoted_cost_cents: number;
  content_type?: string;
  body?: unknown;
}

export interface PaidCallResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  charged_cost_cents: number;
  tx_hash?: string;
  artifact_path?: string;
}
