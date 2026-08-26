import { BlockrunClient } from "@blockrun/llm";
import { requireAgentCashWallet } from "@opencrowd/core";
import {
  normalizeProviderModels,
  readSseCompletion,
  toWireChatMessage,
  type CompletionRequest,
  type ProviderCompletion,
  type ProviderModel,
  type TypedLlmProvider
} from "./providers.js";

/** Minimal official-SDK surface, kept injectable for deterministic tests. */
export interface BlockRunLikeClient {
  stream<T = unknown>(path: string, body?: Record<string, unknown>): AsyncGenerator<T, void, undefined>;
  getSpending(): { totalUsd: number; calls: number };
}

export interface BlockRunProviderOptions {
  apiUrl?: string;
  timeoutMs?: number;
  /** Maximum silence between streamed chunks before the rescue ladder starts. */
  stallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  clientFactory?: () => Promise<BlockRunLikeClient>;
}

/** BlockRun's OpenAI-compatible, x402-v2 LLM gateway. */
export class BlockRunProvider implements TypedLlmProvider {
  readonly id = "blockrun" as const;
  private readonly apiUrl: string;
  private modelsCache?: ProviderModel[];

  constructor(private readonly options: BlockRunProviderOptions = {}) {
    this.apiUrl = (options.apiUrl ?? "https://blockrun.ai/api").replace(/\/$/, "");
  }

  async listModels(options: { refresh?: boolean } = {}): Promise<ProviderModel[]> {
    if (!this.modelsCache || options.refresh) {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.apiUrl}/v1/models`, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000)
      });
      if (!response.ok) {
        throw new Error(`BlockRun model list failed: HTTP ${response.status}. Run \`opencrowd doctor\` or switch providers with /provider x402.`);
      }
      this.modelsCache = normalizeProviderModels(await response.json().catch(() => undefined));
    }
    return this.modelsCache;
  }

  async complete(request: CompletionRequest): Promise<ProviderCompletion> {
    // A client per in-flight completion keeps the SDK's pending-payment and
    // spending counters isolated when subagents run concurrently.
    const client = await this.createClient();
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireChatMessage),
      tools: request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      })),
      tool_choice: request.tools.length > 0 ? "auto" : undefined,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (request.promptCacheKey) {
      body.prompt_cache_key = request.promptCacheKey;
    }

    const started = Date.now();
    const chunks = client.stream<Record<string, unknown>>("/v1/chat/completions", body);
    const encoder = new TextEncoder();
    const totalTimeoutMs = this.options.timeoutMs ?? 300_000;
    const stallTimeoutMs = this.options.stallTimeoutMs ?? 90_000;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const remainingMs = Math.max(1, totalTimeoutMs - (Date.now() - started));
          const next = await withTimeout(
            chunks.next(),
            Math.min(stallTimeoutMs, remainingMs),
            remainingMs <= stallTimeoutMs
              ? `BlockRun request timed out after ${totalTimeoutMs}ms`
              : `BlockRun stream stalled: no chunks for ${stallTimeoutMs}ms (timed out)`
          );
          if (next.done) {
            controller.close();
          } else {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
          }
        } catch (error) {
          void chunks.return().catch(() => undefined);
          controller.error(blockRunError(error));
        }
      }
    });

    try {
      const completion = await readSseCompletion(new Response(stream), request.onTextDelta, started);
      const settledUsd = client.getSpending().totalUsd;
      if (completion.usage.costCents === undefined && settledUsd > 0) {
        completion.usage.costCents = settledUsd * 100;
      }
      return completion;
    } catch (error) {
      throw blockRunError(error);
    }
  }

  private async createClient(): Promise<BlockRunLikeClient> {
    if (this.options.clientFactory) {
      return this.options.clientFactory();
    }
    const wallet = await requireAgentCashWallet();
    return new BlockrunClient({
      privateKey: wallet.privateKey,
      apiUrl: this.apiUrl,
      timeout: this.options.timeoutMs ?? 300_000
    });
  }
}

function blockRunError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("BlockRun inference failed:")) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`BlockRun inference failed: ${detail}. The current x402 provider will be tried for transient failures.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
