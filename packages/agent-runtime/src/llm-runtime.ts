import { DEFAULT_CONFIG, loadConfig, saveSession, type OpenCrowdConfig, type SessionState } from "@opencrowd/core";
import {
  isProviderId,
  OpenRouterProvider,
  resolveSessionModels,
  VeniceProvider,
  type ProviderId,
  type ProviderModel,
  type ResolvedSessionModels,
  type TypedLlmProvider
} from "./providers.js";
import { BlockRunProvider } from "./blockrun.js";
import { X402ProxyProvider } from "./x402-proxy.js";

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
  maxTopUpCentsPerAction: number;
  /**
   * Last-resort per-call rescue provider used only after the primary fails
   * transiently twice in a row. This is not a provider preference: sessions
   * never silently migrate; each rescue is recorded in the ledger.
   */
  fallback?: LlmFallbackRuntime;
}

export interface LlmFallbackRuntime {
  provider: TypedLlmProvider;
  mainModel: string;
  subagentModel: string;
}

/**
 * Headless and eval runs cap the per-request deadline: nobody is watching a
 * stuck call, and with stall detection plus one retry a shorter total bound
 * is safe. 240s stays above the longest healthy generation observed (~220s).
 */
export const NON_INTERACTIVE_LLM_TIMEOUT_MS = 240_000;

const providerCache = new Map<ProviderId, TypedLlmProvider>();

export interface TypedProviderOptions {
  timeoutMs?: number;
  openrouterApiKey?: string;
  x402ProxyUrl?: string;
}

/** Build a provider for a provider ID. */
export function createTypedProvider(id: ProviderId, options: TypedProviderOptions = {}): TypedLlmProvider {
  if (id === "blockrun") {
    return new BlockRunProvider({ timeoutMs: options.timeoutMs });
  }
  if (id === "x402") {
    return new X402ProxyProvider({ baseUrl: options.x402ProxyUrl, timeoutMs: options.timeoutMs });
  }
  if (id === "venice") {
    return new VeniceProvider({ timeoutMs: options.timeoutMs });
  }
  return new OpenRouterProvider({ apiKey: options.openrouterApiKey, timeoutMs: options.timeoutMs });
}

/** One long-lived provider (and underlying client) per process. */
export function sharedTypedProvider(id: ProviderId, options: TypedProviderOptions = {}): TypedLlmProvider {
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
  /** Headless/eval run: cap the per-request deadline (nobody can watch a stuck call). */
  nonInteractive?: boolean;
}

export async function resolveLlmRuntime(
  session: SessionState,
  overrides: LlmRuntimeOverrides = {}
): Promise<LlmRuntimeSelection> {
  const config = await loadConfig();
  const requested = overrides.provider ?? session.models?.provider ?? config.provider;
  if (!isProviderId(requested)) {
    throw new Error(`unknown LLM provider \`${requested}\`; supported: blockrun, x402, venice, openrouter`);
  }
  const providerId: ProviderId = requested;
  const timeoutMs = overrides.nonInteractive
    ? Math.min(config.llmTimeoutMs, NON_INTERACTIVE_LLM_TIMEOUT_MS)
    : config.llmTimeoutMs;
  const provider = sharedTypedProvider(providerId, { timeoutMs, x402ProxyUrl: config.x402ProxyUrl });
  const fallback = resolveFallbackRuntime(providerId, config, timeoutMs);

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
      maxCostCentsPerCall: config.llmMaxCostCentsPerCall,
      maxTopUpCentsPerAction: providerId === "venice" ? config.veniceMaxTopUpCents : 0,
      fallback
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
  return {
    provider,
    models,
    catalog,
    maxCostCentsPerCall: config.llmMaxCostCentsPerCall,
    maxTopUpCentsPerAction: providerId === "venice" ? config.veniceMaxTopUpCents : 0,
    fallback
  };
}

/**
 * Pair BlockRun with the current x402 route; preserve the established
 * x402/Venice pairing for explicitly selected providers. Rescue needs an
 * exact model ID —
 * "auto" would need a live catalog fetch on the rescue path, which is
 * exactly when the network is already misbehaving — so an "auto" preference
 * falls back to the shipped default model for that provider.
 */
function resolveFallbackRuntime(
  primary: ProviderId,
  config: OpenCrowdConfig,
  timeoutMs: number
): LlmFallbackRuntime | undefined {
  const backupId = rescueProviderId(primary);
  const exact = (preferred: string, shipped: string): string =>
    preferred === "auto" || preferred === "off" ? shipped : preferred;
  const mainModel = exact(config[backupId].model, DEFAULT_CONFIG[backupId].model);
  const subagentModel = exact(config[backupId].submodel, mainModel);
  return {
    provider: sharedTypedProvider(backupId, { timeoutMs, x402ProxyUrl: config.x402ProxyUrl }),
    mainModel,
    subagentModel
  };
}

/** Stable provider pairing used by the bounded per-call rescue ladder. */
export function rescueProviderId(primary: ProviderId): ProviderId {
  if (primary === "blockrun" || primary === "venice") {
    return "x402";
  }
  return "venice";
}
