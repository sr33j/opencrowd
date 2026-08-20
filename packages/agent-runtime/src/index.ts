import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import {
  appendLedgerEntry,
  budgetStatus,
  chargeActiveTestWallet,
  completeSession,
  createDefaultPaidHttpClient,
  executeTool,
  DEFAULT_LLM_MODEL,
  finalizeReservation,
  listLlmModels,
  loadConfig,
  readLedger,
  releaseReservation,
  reserveBudget,
  OPEN_CROWD_TOOLS,
  SUBAGENT_TOOL_NAMES,
  TOOL_NAMES,
  VeniceWalletPaidHttpClient,
  type LlmModel,
  type OpenCrowdConfig,
  type PaidHttpClient,
  type PaymentAdapter,
  type ProgressEvent,
  type ServiceCaps,
  type SessionState,
  type ServiceCandidate,
  type ToolContext,
  type ToolResult,
  type ToolName
} from "@opencrowd/core";

export interface LlmMessage {
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
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
}

export interface LlmProvider {
  complete(messages: LlmMessage[]): Promise<LlmResponse>;
}

export type ToolExecutor = (
  name: ToolName,
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolResult>;

export class OpenAiProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly tools?: ToolName[];
  private readonly extraTools?: DynamicToolDefinition[];

  constructor(options: { apiKey?: string; model?: string; tools?: ToolName[]; extraTools?: DynamicToolDefinition[] } = {}) {
    this.client = new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY });
    this.model = options.model ?? process.env.OPENCROWD_OPENAI_MODEL ?? "gpt-4o-mini";
    this.tools = options.tools;
    this.extraTools = options.extraTools;
  }

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAiMessage),
      tools: toolDefinitions(this.tools, this.extraTools),
      tool_choice: "auto"
    });
    const message = response.choices[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseArguments(toolCall.function.arguments)
      }))
    };
  }
}

export class AnthropicProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly tools?: ToolName[];
  private readonly extraTools?: DynamicToolDefinition[];

  constructor(options: { apiKey?: string; model?: string; baseUrl?: string; tools?: ToolName[]; extraTools?: DynamicToolDefinition[] } = {}) {
    this.tools = options.tools;
    this.extraTools = options.extraTools;
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required when OPENCROWD_LLM_PROVIDER=anthropic.");
    }
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.OPENCROWD_ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
    this.baseUrl = options.baseUrl ?? process.env.OPENCROWD_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  }

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    const system = messages.find((message) => message.role === "system")?.content;
    const response = await fetch(new URL("/v1/messages", this.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system,
        messages: messages.filter((message) => message.role !== "system").map(toAnthropicMessage),
        tools: [
          ...OPEN_CROWD_TOOLS.filter((tool) => !this.tools || this.tools.includes(tool.name)).map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
          })),
          ...(this.extraTools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
          }))
        ]
      })
    });
    const body = parseBody(await response.text());
    if (!response.ok) {
      throw new Error(`Anthropic LLM call failed: ${response.status} ${response.statusText} ${responseError(response, body)}`);
    }
    return parseAnthropicMessage(body, validToolNames(this.tools, this.extraTools));
  }
}

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

export interface MockToolExecutorOptions {
  services?: ServiceCandidate[];
}

