import { economyTools } from "./economy-tools.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendConversationMessage, beginQuery, budgetStatus, atomicWrite, SpendingApprovalRequired, SpendingDeclined,
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
  renderAgentSummary,
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
import type { SteeringInbox } from "./inbox.js";

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
  /** Conversation history; the shared loop compacts the complete pending request. */
  history(session: SessionState, contextWindowTokens: number, onProgress?: (event: ProgressEvent) => void): Promise<LlmMessage[]>;
}

export const localRuntimeStorage: RuntimeStorage = {
  createSession: (options) => createOpenCrowdSession(options),
  loadSession: (workspaceRoot, sessionId) => loadSession(workspaceRoot, sessionId),
  appendMessage: (session, message) => appendConversationMessage(session, message as ConversationMessage),
  async history(session) {
    return await readConversationMessages(session) as LlmMessage[];
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
  inbox?: SteeringInbox;
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
    const paidTools = economy ? economyTools(economy, { resuming: !!runOptions.resume }) : undefined;
    const contextWindowTokens = llm.contextWindowTokens
      ?? (llm.kind === "typed" ? fallbackContextWindowTokens(llm.main.model) : fallbackContextWindowTokens(undefined));
    const history = await storage.history(session, contextWindowTokens, runOptions.onProgress);
    return {
      inbox: runOptions.inbox,
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
      ...(paidTools ? { dynamicTools: paidTools, completionGate: paidTools.completionGate } : {})
    };
  }

  async function execute(session: SessionState, task: string, runOptions: RuntimeRunOptions = {}): Promise<AgentTaskResult> {
    const path = join(session.sessionDir, "query-checkpoint.json");
    let persisted: { id: string; task: string; checkpoint?: LoopCheckpoint } | undefined;
    try { persisted = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const resuming = task === "" && !!persisted;
    if (persisted && !resuming) throw new Error("A query is unfinished. Resume it or decline its pending approval before starting another query.");
    const saved = resuming ? persisted! : { id: runOptions.runId ?? randomUUID(), task };
    await beginQuery(session, saved.id);
    const checkpoint = async (value: LoopCheckpoint) => {
      saved.checkpoint = value;
      await atomicWrite(path, JSON.stringify(saved));
      await runOptions.onCheckpoint?.(value);
    };
    await atomicWrite(path, JSON.stringify(saved));
    try {
      const prepared = await prepare(session, { ...runOptions, runId: saved.id, resume: saved.checkpoint ?? runOptions.resume, onCheckpoint: checkpoint });
      const result = await runAgentTaskDetailed(session, saved.task, prepared);
      await rm(path, { force: true });
      return result;
    } catch (error) {
      if (error instanceof SpendingApprovalRequired) return { outcome: "waiting_for_approval", turns: saved.checkpoint?.turn ?? 0,
        summary: { final_message: error.message, approval: error.approval, budget: budgetStatus(session) } };
      if (error instanceof SpendingDeclined) {
        await rm(path, { force: true });
        return { outcome: "stopped", turns: saved.checkpoint?.turn ?? 0, summary: { final_message: error.message, budget: budgetStatus(session) } };
      }
      throw error;
    }
  }
  return {
    storage,
    createSession: (sessionOptions = {}) => storage.createSession({ ...sessionOptions, workspaceRoot: options.workspace }),
    resumeSession: (sessionId) => storage.loadSession(options.workspace, sessionId),
    runTask: execute,
    async runTaskRendered(session, task, runOptions = {}) {
      return renderAgentSummary((await execute(session, task, runOptions)).summary, runOptions);
    }
  };
}
