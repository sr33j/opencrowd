import { createHash } from "node:crypto";
import { contextLimits, isOutputLimitFinishReason, FinancialStateSchema, type FinancialState } from "@opencrowd/protocol";
import { completeWithContext, type ContextState } from "./context.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadKnowledgeTree, renderCapabilityIndex, type KnowledgeOptions } from "./knowledge.js";
import {
  atomicWrite,
  conversationPath,
  appendLedgerEntry,
  budgetStatus,
  BudgetExhaustedError, SpendingApprovalRequired, SpendingDeclined, type Reservation,
  completeSession,
  executeTool,
  finalizeReservation,
  readLedger,
  releaseReservation,
  remainingBudgetCents,
  reserveBudget,
  OPEN_CROWD_TOOLS,
  HOSTED_ONLY_TOOL_NAMES, SUBAGENT_TOOL_NAMES,
  TOOL_NAMES,
  type ProgressEvent,
  type SessionState,
  type ToolContext,
  type ToolResult,
  type ToolName
} from "@opencrowd/core";
import {
  InsufficientCreditError, PaymentUncertainError,
  type LlmUsage,
  type ProviderCompletion,
  type ProviderModel,
  type TypedLlmProvider,
  type WireToolDefinition
} from "./providers.js";

export * from "./providers.js";
export * from "./blockrun.js";
export * from "./llm-runtime.js";
export * from "./runtime.js";
export * from "./worker.js";
export * from "./hosted-provider.js";
export * from "./hosted-economy.js";
export * from "./inbox.js";
import type { SteeringInbox } from "./inbox.js";
export * from "./x402-proxy.js";
export * from "./knowledge.js";
export * from "./context.js";

export interface LlmMessage {
  /** Internal archive marker; adapters omit it from provider requests. */
  contextArchive?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  /** A built-in ToolName or a connector-ingested vendor tool name. */
  name: string;
  arguments: Record<string, unknown>;
}

export interface DynamicToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DynamicToolsOption {
  definitions: DynamicToolDefinition[];
  execute: (name: string, args: Record<string, unknown>, operationId?: string) => Promise<ToolResult>;
}

export interface LlmResponse {
  usage?: LlmUsage;
  content: string;
  toolCalls: LlmToolCall[];
  /** OpenAI-compatible reason the provider stopped generating. */
  finishReason?: string;
}

export interface LlmProvider {
  complete(messages: LlmMessage[], context?: { signal?: AbortSignal; operationId?: string }): Promise<LlmResponse>;
}

export type ToolExecutor = (
  name: ToolName,
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolResult>;

export interface MockLlmProviderOptions {
  seed?: string | number;
  endProbability?: number;
  maxToolTurns?: number;
  tools?: ToolName[];
}

export class MockLlmProvider implements LlmProvider {
  private readonly random: SeededRandom;
  private readonly endProbability: number;
  private readonly maxToolTurns: number;
  private readonly tools: ToolName[];
  private turn = 0;

  constructor(options: MockLlmProviderOptions = {}) {
    this.random = new SeededRandom(options.seed ?? "opencrowd-test-mode");
    this.endProbability = options.endProbability ?? 0.35;
    this.maxToolTurns = options.maxToolTurns ?? 8;
    this.tools = options.tools?.length ? options.tools : TOOL_NAMES.filter((name) => name !== "spawn_subagent" && name !== "check_subagents");
  }

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    this.turn += 1;
    const currentRunMessages = messages.slice(lastUserMessageIndex(messages) + 1);
    const toolResultCount = currentRunMessages.filter((message) => message.role === "tool").length;
    const shouldEnd = toolResultCount > 0
      && (toolResultCount >= this.maxToolTurns || this.random.next() < this.endProbability);
    if (shouldEnd) {
      return {
        content: `Mock test mode completed after ${toolResultCount} tool result${toolResultCount === 1 ? "" : "s"}.`,
        toolCalls: []
      };
    }

    const selectableTools = this.tools.filter((tool) => tool !== "complete_session" || toolResultCount > 0);
    const name = selectableTools[this.random.integer(selectableTools.length)] ?? "get_budget_status";
    return {
      content: "",
      toolCalls: [{
        id: `mock_tool_${this.turn}`,
        name,
        arguments: mockToolArguments(name, messages, this.turn, this.random)
      }]
    };
  }
}

function lastUserMessageIndex(messages: LlmMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return index;
    }
  }
  return -1;
}

/**
 * Local-tools-only mock executor for tests and demo mode. Paid capability in
 * demo mode runs through the REAL economy gateway over in-memory mock
 * adapters, so the enforced lifecycle is exercised, not simulated.
 */
