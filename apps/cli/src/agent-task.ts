import type { ProgressEvent, SessionState } from "@opencrowd/core";
import {
  EconomyGateway,
  MockAgentCashAdapter,
  MockCrowdCodeAdapter,
  sharedEconomyRuntime,
  type ApprovalHandler
} from "@opencrowd/economy";
import {
  createMockToolExecutor,
  createOpenCrowdRuntime,
  fallbackContextWindowTokens,
  resolveLlmRuntime,
  type AgentTaskResult,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmRuntimeSelection,
  type RuntimeLlm,
  type SubagentOptions,
  type ToolExecutor
} from "@opencrowd/agent-runtime";

export interface ReplState {
  testMode: boolean;
  testSeed?: string;
  mockProvider?: LlmProvider;
  mockToolExecutor?: ToolExecutor;
}

export function ensureMockRuntime(state: ReplState): ReplState {
  state.mockProvider ??= createDemoLlmProvider();
  state.mockToolExecutor ??= createMockToolExecutor();
  return state;
}



export interface PersistentAgentTaskOptions {
  model?: string;
  /** Explicit subagent model; overrides the configured preference. */
  subagentModel?: string;
  /** Force "auto" model resolution for this run. */
  forceAutoPolicy?: boolean;
  /** Headless run: cap the per-request LLM deadline (nobody can watch a stuck call). */
  nonInteractive?: boolean;
  testMode?: boolean;
  testSeed?: string;
  mockProvider?: LlmProvider;
  mockToolExecutor?: ToolExecutor;
  compactOutput?: boolean;
  maxTurns?: number;
  onProgress?: (event: ProgressEvent) => void;
  /** Human decision point for ask-mode purchases; absent means they are denied. */
  approvalHandler?: ApprovalHandler;
}

export async function runPersistentAgentTask(
  session: SessionState,
  task: string,
  options: PersistentAgentTaskOptions = {}
): Promise<string> {
  const runtime = cliRuntime(session, options);
  return runtime.runTaskRendered(session, task, {
    maxTurns: options.maxTurns,
    compactOutput: options.compactOutput ?? options.testMode ?? false,
    onProgress: options.onProgress
  });
}

export async function runPersistentAgentTaskDetailed(
  session: SessionState,
  task: string,
  options: PersistentAgentTaskOptions = {}
): Promise<AgentTaskResult> {
  const runtime = cliRuntime(session, options);
  return runtime.runTask(session, task, {
    maxTurns: options.maxTurns,
    compactOutput: options.compactOutput ?? options.testMode ?? false,
    onProgress: options.onProgress
  });
}

/**
 * The CLI adapter around the dependency-injected runtime: it supplies the
 * typed provider wiring (or demo mocks), the economy gateway factory, and
 * default local-filesystem storage.
 */
function cliRuntime(session: SessionState, options: PersistentAgentTaskOptions) {
  return createOpenCrowdRuntime({
    workspace: session.workspaceRoot,
    llmProvider: async (current) => {
      if (options.testMode) {
        return {
          kind: "scripted",
          provider: options.mockProvider ?? createDemoLlmProvider(),
          toolExecutor: options.mockToolExecutor ?? createMockToolExecutor(),
          contextWindowTokens: fallbackContextWindowTokens("mock-test-mode")
        } satisfies RuntimeLlm;
      }
      const llm = await resolveLlmRuntime(current, {
        model: options.model,
        subagentModel: options.subagentModel,
        auto: options.forceAutoPolicy,
        nonInteractive: options.nonInteractive
      });
      return {
        kind: "typed",
        main: {
          provider: llm.provider,
          model: llm.models.main,
          maxCostCentsPerCall: llm.maxCostCentsPerCall,
          maxTopUpCentsPerAction: llm.maxTopUpCentsPerAction,
          promptCacheKey: current.sessionId,
          catalog: llm.catalog,
          fallback: llm.fallback
            ? { provider: llm.fallback.provider, model: llm.fallback.mainModel }
            : undefined,
          // Stream deltas so time-to-first-token is visible in the UI.
          onTextDelta: options.onProgress
            ? (delta) => options.onProgress?.({ type: "assistant_delta", message: delta })
            : undefined
        },
        subagent: subagentOptionsFor(current, llm),
        contextWindowTokens: llm.catalog.find((model) => model.id === llm.models.main)?.contextWindowTokens
          ?? fallbackContextWindowTokens(llm.models.main),
        promptSections: await vendorInstructions()
      } satisfies RuntimeLlm;
    },
    economy: (current) => buildGateway(current, options)
  });
}

/**
 * Build this run's economy gateway. Demo/test mode uses in-memory mock
 * adapters through the REAL enforced lifecycle. When the vendors are
 * unavailable, paid capability is explicitly absent — never rerouted.
 */
async function buildGateway(
  session: SessionState,
  options: PersistentAgentTaskOptions
): Promise<EconomyGateway | undefined> {
  if (options.testMode) {
    return new EconomyGateway({
      session,
      agentcash: demoAgentCashAdapter(),
      crowdcode: new MockCrowdCodeAdapter(),
      approvalMode: session.approvalMode,
      // Demo without a UI auto-allows: no real money exists to protect.
      approvalHandler: options.approvalHandler ?? (async () => ({ decision: "allow_once" })),
      onProgress: options.onProgress
    });
  }
  if (connectorsDisabled()) {
    return undefined;
  }
  try {
    const runtime = await sharedEconomyRuntime();
    return new EconomyGateway({
      session,
      agentcash: runtime.agentcash,
      crowdcode: runtime.crowdcode,
      approvalMode: session.approvalMode,
      approvalHandler: options.approvalHandler,
      onProgress: options.onProgress
    });
  } catch (error) {
    options.onProgress?.({
      type: "complete",
      message: `AgentCash/CrowdCode vendors unavailable (${(error as Error).message}); paid services are unavailable this run`
    });
    return undefined;
  }
}

