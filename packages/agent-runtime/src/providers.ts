import { VeniceClient, VeniceError } from "venice-x402-client";
import { requireAgentCashWallet } from "@opencrowd/core";

/**
 * Typed LLM provider contract. Venice (default) authenticates with the
 * AgentCash wallet over SIWX and consumes prepaid Venice credit; OpenRouter
 * (optional) calls the official OpenRouter API with an API key. There is no
 * automatic fallback between providers: a provider failure surfaces to the
 * user with remediation.
 */

export type ProviderId = "venice" | "openrouter";

export const PROVIDER_IDS: ProviderId[] = ["venice", "openrouter"];

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindowTokens?: number;
  inputCostCentsPer1k?: number;
  outputCostCentsPer1k?: number;
  supportsTools?: boolean;
  raw?: unknown;
}

/** Normalized usage for one completion, including cache metrics when supplied. */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** Actual cost in cents when the provider reports it. */
  costCents?: number;
}

export interface WireToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: WireToolCall[];
}

export interface WireToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  messages: WireMessage[];
  tools: WireToolDefinition[];
  /** Stable per-session cache key; byte-identical prefixes hit provider cache. */
  promptCacheKey?: string;
  /** Streaming callback for assistant text deltas (time-to-first-token). */
  onTextDelta?: (delta: string) => void;
}

export interface ProviderCompletion {
  content: string;
  toolCalls: WireToolCall[];
  usage: LlmUsage;
}

export interface TypedLlmProvider {
  readonly id: ProviderId;
  /** Model catalog; cached per instance with an explicit refresh path. */
  listModels(options?: { refresh?: boolean }): Promise<ProviderModel[]>;
  complete(request: CompletionRequest): Promise<ProviderCompletion>;
}

export interface VeniceProviderOptions {
  timeoutMs?: number;
  /** Test hook: supply the Venice client instead of building one from the wallet. */
  clientFactory?: () => Promise<VeniceLikeClient>;
}

/** The VeniceClient surface the provider needs (test seam). */
export interface VeniceLikeClient {
  readonly balance: number;
  requestRaw(path: string, init?: RequestInit): Promise<Response>;
  getBalance(): Promise<{ balanceUsd: number; canConsume: boolean; minimumTopUpUsd: number; suggestedTopUpUsd: number }>;
  topUp(amountUsd: number): Promise<void>;
}

export class VeniceProvider implements TypedLlmProvider {
  readonly id = "venice" as const;
  private client?: VeniceLikeClient;
  private clientPromise?: Promise<VeniceLikeClient>;
  private modelsCache?: ProviderModel[];

  constructor(private readonly options: VeniceProviderOptions = {}) {}

  /** One long-lived client per provider instance/process. */
  async getClient(): Promise<VeniceLikeClient> {
    if (this.client) {
      return this.client;
    }
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        if (this.options.clientFactory) {
          this.client = await this.options.clientFactory();
        } else {
          const wallet = await requireAgentCashWallet();
          this.client = new VeniceClient(wallet.privateKey, { timeoutMs: this.options.timeoutMs ?? 600_000 });
        }
        return this.client;
      })();
      this.clientPromise.catch(() => {
        this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  /** Last credit balance observed from inference responses; no remote call. */
  cachedCreditUsd(): number | undefined {
    const balance = this.client?.balance;
    return balance !== undefined && balance > 0 ? balance : undefined;
  }

  async listModels(options: { refresh?: boolean } = {}): Promise<ProviderModel[]> {
    if (!this.modelsCache || options.refresh) {
      const client = await this.getClient();
      const response = await client.requestRaw("/api/v1/models?type=text");
      const body = await response.json().catch(() => undefined);
      this.modelsCache = normalizeProviderModels(body);
    }
    return this.modelsCache;
  }

  async complete(request: CompletionRequest): Promise<ProviderCompletion> {
    const client = await this.getClient();
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireChatMessage),
      tools: request.tools.map(toWireToolDefinition),
      tool_choice: request.tools.length > 0 ? "auto" : undefined
    };
    if (request.promptCacheKey) {
      body.prompt_cache_key = request.promptCacheKey;
    }
    let response: Response;
    try {
      response = await client.requestRaw("/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw veniceRemediationError(error);
    }
    const parsed = await response.json().catch(() => undefined);
    return parseChatCompletionResponse(parsed);
  }
}

