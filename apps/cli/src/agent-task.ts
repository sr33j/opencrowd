import {
  appendConversationMessage,
  compactConversationIfNeeded,
  readConversationMessages,
  type ConversationMessage,
  type ProgressEvent,
  type SessionState
} from "@opencrowd/core";
import { buildEconomyContext, sharedConnectorManager, type EconomyContext } from "@opencrowd/connectors";
import {
  createMockToolExecutor,
  fallbackContextWindowTokens,
  MockLlmProvider,
  resolveLlmRuntime,
  runAgentTask,
  runAgentTaskDetailed,
  type AgentRunOptions,
  type AgentTaskResult,
  type LlmMessage,
  type LlmRuntimeSelection,
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
  /** Explicit subagent model; overrides the configured preference. */
  subagentModel?: string;
  /** Force "auto" model resolution for this run. */
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
  if (options.testMode) {
    const contextWindowTokens = fallbackContextWindowTokens("mock-test-mode");
    const history = await compactedHistory(session, contextWindowTokens, options.onProgress);
    return {
      maxTurns: options.maxTurns,
      contextWindowTokens,
      onProgress: options.onProgress,
      onPermissionRequest: options.onPermissionRequest,
      provider: options.mockProvider ?? new MockLlmProvider({ seed: options.testSeed }),
      toolExecutor: options.mockToolExecutor ?? createMockToolExecutor(),
      compactOutput: options.compactOutput ?? true,
      history,
      onMessage: (message) => appendConversationMessage(session, message as ConversationMessage)
    };
  }

  const economy = await tryEconomyContext(options.onProgress);
  const llm = await resolveLlmRuntime(session, {
    model: options.model,
    subagentModel: options.subagentModel,
    auto: options.forceAutoPolicy
  });
  const contextWindowTokens = llm.catalog.find((model) => model.id === llm.models.main)?.contextWindowTokens
    ?? fallbackContextWindowTokens(llm.models.main);
  const history = await compactedHistory(session, contextWindowTokens, options.onProgress);
  return {
    maxTurns: options.maxTurns,
    contextWindowTokens,
    onProgress: options.onProgress,
    onPermissionRequest: options.onPermissionRequest,
    llm: {
      provider: llm.provider,
      model: llm.models.main,
      maxCostCentsPerCall: llm.maxCostCentsPerCall,
      maxTopUpCentsPerAction: llm.maxTopUpCentsPerAction,
      promptCacheKey: session.sessionId,
      catalog: llm.catalog,
      // Stream deltas so time-to-first-token is visible in the UI.
      onTextDelta: options.onProgress
        ? (delta) => options.onProgress?.({ type: "assistant_delta", message: delta })
        : undefined
    },
    compactOutput: options.compactOutput ?? false,
    subagent: subagentOptionsFor(session, llm),
    dynamicTools: economy?.dynamicTools,
    promptSections: economy?.promptSections,
    history,
    onMessage: (message) => appendConversationMessage(session, message as ConversationMessage)
  };
}

async function compactedHistory(
  session: SessionState,
  contextWindowTokens: number,
  onProgress?: (event: ProgressEvent) => void
): Promise<LlmMessage[]> {
  const compaction = await compactConversationIfNeeded(session, { contextWindowTokens });
  if (compaction.compacted) {
    onProgress?.({
      type: "complete",
      message: `Compacted prior conversation into ${compaction.archivePath}`,
      data: { archive_path: compaction.archivePath, tokens_before: compaction.tokensBefore }
    });
  }
  const history = compaction.compacted ? compaction.messages : await readConversationMessages(session);
  return history as LlmMessage[];
}

function subagentOptionsFor(session: SessionState, llm: LlmRuntimeSelection): SubagentOptions | undefined {
  if (!llm.models.subagent) {
    return undefined;
  }
  const model = llm.catalog.find((candidate) => candidate.id === llm.models.subagent);
  const outputCost = model?.outputCostCentsPer1k;
  return {
    model: llm.models.subagent,
    costHint: outputCost !== undefined ? `~${outputCost}¢ per 1k output tokens` : undefined,
    llm: {
      provider: llm.provider,
      model: llm.models.subagent,
      maxCostCentsPerCall: llm.maxCostCentsPerCall,
      maxTopUpCentsPerAction: llm.maxTopUpCentsPerAction,
      promptCacheKey: session.sessionId,
      catalog: llm.catalog
    }
  };
}

/**
 * Start the connector MCP servers and touch the wallet balance before a
 * session is created. On a fresh machine this both installs the pinned
 * vendors (npx cache) and auto-creates the shared AgentCash wallet.
 */
export async function warmStartEconomy(): Promise<void> {
  if (process.env.OPENCROWD_DISABLE_CONNECTORS === "1" || process.env.OPENCROWD_DISABLE_CONNECTORS === "true") {
    return;
  }
  try {
    const manager = await sharedConnectorManager();
    if (manager.hasTool("agentcash_get_balance")) {
      await manager.execute("agentcash_get_balance", {});
    }
  } catch {
    // Connectors are optional at startup; paid capability surfaces the error when used.
  }
}

/**
 * Connector-ingested vendor tools. When the connectors are unavailable the
 * run continues with local tools only — paid capability is explicitly
 * unavailable, never silently rerouted.
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
      message: `connector MCP servers unavailable (${(error as Error).message}); paid services are unavailable this run`
    });
    return undefined;
  }
}
