import { loadConfig, saveSession, type SessionState } from "@opencrowd/core";
import {
  createTypedProvider,
  isProviderId,
  resolveSessionModels,
  type ProviderId,
  type ProviderModel,
  type ResolvedSessionModels,
  type TypedLlmProvider
} from "./providers.js";

/**
 * Session-facing provider/model resolution. Resolved model IDs are persisted
 * on the session so `run --session` reproduces the same choices; providers
 * are cached per process so clients stay long-lived.
 */

export interface LlmRuntimeSelection {
  provider: TypedLlmProvider;
  models: ResolvedSessionModels;
  catalog: ProviderModel[];
  maxCostCentsPerCall: number;
}

const providerCache = new Map<ProviderId, TypedLlmProvider>();

/** One long-lived provider (and underlying client) per process. */
export function sharedTypedProvider(id: ProviderId, options: { timeoutMs?: number } = {}): TypedLlmProvider {
  let provider = providerCache.get(id);
  if (!provider) {
    provider = createTypedProvider(id, options);
    providerCache.set(id, provider);
  }
  return provider;
}

/** Test hook: drop cached providers so tests can inject fresh state. */
export function resetSharedTypedProviders(): void {
  providerCache.clear();
}

export interface LlmRuntimeOverrides {
  provider?: string;
  model?: string;
  subagentModel?: string;
  /** Force "auto" resolution for any preference not explicitly overridden. */
  auto?: boolean;
}

export async function resolveLlmRuntime(
  session: SessionState,
  overrides: LlmRuntimeOverrides = {}
): Promise<LlmRuntimeSelection> {
  const config = await loadConfig();
  const requested = overrides.provider ?? session.models?.provider ?? config.provider;
  if (!isProviderId(requested)) {
    throw new Error(`unknown LLM provider \`${requested}\`; supported: venice, openrouter`);
  }
  const providerId: ProviderId = requested;
  const provider = sharedTypedProvider(providerId, { timeoutMs: config.llmTimeoutMs });

  // Reuse the session's recorded resolution when nothing overrides it, so a
  // resumed session keeps its exact provider and models.
  const recorded = session.models;
  if (!overrides.model && !overrides.subagentModel && !overrides.auto
    && recorded && recorded.provider === providerId) {
    const catalog = await provider.listModels().catch(() => []);
    return {
      provider,
      models: { ...recorded, provider: providerId },
      catalog,
      maxCostCentsPerCall: config.llmMaxCostCentsPerCall
    };
  }

  const defaults = config[providerId];
  const preferences = {
    main: overrides.model ?? (overrides.auto ? "auto" : defaults.model),
    subagent: overrides.subagentModel ?? (overrides.auto ? "auto" : defaults.submodel)
  };
  const catalog = await provider.listModels();
  const models = resolveSessionModels(providerId, catalog, preferences);
  session.models = models;
  await saveSession(session);
  return { provider, models, catalog, maxCostCentsPerCall: config.llmMaxCostCentsPerCall };
}