function veniceRemediationError(error: unknown): Error {
  if (error instanceof VeniceError) {
    if (error.code === "INSUFFICIENT_BALANCE") {
      return new Error(
        "Venice credit is exhausted. Fund the AgentCash wallet with USDC on Base, then retry — " +
        "OpenCrowd tops up Venice credit automatically within the session budget. (venice: INSUFFICIENT_BALANCE)"
      );
    }
    return new Error(`Venice inference failed (${error.code}): ${error.message}. Run \`opencrowd doctor\` to diagnose.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenRouterProvider implements TypedLlmProvider {
  readonly id = "openrouter" as const;
  private modelsCache?: ProviderModel[];
  private readonly baseUrl: string;

  constructor(private readonly options: OpenRouterProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  }

  private apiKey(): string {
    const key = this.options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        "OpenRouter requires an API key. Set OPENROUTER_API_KEY (create one at https://openrouter.ai/keys) " +
        "or switch back to the default provider with `/provider venice`."
      );
    }
    return key;
  }

  async listModels(options: { refresh?: boolean } = {}): Promise<ProviderModel[]> {
    if (!this.modelsCache || options.refresh) {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey()}` }
      });
      if (!response.ok) {
        throw new Error(`OpenRouter model list failed: HTTP ${response.status}. Check OPENROUTER_API_KEY and network access.`);
      }
      this.modelsCache = normalizeProviderModels(await response.json().catch(() => undefined));
    }
    return this.modelsCache;
  }

  async complete(request: CompletionRequest): Promise<ProviderCompletion> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireChatMessage),
      tools: request.tools.map(toWireToolDefinition),
      tool_choice: request.tools.length > 0 ? "auto" : undefined,
      // Returned usage/cost/cache accounting; no separate balance query.
      usage: { include: true }
    };
    const timeout = this.options.timeoutMs ?? 600_000;
    const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
    const parsed = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = errorDetail(parsed) ?? `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        throw new Error(`OpenRouter rejected the API key (${detail}). Check OPENROUTER_API_KEY.`);
      }
      if (response.status === 402) {
        throw new Error(`OpenRouter account credit is exhausted (${detail}). Add credits at https://openrouter.ai/credits.`);
      }
      throw new Error(`OpenRouter completion failed: ${detail}`);
    }
    return parseChatCompletionResponse(parsed);
  }
}

/** Build the process-wide provider for a provider ID. */
export function createTypedProvider(id: ProviderId, options: { timeoutMs?: number; openrouterApiKey?: string } = {}): TypedLlmProvider {
  if (id === "venice") {
    return new VeniceProvider({ timeoutMs: options.timeoutMs });
  }
  return new OpenRouterProvider({ apiKey: options.openrouterApiKey, timeoutMs: options.timeoutMs });
}

export function isProviderId(value: unknown): value is ProviderId {
  return value === "venice" || value === "openrouter";
}

/** Resolved per-session model selection, persisted for reproducibility. */
export interface ResolvedSessionModels {
  provider: ProviderId;
  main: string;
  /** Absent when subagents are disabled (`off`). */
  subagent?: string;
  resolvedAt: string;
}

/** Minimum context window a subagent model must offer before price wins. */
export const SUBAGENT_CONTEXT_FLOOR_TOKENS = 32_000;

export interface ModelPreferences {
  /** Exact model ID or "auto". */
  main: string;
  /** Exact model ID, "auto", or "off". */
  subagent: string;
}

/**
 * Resolve "auto"/explicit model preferences against the provider's live
 * catalog. Resolved IDs are exact and must be persisted on the session.
 */