export function createMockToolExecutor(options: MockToolExecutorOptions = {}): ToolExecutor {
  const services = options.services ?? MOCK_X402_SERVICES;
  return async (name, args, context) => {
    try {
      switch (name) {
        case "search_services": {
          const limit = integerValue(args.limit) ?? services.length;
          const maxBudgetCents = integerValue(args.max_budget_cents);
          const query = stringValue(args.query) ?? "mock service";
          context.onProgress?.({ type: "searching", message: `Mock searching Bazaar for "${query}"` });
          context.onProgress?.({ type: "ranking", message: "Mock ranking service candidates" });
          return ok(services
            .filter((service) => maxBudgetCents === undefined || service.price_cents === undefined || service.price_cents <= maxBudgetCents)
            .slice(0, limit));
        }
        case "get_budget_status":
          return ok(budgetStatus(context.session));
        case "list_allowed_services":
          return ok([
            {
              resource_url: services[0]?.resource_url ?? "https://mock.opencrowd.test/x402/service-1",
              mode: "yolo",
              caps: { max_cost_cents: 0, session_max_cents: 0 },
              created_at: context.session.createdAt,
              updated_at: context.session.updatedAt,
              notes: "mock test mode permission"
            }
          ]);
        case "add_allowed_service":
        case "request_service_permission":
          return ok({
            resource_url: stringValue(args.resource_url) ?? services[0]?.resource_url,
            mode: name === "request_service_permission" ? "ask_first" : "yolo",
            caps: objectValue(args.caps) ?? {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            notes: stringValue(args.reason) ?? "mock test mode permission"
          });
        case "remove_allowed_service":
          return ok({ removed: true, resource_url: stringValue(args.resource_url) });
        case "block_service":
          return ok({
            resource_url: stringValue(args.resource_url) ?? services[0]?.resource_url,
            mode: "blocked",
            caps: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            notes: "mock test mode block"
          });
        case "call_service": {
          const resourceUrl = stringValue(args.resource_url) ?? services[0]?.resource_url ?? "https://mock.opencrowd.test/x402/service-1";
          const method = stringValue(args.method) ?? "GET";
          const matchedService = services.find((service) => service.resource_url === resourceUrl);
          const costCents = integerValue(args.quoted_cost_cents) ?? matchedService?.price_cents ?? 0;
          const artifactPath = `artifacts/mock-service-calls/${Date.now()}-${slugUrl(resourceUrl)}.json`;
          context.onProgress?.({ type: "checking_budget", message: "Mock checking session budget" });
          context.onProgress?.({ type: "checking_permission", message: `Mock checking permission for ${resourceUrl}` });
          context.onProgress?.({ type: "reserving_spend", message: `Mock reserving ${costCents} cents` });
          const reservation = await reserveBudget(context.session, costCents);
          try {
            await chargeActiveTestWallet(costCents);
            await finalizeReservation(context.session, reservation, costCents);
            context.onProgress?.({ type: "calling_service", message: `Mock calling ${resourceUrl}` });
            context.onProgress?.({ type: "saving_artifact", message: "Mock saving service response artifact" });
            await appendLedgerEntry(context.session.ledgerPath, {
              session_id: context.session.sessionId,
              type: "service_call",
              resource_url: resourceUrl,
              method,
              quoted_cost_cents: costCents,
              charged_cost_cents: costCents,
              status: "charged",
              permission_mode: context.session.permissionMode,
              artifact_path: artifactPath,
              payment_id: "mock-payment",
              notes: "mock test mode service call"
            });
          } catch (error) {
            await releaseReservation(context.session, reservation);
            await appendLedgerEntry(context.session.ledgerPath, {
              session_id: context.session.sessionId,
              type: "service_call",
              resource_url: resourceUrl,
              method,
              quoted_cost_cents: costCents,
              charged_cost_cents: 0,
              status: "failed",
              permission_mode: context.session.permissionMode,
              artifact_path: artifactPath,
              notes: (error as Error).message
            });
            throw error;
          }
          return ok({
            status: 200,
            headers: { "content-type": "application/json", "x-opencrowd-mock": "true" },
            body: {
              ok: true,
              mock: true,
              resource_url: resourceUrl,
              method,
              summary: "This is a mock x402 service response. No network request occurred."
            },
            charged_cost_cents: costCents,
            artifact_path: artifactPath
          });
        }
        case "save_file":
          return ok({
            path: `artifacts/${stringValue(args.path) ?? "mock-output.txt"}`,
            bytes: Buffer.byteLength(stringValue(args.content) ?? ""),
            metadata: objectValue(args.metadata)
          });
        case "read_file":
          return ok({ content: `Mock file content for ${stringValue(args.path) ?? "unknown path"}.` });
        case "list_files":
          return ok([
            "mock-output.txt",
            "mock-service-calls/service-1.json"
          ].filter((path) => path.startsWith(stringValue(args.prefix) ?? "")));
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
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  };
}

export const MOCK_X402_SERVICES: ServiceCandidate[] = Array.from({ length: 10 }, (_, index) => {
  const number = index + 1;
  const method = number % 3 === 0 ? "POST" : "GET";
  const priceCents = number;
  return {
    resource_url: `https://mock.opencrowd.test/x402/service-${number}`,
    title: `Mock x402 Service ${number}`,
    description: `Deterministic mock x402 service ${number} for OpenCrowd test mode.`,
    methods: [method],
    price_cents: priceCents,
    price_display: `$${(priceCents / 100).toFixed(2)} USDC`,
    currency: "USDC",
    tags: ["mock", "x402", number % 2 === 0 ? "data" : "analysis"],
    score: 1 - index / 20,
    raw: { mock: true, id: number }
  };
});

function mockToolArguments(
  name: ToolName,
  messages: LlmMessage[],
  turn: number,
  random: SeededRandom
): Record<string, unknown> {
  const service = MOCK_X402_SERVICES[random.integer(MOCK_X402_SERVICES.length)] ?? MOCK_X402_SERVICES[0];
  const task = [...messages].reverse().find((message) => message.role === "user")?.content ?? "mock OpenCrowd task";
  switch (name) {
    case "search_services":
      return { query: task.slice(0, 80) || "mock OpenCrowd service", limit: 10 };
    case "get_budget_status":
    case "list_allowed_services":
      return {};
    case "add_allowed_service":
      return { resource_url: service.resource_url, caps: { max_cost_cents: service.price_cents ?? 0 } };
    case "remove_allowed_service":
    case "block_service":
      return { resource_url: service.resource_url };
    case "request_service_permission":
      return {
        resource_url: service.resource_url,
        reason: "Mock test mode wants to exercise permission handling.",
        caps: { max_cost_cents: service.price_cents ?? 0 }
      };
    case "call_service":
      return {
        resource_url: service.resource_url,
        method: service.methods[0] ?? "GET",
        quoted_cost_cents: service.price_cents ?? 0,
        body: { mock: true, task }
      };
    case "save_file":
      return {
        path: `mock-output-${turn}.txt`,
        content: `Mock output for: ${task}`,
        metadata: { mock: true, turn }
      };
    case "read_file":
      return { path: "mock-output.txt" };
    case "list_files":
      return {};
    case "run_shell":
      return { command: "echo mock test mode", cwd: ".", timeout_ms: 1000 };
    case "spawn_subagent":
      return { task: `Mock subtask for: ${task.slice(0, 80)}` };
    case "check_subagents":
      return {};
    case "complete_session":
      return { final_message: `Mock test mode completed task: ${task.slice(0, 120)}` };
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

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function slugUrl(url: string): string {
  return url.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "service";
}

export interface X402LlmProviderOptions {
  model?: string;
  maxCostCents?: number;
  paymentAdapter?: PaymentAdapter;
  paidHttpClient?: PaidHttpClient;
  fetchImpl?: typeof fetch;
  /** Restrict the tools advertised to the model (defaults to all tools). */
  tools?: ToolName[];
  /** Connector-ingested vendor tool definitions to advertise alongside built-ins. */
  extraTools?: DynamicToolDefinition[];
  /** Ledger session_id override so subagent spend stays tagged in the shared ledger. */
  ledgerSessionId?: string;
}

export class X402LlmProvider implements LlmProvider {
  private models?: LlmModel[];

  constructor(
    private readonly session: SessionState,
    private readonly options: X402LlmProviderOptions = {}
  ) {}

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    const config = await loadConfig();
    const modelId = this.options.model ?? config.x402LlmModel;
    const models = await this.getModels(config.x402LlmBaseUrl);
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) {
      const prefix = modelId === DEFAULT_LLM_MODEL
        ? `Default model \`${DEFAULT_LLM_MODEL}\` is not available from the configured x402 LLM provider.`
        : `Model \`${modelId}\` is not available from the configured x402 LLM provider.`;
      throw new Error(`${prefix} Run \`opencrowd models list\` and choose an available model with \`opencrowd models set <model>\`, or pass \`opencrowd run --model <model>\`.`);
    }

    const endpoint = endpointUrl(config.x402LlmBaseUrl, "chat/completions").toString();
    const mapped = messages.map(toOpenAiMessage);
    const body = {
      model: model.id,
      // Anthropic-family models need explicit cache breakpoints; OpenAI-style
      // backends cache stable prefixes automatically (our history is
      // append-only within a session, so prefixes stay stable).
      messages: /claude/i.test(model.id) ? withCacheControl(mapped) : mapped,
      tools: toolDefinitions(this.options.tools, this.options.extraTools),
      tool_choice: "auto"
    };
    const maxCostCents = this.options.maxCostCents ?? model.max_cost_cents ?? config.x402LlmMaxCostCents;

    const reservation = await reserveBudget(this.session, maxCostCents);
    const started = Date.now();
    let finalized = false;
    try {
      const response = await this.paidLlmRequest(endpoint, body, maxCostCents, config);
      const parsedBody = response.body;
      const usage = tokenUsage(parsedBody);
      const charged = response.chargedCostCents !== undefined
        ? Math.round(response.chargedCostCents)
        : response.ok
          ? usageCostCents(usage, model) ?? maxCostCents
          : 0;
      await finalizeReservation(this.session, reservation, charged);
      finalized = true;
      await appendLedgerEntry(this.session.ledgerPath, {
        session_id: this.options.ledgerSessionId ?? this.session.sessionId,
        type: "llm_call",
        endpoint,
        model: model.id,
        method: "POST",
        quoted_cost_cents: maxCostCents,
        charged_cost_cents: charged,
        status: response.ok ? "charged" : "failed",
        permission_mode: this.session.permissionMode,
        payment_id: response.paymentId,
        tx_hash: response.txHash,
        latency_ms: Date.now() - started,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        notes: response.ok ? undefined : responseError(response, parsedBody)
      });

      if (!response.ok) {
        throw new Error(`x402 LLM call failed: ${response.status} ${response.statusText}`);
      }
      return parseChatCompletion(parsedBody, validToolNames(this.options.tools, this.options.extraTools));
    } catch (error) {
      if (!finalized) {
        await releaseReservation(this.session, reservation);
        await appendLedgerEntry(this.session.ledgerPath, {
          session_id: this.options.ledgerSessionId ?? this.session.sessionId,
          type: "llm_call",
          endpoint,
          model: model.id,
          method: "POST",
          quoted_cost_cents: maxCostCents,
          charged_cost_cents: 0,
          status: "failed",
          permission_mode: this.session.permissionMode,
          latency_ms: Date.now() - started,
          notes: (error as Error).message
        });
      }
      throw error;
    }
  }

  private async getModels(baseUrl: string): Promise<LlmModel[]> {
    if (!this.models) {
      this.models = await listLlmModels({ baseUrl, fetchImpl: this.options.fetchImpl });
    }
    return this.models;
  }

  private async paidLlmRequest(endpoint: string, body: unknown, maxCostCents: number, config: OpenCrowdConfig): Promise<PaidLlmResponse> {
    if (this.options.paidHttpClient) {
      return this.options.paidHttpClient.request({
        url: endpoint,
        method: "POST",
        maxCostCents,
        headers: { "content-type": "application/json" },
        body
      });
    }
    if (this.options.paymentAdapter || this.options.fetchImpl) {
      const signer = this.options.paymentAdapter;
      if (!signer) {
        throw new Error("a paymentAdapter is required when fetchImpl is supplied");
      }
      let signed;
      try {
        signed = await signer.sign({
          resourceUrl: endpoint,
          method: "POST",
          quotedCostCents: maxCostCents,
          paymentKind: "upto",
          body
        });
      } catch (error) {
        throw new Error(`${(error as Error).message}. x402 LLM calls require upto payment authorization; exact-payment fallback is not enabled.`);
      }
      const response = await (this.options.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signed.headers
        },
        body: JSON.stringify(body)
      });
      const responseText = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: parseBody(responseText),
        chargedCostCents: chargedCost(response, maxCostCents),
        paymentId: paymentId(response, signed.paymentId),
        txHash: txHash(response, signed.txHash)
      };
    }
    const client = await createDefaultPaidHttpClient();
    return client.request({
      url: endpoint,
      method: "POST",
      maxCostCents,
      headers: { "content-type": "application/json" },
      body
    });
  }
}

