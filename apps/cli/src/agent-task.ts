import {
  appendConversationMessage,
  compactConversationIfNeeded,
  fallbackContextWindowTokens,
  listLlmModels,
  loadConfig,
  readConversationMessages,
  resolveModelPolicy,
  saveSession,
  type ConversationMessage,
  type LlmModel,
  type ModelPolicy,
  type ProgressEvent,
  type ResolvedModelPolicy,
  type SessionState
} from "@opencrowd/core";
import { buildEconomyContext, sharedConnectorManager, type EconomyContext } from "@opencrowd/connectors";
import {
  createMockToolExecutor,
  MockLlmProvider,
  runAgentTask,
  runAgentTaskDetailed,
  type AgentRunOptions,
  type AgentTaskResult,
  type LlmMessage,
  type PermissionRequest,
  type SubagentOptions,
  type ToolExecutor
} from "@opencrowd/agent-runtime";

export interface ReplState {
  model?: string;
  testMode: boolean;
  testSeed?: string;
  mockProvider?: MockLlmProvider;
  mockToolExecutor?: ToolExecutor;
}

export function ensureMockRuntime(state: ReplState): ReplState {
  state.mockProvider ??= new MockLlmProvider({ seed: state.testSeed });
  state.mockToolExecutor ??= createMockToolExecutor();
  return state;
}

export interface PersistentAgentTaskOptions {
  model?: string;
  /** Explicit subagent model; overrides the configured policy. */
  subagentModel?: string;
  /** Force auto model policy for this run (frontier main + cheap subagents). */
  forceAutoPolicy?: boolean;
  testMode?: boolean;
  testSeed?: string;
  mockProvider?: MockLlmProvider;
  mockToolExecutor?: ToolExecutor;
  compactOutput?: boolean;
  maxTurns?: number;
  onProgress?: (event: ProgressEvent) => void;
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>;
}

export async function runPersistentAgentTask(
  session: SessionState,
  task: string,
  options: PersistentAgentTaskOptions = {}
): Promise<string> {
  const runOptions = await preparePersistentRun(session, options);
  return runAgentTask(session, task, runOptions);
}

export async function runPersistentAgentTaskDetailed(
  session: SessionState,
  task: string,
  options: PersistentAgentTaskOptions = {}
): Promise<AgentTaskResult> {
  const runOptions = await preparePersistentRun(session, options);
  return runAgentTaskDetailed(session, task, runOptions);
}

async function preparePersistentRun(
  session: SessionState,
  options: PersistentAgentTaskOptions
): Promise<AgentRunOptions> {
  const economy = options.testMode ? undefined : await tryEconomyContext(options.onProgress);
  const models = options.testMode ? [] : await tryListModels();
  const policy = options.testMode ? undefined : await resolveSessionPolicy(session, models, options);
  const mainModel = policy?.main ?? options.model;
  const contextWindowTokens = options.testMode
    ? fallbackContextWindowTokens("mock-test-mode")
    : contextWindowFor(models, mainModel) ?? fallbackContextWindowTokens(mainModel ?? (await loadConfig()).x402LlmModel);
  const compaction = await compactConversationIfNeeded(session, { contextWindowTokens });
  if (compaction.compacted) {
    options.onProgress?.({
      type: "complete",
      message: `Compacted prior conversation into ${compaction.archivePath}`,
      data: { archive_path: compaction.archivePath, tokens_before: compaction.tokensBefore }
    });
  }
  const history = (compaction.compacted ? compaction.messages : await readConversationMessages(session)) as ConversationMessage[];
  return {
    model: mainModel,
    maxTurns: options.maxTurns,
    contextWindowTokens,
    onProgress: options.onProgress,
    onPermissionRequest: options.onPermissionRequest,
    provider: options.testMode ? options.mockProvider ?? new MockLlmProvider({ seed: options.testSeed }) : undefined,
    toolExecutor: options.testMode ? options.mockToolExecutor ?? createMockToolExecutor() : undefined,
    compactOutput: options.compactOutput ?? options.testMode,
    subagent: policy ? subagentOptionsFor(models, policy) : undefined,
    dynamicTools: economy?.dynamicTools,
    promptSections: economy?.promptSections,
    history: history as LlmMessage[],
    onMessage: (message) => appendConversationMessage(session, message as ConversationMessage)
  };
}

/**
 * Connector-ingested vendor tools (integration spec). Unavailable connectors
 * degrade to the legacy economic path rather than failing the run.
 */
async function tryEconomyContext(onProgress?: (event: ProgressEvent) => void): Promise<EconomyContext | undefined> {
  if (process.env.OPENCROWD_DISABLE_CONNECTORS === "1" || process.env.OPENCROWD_DISABLE_CONNECTORS === "true") {
    return undefined;
  }
  try {
    const manager = await sharedConnectorManager();
    return await buildEconomyContext(manager);
  } catch (error) {
    onProgress?.({
      type: "complete",
      message: `connector MCP servers unavailable (${(error as Error).message}); using the legacy service path`
    });
    return undefined;
  }
}

/**
 * Resolve the model policy for this run and record it in the session so
 * evals are reproducible. Auto mode fails loudly when the catalog lacks a
 * frontier model; manual mode falls back to the existing single-model
 * behavior (no subagents) when resolution is impossible.
 */
async function resolveSessionPolicy(
  session: SessionState,
  models: LlmModel[],
  options: PersistentAgentTaskOptions
): Promise<ResolvedModelPolicy | undefined> {
  const config = await loadConfig();
  const mode = options.forceAutoPolicy ? "auto" : config.modelPolicy.mode;
  const policy: ModelPolicy = {
    mode,
    main: options.model
      ?? (config.modelPolicy.main !== "auto" ? config.modelPolicy.main : mode === "auto" ? "auto" : config.x402LlmModel),
    subagent: options.subagentModel ?? config.modelPolicy.subagent
  };
  try {
    const resolved = resolveModelPolicy(models, policy);
    session.modelPolicy = resolved;
    await saveSession(session);
    return resolved;
  } catch (error) {
    if (mode === "auto") {
      throw error;
    }
    return undefined;
  }
}

function subagentOptionsFor(models: LlmModel[], policy: ResolvedModelPolicy): SubagentOptions {
  const model = models.find((candidate) => candidate.id === policy.subagent);
  const outputCost = model?.output_cost_cents_per_1k;
  return {
    model: policy.subagent,
    costHint: outputCost !== undefined ? `~${outputCost}¢ per 1k output tokens` : undefined
  };
}

async function tryListModels(): Promise<LlmModel[]> {
  try {
    return await listLlmModels();
  } catch {
    return [];
  }
}

function contextWindowFor(models: LlmModel[], modelId: string | undefined): number | undefined {
  if (!modelId) {
    return undefined;
  }
  return models.find((candidate) => candidate.id === modelId)?.context_window_tokens;
}

export async function resolveContextWindowTokens(model: string | undefined): Promise<number> {
  const config = await loadConfig();
  const modelId = model ?? config.x402LlmModel;
  try {
    const models = await listLlmModels();
    const resolved = models.find((candidate) => candidate.id === modelId);
    return resolved?.context_window_tokens ?? fallbackContextWindowTokens(modelId);
  } catch {
    return fallbackContextWindowTokens(modelId);
  }
}