export function resolveSessionModels(
  provider: ProviderId,
  models: ProviderModel[],
  preferences: ModelPreferences
): ResolvedSessionModels {
  if (models.length === 0) {
    throw new Error(`cannot resolve models: the ${provider} catalog returned no models`);
  }
  const main = preferences.main === "auto"
    ? autoMainModel(models)
    : requireModel(provider, models, preferences.main, "main");
  const subagent = preferences.subagent === "off"
    ? undefined
    : preferences.subagent === "auto"
      ? autoSubagentModel(models)
      : requireModel(provider, models, preferences.subagent, "subagent");
  return { provider, main, subagent, resolvedAt: new Date().toISOString() };
}

function autoMainModel(models: ProviderModel[]): string {
  // Tool calling is required by the agent loop; blended price is the best
  // capability proxy catalog metadata reliably carries.
  const toolCapable = models.filter((model) => model.supportsTools !== false);
  const candidates = toolCapable.length > 0 ? toolCapable : models;
  return candidates.reduce((best, model) => blendedCostPer1k(model) > blendedCostPer1k(best) ? model : best).id;
}

function autoSubagentModel(models: ProviderModel[]): string {
  const toolCapable = models.filter((model) => model.supportsTools !== false);
  const pool = toolCapable.length > 0 ? toolCapable : models;
  const aboveFloor = pool.filter((model) => contextWindow(model) >= SUBAGENT_CONTEXT_FLOOR_TOKENS);
  const candidates = aboveFloor.length > 0 ? aboveFloor : pool;
  return candidates.reduce((cheapest, model) => blendedCostPer1k(model) < blendedCostPer1k(cheapest) ? model : cheapest).id;
}

function requireModel(provider: ProviderId, models: ProviderModel[], id: string, role: string): string {
  if (!models.some((model) => model.id === id)) {
    throw new Error(`${role} model \`${id}\` is not in the ${provider} catalog; run \`/models\` to list available models`);
  }
  return id;
}

function blendedCostPer1k(model: ProviderModel): number {
  return (model.inputCostCentsPer1k ?? 0) + (model.outputCostCentsPer1k ?? 0);
}

function contextWindow(model: ProviderModel): number {
  return model.contextWindowTokens ?? fallbackContextWindowTokens(model.id);
}

export function fallbackContextWindowTokens(modelId: string | undefined): number {
  const model = modelId?.toLowerCase() ?? "";
  if (model.includes("gpt-5") || model.includes("gpt-4.1") || model.includes("claude") || model.includes("gemini")) {
    return 200_000;
  }
  if (model.includes("gpt-4o") || model.includes("glm") || model.includes("llama")) {
    return 128_000;
  }
  return 64_000;
}

/**
 * Some catalogs report absurd context lengths (128M tokens); trusting them
 * disables compaction forever. Fall back to the per-family default instead.
 */
function plausibleContextWindow(value: number | undefined): number | undefined {
  return value !== undefined && value > 4_000_000 ? undefined : value;
}

export function normalizeProviderModels(body: unknown): ProviderModel[] {
  const records = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown[] })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown[] })?.models)
        ? (body as { models: unknown[] }).models
        : [];
  return records.map(normalizeModel).filter((model): model is ProviderModel => model !== null);
}

function normalizeModel(record: unknown): ProviderModel | null {
  if (typeof record === "string") {
    return { id: record, raw: record };
  }
  if (!record || typeof record !== "object") {
    return null;
  }
  const item = record as Record<string, unknown>;
  const id = stringValue(item.id ?? item.model ?? item.slug);
  if (!id) {
    return null;
  }
  const spec = objectValue(item.model_spec);
  const pricing = objectValue(item.pricing) ?? objectValue(spec?.pricing);
  const capabilities = objectValue(spec?.capabilities);
  return {
    id,
    name: stringValue(item.name ?? item.display_name ?? spec?.name),
    contextWindowTokens: plausibleContextWindow(numberValue(
      item.context_length ?? item.context_window ?? spec?.availableContextTokens ?? spec?.contextLength
    )),
    inputCostCentsPer1k: costCentsPer1k(pricing?.prompt ?? pricing?.input),
    outputCostCentsPer1k: costCentsPer1k(pricing?.completion ?? pricing?.output),
    supportsTools: booleanValue(capabilities?.supportsFunctionCalling ?? toolSupportFromList(item.supported_parameters)),
    raw: record
  };
}

