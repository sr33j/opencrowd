import { fallbackContextWindowTokens, type LlmModel } from "./llm-models.js";

export type ModelPolicyMode = "auto" | "manual";

export interface ModelPolicy {
  mode: ModelPolicyMode;
  /** Frontier model for the main loop; "auto" resolves from the live catalog. */
  main: string;
  /** Cheap fast model for subagents; "auto" resolves from the live catalog. */
  subagent: string;
}

export interface ResolvedModelPolicy {
  mode: ModelPolicyMode;
  main: string;
  subagent: string;
  resolvedAt: string;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  mode: "manual",
  main: "qwen/qwen3.8-max",
  subagent: "openai/gpt-5.6-luna"
};

/** Minimum context window a subagent model must offer before price wins. */
export const SUBAGENT_CONTEXT_FLOOR_TOKENS = 32_000;

/**
 * Model families considered frontier tier for the main loop. Auto mode
 * refuses to resolve when the catalog carries none of these, so a mid-tier
 * main loop never silently masquerades as a harness baseline.
 */
const FRONTIER_MODEL_PATTERNS = [
  /claude-(opus|sonnet)/,
  /\bopus\b/,
  /gpt-5/,
  /gpt-4\.1(?!-mini|-nano)/,
  /gemini-[23][.-]\d+-pro/,
  /grok-[34]/,
  /deepseek-r1/,
  /kimi-k2/,
  /qwen3?-max/
];

export function isFrontierModel(model: LlmModel): boolean {
  const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
  return FRONTIER_MODEL_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function resolveModelPolicy(models: LlmModel[], policy: ModelPolicy): ResolvedModelPolicy {
  if (models.length === 0) {
    throw new Error("cannot resolve model policy: the x402 LLM catalog returned no models");
  }
  const main = policy.main === "auto" ? resolveMainModel(models, policy.mode) : requireModel(models, policy.main, "main");
  const subagent = policy.subagent === "auto" ? resolveSubagentModel(models) : requireModel(models, policy.subagent, "subagent");
  return {
    mode: policy.mode,
    main,
    subagent,
    resolvedAt: new Date().toISOString()
  };
}

function resolveMainModel(models: LlmModel[], mode: ModelPolicyMode): string {
  const frontier = models.filter(isFrontierModel);
  if (frontier.length === 0) {
    if (mode === "auto") {
      throw new Error([
        "auto mode requires a frontier-tier model in the x402 catalog and none is available.",
        "Refusing to silently degrade to a mid-tier main loop: harness results would look like model losses.",
        "Run `opencrowd models list` to inspect the catalog, or set an explicit main model with `opencrowd models set <model>`."
      ].join(" "));
    }
    return mostCapableModel(models).id;
  }
  return mostCapableModel(frontier).id;
}

function resolveSubagentModel(models: LlmModel[]): string {
  const aboveFloor = models.filter((model) => contextWindow(model) >= SUBAGENT_CONTEXT_FLOOR_TOKENS);
  const candidates = aboveFloor.length > 0 ? aboveFloor : models;
  return candidates.reduce((cheapest, model) => costPer1k(model) < costPer1k(cheapest) ? model : cheapest).id;
}

function requireModel(models: LlmModel[], id: string, role: string): string {
  if (!models.some((model) => model.id === id)) {
    throw new Error(`${role} model \`${id}\` is not available from the configured x402 LLM provider; run \`opencrowd models list\``);
  }
  return id;
}

function mostCapableModel(models: LlmModel[]): LlmModel {
  // Output price is the best capability proxy the catalog metadata carries.
  return models.reduce((best, model) => costPer1k(model) > costPer1k(best) ? model : best);
}

function costPer1k(model: LlmModel): number {
  const output = model.output_cost_cents_per_1k;
  const input = model.input_cost_cents_per_1k;
  if (output !== undefined || input !== undefined) {
    return (output ?? 0) + (input ?? 0);
  }
  return model.max_cost_cents ?? 0;
}

function contextWindow(model: LlmModel): number {
  return model.context_window_tokens ?? fallbackContextWindowTokens(model.id);
}
