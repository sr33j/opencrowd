import { createPaymentHeader } from "x402/client";
import { createSigner } from "x402/types";
import { requireAgentCashWallet } from "@opencrowd/core";
import {
  parseChatCompletionResponse,
  readSseCompletion,
  toWireChatMessage,
  type CompletionRequest,
  type ProviderCompletion,
  type ProviderModel,
  type TypedLlmProvider,
  normalizeProviderModels
} from "./providers.js";

/**
 * The x402 token proxy provider: an OpenAI-compatible route metered with
 * x402 micropayments (upto-style: the challenge quotes a ceiling, the
 * service settles actual usage). Payment is signed with the shared
 * AgentCash wallet key only when the route actually challenges (HTTP 402);
 * unchallenged requests pass through with zero payment overhead. After the
 * first challenge the requirement is cached and the payment header is
 * attached preemptively, so steady-state remains one round trip per turn.
 */

export interface X402ProxyProviderOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Abort when the completion stream goes silent for this long. Any bytes
   * count as liveness, but the proxy forwards NOTHING while the upstream
   * model reasons — measured silent-reasoning gaps reach ~37s on hard tasks
   * — so this must stay well above legitimate think time. A stalled request
   * surfaces as a transient timeout, which the budget layer retries.
   */
  stallTimeoutMs?: number;
  /**
   * Cap on simultaneous in-flight completions per provider instance. The
   * proxy's serving capacity is fixed: beyond ~6 concurrent requests it
   * queues server-side, inflating time-to-first-token for everyone. Queueing
   * client-side instead is free — a parked call has not signed a payment or
   * started its stall/timeout clocks yet.
   */
  maxConcurrent?: number;
  fetchImpl?: typeof fetch;
  /** Test hook: sign challenges without a real wallet. */
  privateKey?: string;
}

const DEFAULT_STALL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_CONCURRENT = 6;

/** FIFO counting semaphore; a released slot passes directly to the next waiter. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/** One abort signal covering a total deadline plus an inter-byte idle deadline. */
class StreamLiveness {
  readonly controller = new AbortController();
  private idleTimer?: NodeJS.Timeout;
  private readonly totalTimer: NodeJS.Timeout;

  constructor(private readonly idleMs: number, totalMs: number) {
    this.totalTimer = setTimeout(() => {
      this.controller.abort(new Error(`x402 proxy request timed out after ${totalMs}ms`));
    }, totalMs);
    this.bump();
  }

  bump(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.controller.abort(new Error(`x402 proxy stream stalled: no bytes for ${this.idleMs}ms (timed out)`));
    }, this.idleMs);
  }

  clear(): void {
    clearTimeout(this.idleTimer);
    clearTimeout(this.totalTimer);
  }
}

export class X402ProxyProvider implements TypedLlmProvider {
  readonly id = "x402" as const;
  private readonly baseUrl: string;
  private readonly slots: Semaphore;
  private modelsCache?: ProviderModel[];
  /** Last observed 402 challenge for the completions endpoint. */
  private cachedChallenge?: unknown;

  constructor(private readonly options: X402ProxyProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://x402-tokens.fly.dev/v1").replace(/\/$/, "");
    this.slots = new Semaphore(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async privateKey(): Promise<`0x${string}`> {
    if (this.options.privateKey) {
      return this.options.privateKey as `0x${string}`;
    }
    return (await requireAgentCashWallet()).privateKey;
  }

  async listModels(options: { refresh?: boolean } = {}): Promise<ProviderModel[]> {
    if (!this.modelsCache || options.refresh) {
      const response = await this.fetchImpl()(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000)
      });
      if (!response.ok) {
        throw new Error(`x402 proxy model list failed: HTTP ${response.status} from ${this.baseUrl}/models. Run \`opencrowd doctor\` or switch providers with /provider venice.`);
      }
      this.modelsCache = normalizeProviderModels(await response.json().catch(() => undefined));
    }
    return this.modelsCache;
  }