interface PaidLlmResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  chargedCostCents?: number;
  paymentId?: string;
  txHash?: string;
}

export interface PermissionRequest {
  resource_url: string;
  reason: string;
  caps?: ServiceCaps;
}

export interface AgentRunOptions {
  provider?: LlmProvider;
  model?: string;
  history?: LlmMessage[];
  onMessage?: (message: LlmMessage) => Promise<void> | void;
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Human-in-the-loop gate for request_service_permission. When set, the
   * permission is only recorded if this resolves true; otherwise the agent
   * receives a denial. When unset (MCP/local-api/non-interactive), the
   * request is recorded directly as before.
   */
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>;
  toolExecutor?: ToolExecutor;
  compactOutput?: boolean;
  maxTurns?: number;
  /** Restrict the tools advertised to the model. Defaults to every tool except spawn_subagent unless `subagent` is set. */
  tools?: ToolName[];
  /** Enable spawn_subagent delegation to a cheap fast model with local tools only. */
  subagent?: SubagentOptions;
  /**
   * Connector-ingested vendor tools (integration spec). When present, the
   * legacy marketplace/permission tools are dropped from the model surface
   * and `promptSections` replaces the legacy economy prompt.
   */
  dynamicTools?: DynamicToolsOption;
  /** Live-fact prompt sections (balances, vendor instructions, house rules). */
  promptSections?: string[];
  /**
   * When set, the in-memory context is compacted mid-run once it exceeds
   * ~70% of this window. The persisted trajectory keeps full fidelity.
   */
  contextWindowTokens?: number;
}