export function createMockToolExecutor(): ToolExecutor {
  return async (name, args, context) => {
    try {
      switch (name) {
        case "get_budget_status":
          return ok(budgetStatus(context.session));
        case "save_file":
          return ok({
            path: `artifacts/${stringValue(args.path) ?? "mock-output.txt"}`,
            bytes: Buffer.byteLength(stringValue(args.content) ?? ""),
            metadata: objectValue(args.metadata)
          });
        case "read_file":
          return ok({ content: `Mock file content for ${stringValue(args.path) ?? "unknown path"}.` });
        case "list_files":
          return ok(["mock-output.txt"].filter((path) => path.startsWith(stringValue(args.prefix) ?? "")));
        case "run_shell":
          context.onProgress?.({ type: "running_shell", message: "Mock running gated shell command" });
          return ok({
            command: stringValue(args.command) ?? "",
            cwd: stringValue(args.cwd) ?? context.session.workspaceRoot,
            exit_code: 0,
            timed_out: false,
            stdout: "mock shell stdout\n",
            stderr: ""
          });
        case "spawn_subagent":
          return ok({
            subagent_id: `${context.session.sessionId}#sub-mock`,
            model: "mock-test-mode",
            outcome: "completed",
            final_message: `Mock subagent completed task: ${stringValue(args.task) ?? "mock subtask"}`,
            turns: 1,
            trajectory_path: `${context.session.sessionDir}/subagents/mock/messages.jsonl`,
            artifacts_written: []
          });
        case "check_subagents":
          return ok({ subagents: [] });
        case "complete_session":
          return ok(await completeSession(context.session, stringValue(args.final_message) ?? "Mock test mode session completed."));
        case "deploy_service":
          return { ok: false, error: "deploy_service is unavailable in mock mode" };
        case "request_secret":
          return { ok: false, error: "request_secret is unavailable in mock mode" };
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  };
}

function mockToolArguments(
  name: ToolName,
  messages: LlmMessage[],
  turn: number,
  _random: SeededRandom
): Record<string, unknown> {
  const task = [...messages].reverse().find((message) => message.role === "user")?.content ?? "mock OpenCrowd task";
  switch (name) {
    case "get_budget_status":
    case "check_subagents":
    case "list_files":
      return {};
    case "save_file":
      return {
        path: `mock-output-${turn}.txt`,
        content: `Mock output for: ${task}`,
        metadata: { mock: true, turn }
      };
    case "read_file":
      return { path: "mock-output.txt" };
    case "run_shell":
      return { command: "echo mock test mode", cwd: ".", timeout_ms: 1000 };
    case "spawn_subagent":
      return { task: `Mock subtask for: ${task.slice(0, 80)}` };
    case "complete_session":
      return { final_message: `Mock test mode completed task: ${task.slice(0, 120)}` };
    case "deploy_service":
      return { slug: "mock-service", name: "Mock service", description: task.slice(0, 120), price_usd: "0.001", entry: "service/index.js", routes: [] };
    case "request_secret":
      return { name: "MOCK_API_KEY", allowed_hosts: ["api.example.com"], reason: `Mock secret for: ${task.slice(0, 80)}` };
  }
}

class SeededRandom {
  private state: number;

  constructor(seed: string | number) {
    this.state = normalizeSeed(seed);
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  integer(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      return 0;
    }
    return Math.floor(this.next() * maxExclusive);
  }
}

function normalizeSeed(seed: string | number): number {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0 || 1;
  }
  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface BudgetedLlmOptions {
  /** Exact model ID resolved for this session/role. */
  model: string;
  /** Local reservation ceiling per request, reconciled to actual cost. */
  maxCostCentsPerCall: number;
  /** Restrict the built-in tools advertised to the model. */
  tools?: ToolName[];
  /** Connector/gateway tool definitions to advertise alongside built-ins. */
  extraTools?: DynamicToolDefinition[];
  /** Ledger session_id override so subagent spend stays tagged in the shared ledger. */
  ledgerSessionId?: string;
  /** Stable per-session cache key forwarded to the provider. */
  promptCacheKey?: string;
  /** Catalog pricing for cost estimation when the provider reports none. */
  catalog?: ProviderModel[];
  /** Output cap forwarded to the provider as max_tokens. */
  maxOutputTokens?: number;
  /** Streaming text callback (time-to-first-token). */
  onTextDelta?: (delta: string) => void;
  /**
   * Ceiling for one automatic credit top-up when the provider signals
   * exhausted prepaid credit. The actual amount is further bounded by the
   * remaining session allowance; at most one top-up and one retry happen.
   */
  maxTopUpCentsPerAction?: number;
  /**
   * Per-call rescue after the primary fails transiently twice in a row.
   * Sessions never silently migrate providers; each rescue is a single call
   * on the backup, recorded in the ledger with the reason.
   */
  fallback?: LlmFallbackTarget;
  /**
   * Ask-mode confirmation for provider money/routing actions — a rescue
   * call on the backup provider, or an automatic credit top-up (Venice
   * deposits are non-withdrawable). In ask mode an absent handler denies
   * the action, mirroring purchase approvals.
   */
  confirmProviderAction?: (request: ProviderActionRequest) => Promise<boolean>;
}

export interface LlmFallbackTarget {
  provider: TypedLlmProvider;
  model: string;
}

export interface ProviderActionRequest {
  action: "rescue_call" | "credit_top_up";
  providerId: string;
  detail: string;
  amountCents: number;
}

/**
 * Consecutive per-call failovers per primary provider instance (process-wide:
 * the shared provider is one instance). At the threshold the primary is
 * treated as degraded and calls go straight to the backup, skipping the
 * doomed attempt+retry against a dead route. A primary success below the
 * threshold resets the count; once degraded, the primary stays parked for
 * the rest of the process, and a fresh run probes it again.
 */
const failoverCounts = new WeakMap<TypedLlmProvider, number>();
const DEGRADED_AFTER_FAILOVERS = 3;

/**
 * Adapts a typed provider to the loop-facing LlmProvider interface, adding
 * the local budget lifecycle: reserve before the request, finalize with the
 * actual cost, and append a normalized llm_call ledger row (including cache
 * metrics). This is the only place LLM spend touches the budget.
 */
export class BudgetedLlmProvider implements LlmProvider {
  constructor(
    private readonly session: SessionState,
    private readonly provider: TypedLlmProvider,
    private readonly options: BudgetedLlmOptions
  ) {}

  async complete(messages: LlmMessage[], context?: { signal?: AbortSignal }): Promise<LlmResponse> {
    context?.signal?.throwIfAborted();
    const definitions = wireToolDefinitions(this.options.tools, this.options.extraTools);
    let reservation: Reservation | undefined;
    const started = Date.now();
    const fallback = this.options.fallback;
    // Degraded-first routing is skipped in ask mode: every backup call there
    // is individually confirmed, so the primary is always probed first.
    const degraded = fallback !== undefined && this.session.approvalMode !== "ask"
      && (failoverCounts.get(this.provider) ?? 0) >= DEGRADED_AFTER_FAILOVERS;
    let used = degraded && fallback
      ? { provider: fallback.provider, model: fallback.model, note: `primary ${this.provider.id} degraded after repeated failovers` }
      : { provider: this.provider, model: this.options.model, note: undefined as string | undefined };
    const authorize = async (amountCents: number, identity: string) => {
      if (reservation) await releaseReservation(this.session, reservation);
      reservation = undefined;
      reservation = await reserveBudget(this.session, amountCents, { description: `${used.provider.id} · ${used.model}`, identity });
    };
    const attempt = async (): Promise<ProviderCompletion> => {
      if (!used.provider.quotesPayments) {
        const model = this.options.catalog?.find(m => m.id === used.model);
        const estimate = this.session.query && model?.inputCostCentsPer1k !== undefined && model.outputCostCentsPer1k !== undefined
          ? Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools: definitions }), "utf8") * model.inputCostCentsPer1k / 1000
            + (this.options.maxOutputTokens ?? 1024) * model.outputCostCentsPer1k / 1000)
          : this.options.maxCostCentsPerCall;
        await authorize(estimate, JSON.stringify({ provider: used.provider.id, model: used.model, messages, definitions }));
      }
      return used.provider.complete({
        model: used.model, messages, tools: definitions, authorizePayment: authorize,
        promptCacheKey: this.options.promptCacheKey, onTextDelta: this.options.onTextDelta,
        maxOutputTokens: this.options.maxOutputTokens, signal: context?.signal
      });
    };
    try {
      let completion: ProviderCompletion;
      try {
        completion = await attempt();
      } catch (error) {
        context?.signal?.throwIfAborted();
        if (error instanceof InsufficientCreditError && used.provider.topUpCredit) {
          // Exhausted prepaid credit: exactly one bounded top-up, one retry.
          await this.performBoundedTopUp(error, used.provider);
          completion = await attempt();
        } else if (isTransientProviderError(error)) {
          // Escalation ladder for transient faults (timeouts, stalls, rate
          // limits, dropped connections): one retry on the same provider,
          // then — if configured — one rescue call on the backup provider.
          // Anything else surfaces unchanged; there is no retry loop.
          try {
            completion = await attempt();
          } catch (second) {
            if (!fallback || used.provider === fallback.provider || !isTransientProviderError(second)) {
              throw second;
            }
            const approved = await this.approveProviderAction({
              action: "rescue_call",
              providerId: fallback.provider.id,
              detail: `one rescue LLM call on ${fallback.provider.id} (${fallback.model}) after ${this.provider.id} failed twice: ${truncateNote((second as Error).message)}`,
              amountCents: this.options.maxCostCentsPerCall
            });
            if (!approved) {
              throw second;
            }
            failoverCounts.set(this.provider, (failoverCounts.get(this.provider) ?? 0) + 1);
            used = {
              provider: fallback.provider,
              model: fallback.model,
              note: `failover from ${this.provider.id} after: ${truncateNote((second as Error).message)}`
            };
            completion = await attempt();
          }
        } else {
          throw error;
        }
      }
      if (used.provider === this.provider) {
        failoverCounts.delete(this.provider);
      }
      const charged = used.provider.quotesPayments && completion.usage.costCents === undefined && reservation
        ? reservation.amountCents : chargedCostCents(completion.usage, used.model, this.options.catalog);
      if (reservation) await finalizeReservation(this.session, reservation, charged);
      await appendLedgerEntry(this.session.ledgerPath, {
        session_id: this.options.ledgerSessionId ?? this.session.sessionId,
        type: "llm_call",
        endpoint: used.provider.id,
        model: used.model,
        method: "POST",
        quoted_cost_cents: reservation?.amountCents ?? this.options.maxCostCentsPerCall,
        charged_cost_cents: charged,
        status: "charged",
        approval_mode: this.session.approvalMode,
        latency_ms: Date.now() - started,
        input_tokens: completion.usage.inputTokens,
        output_tokens: completion.usage.outputTokens,
        notes: joinNotes(usageMetricsNote(completion), used.note)
      });
      const valid = validToolNames(this.options.tools, this.options.extraTools);
      return {
        content: completion.content,
        toolCalls: completion.toolCalls.filter((toolCall) => valid.has(toolCall.name)),
        finishReason: completion.finishReason,
        usage: completion.usage
      };
    } catch (error) {
      if (reservation) {
        if (error instanceof PaymentUncertainError) await finalizeReservation(this.session, reservation, reservation.amountCents);
        else await releaseReservation(this.session, reservation);
      }
      await appendLedgerEntry(this.session.ledgerPath, {
        session_id: this.options.ledgerSessionId ?? this.session.sessionId,
        type: "llm_call",
        endpoint: used.provider.id,
        model: used.model,
        method: "POST",
        quoted_cost_cents: reservation?.amountCents ?? this.options.maxCostCentsPerCall,
        charged_cost_cents: error instanceof PaymentUncertainError ? reservation?.amountCents ?? 0 : 0,
        status: error instanceof PaymentUncertainError ? "unknown" : "failed",
        approval_mode: this.session.approvalMode,
        latency_ms: Date.now() - started,
        notes: joinNotes(truncateNote((error as Error).message), used.note)
      });
      throw error;
    }
  }

  /**
   * One credit top-up bounded by the per-action ceiling and the remaining
   * session allowance. The top-up is recorded as a cash-flow fact
   * (wallet_top_up ledger row) and does not enter session spend: LLM usage
   * consumes the credit and is what counts against the budget, so the two
   * are never double-counted.
   */
  private async performBoundedTopUp(error: InsufficientCreditError, provider: TypedLlmProvider): Promise<void> {
    const ceilingCents = this.options.maxTopUpCentsPerAction ?? 0;
    if (ceilingCents <= 0) {
      throw error;
    }
    if (this.session.approvalMode === "off") {
      // A top-up is a real (non-withdrawable) deposit, not plain LLM spend.
      throw new Error(`${error.message} Automatic top-ups are disabled in approval mode \`off\`; top up manually with /fund.`);
    }
    const allowanceCents = remainingBudgetCents(this.session);
    const amountCents = this.session.query ? Math.max(ceilingCents, Math.ceil((error.minimumTopUpUsd ?? 0) * 100)) : Math.min(ceilingCents, allowanceCents);
    const minimumCents = error.minimumTopUpUsd !== undefined ? Math.ceil(error.minimumTopUpUsd * 100) : 0;
    if (amountCents <= 0 || amountCents < minimumCents) {
      throw new Error(
        `${error.message} An automatic top-up needs at least ${formatCents(Math.max(minimumCents, 1))} ` +
        `but only ${formatCents(Math.max(allowanceCents, 0))} of session allowance remains (per-top-up cap ${formatCents(ceilingCents)}). ` +
        "Raise the session budget with /budget or top up manually."
      );
    }
    const approved = await this.approveProviderAction({
      action: "credit_top_up",
      providerId: provider.id,
      detail: `deposit ${formatCents(amountCents)} of wallet USDC as ${provider.id} prepaid credit (deposits are not withdrawable)`,
      amountCents
    });
    if (!approved) {
      throw new Error(`${error.message} The automatic top-up was declined; top up manually with /fund or approve it next time.`);
    }
    const deposit = this.session.query ? await reserveBudget(this.session, amountCents, {
      description: `${provider.id} prepaid credit deposit (not withdrawable)`, identity: `top-up:${provider.id}:${amountCents}`
    }) : undefined;
    try { await provider.topUpCredit!(amountCents / 100); }
    finally { if (deposit) await releaseReservation(this.session, deposit); }
    await appendLedgerEntry(this.session.ledgerPath, {
      session_id: this.options.ledgerSessionId ?? this.session.sessionId,
      type: "wallet_top_up",
      endpoint: provider.id,
      quoted_cost_cents: amountCents,
      charged_cost_cents: amountCents,
      status: "charged",
      approval_mode: this.session.approvalMode,
      notes: "automatic bounded provider credit top-up (cash flow; usage is billed against the budget)"
    });
  }

  /** Ask mode requires explicit confirmation; auto (and off, for rescues) proceeds. */
  private async approveProviderAction(request: ProviderActionRequest): Promise<boolean> {
    if (this.session.approvalMode !== "ask") {
      return true;
    }
    return await this.options.confirmProviderAction?.(request) ?? false;
  }
}

