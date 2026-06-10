import {
  appendConversationMessage,
  compactConversationIfNeeded,
  fallbackContextWindowTokens,
  listLlmModels,
  loadConfig,
  readConversationMessages,
  type ConversationMessage,
  type ProgressEvent,
  type SessionState
} from "@opencrowd/core";
import {
  createMockToolExecutor,
  MockLlmProvider,
  runAgentTask,
  type LlmMessage,
  type PermissionRequest,
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
  testMode?: boolean;
  testSeed?: string;
  mockProvider?: MockLlmProvider;
  mockToolExecutor?: ToolExecutor;
  compactOutput?: boolean;
  onProgress?: (event: ProgressEvent) => void;
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>;
}

export async function runPersistentAgentTask(
  session: SessionState,
  task: string,
  options: PersistentAgentTaskOptions = {}
): Promise<string> {
  const contextWindowTokens = options.testMode
    ? fallbackContextWindowTokens("mock-test-mode")
    : await resolveContextWindowTokens(options.model);
  const compaction = await compactConversationIfNeeded(session, { contextWindowTokens });
  if (compaction.compacted) {
    options.onProgress?.({
      type: "complete",
      message: `Compacted prior conversation into ${compaction.archivePath}`,
      data: { archive_path: compaction.archivePath, tokens_before: compaction.tokensBefore }
    });
  }
  const history = (compaction.compacted ? compaction.messages : await readConversationMessages(session)) as ConversationMessage[];
  return runAgentTask(session, task, {
    model: options.model,
    onProgress: options.onProgress,
    onPermissionRequest: options.onPermissionRequest,
    provider: options.testMode ? options.mockProvider ?? new MockLlmProvider({ seed: options.testSeed }) : undefined,
    toolExecutor: options.testMode ? options.mockToolExecutor ?? createMockToolExecutor() : undefined,
    compactOutput: options.compactOutput ?? options.testMode,
    history: history as LlmMessage[],
    onMessage: (message) => appendConversationMessage(session, message as ConversationMessage)
  });
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