/** Legacy economic surface retired from the model when connector tools are active. */
export const LEGACY_ECONOMY_TOOLS: ToolName[] = [
  "search_services",
  "call_service",
  "list_allowed_services",
  "add_allowed_service",
  "remove_allowed_service",
  "block_service",
  "request_service_permission"
];

export interface SubagentOptions {
  model: string;
  maxTurns?: number;
  /** Human-readable price hint (for the delegation prompt), e.g. "$0.01 max per call". */
  costHint?: string;
  /** Explicit subagent provider (tests and custom wiring). */
  provider?: LlmProvider;
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

export type AgentTaskOutcome = "completed" | "stopped" | "max_turns";

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
  let enabledTools = options.tools
    ?? (options.subagent ? TOOL_NAMES : TOOL_NAMES.filter((name) => name !== "spawn_subagent"));
  if (options.dynamicTools) {
    enabledTools = enabledTools.filter((name) => !LEGACY_ECONOMY_TOOLS.includes(name));
  }
  const dynamicDefinitions = options.dynamicTools?.definitions ?? [];
  const provider = options.provider ?? defaultProvider(session, options.model, enabledTools, dynamicDefinitions);
  const toolExecutor = options.toolExecutor ?? executeTool;
  const systemPromptParts = [
    "You are the local OpenCrowd agent running as a CLI or MCP-backed tool on the user's personal machine.",
    "You have a Base USDC wallet attached to this session, local file tools, and a gated bash tool.",
    "Try to solve the user's task completely. Use local files and bash when they are sufficient, but remember they are bounded by the user's installed tools, credentials, network, open ports, and process lifetime.",
    "Before repeatedly fighting the local environment, decide whether the task needs external capability such as hosting, persistent infrastructure, remote compute, specialized APIs, live data, or access the user's device does not have."
  ];
  if (options.dynamicTools) {
    systemPromptParts.push(
      "When the local computer is not the right environment, or after one clear local capability failure, use the paid connector tools; discovering and paying bespoke services is your superpower.",
      "Each tool result includes the budget before and after that tool call.",
      ...(options.promptSections ?? [])
    );
  } else {
    systemPromptParts.push(
      "When the local or hosted computer is not the right environment, or after one clear local capability failure, use search_services; discovering bespoke x402 services is your superpower.",
      "After selecting a service, spend Base USDC with call_service as needed.",
      "You may need to try multiple services or use several services in sequence. Each tool result includes the budget before and after that tool call.",
      "Budgeting and permissioning are local policy gates; yolo mode means services are allowed unless blocked. Never ask for wallet private keys or secrets."
    );
  }
  systemPromptParts.push("End by calling complete_session with a concise final message.");
  if (options.subagent) {
    systemPromptParts.push(
      `Delegation: spawn_subagent runs a cheaper, faster model (${options.subagent.model}${options.subagent.costHint ? `, ${options.subagent.costHint}` : ""}) with local file and shell tools only.`,
      "Multiple spawn_subagent calls in one reply run in parallel, so batch independent subtasks into a single reply; scale effort to the task (simple lookups need no subagents; broad sweeps merit 2-4).",
      "Give each subagent an objective, expected output format, and clear boundaries so parallel subagents cannot make conflicting decisions; they see none of this conversation, so pass explicit context (file paths, constraints).",
      "Each subagent's files land under artifacts/subagents/<n>/ and its completion lists what it wrote.",
      "Delegate bounded, low-judgment work such as searching, summarizing, extracting, or mechanical edits; keep planning, paid-service decisions, and final answers in this main loop."
    );
  }
  const messages: LlmMessage[] = [
    { role: "system", content: systemPromptParts.join(" ") },
    ...(options.history ?? []),
    { role: "user", content: task }
  ];
  await options.onMessage?.({ role: "user", content: task });