async function vendorInstructions(): Promise<string[] | undefined> {
  if (connectorsDisabled()) {
    return undefined;
  }
  try {
    return (await sharedEconomyRuntime()).instructions();
  } catch {
    return undefined;
  }
}

function connectorsDisabled(): boolean {
  return process.env.OPENCROWD_DISABLE_CONNECTORS === "1" || process.env.OPENCROWD_DISABLE_CONNECTORS === "true";
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
      catalog: llm.catalog,
      fallback: llm.fallback
        ? { provider: llm.fallback.provider, model: llm.fallback.subagentModel }
        : undefined
    }
  };
}

/**
 * Warm the vendor connections and touch the wallet balance before a session
 * starts. On a fresh machine this both installs the pinned vendors (npx
 * cache) and auto-creates the shared AgentCash wallet.
 */
export async function warmStartEconomy(): Promise<void> {
  if (connectorsDisabled()) {
    return;
  }
  try {
    const runtime = await sharedEconomyRuntime();
    await runtime.agentcash.getBalance();
  } catch {
    // Vendors are optional at startup; paid capability surfaces the error when used.
  }
}

export const DEMO_ENDPOINT = "https://demo.opencrowd.test/api/answer";

/** Mock AgentCash with one plausible demo service; no network, no real money. */
export function demoAgentCashAdapter(): MockAgentCashAdapter {
  let paymentIndex = 0;
  return new MockAgentCashAdapter({
    balance: { total_usd: 25, networks: { base: { usdc: 25, address: "0xDEMO000000000000000000000000000000000000" } }, demo: true },
    searchResults: {
      results: [{
        origin: "https://demo.opencrowd.test",
        endpoint: DEMO_ENDPOINT,
        method: "POST",
        description: "Demo paid answering service (mock; no real money moves)",
        price_usd: 0.05
      }]
    },
    schemas: {
      [DEMO_ENDPOINT]: {
        url: DEMO_ENDPOINT,
        method: "POST",
        auth: "paid x402 base",
        price: 0.05,
        input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] }
      }
    },
    fetchResults: {
      [DEMO_ENDPOINT]: (request) => {
        paymentIndex += 1;
        return {
          ok: true,
          ambiguous: false,
          status: 200,
          data: { answer: `Demo service answer for ${JSON.stringify(request.body)}. (mock response — no network request occurred)` },
          authMode: "paid",
          payment: {
            paidUsd: 0.05,
            rail: "x402-base",
            reference: `0xdemo${paymentIndex}`,
            proof: "ZGVtby1wcm9vZg==",
            payTo: "0xdemopayee"
          }
        };
      }
    }
  });
}

/**
 * Deterministic demo agent: walks the full enforced purchase lifecycle —
 * discover, inspect, pay, review — against the mock adapters, then finishes.
 */
export function createDemoLlmProvider(): LlmProvider {
  return {
    async complete(messages: LlmMessage[]): Promise<LlmResponse> {
      const task = [...messages].reverse().find((message) => message.role === "user")?.content ?? "demo task";
      const toolMessages = messages.filter((message) => message.role === "tool");
      const step = toolMessages.length;
      switch (step) {
        case 0:
          return {
            content: "I'll look for a paid service that can help with this.",
            toolCalls: [{ id: "demo_1", name: "find_paid_service", arguments: { query: task.slice(0, 80) } }]
          };
        case 1:
          return {
            content: "Inspecting the demo service's schema, price, and reputation before paying.",
            toolCalls: [{ id: "demo_2", name: "inspect_paid_service", arguments: { url: DEMO_ENDPOINT, method: "POST" } }]
          };
        case 2:
          return {
            content: "Price and reputation look fine — executing one paid call.",
            toolCalls: [{
              id: "demo_3",
              name: "call_paid_service",
              arguments: { url: DEMO_ENDPOINT, method: "POST", body: { task: task.slice(0, 120) }, max_cost_cents: 5 }
            }]
          };
        case 3: {
          const purchaseId = purchaseIdFrom(toolMessages[toolMessages.length - 1]);
          if (!purchaseId) {
            return {
              content: "",
              toolCalls: [{ id: "demo_4", name: "complete_session", arguments: { final_message: "Demo finished (the paid call did not go through)." } }]
            };
          }
          return {
            content: "Submitting the required CrowdCode review for the purchase.",
            toolCalls: [{
              id: "demo_4",
              name: "review_paid_service",
              arguments: { purchase_id: purchaseId, rating: 5, reason: "Demo service answered instantly with a clean receipt.", task_context: task.slice(0, 120) }
            }]
          };
        }
        default:
          return {
            content: "",
            toolCalls: [{
              id: "demo_5",
              name: "complete_session",
              arguments: { final_message: `Demo complete: discovered, inspected, paid, and reviewed a mock service for "${task.slice(0, 80)}". No real money moved.` }
            }]
          };
      }
    }
  };
}

function purchaseIdFrom(toolMessage: LlmMessage | undefined): string | undefined {
  if (!toolMessage) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(toolMessage.content) as { result?: { data?: { purchase_id?: unknown } } };
    const id = parsed.result?.data?.purchase_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