  async complete(request: CompletionRequest): Promise<ProviderCompletion> {
    // Queue locally past the concurrency cap; signing and the stall/timeout
    // clocks only start once a slot is held and the request actually goes out.
    await this.slots.acquire();
    try {
      return await this.completeNow(request);
    } finally {
      this.slots.release();
    }
  }

  private async completeNow(request: CompletionRequest): Promise<ProviderCompletion> {
    // Always stream: liveness is only observable on a streamed response, and
    // a silent stall is then distinguishable from a long generation.
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
    const url = `${this.baseUrl}/chat/completions`;
    const liveness = new StreamLiveness(
      this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      this.options.timeoutMs ?? 300_000
    );
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: liveness.controller.signal
    };

    try {
      const started = Date.now();
      // A previously seen challenge lets us pre-sign and skip the 402 round trip.
      let response = await this.fetchImpl()(url, this.cachedChallenge
        ? { ...init, headers: await this.paymentHeaders(this.cachedChallenge, url) }
        : init);
      liveness.bump();
      // Sign the fresh (or changed) challenge and retry. Two signed attempts:
      // the proxy's payment validation measurably flakes (~25%) and a fresh
      // signature on the very next attempt recovers, so absorbing one
      // rejection here is far cheaper than escalating to the rescue ladder.
      for (let signedAttempts = 0; response.status === 402 && signedAttempts < 2; signedAttempts += 1) {
        this.cachedChallenge = await challengeFromResponse(response);
        if (!x402Challenge(this.cachedChallenge)?.accepts.length) {
          this.cachedChallenge = undefined;
          throw new Error(`the x402 proxy demanded payment but returned no parseable challenge (${this.baseUrl})`);
        }
        liveness.bump();
        response = await this.fetchImpl()(url, { ...init, headers: await this.paymentHeaders(this.cachedChallenge, url) });
        liveness.bump();
      }
      if (response.status === 402) {
        this.cachedChallenge = undefined;
        throw new Error("the x402 proxy rejected a signed payment; check the wallet's USDC balance on Base and retry");
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`x402 proxy completion failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      const completion = contentType.includes("text/event-stream")
        ? await readSseCompletion(response, request.onTextDelta, started, () => liveness.bump())
        // Some routes ignore `stream` and answer with plain JSON.
        : parseChatCompletionResponse(await response.json().catch(() => undefined));
      completion.usage = withSettledCost(completion.usage, response);
      return completion;
    } finally {
      liveness.clear();
    }
  }

  private async paymentHeaders(challenge: unknown, url: string): Promise<Headers> {
    const parsed = x402Challenge(challenge);
    if (!parsed?.accepts.length) {
      return new Headers({ "content-type": "application/json" });
    }
    const selected = selectBasePaymentRequirement(parsed.accepts);
    const merged = mergeChallengeRequirement(selected, parsed.resource, url);
    const requirement = normalizePaymentRequirement(merged);
    const signer = await createSigner("base", await this.privateKey());
    const rawHeader = await createPaymentHeader(signer, parsed.x402Version, requirement as never);
    const header = compatiblePaymentHeader(rawHeader, parsed.x402Version, selected);
    return new Headers({
      "content-type": "application/json",
      "X-PAYMENT": header,
      "PAYMENT-SIGNATURE": header,
      "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE"
    });
  }
}

/**
 * The route's settled-cost headers are what was actually charged (including
 * any proxy markup), so they take precedence over body usage cost.
 */
function withSettledCost(usage: ProviderCompletion["usage"], response: Response): ProviderCompletion["usage"] {
  for (const name of ["x402-charged-cost-cents", "x-charged-cost-cents"]) {
    const value = response.headers.get(name);
    if (value !== null && Number.isFinite(Number(value))) {
      return { ...usage, costCents: Number(value) };
    }
  }
  for (const name of ["x-billed-usd", "x-charged-usd", "x-settled-usd", "x-402-priced-at"]) {
    const value = response.headers.get(name);
    if (value !== null && Number.isFinite(Number(value))) {
      return { ...usage, costCents: Number(value) * 100 };
    }
  }
  return usage;
}

async function challengeFromResponse(response: Response): Promise<unknown> {
  const bodyChallenge = await response.clone().json().catch(() => undefined);
  if (bodyChallenge && x402Challenge(bodyChallenge)?.accepts.length) {
    return bodyChallenge;
  }
  const headerValue = response.headers.get("payment-required") ?? response.headers.get("x-payment-required");
  if (headerValue) {
    const headerChallenge = parseBase64Json(headerValue) ?? parseMaybeJson(headerValue);
    if (headerChallenge) {
      return headerChallenge;
    }
  }
  return bodyChallenge;
}

function x402Challenge(challenge: unknown): { x402Version: number; accepts: unknown[]; resource?: unknown } | undefined {
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) {
    return undefined;
  }
  const record = challenge as Record<string, unknown>;
  const candidate = Array.isArray(record.accepts)
    ? record
    : record.x402 && typeof record.x402 === "object" && !Array.isArray(record.x402) && Array.isArray((record.x402 as Record<string, unknown>).accepts)
      ? record.x402 as Record<string, unknown>
      : undefined;
  if (!candidate) {
    return undefined;
  }
  return {
    x402Version: numberValue(candidate.x402Version ?? record.x402Version) ?? 1,
    accepts: candidate.accepts as unknown[],
    resource: candidate.resource ?? record.resource
  };
}

function selectBasePaymentRequirement(accepts: unknown[]): unknown {
  return accepts.find((item) => item && typeof item === "object" && (item as { scheme?: unknown }).scheme === "exact" && ["eip155:8453", "base"].includes(String((item as { network?: unknown }).network)))
    ?? accepts.find((item) => item && typeof item === "object" && ["eip155:8453", "base"].includes(String((item as { network?: unknown }).network)))
    ?? accepts[0];
}

function mergeChallengeRequirement(requirement: unknown, challengeResource?: unknown, fallbackUrl?: string): unknown {
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
    return requirement;
  }
  const record = requirement as Record<string, unknown>;
  return {
    ...record,
    resource: record.resource ?? challengeResource ?? (fallbackUrl ? { url: fallbackUrl } : undefined)
  };
}

function normalizePaymentRequirement(requirement: unknown): unknown {
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
    return requirement;
  }
  const record = requirement as Record<string, unknown>;
  const resource = record.resource && typeof record.resource === "object" && !Array.isArray(record.resource)
    ? stringValue((record.resource as Record<string, unknown>).url)
    : stringValue(record.resource);
  return {
    ...record,
    network: record.network === "eip155:8453" ? "base" : record.network === "eip155:84532" ? "base-sepolia" : record.network,
    maxAmountRequired: stringValue(record.maxAmountRequired ?? record.amount),
    resource,
    description: stringValue(record.description) ?? "x402 paid resource",
    mimeType: stringValue(record.mimeType) ?? "application/json"
  };
}

/**
 * v2 middleware deep-matches `accepted` against its own offer, so the header
 * must round-trip the requirement exactly as the service offered it. v1
 * services deep-match the network string instead: the signing library
 * normalizes `eip155:8453` to `base`, so restore the challenge's original
 * network in the envelope.
 */
function compatiblePaymentHeader(header: string, x402Version: number, originalRequirement: unknown): string {
  if (!originalRequirement || typeof originalRequirement !== "object" || Array.isArray(originalRequirement)) {
    return header;
  }
  if (x402Version >= 2) {
    try {
      const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: unknown };
      return Buffer.from(JSON.stringify({
        x402Version,
        accepted: originalRequirement,
        payload: payment.payload
      })).toString("base64");
    } catch {
      return header;
    }
  }
  const originalNetwork = stringValue((originalRequirement as Record<string, unknown>).network);
  if (!originalNetwork || !originalNetwork.startsWith("eip155:")) {
    return header;
  }
  try {
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    payment.network = originalNetwork;
    return Buffer.from(JSON.stringify(payment)).toString("base64");
  } catch {
    return header;
  }
}

function parseBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