  const maxTurns = options.maxTurns ?? 100;
  const repeatedFailures = new Map<string, number>();
  let serviceCallFailures = 0;
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
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (options.contextWindowTokens) {
      const compacted = compactMessagesInPlace(messages, options.contextWindowTokens);
      if (compacted) {
        options.onProgress?.({
          type: "complete",
          message: `Compacted ${compacted.droppedMessages} earlier messages mid-run (~${compacted.tokensBefore} tokens; trajectory keeps full history)`
        });
      }
    }
    options.onProgress?.({ type: "calling_llm", message: `Calling LLM provider (turn ${turn + 1}/${maxTurns})` });
    const response = provider instanceof MockLlmProvider
      ? await completeMockLlmCall(session, provider, messages, turn + 1)
      : await provider.complete(messages);
    if (response.content || response.toolCalls.length > 0) {
      const assistantMessage = assistantMessageFromResponse(response);
      messages.push(assistantMessage);
      await options.onMessage?.(assistantMessage);
    }
    if (response.toolCalls.length === 0) {
      const summary = await completeSession(session, response.content || "Session completed.");
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
        const promise = subagentLimiter(() => runSubagentTask(session, call.arguments, subagent, index, options));
        if (call.arguments.background === true) {
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
      options.onProgress?.({
        type: "calling_tool",
        message: `Tool call: ${summarizeToolCall(call)}`,
        data: { tool: call.name, arguments: call.arguments }
      });
      const budgetBeforeToolCall = budgetStatus(session);
      let result: ToolResult;
      if (call.name === "spawn_subagent") {
        result = options.subagent
          ? await (spawnedThisTurn.get(call.id) ?? Promise.resolve({ ok: false, error: "subagent launch failed" }))
          : { ok: false, error: "subagents are not enabled for this session" };
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
        result = await runGatedTool(toolExecutor, call as LlmToolCall & { name: ToolName }, session, options);
      } else if (options.dynamicTools) {
        result = await options.dynamicTools.execute(call.name, call.arguments);
      } else {
        result = { ok: false, error: `unknown tool: ${call.name}` };
      }
      const budgetAfterToolCall = budgetStatus(session);
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
      messages.push(toolMessage);
      await options.onMessage?.(toolMessage);
      if (!result.ok) {
        if (call.name === "call_service") {
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
      if (call.name === "complete_session") {
        const backgroundResults = backgroundSubagents.size > 0 ? await drainBackground() : undefined;
        if (result.ok && result.data && typeof result.data === "object") {
          const summary = result.data as Record<string, unknown>;
          if (backgroundResults) {
            summary.background_subagents = backgroundResults;
          }
          return { outcome: "completed", summary, turns: turn + 1 };
        }
        const summary = await completeSession(session, response.content || result.error || "Session completed.");
        if (backgroundResults) {
          summary.background_subagents = backgroundResults;
        }
        return { outcome: "completed", summary, turns: turn + 1 };
      }
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
  parentOptions: AgentRunOptions
): Promise<ToolResult> {
  const task = typeof args.task === "string" ? args.task : "";
  if (!task) {
    return { ok: false, error: "spawn_subagent requires a task" };
  }
  const subagentId = `${session.sessionId}#sub${index}`;
  const trajectoryDir = join(session.sessionDir, "subagents", String(index));
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
  const messages: LlmMessage[] = [
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
  for (const message of messages) {
    await record(message);
  }

  const repeatedFailures = new Map<string, number>();
  const artifactsWritten: string[] = [];
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
    return { ok: true, data: completion };
  };

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      forwardProgress({ type: "calling_llm", message: `Calling LLM provider (turn ${turn + 1}/${maxTurns})` });
      const response = provider instanceof MockLlmProvider
        ? await completeMockLlmCall(session, provider, messages, turn + 1)
        : await provider.complete(messages);
      if (response.content || response.toolCalls.length > 0) {
        const assistantMessage = assistantMessageFromResponse(response);
        messages.push(assistantMessage);
        await record(assistantMessage);
      }
      if (response.toolCalls.length === 0) {
        return finish("completed", response.content || "Subagent finished.", turn + 1);
      }
      for (const call of response.toolCalls) {
        if (call.name === "complete_session") {
          const finalMessage = typeof call.arguments.final_message === "string" && call.arguments.final_message
            ? call.arguments.final_message
            : response.content || "Subagent finished.";
          return finish("completed", finalMessage, turn + 1);
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
          ? await toolExecutor(call.name as ToolName, callArguments, { session, onProgress: forwardProgress })
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
  if (process.env.OPENCROWD_LLM_PROVIDER === "openai") {
    return new OpenAiProvider({ model: subagent.model, tools: SUBAGENT_TOOL_NAMES });
  }
  if (process.env.OPENCROWD_LLM_PROVIDER === "anthropic") {
    return new AnthropicProvider({ model: subagent.model, tools: SUBAGENT_TOOL_NAMES });
  }
  return new X402LlmProvider(session, {
    model: subagent.model,
    tools: SUBAGENT_TOOL_NAMES,
    ledgerSessionId: subagentId
  });
}

async function runGatedTool(
  toolExecutor: ToolExecutor,
  call: LlmToolCall & { name: ToolName },
  session: SessionState,
  options: AgentRunOptions
): Promise<ToolResult> {
  if (call.name === "request_service_permission" && options.onPermissionRequest) {
    const request: PermissionRequest = {
      resource_url: String(call.arguments.resource_url ?? ""),
      reason: String(call.arguments.reason ?? ""),
      caps: objectValue(call.arguments.caps) as ServiceCaps | undefined
    };
    options.onProgress?.({
      type: "requesting_permission",
      message: `Waiting for user approval: ${request.resource_url}`,
      data: { ...request } as unknown as Record<string, unknown>
    });
    const approved = await options.onPermissionRequest(request);
    if (!approved) {
      return {
        ok: false,
        error: `user denied permission for ${request.resource_url}; do not retry this service unless the user asks`
      };
    }
  }
  return toolExecutor(call.name, call.arguments, { session, onProgress: options.onProgress });
}

/**
 * Mid-run in-memory compaction: keep the system prompt and the most recent
 * messages under ~30% of the window, replace the dropped middle with a
 * short summary message. The persisted trajectory is untouched, so graders
 * keep full fidelity. Costs one cache miss per compaction.
 */
function compactMessagesInPlace(
  messages: LlmMessage[],
  contextWindowTokens: number
): { droppedMessages: number; tokensBefore: number } | undefined {
  const estimate = (items: LlmMessage[]) => items.reduce((total, message) => {
    const toolCalls = message.toolCalls ? JSON.stringify(message.toolCalls) : "";
    return total + Math.ceil((message.role.length + message.content.length + toolCalls.length) / 4);
  }, 0);
  const tokensBefore = estimate(messages);
  if (tokensBefore <= contextWindowTokens * 0.7 || messages.length < 8) {
    return undefined;
  }
  const system = messages[0];
  const keepBudget = Math.floor(contextWindowTokens * 0.3);
  const recent: LlmMessage[] = [];
  let recentTokens = 0;
  for (let index = messages.length - 1; index > 0; index -= 1) {
    const tokens = estimate([messages[index]]);
    if (recent.length > 0 && recentTokens + tokens > keepBudget) {
      break;
    }
    recent.unshift(messages[index]);
    recentTokens += tokens;
  }
  // Never let the kept window start with an orphaned tool result.
  while (recent[0]?.role === "tool") {
    recent.shift();
  }
  const dropped = messages.length - 1 - recent.length;
  if (dropped <= 0) {
    return undefined;
  }
  const droppedSlice = messages.slice(1, 1 + dropped);
  const firstUser = droppedSlice.find((message) => message.role === "user")?.content.trim();
  const lastAssistant = [...droppedSlice].reverse().find((message) => message.role === "assistant" && message.content.trim())?.content.trim();
  const summary: LlmMessage = {
    role: "user",
    content: [
      `Earlier context was compacted mid-run to stay within the model window (${dropped} messages, ~${tokensBefore} tokens before).`,
      firstUser ? `Original task: ${firstUser.slice(0, 800)}` : undefined,
      lastAssistant ? `Most recent progress before compaction: ${lastAssistant.slice(0, 1200)}` : undefined,
      "Continue from the retained recent messages below."
    ].filter(Boolean).join("\n")
  };
  messages.splice(0, messages.length, system, summary, ...recent);
  return { droppedMessages: dropped, tokensBefore };
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
    await chargeActiveTestWallet(costCents);
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
      permission_mode: session.permissionMode,
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
      permission_mode: session.permissionMode,
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

function defaultProvider(
  session: SessionState,
  model: string | undefined,
  tools?: ToolName[],
  extraTools?: DynamicToolDefinition[]
): LlmProvider {
  if (process.env.OPENCROWD_LLM_PROVIDER === "openai") {
    return new OpenAiProvider({ model, tools, extraTools });
  }
  if (process.env.OPENCROWD_LLM_PROVIDER === "anthropic") {
    return new AnthropicProvider({ model, tools, extraTools });
  }
  return new X402LlmProvider(session, { model, tools, extraTools });
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
    case "searching":
      return `     ${event.message}`;
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
    case "searching":
    case "ranking":
    case "checking_budget":
    case "checking_permission":
    case "requesting_permission":
    case "reserving_spend":
    case "signing_with_ows":
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

function renderAgentSummary(summary: Record<string, unknown>, options: AgentRunOptions): string {
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

function toolDefinitions(names?: ToolName[], extraTools?: DynamicToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    ...OPEN_CROWD_TOOLS.filter((tool) => !names || names.includes(tool.name)).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name as string,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>
      }
    })),
    ...(extraTools ?? []).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
  ];
}

function validToolNames(names?: ToolName[], extraTools?: DynamicToolDefinition[]): Set<string> {
  return new Set<string>([
    ...(names ?? TOOL_NAMES),
    ...(extraTools ?? []).map((tool) => tool.name)
  ]);
}

function summarizeToolCall(call: LlmToolCall): string {
  switch (call.name) {
    case "search_services":
      return `search_services query="${String(call.arguments.query ?? "")}"`;
    case "call_service":
      return `call_service ${String(call.arguments.method ?? "POST")} ${String(call.arguments.resource_url ?? "")}`;
    case "request_service_permission":
      return `request_service_permission ${String(call.arguments.resource_url ?? "")}`;
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
  if (name === "search_services" && Array.isArray(result.data)) {
    const first = result.data[0] as { title?: unknown; resource_url?: unknown; price_display?: unknown } | undefined;
    return `search_services found ${result.data.length} candidate${result.data.length === 1 ? "" : "s"}${first ? `; top: ${String(first.title ?? first.resource_url)} (${String(first.price_display ?? "price unknown")})` : ""}`;
  }
  if (name === "call_service" && result.data && typeof result.data === "object") {
    const data = result.data as { status?: unknown; charged_cost_cents?: unknown; artifact_path?: unknown };
    return `call_service HTTP ${String(data.status ?? "unknown")}, charged ${formatCents(Number(data.charged_cost_cents ?? 0))}${data.artifact_path ? `, saved ${String(data.artifact_path)}` : ""}`;
  }
  if (name === "get_budget_status" && result.data && typeof result.data === "object") {
    const data = result.data as { remaining_cents?: unknown };
    return `remaining ${formatCents(Number(data.remaining_cents ?? 0))}`;
  }
  if (name === "request_service_permission" && result.data && typeof result.data === "object") {
    const data = result.data as { resource_url?: unknown; mode?: unknown };
    return `permission ${String(data.mode ?? "recorded")} for ${String(data.resource_url ?? "")}`;
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

function toOpenAiMessage(message: LlmMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content
    };
  }
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments)
      }
    }));
    if (toolCalls?.length) {
      return {
        role: "assistant",
        tool_calls: toolCalls
      } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    }
    return {
      role: "assistant",
      content: message.content
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
  }
  return {
    role: message.role,
    content: message.content
  };
}

function toAnthropicMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content
      }]
    };
  }
  if (message.role === "assistant") {
    const content: Record<string, unknown>[] = [];
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }
    for (const toolCall of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments
      });
    }
    return { role: "assistant", content };
  }
  return {
    role: "user",
    content: message.content
  };
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseBody(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseChatCompletion(body: unknown, validNames: Set<string> = new Set(TOOL_NAMES)): LlmResponse {
  const firstChoice = Array.isArray((body as { choices?: unknown[] })?.choices)
    ? (body as { choices: unknown[] }).choices[0]
    : undefined;
  const message = firstChoice && typeof firstChoice === "object"
    ? (firstChoice as { message?: unknown }).message
    : undefined;
  const objectMessage = message && typeof message === "object" ? message as Record<string, unknown> : {};
  return {
    content: messageContent(objectMessage.content),
    toolCalls: Array.isArray(objectMessage.tool_calls)
      ? objectMessage.tool_calls.map((value) => toToolCall(value, validNames)).filter((toolCall): toolCall is LlmToolCall => toolCall !== null)
      : []
  };
}

function parseAnthropicMessage(body: unknown, validNames: Set<string> = new Set(TOOL_NAMES)): LlmResponse {
  const content = Array.isArray((body as { content?: unknown[] })?.content)
    ? (body as { content: unknown[] }).content
    : [];
  const text = content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      return typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "";
    }
    return "";
  }).join("");
  const toolCalls = content.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "tool_use") {
      return null;
    }
    const object = block as Record<string, unknown>;
    const name = typeof object.name === "string" ? object.name : undefined;
    if (!name || !validNames.has(name)) {
      return null;
    }
    return {
      id: typeof object.id === "string" ? object.id : `call-${Date.now()}`,
      name,
      arguments: object.input && typeof object.input === "object" && !Array.isArray(object.input)
        ? object.input as Record<string, unknown>
        : {}
    };
  }).filter((toolCall): toolCall is LlmToolCall => toolCall !== null);
  return { content: text, toolCalls };
}