function toolSupportFromList(value: unknown): boolean | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(String).includes("tools");
}

/**
 * Pricing normalization. OpenRouter reports USD per token (strings); Venice
 * reports USD per million tokens objects ({ usd }) or plain numbers.
 */
function costCentsPer1k(value: unknown): number | undefined {
  const usd = objectValue(value)?.usd ?? value;
  const parsed = typeof usd === "number" ? usd : typeof usd === "string" && usd.trim() !== "" ? Number(usd) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  // Heuristic: USD-per-token values are tiny (< 0.01); USD-per-million are >= 0.01.
  if (parsed < 0.01) {
    return parsed * 1_000 * 100;
  }
  return (parsed / 1_000_000) * 1_000 * 100;
}

/** Serialize a loop message into the OpenAI-compatible wire shape. */
export function toWireChatMessage(message: WireMessage): Record<string, unknown> {
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
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments)
      }
    }));
    if (toolCalls?.length) {
      return { role: "assistant", tool_calls: toolCalls };
    }
    return { role: "assistant", content: message.content };
  }
  return { role: message.role, content: message.content };
}

function toWireToolDefinition(tool: WireToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

export function parseChatCompletionResponse(body: unknown): ProviderCompletion {
  const firstChoice = Array.isArray((body as { choices?: unknown[] })?.choices)
    ? (body as { choices: unknown[] }).choices[0]
    : undefined;
  const message = objectValue(objectValue(firstChoice)?.message) ?? {};
  return {
    content: messageContent(message.content),
    toolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map(toParsedToolCall).filter((toolCall): toolCall is WireToolCall => toolCall !== null)
      : [],
    usage: normalizeUsage((body as { usage?: unknown })?.usage)
  };
}

export function normalizeUsage(value: unknown): LlmUsage {
  const usage = objectValue(value);
  if (!usage) {
    return {};
  }
  const promptDetails = objectValue(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const costUsd = numberishValue(usage.cost ?? usage.total_cost);
  return {
    inputTokens: numberValue(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: numberValue(usage.completion_tokens ?? usage.output_tokens),
    cachedInputTokens: numberValue(promptDetails?.cached_tokens ?? usage.cached_tokens),
    cacheWriteTokens: numberValue(promptDetails?.cache_write_tokens ?? usage.cache_creation_input_tokens),
    costCents: costUsd !== undefined ? costUsd * 100 : undefined
  };
}

function toParsedToolCall(value: unknown): WireToolCall | null {
  const object = objectValue(value);
  if (!object) {
    return null;
  }
  const fn = objectValue(object.function) ?? {};
  const name = stringValue(fn.name);
  if (!name) {
    return null;
  }
  let parsedArguments: Record<string, unknown> = {};
  if (typeof fn.arguments === "string") {
    try {
      parsedArguments = JSON.parse(fn.arguments) as Record<string, unknown>;
    } catch {
      parsedArguments = {};
    }
  }
  return {
    id: stringValue(object.id) ?? `call-${Date.now()}`,
    name,
    arguments: parsedArguments
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
      const text = objectValue(part)?.text;
      return typeof text === "string" ? text : "";
    }).join("");
  }
  return "";
}

function errorDetail(body: unknown): string | undefined {
  const error = objectValue(body)?.error;
  if (typeof error === "string") {
    return error;
  }
  const message = objectValue(error)?.message;
  return typeof message === "string" ? message : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function numberishValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