/** Timeouts, stalls, rate limits, server errors, and dropped connections merit the retry/failover ladder. */
function isTransientProviderError(error: unknown): boolean {
  if (error instanceof InsufficientCreditError || error instanceof BudgetExhaustedError || error instanceof SpendingApprovalRequired || error instanceof SpendingDeclined || error instanceof PaymentUncertainError) {
    return false;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // "rejected a signed payment" is transient by measurement: the proxy's
  // payment validation flakes (~25% observed) and a fresh challenge+signature
  // on the very next attempt succeeds.
  return /TIMEOUT|timed out|stalled|429|rate limit|HTTP 5\d\d|rejected a signed payment|payment was rejected|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network|terminated|unexpected EOF/i.test(message);
}

function truncateNote(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const present = notes.filter((note): note is string => note !== undefined && note !== "");
  return present.length > 0 ? present.join(" | ") : undefined;
}

/**
 * Actual cost: provider-reported, else estimated from catalog pricing, else 0.
 * Fractional cents are preserved — most single calls cost well under a cent,
 * and rounding each to an integer would erase real spend from the ledger.
 */
function chargedCostCents(usage: LlmUsage, modelId: string, catalog?: ProviderModel[]): number {
  if (usage.costCents !== undefined) {
    return Math.max(0, roundCents(usage.costCents));
  }
  const model = catalog?.find((candidate) => candidate.id === modelId);
  if (model && (model.inputCostCentsPer1k !== undefined || model.outputCostCentsPer1k !== undefined)
    && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    const cents = ((usage.inputTokens ?? 0) / 1_000) * (model.inputCostCentsPer1k ?? 0)
      + ((usage.outputTokens ?? 0) / 1_000) * (model.outputCostCentsPer1k ?? 0);
    return Math.max(0, roundCents(cents));
  }
  return 0;
}

function roundCents(cents: number): number {
  return Math.round(cents * 10_000) / 10_000;
}

/**
 * Cache hit/write metrics and time-to-first-token, recorded so repeated-turn
 * hit rates and streaming latency can be verified from the ledger.
 */
function usageMetricsNote(completion: ProviderCompletion): string | undefined {
  const usage = completion.usage;
  if (usage.cachedInputTokens === undefined && usage.cacheWriteTokens === undefined && completion.firstTokenMs === undefined) {
    return undefined;
  }
  return JSON.stringify({
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    first_token_ms: completion.firstTokenMs
  });
}

function wireToolDefinitions(names?: ToolName[], extraTools?: DynamicToolDefinition[]): WireToolDefinition[] {
  return [
    ...OPEN_CROWD_TOOLS.filter((tool) => !names || names.includes(tool.name)).map((tool) => ({
      name: tool.name as string,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>
    })),
    ...(extraTools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  ];
}

/** Typed provider + resolved model for one loop role (main or subagent). */
export interface TypedLlmRuntime {
  provider: TypedLlmProvider;
  model: string;
  maxCostCentsPerCall: number;
  maxTopUpCentsPerAction?: number;
  promptCacheKey?: string;
  catalog?: ProviderModel[];
  onTextDelta?: (delta: string) => void;
  /** Per-call rescue provider+model after two consecutive transient failures. */
  fallback?: LlmFallbackTarget;
  /** Ask-mode confirmation for rescue calls and credit top-ups. */
  confirmProviderAction?: (request: ProviderActionRequest) => Promise<boolean>;
}

export interface LoopCheckpoint {
  deliveredMessageIds?: string[];
  context?: ContextState;
  messages: LlmMessage[];
  turn: number;
  response?: LlmResponse;
  completedTools: Record<string, ToolResult>;
  completionNudges: number;
  outputContinuationNudges: number;
  outputContinuationPrefix: string;
  serviceCallFailures: number;
  repeatedFailures: Array<[string, number]>;
}

/** Static fallback capability index; replaced by `AgentRunOptions.capabilityIndex` when a knowledge base is supplied. */
export const DEFAULT_CAPABILITY_INDEX =
  "Paid capability index — fast paths the wallet can buy in one call, typically under a cent: web search and news (Exa-grade) plus page scraping via https://stableenrich.dev; social media data via https://stablesocial.dev; more via find_paid_service.";

export interface AgentRunOptions {
  inbox?: SteeringInbox;
  signal?: AbortSignal;
  runId?: string;
  resume?: LoopCheckpoint;
  onCheckpoint?: (checkpoint: LoopCheckpoint) => Promise<void>;
  /** Durable hosted gateway failures must escape the loop, never be parsed/retried. */
  hosted?: boolean;
  /** Authoritative hosted ledger and wallet snapshot; local budgets are not cloud balances. */
  financialState?: () => Promise<FinancialState>;
  /** Scripted/mock provider (tests, demo). Exactly one of provider/llm is required. */
  provider?: LlmProvider;
  /** Typed provider runtime; the loop wraps it with local budget accounting. */
  llm?: TypedLlmRuntime;
  history?: LlmMessage[];
  onMessage?: (message: LlmMessage) => Promise<void> | void;
  onProgress?: (event: ProgressEvent) => void;
  toolExecutor?: ToolExecutor;
  compactOutput?: boolean;
  maxTurns?: number;
  /** Restrict the tools advertised to the model. Defaults to every tool except spawn_subagent unless `subagent` is set. */
  tools?: ToolName[];
  /** Enable spawn_subagent delegation to a cheap fast model with local tools only. */
  subagent?: SubagentOptions;
  /**
   * The economy gateway's stable paid-capability tools (or any injected
   * dynamic tool surface). Absent means paid services are unavailable.
   */
  dynamicTools?: DynamicToolsOption;
  /** Live-fact prompt sections (balances, vendor instructions, house rules). */
  promptSections?: string[];
  /**
   * Replaces the built-in one-line paid-capability index with an explicit
   * text block (evals). When absent, the knowledge tree is loaded per
   * `knowledge` and rendered into this slot.
   */
  capabilityIndex?: string;
  /**
   * Knowledge tree selection: `false` keeps the static capability line
   * (eval baselines); `{ dir }` loads an explicit tree; absent resolves
   * OPENCROWD_KNOWLEDGE_DIR, then the snapshot bundled with the runtime.
   * Only applies when paid tools (`dynamicTools`) are available.
   */
  knowledge?: false | KnowledgeOptions;
  /**
   * Compaction triggers at 80%, targeting 40%; raw context is archived first.
   */
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  /**
   * Session-completion gate: returns a blocking reason (e.g. a pending
   * required review) or undefined. The loop refuses to complete while it
   * blocks, nudging the model once before stopping deterministically.
   */
  completionGate?: () => Promise<string | undefined>;
}

export interface SubagentOptions {
  model: string;
  maxTurns?: number;
  /** Human-readable price hint (for the delegation prompt), e.g. "$0.01 max per call". */
  costHint?: string;
  /** Explicit subagent provider (tests and custom wiring). */
  provider?: LlmProvider;
  /** Typed provider runtime for subagents; wrapped with shared budget accounting. */
  llm?: TypedLlmRuntime;
  /** Concurrent subagents per batch (default 4). */
  maxParallel?: number;
}

/** Tracks background (fire-and-forget) subagents for check_subagents and completion draining. */
interface BackgroundSubagent {
  index: number;
  task: string;
  status: "running" | "finished";
  promise: Promise<ToolResult>;
  result?: ToolResult;
}

export type AgentTaskOutcome = "completed" | "stopped" | "max_turns" | "budget_exhausted" | "waiting_for_approval";

export interface AgentTaskResult {
  outcome: AgentTaskOutcome;
  summary: Record<string, unknown>;
  turns: number;
}

export async function runAgentTask(session: SessionState, task: string, options: AgentRunOptions = {}): Promise<string> {
  const result = await runAgentTaskDetailed(session, task, options);
  return renderAgentSummary(result.summary, options);
}

export async function runAgentTaskDetailed(session: SessionState, task: string, options: AgentRunOptions = {}): Promise<AgentTaskResult> {
  const enabledTools = options.tools
    ?? (options.hosted ? TOOL_NAMES.filter(name => !["spawn_subagent", "check_subagents"].includes(name))
      : TOOL_NAMES.filter((name) => !HOSTED_ONLY_TOOL_NAMES.includes(name) && (options.subagent || name !== "spawn_subagent")));
  const dynamicDefinitions = options.dynamicTools?.definitions ?? [];
  const model = options.llm?.catalog?.find((m) => m.id === options.llm?.model);
  const limits = contextLimits(options.contextWindowTokens ?? model?.contextWindowTokens, options.maxOutputTokens ?? model?.maxOutputTokens);
  const contextState: ContextState = { ...options.resume?.context };
  const provider = options.provider ?? (options.llm
    ? new BudgetedLlmProvider(session, options.llm.provider, {
      model: options.llm.model,
      maxOutputTokens: limits.outputTokens,
      maxCostCentsPerCall: options.llm.maxCostCentsPerCall,
      maxTopUpCentsPerAction: options.llm.maxTopUpCentsPerAction,
      tools: enabledTools,
      extraTools: dynamicDefinitions,
      promptCacheKey: options.llm.promptCacheKey,
      catalog: options.llm.catalog,
      onTextDelta: options.llm.onTextDelta,
      fallback: options.llm.fallback,
      confirmProviderAction: options.llm.confirmProviderAction
    })
    : undefined);
  if (!provider) {
    throw new Error("no LLM provider configured: pass an explicit provider (tests/demo) or a typed llm runtime");
  }
  const toolExecutor = options.toolExecutor ?? executeTool;
  const knowledge = options.capabilityIndex === undefined && options.knowledge !== false && options.dynamicTools
    ? await loadKnowledgeTree(session, options.knowledge ?? {})
    : undefined;
  const capabilityIndex = options.capabilityIndex ?? (knowledge ? renderCapabilityIndex(knowledge.l0) : undefined);
  const systemPromptParts = [
    options.hosted
      ? "You are a hosted OpenCrowd agent running in the cloud with your own USDC wallet on Base."
      : "You are the local OpenCrowd agent, a CLI agent with a USDC wallet running on the user's personal machine.",
    "Try to solve the user's task completely. Use local files and bash when they are sufficient, but remember they are bounded by the user's installed tools, credentials, network, open ports, and process lifetime.",
    "Before repeatedly fighting the local environment, decide whether the task needs external capability such as hosting, persistent infrastructure, remote compute, specialized APIs, live data, or access the user's device does not have."
  ];
  if (options.hosted) systemPromptParts.push(
    "You operate this service for its owner. Inference and paid tools debit its USDC wallet. When authorized to build or sell a service, take concrete steps within the owner's configured scope and budget. Ask only for missing information or permissions that materially block progress. Report actual costs and outcomes. Financial sustainability is the owner's business objective; respect their stop controls.",
    "Financial state: the current hosted financial snapshot is authoritative; historical local session budget figures are not wallet balances and may omit inference spending. Wallet balance, pending payment holds, settled inference spend, settled service spend, and remaining run budget are separate. Spending totals cover only the identified current run. A budget limit does not supply funds. An unavailable balance is unknown, not zero. The snapshot before a model call excludes that call's eventual charge; never claim a response was free or that you spent nothing merely because no paid tool ran. Use get_budget_status or get_wallet_status for refreshed financial state. Respect approval mode and per-call limits; over-limit requests require the owner's approval."
  );
  if (options.dynamicTools) {
    systemPromptParts.push(
      "When the local computer is not the right environment, or after one clear local capability failure, buy external capability: find_paid_service to discover, inspect_paid_service to see the exact schema/price/reputation, call_paid_service to execute through the enforced purchase lifecycle, and review_paid_service for the required review after every confirmed paid call (success or failure). The same review tool accepts unpaid experiences; review relevant free results or failed attempts without inventing payment evidence. Distinguish provider faults from local errors and uncertain failures.",
      ...(options.hosted
        ? ["Discover services through AgentCash search and provider catalogs. You can use new services without prior CrowdCode reviews. Only x402 USDC on Base is payable, within the user's configured limits; over-limit quotes request approval. Use read_service for authenticated job polling and never resubmit a pending generation job."]
        : []),
      capabilityIndex ?? DEFAULT_CAPABILITY_INDEX,
      "When a task needs current web facts, search results, or unfamiliar page content, make one paid web search your FIRST move — do not serially guess URLs with curl; one paid search replaces minutes of blind fetching and costs less than the LLM turns it saves.",
      "Approval, budget, reputation, and payment rails are enforced in code — you cannot bypass them, so state costs plainly and never invent payment details.",
      "When the user says CrowdCode on/off, call set_crowdcode_enabled; default to session scope unless they ask for a persistent default. Use list_my_reviews and delete_my_review for user-directed review management, including while off. Before finishing a substantive task, consider concrete paid services that would fix real shortcomings and submit qualifying demand with request_service, unless CrowdCode is off. Never invent a purchase or demand.",
      "Each tool result includes the budget before and after that tool call. Never ask for wallet private keys or secrets.",
      ...(options.promptSections ?? [])
    );
  } else {
    systemPromptParts.push(
      "Paid external services are unavailable in this run; work with local tools only and say so if the task truly requires external capability."
    );
  }
  const hostedTools = options.hosted ? (options.tools ?? TOOL_NAMES) : [];
  if (hostedTools.includes("deploy_service")) {
    systemPromptParts.push(
      "Hosting: you can publish paid HTTP services with deploy_service. Write the entry module with save_file (for example service/index.js) as an ES module with `export default { async fetch(request, env) { ... } }`, with no imports and no npm packages; the Workers runtime provides fetch, Request, Response, URL and crypto.",
      "The platform enforces payment before your handler runs, so your code only implements the route logic. Vault secrets you list in `secrets` arrive as env.NAME placeholders that are swapped for the real value only on outbound requests to `allowed_hosts`; never log, hash locally, or return a secret, and never build URLs to hosts you did not declare.",
      "After deploy_service succeeds, report the public URL, the price, and how to call each route."
    );
  }
  if (hostedTools.includes("request_secret")) {
    systemPromptParts.push(
      "Secrets: when a service needs an API key or token, call request_secret with a SCREAMING_SNAKE_CASE name, the hosts it may be sent to, and a one-sentence reason. The user adds the value in their own UI; never ask them to paste a secret into the chat and never expect to see it. If the result is \"active\", list the name in deploy_service `secrets` and read it as env.NAME; if it is \"requested\", tell the user what to add and continue or finish without it."
    );
  }
  systemPromptParts.push("End by calling complete_session with a concise final message.");
  if (options.subagent) {
    systemPromptParts.push(
      `Delegation: spawn_subagent runs a cheaper, faster model (${options.subagent.model}${options.subagent.costHint ? `, ${options.subagent.costHint}` : ""}) with local file and shell tools only.`,
      "Delegate ONLY when you can spawn two or more INDEPENDENT subagents in the same reply — parallel fan-out is the entire benefit; multiple spawn_subagent calls in one reply run concurrently (2-4 is the sweet spot).",
      "If the work is one sequential thread where each step depends on the previous result, do it yourself in this main loop: a chain of single subagents is strictly slower than working directly and adds spawn/read overhead on top.",
      "Give each subagent an objective, expected output format, and clear boundaries so parallel subagents cannot make conflicting decisions; they see none of this conversation, so pass explicit context (file paths, constraints).",
      "Each subagent's files land under artifacts/subagents/<n>/ and its completion lists what it wrote.",
      "Suitable subagent work: summarizing, extracting, mechanical edits, or reading specific already-known URLs (subagents can curl free URLs via run_shell); keep planning, paid-service decisions, and final answers in this main loop.",
      "For web research: first buy one paid web search here in the main loop, then fan the returned URLs out to parallel subagents in a single reply. Never send a subagent off to guess URLs with curl."
    );
  }
  const messages: LlmMessage[] = options.resume?.messages ?? [
    { role: "system", content: systemPromptParts.join(" ") },
    ...(options.history ?? []),
    { role: "user", content: task }
  ];
  let financial: FinancialState = { status: "unavailable", reason: "Hosted financial state has not been read." };
  const refreshFinancialState = async () => {
    if (!options.financialState) return;
    try { financial = FinancialStateSchema.parse(await options.financialState()); }
    catch { financial = { status: "unavailable", reason: "Hosted financial state could not be read; do not use local budget figures." }; }
  };
  const currentBudget = () => options.financialState ? financial : budgetStatus(session);
  const financialPrefix = "Current hosted financial snapshot: ";
  if (!options.resume) await options.onMessage?.({ role: "user", content: task });

  const maxTurns = options.maxTurns ?? 100;
  const repeatedFailures = new Map<string, number>(options.resume?.repeatedFailures);
  let completionNudges = options.resume?.completionNudges ?? 0;
  let outputContinuationNudges = options.resume?.outputContinuationNudges ?? 0;
  let outputContinuationPrefix = options.resume?.outputContinuationPrefix ?? "";
  let serviceCallFailures = options.resume?.serviceCallFailures ?? 0;
  const deliveredMessageIds = new Set(options.resume?.deliveredMessageIds ?? []);
  const checkpoint = async (turn: number, response?: LlmResponse, completedTools: Record<string, ToolResult> = {}) => {
    await options.onCheckpoint?.(structuredClone({ messages, turn, response, completedTools, context: contextState, deliveredMessageIds: [...deliveredMessageIds],
      completionNudges, outputContinuationNudges, outputContinuationPrefix, serviceCallFailures,
      repeatedFailures: [...repeatedFailures.entries()] }));
  };
  const injectMessages = async (turn: number) => {
    const pending = await options.inbox?.pending() ?? [];
    const fresh = pending.filter(m => !deliveredMessageIds.has(m.id));
    for (const message of fresh) {
      messages.push({ role: "user", content: message.prompt });
      deliveredMessageIds.add(message.id);
    }
    if (fresh.length) await checkpoint(turn);
    for (const message of fresh) await options.onMessage?.({ role: "user", content: message.prompt });
    if (pending.length) await options.inbox?.delivered(pending.map(m => m.id));
    return fresh.length > 0;
  };
  let subagentCount = 0;
  const backgroundSubagents = new Map<string, BackgroundSubagent>();
  const subagentLimiter = createLimiter(options.subagent?.maxParallel ?? 4);
  const drainBackground = async (): Promise<Record<string, unknown>[]> => {
    const outstanding = [...backgroundSubagents.values()];
    await Promise.all(outstanding.map((entry) => entry.promise));
    return outstanding.map((entry) => ({
      subagent_index: entry.index,
      task: entry.task,
      ...(entry.result?.ok && entry.result.data && typeof entry.result.data === "object"
        ? entry.result.data as Record<string, unknown>
        : { outcome: "error", error: entry.result?.error })
    }));
  };
  for (let turn = options.resume?.turn ?? 0; turn < maxTurns; turn += 1) {
    options.signal?.throwIfAborted();
    const restored = turn === options.resume?.turn ? options.resume : undefined;
    // Never change a checkpointed paid request on resume, or split an
    // assistant tool-call batch from its results with a user message.
    if (!restored) await injectMessages(turn);
    const completedTools: Record<string, ToolResult> = Object.assign(Object.create(null), restored?.completedTools ?? {});
    options.onProgress?.({ type: "calling_llm", message: `Calling LLM provider (turn ${turn + 1}/${maxTurns})` });
    let response: LlmResponse;
    try {
      if (options.financialState && !restored?.response && !contextState.prepared) {
        await refreshFinancialState();
        const snapshot: LlmMessage = { role: "system", content: financialPrefix + JSON.stringify(financial) };
        const index = messages.findIndex(m => m.role === "system" && m.content.startsWith(financialPrefix));
        if (index === -1) messages.splice(1, 0, snapshot);
        else messages[index] = snapshot;
      }
      response = restored?.response ?? await completeWithContext(session, messages, {
          provider: provider instanceof MockLlmProvider ? { complete: (input) => completeMockLlmCall(session, provider, input, turn + 1) } : provider, tools: wireToolDefinitions(enabledTools, dynamicDefinitions), state: contextState,
          contextWindowTokens: limits.contextWindow, maxOutputTokens: limits.outputTokens,
          hosted: options.hosted, signal: options.signal, operationId: `${options.runId ?? session.sessionId}:llm:${turn}`,
          checkpoint: () => checkpoint(turn),
          onCompaction: async (result) => {
            await atomicWrite(conversationPath(session), messages.filter(m => m.role !== "system")
              .map(message => JSON.stringify({ type: "message", message }) + "\n").join(""));
            options.onProgress?.({ type: "complete", message: `Compacted context: ~${result.tokensBefore} → ~${result.tokensAfter} tokens. Archive: ${result.archivePath}`, data: result });
          }
        });
      options.signal?.throwIfAborted();
      await refreshFinancialState(); // includes the model payment, including a replayed receipt
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        // Budget exhaustion is a deterministic stop, not a fault: finish
        // with what the session accomplished so far.
        const summary = await completeSession(session, `Stopped: the session budget is exhausted (${error.message}).`);
        return { outcome: options.hosted ? "budget_exhausted" : "stopped", summary, turns: turn + 1 };
      }
      throw error;
    }
    if (!restored?.response && (response.content || response.toolCalls.length > 0)) {
      // Tool calls cut off by the provider's output limit are incomplete and
      // must never execute. Preserve only the partial prose for continuation.
      const assistantMessage = assistantMessageFromResponse(isOutputLimitFinishReason(response.finishReason)
        ? { ...response, toolCalls: [] }
        : response);
      messages.push(assistantMessage);
      await options.onMessage?.(assistantMessage);
    }
    await checkpoint(turn, response, completedTools);
    if (isOutputLimitFinishReason(response.finishReason)) {
      outputContinuationPrefix += response.content;
      if (outputContinuationNudges >= 1) {
        const summary = await completeSession(
          session,
          `Stopped: the LLM hit its output limit twice. Partial response:\n\n${outputContinuationPrefix}`
        );
        return { outcome: "stopped", summary, turns: turn + 1 };
      }
      outputContinuationNudges += 1;
      const nudge: LlmMessage = {
        role: "user",
        content: "Your previous response hit the provider output limit. Any tool calls in that response were discarded and did not execute. If you were calling a tool, issue a complete, shorter tool call. Otherwise continue the answer exactly where it stopped. Put only the remaining suffix in complete_session.final_message; OpenCrowd will prepend the saved prefix. Do not repeat completed material."
      };
      messages.push(nudge);
      await options.onMessage?.(nudge);
      continue;
    }
    if (response.toolCalls.length === 0) {
      if (await injectMessages(turn + 1)) continue;
      const blocker = await options.completionGate?.();
      if (blocker) {
        if (completionNudges >= 1) {
          const summary = await completeSession(session, `Stopped: ${blocker}`);
          return { outcome: "stopped", summary, turns: turn + 1 };
        }
        completionNudges += 1;
        const nudge: LlmMessage = { role: "user", content: `You cannot finish yet: ${blocker}` };
        messages.push(nudge);
        await options.onMessage?.(nudge);
        continue;
      }
      const summary = await completeSession(session, outputContinuationPrefix + (response.content || "Session completed."));
      return { outcome: "completed", summary, turns: turn + 1 };
    }
    // Launch every spawn_subagent in this reply immediately (bounded
    // concurrency): one assistant turn is the parallelism unit, with a
    // barrier at the turn boundary — background spawns skip the barrier.
    const spawnedThisTurn = new Map<string, Promise<ToolResult>>();
    if (options.subagent) {
      for (const call of response.toolCalls) {
        if (call.name !== "spawn_subagent") {
          continue;
        }
        subagentCount += 1;
        const index = subagentCount;
        const subagent = options.subagent;
        const key = options.runId ? createHash("sha256").update(`${options.runId}:${turn}:${call.id}`).digest("hex").slice(0,24) : undefined;
        const promise = subagentLimiter(() => runSubagentTask(session, call.arguments, subagent, index, options, key));
        void promise.catch(() => undefined);
        // Query spending must checkpoint the entire fan-out before advancing.
        // Work still runs concurrently; join it so approval can resume each child exactly.
        if (call.arguments.background === true && !session.query) {
          const entry: BackgroundSubagent = {
            index,
            task: String(call.arguments.task ?? ""),
            status: "running",
            promise: promise.then((result) => {
              entry.status = "finished";
              entry.result = result;
              return result;
            })
          };
          backgroundSubagents.set(String(index), entry);
          spawnedThisTurn.set(call.id, Promise.resolve({
            ok: true,
            data: { subagent_index: index, status: "running", note: "running in the background; collect the result with check_subagents" }
          }));
        } else {
          spawnedThisTurn.set(call.id, promise);
        }
      }
    }
    for (const call of response.toolCalls) {
      options.signal?.throwIfAborted();
      options.onProgress?.({
        type: "calling_tool",
        message: `Tool call: ${summarizeToolCall(call)}`,
        data: { tool: call.name, arguments: call.arguments }
      });
      const budgetBeforeToolCall = currentBudget();
      const callArguments = call.name === "complete_session" && outputContinuationPrefix
        ? {
          ...call.arguments,
          final_message: outputContinuationPrefix + (typeof call.arguments.final_message === "string" ? call.arguments.final_message : "")
        }
        : call.arguments;
      let result: ToolResult;
      if (completedTools[call.id]) {
        result = completedTools[call.id];
      } else if (call.name === "spawn_subagent") {
        try {
          result = options.subagent
            ? await (spawnedThisTurn.get(call.id) ?? Promise.resolve({ ok: false, error: "subagent launch failed" }))
            : { ok: false, error: "subagents are not enabled for this session" };
        } catch (error) { await Promise.allSettled(spawnedThisTurn.values()); throw error; }
      } else if (call.name === "check_subagents") {
        if (call.arguments.wait === true) {
          result = { ok: true, data: { subagents: await drainBackground() } };
        } else {
          result = {
            ok: true,
            data: {
              subagents: [...backgroundSubagents.values()].map((entry) => ({
                subagent_index: entry.index,
                task: entry.task,
                status: entry.status,
                ...(entry.status === "finished" && entry.result?.ok && entry.result.data && typeof entry.result.data === "object"
                  ? entry.result.data as Record<string, unknown>
                  : entry.status === "finished" ? { outcome: "error", error: entry.result?.error } : {})
              }))
            }
          };
        }
      } else if (TOOL_NAMES.includes(call.name as ToolName)) {
        result = await toolExecutor(call.name as ToolName, callArguments, { session, onProgress: options.onProgress, signal: options.signal });
      } else if (options.dynamicTools) {
        result = await options.dynamicTools.execute(call.name, callArguments);
      } else {
        result = { ok: false, error: `unknown tool: ${call.name}` };
      }
      await refreshFinancialState(); // includes a settled service payment and changed approvals
      const budgetAfterToolCall = currentBudget();
      if (options.financialState && call.name === "get_budget_status") result = { ok: true, data: financial };
      if (options.financialState && call.name === "complete_session" && result.ok && result.data && typeof result.data === "object") {
        result = { ...result, data: { ...result.data, budget: financial } };
      }
      options.onProgress?.({
        type: "tool_result",
        message: `Tool result: ${summarizeToolResult(call.name, result)}`,
        data: { tool: call.name, ok: result.ok, error: result.error, result: result.data as Record<string, unknown> | undefined }
      });
      const toolMessage = {
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(toolMessagePayload({
          budget_before_tool_call: budgetBeforeToolCall,
          result,
          budget_after_tool_call: budgetAfterToolCall
        }))
      } as LlmMessage;
      if (!completedTools[call.id]) {
        messages.push(toolMessage);
        completedTools[call.id] = result;
        await checkpoint(turn, response, completedTools);
        await options.onMessage?.(toolMessage);
      }
      if (!result.ok) {
        if (call.name === "call_paid_service") {
          serviceCallFailures += 1;
          if (serviceCallFailures >= 3) {
            const summary = await completeSession(session, `Stopped after ${serviceCallFailures} service call failures. Last error: ${result.error}`);
            return { outcome: "stopped", summary, turns: turn + 1 };
          }
        }
        const key = `${call.name}:${JSON.stringify(call.arguments)}:${result.error}`;
        const count = (repeatedFailures.get(key) ?? 0) + 1;
        repeatedFailures.set(key, count);
        if (count >= 2) {
          const summary = await completeSession(session, `Stopped because ${call.name} failed repeatedly: ${result.error}`);
          return { outcome: "stopped", summary, turns: turn + 1 };
        }
      }
    }
    // Finish the entire tool batch before injecting messages or completing.
    const completionCall = response.toolCalls.find(call => call.name === "complete_session");
    if (completionCall) {
      const call = completionCall;
      const result = completedTools[call.id];
      if (await injectMessages(turn + 1)) continue;
        const blocker = await options.completionGate?.();
        if (blocker) {
          if (completionNudges >= 1) {
            const summary = await completeSession(session, `Stopped: ${blocker}`);
            return { outcome: "stopped", summary, turns: turn + 1 };
          }
          completionNudges += 1;
          const gateMessage = {
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({ result: { ok: false, error: `cannot complete yet: ${blocker}` } })
          } as LlmMessage;
          messages.push(gateMessage);
          await options.onMessage?.(gateMessage);
          continue;
        }
        const backgroundResults = backgroundSubagents.size > 0 ? await drainBackground() : undefined;
        if (result.ok && result.data && typeof result.data === "object") {
          const summary = { ...result.data } as Record<string, unknown>;
          if (backgroundResults) {
            summary.background_subagents = backgroundResults;
          }
          return { outcome: "completed", summary, turns: turn + 1 };
        }
        const summary = await completeSession(
          session,
          outputContinuationPrefix + (response.content || result.error || "Session completed.")
        );
        if (backgroundResults) {
          summary.background_subagents = backgroundResults;
        }
        return { outcome: "completed", summary, turns: turn + 1 };
    }
  }
  if (backgroundSubagents.size > 0) {
    await drainBackground();
  }
  const summary = await completeSession(session, "Stopped after reaching the maximum tool loop turns.");
  return { outcome: "max_turns", summary, turns: maxTurns };
}

/** Minimal concurrency limiter: at most `max` tasks in flight. */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

interface SubagentCompletion {
  subagent_id: string;
  model: string;
  outcome: "completed" | "stopped" | "max_turns";
  final_message: string;
  turns: number;
  trajectory_path: string;
  /** Artifact paths this subagent wrote (namespaced under subagents/<n>/). */
  artifacts_written: string[];
}

/**
 * Run one bounded subagent: local tools only, one level deep, sequential.
 * The subagent shares the parent session's budget, ledger, and artifacts;
 * its LLM spend is tagged in the shared ledger by subagent session id and
 * its trajectory persists under sessions/<id>/subagents/<n>/.
 */
async function runSubagentTask(
  session: SessionState,
  args: Record<string, unknown>,
  subagent: SubagentOptions,
  index: number,
  parentOptions: AgentRunOptions,
  operationKey?: string
): Promise<ToolResult> {
  const task = typeof args.task === "string" ? args.task : "";
  if (!task) {
    return { ok: false, error: "spawn_subagent requires a task" };
  }
  const subagentId = `${session.sessionId}#sub${index}`;
  const trajectoryDir = join(session.sessionDir, "subagents", operationKey ?? String(index));
  const trajectoryPath = join(trajectoryDir, "messages.jsonl");
  await mkdir(trajectoryDir, { recursive: true });
  const record = async (message: LlmMessage) => {
    await appendFile(trajectoryPath, `${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message })}\n`, "utf8");
  };
  const provider = subagentProvider(session, subagent, subagentId, parentOptions);
  const toolExecutor = parentOptions.toolExecutor ?? executeTool;
  const maxTurns = subagent.maxTurns ?? 24;
  const forwardProgress = (event: ProgressEvent) => {
    parentOptions.onProgress?.({ ...event, message: `[subagent ${index}] ${event.message}` });
  };
  let messages: LlmMessage[] = [
    {
      role: "system",
      content: [
        "You are an OpenCrowd subagent handling one bounded subtask for the main agent.",
        "You have local file tools and a gated bash tool only: no paid services, no wallet actions, no further subagents.",
        "Work only from the task and context provided; you cannot see the main conversation.",
        "Finish by calling complete_session with a final message containing exactly what the main agent asked for."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Task: ${task}`,
        typeof args.context === "string" && args.context ? `Context: ${args.context}` : undefined,
        typeof args.expected_output === "string" && args.expected_output ? `Expected output: ${args.expected_output}` : undefined
      ].filter(Boolean).join("\n\n")
    }
  ];
  const statePath = join(trajectoryDir, "checkpoint.json");
  type Saved = { messages: LlmMessage[]; turn: number; response?: LlmResponse; completed: string[]; context: ContextState;
    outputContinuationNudges: number; outputContinuationPrefix: string; artifactsWritten: string[]; result?: ToolResult };
  let saved: Saved | undefined;
  if (operationKey) try { saved = JSON.parse(await readFile(statePath, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (saved?.result) return saved.result;
  if (saved) messages = saved.messages;
  else for (const message of messages) await record(message);
  const repeatedFailures = new Map<string, number>();
  let outputContinuationNudges = saved?.outputContinuationNudges ?? 0;
  let outputContinuationPrefix = saved?.outputContinuationPrefix ?? "";
  const artifactsWritten: string[] = saved?.artifactsWritten ?? [];
  const contextState: ContextState = saved?.context ?? {};
  let turn = saved?.turn ?? 0;
  const persist = async (response?: LlmResponse, completed: string[] = [], result?: ToolResult) => {
    if (operationKey) await atomicWrite(statePath, JSON.stringify({ messages, turn, response, completed, context: contextState,
      outputContinuationNudges, outputContinuationPrefix, artifactsWritten, result } satisfies Saved));
  };
  const model = subagent.llm?.catalog?.find(m => m.id === subagent.model);
  const finish = async (outcome: SubagentCompletion["outcome"], finalMessage: string, turns: number): Promise<ToolResult> => {
    const completion: SubagentCompletion = {
      subagent_id: subagentId,
      model: subagent.model,
      outcome,
      final_message: finalMessage,
      turns,
      trajectory_path: trajectoryPath,
      artifacts_written: artifactsWritten
    };
    const result = { ok: true, data: completion };
    await persist(undefined, [], result);
    return result;
  };

  try {
    for (; turn < maxTurns; turn += 1) {
      parentOptions.signal?.throwIfAborted();
      forwardProgress({ type: "calling_llm", message: `Calling LLM provider (turn ${turn + 1}/${maxTurns})` });
      let response: LlmResponse;
      try {
        await persist(saved?.response, saved?.completed);
        response = saved?.response ?? (provider instanceof MockLlmProvider
          ? await completeMockLlmCall(session, provider, messages, turn + 1)
          : await completeWithContext(session, messages, { provider, tools: wireToolDefinitions(SUBAGENT_TOOL_NAMES), state: contextState, contextWindowTokens: model?.contextWindowTokens, maxOutputTokens: model?.maxOutputTokens, signal: parentOptions.signal, checkpoint: () => persist() }));
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          return finish("stopped", "Subagent stopped: the shared session budget is exhausted.", turn + 1);
        }
        throw error;
      }
      if (!saved?.response && (response.content || response.toolCalls.length > 0)) {
        const assistantMessage = assistantMessageFromResponse(isOutputLimitFinishReason(response.finishReason)
          ? { ...response, toolCalls: [] }
          : response);
        messages.push(assistantMessage);
        await record(assistantMessage);
      }
      const completed = saved?.completed ?? [];
      saved = undefined;
      await persist(response, completed);
      if (isOutputLimitFinishReason(response.finishReason)) {
        outputContinuationPrefix += response.content;
        if (outputContinuationNudges >= 1) {
          return finish("stopped", `Subagent stopped: the LLM hit its output limit twice. Partial response:\n\n${outputContinuationPrefix}`, turn + 1);
        }
        outputContinuationNudges += 1;
        const nudge: LlmMessage = {
          role: "user",
          content: "Your previous response hit the provider output limit. Any tool calls in that response were discarded and did not execute. If you were calling a tool, issue a complete, shorter tool call. Otherwise continue the answer exactly where it stopped. Put only the remaining suffix in complete_session.final_message; OpenCrowd will prepend the saved prefix. Do not repeat completed material."
        };
        messages.push(nudge);
        await record(nudge);
        continue;
      }
      if (response.toolCalls.length === 0) {
        return finish("completed", outputContinuationPrefix + (response.content || "Subagent finished."), turn + 1);
      }
      for (const call of response.toolCalls) {
        if (completed.includes(call.id)) continue;
        if (call.name === "complete_session") {
          const finalMessage = typeof call.arguments.final_message === "string" && call.arguments.final_message
            ? call.arguments.final_message
            : response.content || "Subagent finished.";
          return finish("completed", outputContinuationPrefix + finalMessage, turn + 1);
        }
        forwardProgress({
          type: "calling_tool",
          message: `Tool call: ${summarizeToolCall(call)}`,
          data: { tool: call.name, arguments: call.arguments }
        });
        // Writes are namespaced per subagent so parallel subagents can never
        // clobber each other's artifacts (reads stay workspace-wide).
        let callArguments = call.arguments;
        if (call.name === "save_file" && typeof call.arguments.path === "string") {
          const namespace = `subagents/${index}/`;
          const path = call.arguments.path.startsWith(namespace) ? call.arguments.path : `${namespace}${call.arguments.path}`;
          callArguments = { ...call.arguments, path };
          artifactsWritten.push(path);
        }
        const result = SUBAGENT_TOOL_NAMES.includes(call.name as ToolName)
          ? await toolExecutor(call.name as ToolName, callArguments, { session, onProgress: forwardProgress, signal: parentOptions.signal })
          : { ok: false, error: `${call.name} is not available to subagents; local tools only` };
        forwardProgress({
          type: "tool_result",
          message: `Tool result: ${summarizeToolResult(call.name, result)}`,
          data: { tool: call.name, ok: result.ok, error: result.error, result: result.data as Record<string, unknown> | undefined }
        });
        const toolMessage = {
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(toolMessagePayload({ result }))
        } as LlmMessage;
        messages.push(toolMessage);
        await record(toolMessage);
        completed.push(call.id);
        await persist(response, completed);
        if (!result.ok) {
          const key = `${call.name}:${JSON.stringify(call.arguments)}:${result.error}`;
          const count = (repeatedFailures.get(key) ?? 0) + 1;
          repeatedFailures.set(key, count);
          if (count >= 2) {
            return finish("stopped", `Subagent stopped because ${call.name} failed repeatedly: ${result.error}`, turn + 1);
          }
        }
      }
    }
    return finish("max_turns", "Subagent stopped after reaching its maximum turns.", maxTurns);
  } catch (error) {
    if (error instanceof SpendingApprovalRequired || error instanceof SpendingDeclined) throw error;
    return { ok: false, error: `subagent ${index} failed: ${(error as Error).message}` };
  }
}

function subagentProvider(
  session: SessionState,
  subagent: SubagentOptions,
  subagentId: string,
  parentOptions: AgentRunOptions
): LlmProvider {
  if (subagent.provider) {
    return subagent.provider;
  }
  if (parentOptions.provider instanceof MockLlmProvider) {
    return new MockLlmProvider({ seed: subagentId, tools: SUBAGENT_TOOL_NAMES });
  }
  if (subagent.llm) {
    return new BudgetedLlmProvider(session, subagent.llm.provider, {
      model: subagent.llm.model,
      maxOutputTokens: contextLimits(subagent.llm.catalog?.find(m => m.id === subagent.llm?.model)?.contextWindowTokens, subagent.llm.catalog?.find(m => m.id === subagent.llm?.model)?.maxOutputTokens).outputTokens,
      maxCostCentsPerCall: subagent.llm.maxCostCentsPerCall,
      maxTopUpCentsPerAction: subagent.llm.maxTopUpCentsPerAction,
      tools: SUBAGENT_TOOL_NAMES,
      promptCacheKey: subagent.llm.promptCacheKey,
      catalog: subagent.llm.catalog,
      ledgerSessionId: subagentId,
      fallback: subagent.llm.fallback,
      confirmProviderAction: subagent.llm.confirmProviderAction
    });
  }
  throw new Error("subagent has no provider: pass subagent.provider (tests) or subagent.llm (typed runtime)");
}

function assistantMessageFromResponse(response: LlmResponse): LlmMessage {
  // Keep assistant text even when the response also carries tool calls, so
  // trajectories preserve the model's stated reasoning (HARNESS_IMPROVEMENT).
  return {
    role: "assistant",
    content: response.content,
    toolCalls: response.toolCalls
  };
}

async function completeMockLlmCall(
  session: SessionState,
  provider: MockLlmProvider,
  messages: LlmMessage[],
  turn: number
): Promise<LlmResponse> {
  const costCents = 1;
  const reservation = await reserveBudget(session, costCents);
  const started = Date.now();
  try {
    const response = await provider.complete(messages);
    await finalizeReservation(session, reservation, costCents);
    await appendLedgerEntry(session.ledgerPath, {
      session_id: session.sessionId,
      type: "llm_call",
      endpoint: "mock://llm",
      model: "mock-test-mode",
      method: "POST",
      quoted_cost_cents: costCents,
      charged_cost_cents: costCents,
      status: "charged",
      approval_mode: session.approvalMode,
      payment_id: `mock-llm-${turn}`,
      latency_ms: Date.now() - started,
      notes: "mock test mode LLM call"
    });
    return response;
  } catch (error) {
    await releaseReservation(session, reservation);
    await appendLedgerEntry(session.ledgerPath, {
      session_id: session.sessionId,
      type: "llm_call",
      endpoint: "mock://llm",
      model: "mock-test-mode",
      method: "POST",
      quoted_cost_cents: costCents,
      charged_cost_cents: 0,
      status: "failed",
      approval_mode: session.approvalMode,
      latency_ms: Date.now() - started,
      notes: (error as Error).message
    });
    throw error;
  }
}

function toolMessagePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return truncateForModel(pruneToolPayload(payload), 12_000) as Record<string, unknown>;
}

function pruneToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(pruneToolPayload);
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.data) && record.data.every(isServiceCandidateLike)) {
    return {
      ...record,
      data: record.data.slice(0, 8).map((candidate) => {
        const item = candidate as Record<string, unknown>;
        return {
          resource_url: item.resource_url,
          title: item.title,
          description: item.description,
          methods: item.methods,
          price_cents: item.price_cents,
          price_display: item.price_display,
          currency: item.currency,
          tags: item.tags,
          score: item.score
        };
      })
    };
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, pruneToolPayload(child)]));
}

function isServiceCandidateLike(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "resource_url" in value);
}

function truncateForModel(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateForModel(item, maxChars));
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const childLimit = key === "stdout" || key === "stderr" ? 6_000 : key === "command" ? 2_000 : maxChars;
    return [key, truncateForModel(child, childLimit)];
  }));
}

export async function buildSessionSummary(
  session: SessionState,
  finalMessage: string,
  options: { compact?: boolean } = {}
): Promise<string> {
  const summary = await completeSession(session, finalMessage);
  return options.compact ? renderCompactPurchaseSummary(summary) : renderPurchaseSummary(summary);
}

export interface RenderProgressOptions {
  compact?: boolean;
  style?: "plain" | "compact" | "pretty";
  width?: number;
  color?: boolean;
}

export function renderProgress(event: ProgressEvent, options: RenderProgressOptions = {}): string {
  const style = options.style ?? (options.compact ? "compact" : "plain");
  // Streaming deltas are for live UIs; line-oriented renderers skip them.
  if (event.type === "assistant_delta") {
    return "";
  }
  if (style === "plain") {
    return event.message;
  }
  if (style === "pretty") {
    return renderPrettyProgress(event, options);
  }
  switch (event.type) {
    case "calling_llm":
      return event.message.replace(/^Calling LLM provider \(turn /, "turn ").replace(/\)$/, "");
    case "calling_tool":
      return `  -> ${event.message.replace(/^Tool call: /, "")}`;
    case "tool_result":
      return `  <- ${event.message.replace(/^Tool result: /, "")}`;
    case "calling_service":
      return `     ${event.message}`;
    case "running_shell":
      return `     ${event.message}`;
    case "complete":
      return event.message;
    default:
      return "";
  }
}

function renderPrettyProgress(event: ProgressEvent, options: RenderProgressOptions): string {
  const color = options.color ?? false;
  const accent = (value: string) => color ? `\x1b[36m${value}\x1b[0m` : value;
  const muted = (value: string) => color ? `\x1b[2m${value}\x1b[0m` : value;
  const ok = (value: string) => color ? `\x1b[32m${value}\x1b[0m` : value;
  const width = Math.max(40, options.width ?? 100);
  switch (event.type) {
    case "calling_llm":
      return `${accent("*")} ${event.message.replace(/^Calling LLM provider \(turn /, "turn ").replace(/\)$/, "")}`;
    case "calling_tool":
      return `  ${accent("->")} ${truncateMiddle(event.message.replace(/^Tool call: /, ""), width - 7)}`;
    case "tool_result":
      return `  ${ok("<-")} ${truncateMiddle(event.message.replace(/^Tool result: /, ""), width - 7)}`;
    case "requesting_permission":
    case "reserving_spend":
    case "calling_service":
    case "saving_artifact":
    case "running_shell":
      return `     ${muted(truncateMiddle(event.message, width - 5))}`;
    case "complete":
      return event.message;
    default:
      return "";
  }
}

export function renderAgentSummary(summary: Record<string, unknown>, options: AgentRunOptions): string {
  return options.compactOutput ? renderCompactPurchaseSummary(summary) : renderPurchaseSummary(summary);
}

export function renderCompactPurchaseSummary(summary: Record<string, unknown>): string {
  const budget = summary.budget as Record<string, unknown> | undefined;
  const purchases = Array.isArray(summary.service_calls)
    ? summary.service_calls as Record<string, string>[]
    : Array.isArray(summary.purchases)
      ? summary.purchases as Record<string, string>[]
      : [];
  const artifacts = Array.isArray(summary.artifacts) ? summary.artifacts as string[] : [];
  const spent = formatCents(Number(budget?.total_spent_cents ?? budget?.spent_cents ?? 0));
  const remaining = formatCents(Number(budget?.remaining_cents ?? 0));
  const services = purchases.length === 0
    ? "services none"
    : `services ${purchases.length}, $${(sumCents(purchases) / 100).toFixed(2)}`;
  const artifactSummary = artifacts.length === 0 ? "artifacts none" : `artifacts ${artifacts.length}`;
  return [
    String(summary.final_message ?? "Session complete."),
    `summary: spent ${spent}, remaining ${remaining}, ${services}, ${artifactSummary}`
  ].join("\n");
}

export function renderProgressMessage(event: ProgressEvent): string {
  return event.message;
}

export async function renderLedgerSummary(session: SessionState): Promise<string> {
  const rows = await readLedger(session.ledgerPath);
  return renderPurchaseSummary({
    final_message: "Ledger summary",
    budget: {
      budget_cents: session.budgetCents,
      spent_cents: session.spentCents,
      remaining_cents: Math.max(0, session.budgetCents - session.spentCents - session.reservedCents),
      llm_spend_cents: sumCents(rows.filter((row) => row.type === "llm_call")),
      external_service_spend_cents: sumCents(rows.filter((row) => row.type === "service_call")),
      wallet_top_up_spend_cents: sumCents(rows.filter((row) => row.type === "wallet_top_up")),
      total_spent_cents: session.spentCents
    },
    llm_calls: rows.filter((row) => row.type === "llm_call"),
    wallet_top_ups: rows.filter((row) => row.type === "wallet_top_up"),
    service_calls: rows.filter((row) => row.type === "service_call"),
    purchases: rows.filter((row) => row.type === "service_call"),
    artifacts: rows.filter((row) => row.artifact_path).map((row) => row.artifact_path)
  });
}

function renderPurchaseSummary(summary: Record<string, unknown>): string {
  const budget = summary.budget as Record<string, unknown> | undefined;
  const purchases = Array.isArray(summary.service_calls)
    ? summary.service_calls as Record<string, string>[]
    : Array.isArray(summary.purchases)
      ? summary.purchases as Record<string, string>[]
      : [];
  const llmCalls = Array.isArray(summary.llm_calls) ? summary.llm_calls as Record<string, string>[] : [];
  const walletTopUps = Array.isArray(summary.wallet_top_ups) ? summary.wallet_top_ups as Record<string, string>[] : [];
  const artifacts = Array.isArray(summary.artifacts) ? summary.artifacts as string[] : [];
  const lines = [
    String(summary.final_message ?? "Session complete."),
    "",
    `Budget: ${formatCents(Number(budget?.budget_cents ?? 0))}`,
    `LLM spend: ${formatCents(Number(budget?.llm_spend_cents ?? 0))}`,
    `Venice top-ups: ${formatCents(Number(budget?.wallet_top_up_spend_cents ?? 0))}`,
    `External service spend: ${formatCents(Number(budget?.external_service_spend_cents ?? 0))}`,
    `Total spent: ${formatCents(Number(budget?.total_spent_cents ?? budget?.spent_cents ?? 0))}`,
    `Remaining: ${formatCents(Number(budget?.remaining_cents ?? 0))}`,
    "",
    "LLM calls:"
  ];
  if (llmCalls.length === 0) {
    lines.push("- none");
  } else {
    for (const row of llmCalls) {
      lines.push(`- ${row.model || "unknown"} ${row.status || ""} ${formatCents(Number(row.charged_cost_cents || 0))}`.trim());
    }
  }
  lines.push("", "Wallet top-ups:");
  if (walletTopUps.length === 0) {
    lines.push("- none");
  } else {
    for (const row of walletTopUps) {
      lines.push(`- ${row.status || ""} ${formatCents(Number(row.charged_cost_cents || 0))}`.trim());
    }
  }
  lines.push(
    "",
    "Purchased services:"
  );
  if (purchases.length === 0) {
    lines.push("- none");
  } else {
    for (const row of purchases) {
      lines.push(`- ${row.resource_url || "unknown"} ${row.status || ""} ${formatCents(Number(row.charged_cost_cents || 0))} ${row.artifact_path || ""}`.trim());
    }
  }
  lines.push("", "Artifacts:");
  if (artifacts.length === 0) {
    lines.push("- none");
  } else {
    for (const artifact of artifacts) {
      lines.push(`- ${artifact}`);
    }
  }
  return lines.join("\n");
}

function validToolNames(names?: ToolName[], extraTools?: DynamicToolDefinition[]): Set<string> {
  return new Set<string>([
    ...(names ?? TOOL_NAMES),
    ...(extraTools ?? []).map((tool) => tool.name)
  ]);
}

function summarizeToolCall(call: LlmToolCall): string {
  switch (call.name) {
    case "find_paid_service":
      return `find_paid_service ${String(call.arguments.origin ?? call.arguments.query ?? "")}`;
    case "inspect_paid_service":
      return `inspect_paid_service ${String(call.arguments.method ?? "POST")} ${String(call.arguments.url ?? "")}`;
    case "call_paid_service":
      return `call_paid_service ${String(call.arguments.method ?? "POST")} ${String(call.arguments.url ?? "")}`;
    case "review_paid_service":
      return `review_paid_service ${String(call.arguments.purchase_id ?? "")} rating=${String(call.arguments.rating ?? "")}`;
    case "complete_session":
      return "complete_session";
    default:
      return `${call.name} ${compactJson(call.arguments, 180)}`;
  }
}

function summarizeToolResult(name: string, result: ToolResult): string {
  if (!result.ok) {
    return `${name} failed: ${result.error}`;
  }
  if (name === "call_paid_service" && result.data && typeof result.data === "object") {
    const data = result.data as { outcome?: unknown; status?: unknown; charged_cost_cents?: unknown; artifact_path?: unknown };
    return `call_paid_service ${String(data.outcome ?? "?")} HTTP ${String(data.status ?? "?")}, charged ${formatCents(Number(data.charged_cost_cents ?? 0))}${data.artifact_path ? `, saved ${String(data.artifact_path)}` : ""}`;
  }
  if (name === "get_budget_status" && result.data && typeof result.data === "object") {
    if ("status" in result.data) return `hosted finances: ${String(result.data.status)}`;
    const data = result.data as { remaining_cents?: unknown };
    return `remaining ${formatCents(Number(data.remaining_cents ?? 0))}`;
  }
  return `${name} ok: ${compactJson(result.data, 220)}`;
}

function compactJson(value: unknown, maxLength: number): string {
  const text = JSON.stringify(value);
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function formatCents(cents: number): string {
  // Sub-cent spend is real (a cheap LLM call): show it instead of $0.00.
  return `$${(cents / 100).toFixed(cents > 0 && cents < 1 ? 4 : 2)}`;
}

function sumCents(rows: Record<string, string>[]): number {
  // Keep fractional cents: most single LLM calls cost well under 1¢ and
  // per-row rounding would erase the session's real spend.
  const total = rows.reduce((sum, row) => {
    const value = Number(row.charged_cost_cents || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  return roundCents(total);
}