function toToolCall(value: unknown, validNames: Set<string>): LlmToolCall | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const object = value as Record<string, unknown>;
  const fn = object.function && typeof object.function === "object" ? object.function as Record<string, unknown> : {};
  const name = typeof fn.name === "string" ? fn.name : undefined;
  if (!name || !validNames.has(name)) {
    return null;
  }
  return {
    id: typeof object.id === "string" ? object.id : `call-${Date.now()}`,
    name,
    arguments: typeof fn.arguments === "string" ? parseArguments(fn.arguments) : {}
  };
}

function messageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    }).join("");
  }
  return "";
}

function chargedCost(response: Response, fallback: number): number {
  const header = response.headers.get("x402-charged-cost-cents") ?? response.headers.get("x-charged-cost-cents");
  if (header && Number.isFinite(Number(header))) {
    return Math.round(Number(header));
  }
  return response.ok ? fallback : 0;
}

function paymentId(response: Response, fallback: string | undefined): string | undefined {
  return response.headers.get("x402-payment-id") ?? response.headers.get("x-payment-id") ?? fallback;
}

function txHash(response: Response, fallback: string | undefined): string | undefined {
  return response.headers.get("x402-tx-hash") ?? response.headers.get("x-transaction-hash") ?? fallback;
}

/** Cache breakpoints on the system prompt and the latest message; the prefix between them hits cache. */
function withCacheControl(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): unknown[] {
  return messages.map((message, index) => {
    const isBreakpoint = index === 0 || index === messages.length - 1;
    if (!isBreakpoint || typeof message.content !== "string" || message.content.length === 0) {
      return message;
    }
    return {
      ...message,
      content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }]
    };
  });
}

