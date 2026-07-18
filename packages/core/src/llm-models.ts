import { loadConfig, updateConfig } from "./config.js";

export interface LlmModel {
  id: string;
  name?: string;
  max_cost_cents?: number;
  context_window_tokens?: number;
  input_cost_cents_per_1k?: number;
  output_cost_cents_per_1k?: number;
  raw?: unknown;
}

export interface LlmModelListOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function listLlmModels(options: LlmModelListOptions = {}): Promise<LlmModel[]> {
  const config = await loadConfig();
  const url = endpointUrl(options.baseUrl ?? config.x402LlmBaseUrl, "models");
  const response = await (options.fetchImpl ?? fetch)(url);
  if (!response.ok) {
    throw new Error(`x402 LLM model list failed: ${response.status} ${response.statusText}`);
  }
  return normalizeLlmModels(await response.json());
}

export async function setPreferredLlmModel(model: string): Promise<{ model: string }> {
  if (!model.trim()) {
    throw new Error("model is required");
  }
  await updateConfig({ x402LlmModel: model });
  return { model };
}

export function normalizeLlmModels(body: unknown): LlmModel[] {
  const records = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown[] }).data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown[] }).models)
        ? (body as { models: unknown[] }).models
        : [];

  return records.map(normalizeModel).filter((model): model is LlmModel => model !== null);
}

function normalizeModel(record: unknown): LlmModel | null {
  if (typeof record === "string") {
    return { id: record, raw: record };
  }
  if (!record || typeof record !== "object") {
    return null;
  }
  const item = record as Record<string, unknown>;
  const id = stringValue(item.id ?? item.model ?? item.name ?? item.slug);
  if (!id) {
    return null;
  }
  return {
    id,
    name: stringValue(item.name ?? item.display_name ?? item.displayName ?? objectValue(item.model_spec)?.name),
    max_cost_cents: numberValue(item.max_cost_cents ?? item.maxCostCents ?? item.upto_cost_cents ?? item.price_cents),
    context_window_tokens: numberValue(item.context_window_tokens ?? item.contextWindowTokens ?? item.context_window ?? item.contextWindow),
    input_cost_cents_per_1k: numberValue(item.input_cost_cents_per_1k ?? item.inputCostCentsPer1k),
    output_cost_cents_per_1k: numberValue(item.output_cost_cents_per_1k ?? item.outputCostCentsPer1k),
    raw: record
  };
}

export function fallbackContextWindowTokens(modelId: string | undefined): number {
  const model = modelId?.toLowerCase() ?? "";
  if (model.includes("gpt-5") || model.includes("gpt-4.1") || model.includes("claude") || model.includes("gemini")) {
    return 200_000;
  }
  if (model.includes("gpt-4o") || model.includes("glm")) {
    return 128_000;
  }
  return 64_000;
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function endpointUrl(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}
