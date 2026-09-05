import {
  appendConversationMessage,
  compactConversationIfNeeded,
  createOpenCrowdSession,
  loadSession,
  readConversationMessages,
  type ConversationMessage,
  type ProgressEvent,
  type SessionOptions,
  type SessionState,
  type ToolResult
} from "@opencrowd/core";
import {
  runAgentTask,
  runAgentTaskDetailed,
  type AgentRunOptions,
  type AgentTaskResult,
  type DynamicToolDefinition,
  type LlmMessage,
  type LlmProvider,
  type LoopCheckpoint,
  type SubagentOptions,
  type ToolExecutor,
  type TypedLlmRuntime
} from "./index.js";
import { fallbackContextWindowTokens } from "./providers.js";

/**
 * The dependency-injected local runtime. The CLI is one adapter around it; a
 * hosted wrapper can inject its own storage, LLM wiring, economy port, and
 * approval handling without touching terminal globals. Until this API is
 * intentionally stabilized, only the `opencrowd` CLI package is published.
 */

/** Session/conversation persistence. The default implementation is the local filesystem. */
export interface RuntimeStorage {
  createSession(options: SessionOptions): Promise<SessionState>;
  loadSession(workspaceRoot: string, sessionId: string): Promise<SessionState>;
  appendMessage(session: SessionState, message: LlmMessage): Promise<void>;
  /** Conversation history for the next run, compacting under context pressure. */
  history(session: SessionState, contextWindowTokens: number, onProgress?: (event: ProgressEvent) => void): Promise<LlmMessage[]>;
}

export const localRuntimeStorage: RuntimeStorage = {
  createSession: (options) => createOpenCrowdSession(options),
  loadSession: (workspaceRoot, sessionId) => loadSession(workspaceRoot, sessionId),
  appendMessage: (session, message) => appendConversationMessage(session, message as ConversationMessage),
  async history(session, contextWindowTokens, onProgress) {
    const compaction = await compactConversationIfNeeded(session, { contextWindowTokens });
    if (compaction.compacted) {
      onProgress?.({
        type: "complete",
        message: `Compacted prior conversation into ${compaction.archivePath}`,
        data: { archive_path: compaction.archivePath, tokens_before: compaction.tokensBefore }
      });
    }
    return (compaction.compacted ? compaction.messages : await readConversationMessages(session)) as LlmMessage[];
  }
};

/** The economy gateway surface the loop needs; @opencrowd/economy's EconomyGateway satisfies it. */
export interface EconomyPort {
  definitions(): DynamicToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  hasPendingRequiredReviews(): Promise<boolean>;
}

/** LLM wiring for one run: a typed provider runtime or a scripted provider (tests/demo). */
export type RuntimeLlm =
  | { kind: "typed"; main: TypedLlmRuntime; subagent?: SubagentOptions; contextWindowTokens?: number; promptSections?: string[] }
  | { kind: "scripted"; provider: LlmProvider; toolExecutor?: ToolExecutor; contextWindowTokens?: number };

export interface OpenCrowdRuntimeOptions {
  workspace: string;
  storage?: RuntimeStorage;
  /** Resolve the LLM wiring for a session (provider, models, streaming). */
  llmProvider: (session: SessionState) => Promise<RuntimeLlm>;
  /** Resolve the paid-capability port for a session; undefined disables paid tools. */
  economy?: (session: SessionState) => Promise<EconomyPort | undefined>;
}

export interface RuntimeRunOptions {
  signal?: AbortSignal;
  runId?: string;
  resume?: LoopCheckpoint;
  onCheckpoint?: (checkpoint: LoopCheckpoint) => Promise<void>;
  hosted?: boolean;
  maxTurns?: number;
  compactOutput?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

export interface OpenCrowdRuntime {
  storage: RuntimeStorage;
  createSession(options?: Omit<SessionOptions, "workspaceRoot">): Promise<SessionState>;
  resumeSession(sessionId: string): Promise<SessionState>;
  runTask(session: SessionState, task: string, options?: RuntimeRunOptions): Promise<AgentTaskResult>;
  runTaskRendered(session: SessionState, task: string, options?: RuntimeRunOptions): Promise<string>;
}

export function createOpenCrowdRuntime(options: OpenCrowdRuntimeOptions): OpenCrowdRuntime {
  const storage = options.storage ?? localRuntimeStorage;

  async function prepare(session: SessionState, runOptions: RuntimeRunOptions): Promise<AgentRunOptions> {
    const llm = await options.llmProvider(session);
    const economy = await options.economy?.(session);
    const contextWindowTokens = llm.contextWindowTokens
      ?? (llm.kind === "typed" ? fallbackContextWindowTokens(llm.main.model) : fallbackContextWindowTokens(undefined));
    const history = await storage.history(session, contextWindowTokens, runOptions.onProgress);
    return {
      signal: runOptions.signal,
      runId: runOptions.runId,
      resume: runOptions.resume,
      onCheckpoint: runOptions.onCheckpoint,
      hosted: runOptions.hosted,
      maxTurns: runOptions.maxTurns,
      compactOutput: runOptions.compactOutput,
      contextWindowTokens,
      onProgress: runOptions.onProgress,
      history,
      onMessage: (message) => storage.appendMessage(session, message),
      ...(llm.kind === "typed"
        ? { llm: llm.main, subagent: llm.subagent, promptSections: llm.promptSections }
        : { provider: llm.provider, toolExecutor: llm.toolExecutor }),
      ...(economy
        ? {
          dynamicTools: {
            definitions: economy.definitions(),
            execute: (name, args) => economy.execute(name, args)
          },
          completionGate: async () => (await economy.hasPendingRequiredReviews())
            ? "a confirmed paid purchase still needs its required review; submit it with review_paid_service"
            : undefined
        }
        : {})
    };
  }

  return {
    storage,
    createSession: (sessionOptions = {}) => storage.createSession({ ...sessionOptions, workspaceRoot: options.workspace }),
    resumeSession: (sessionId) => storage.loadSession(options.workspace, sessionId),
    async runTask(session, task, runOptions = {}) {
      return runAgentTaskDetailed(session, task, await prepare(session, runOptions));
    },
    async runTaskRendered(session, task, runOptions = {}) {
      return runAgentTask(session, task, await prepare(session, runOptions));
    }
  };
}