/** Actual cost from token usage and catalog pricing when the route doesn't report settled cost. */
function usageCostCents(usage: { inputTokens?: number; outputTokens?: number }, model: LlmModel): number | undefined {
  if (model.input_cost_cents_per_1k === undefined && model.output_cost_cents_per_1k === undefined) {
    return undefined;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }
  const cents = ((usage.inputTokens ?? 0) / 1_000) * (model.input_cost_cents_per_1k ?? 0)
    + ((usage.outputTokens ?? 0) / 1_000) * (model.output_cost_cents_per_1k ?? 0);
  return Math.round(cents);
}

function tokenUsage(body: unknown): { inputTokens?: number; outputTokens?: number } {
  const usage = body && typeof body === "object" ? (body as { usage?: unknown }).usage : undefined;
  if (!usage || typeof usage !== "object") {
    return {};
  }
  const object = usage as Record<string, unknown>;
  return {
    inputTokens: numberValue(object.prompt_tokens ?? object.input_tokens),
    outputTokens: numberValue(object.completion_tokens ?? object.output_tokens)
  };
}

function responseError(response: { status: number }, body: unknown): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return `HTTP ${response.status}: ${(error as { message: string }).message}`;
    }
  }
  return `HTTP ${response.status}`;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.round(Number(value));
  }
  return undefined;
}

function endpointUrl(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function sumCents(rows: Record<string, string>[]): number {
  return rows.reduce((total, row) => {
    const value = Number(row.charged_cost_cents || 0);
    return total + (Number.isFinite(value) ? Math.round(value) : 0);
  }, 0);
}
