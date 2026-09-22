import { economyTools } from "./economy-tools.js";
import { RuntimePause } from "./worker.js";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { SpendingDeclined, type SessionState } from "@opencrowd/core";
import {
  EconomyGateway, BaseServiceDiscovery, summarizeEvidence,
  type AgentCashAdapter,
  type CrowdCodeAdapter,
  type McpCallResult,
  type PaidFetchRequest,
  type PaidFetchResult,
  type PaymentRail,
  type ReviewResult,
  type ReviewSubmission,
  type ServiceEvidence,
  type ServiceQuery,
  type WalletStatusResult
} from "@opencrowd/economy";
import { SERVICE_GATEWAY_TIMEOUT_MS } from "@opencrowd/protocol";
import { HostedToolTimeout, postHostedTool, type HostedBridgeOptions } from "./hosted-provider.js";

/**
 * Hosted adapters for the economy gateway. The same enforced purchase
 * lifecycle runs in the worker; discovery and inspection use CrowdCode's
 * public API and an unauthenticated probe, while every credentialed step
 * (payment, signed review, balance) crosses the supervisor socket as an
 * `economy.*` tool. The agent process never holds a wallet.
 */

export const DEFAULT_CROWDCODE_BASE = "https://crowdcode-backend.onrender.com";
const LIST_CACHE_MS = 60_000;
/**
 * The supervisor waits SERVICE_GATEWAY_TIMEOUT_MS on the gateway, which waits
 * SERVICE_PROVIDER_TIMEOUT_MS on the provider. The runtime must never be the
 * first layer to give up: abandoning the socket discards an answer the gateway
 * may already have paid for.
 */
const PAY_TIMEOUT_MS = SERVICE_GATEWAY_TIMEOUT_MS + 30_000;
/** Pause before re-posting a purchase whose first attempt lost the socket. */
const RECONCILE_DELAY_MS = 2_000;
/** Socket errors raised before anything was sent; there is no purchase to reconcile. */
const NOT_SENT_CODES = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTDIR"]);
const FREE_FETCH_TIMEOUT_MS = 30_000;
const USDC_ATOMIC_PER_USD = 1_000_000;
const BASE_NETWORK = "eip155:8453";
/** Gateway tools that have no hosted counterpart worth advertising. */
const HIDDEN_HOSTED_TOOLS = new Set(["bridge_usdc"]);

export interface HostedEconomyOptions extends HostedBridgeOptions {
  session: SessionState;
  fetcher?: typeof fetch;
  crowdcodeBase?: string;
  /** Test hook: delay before the single purchase reconcile after a lost socket. */
  reconcileDelayMs?: number;
}

interface ListedService {
  service_id: string;
  name: string;
  endpoint: string;
  directory_slug?: string;
  payment_provider: string;
  score?: number;
  n_eff?: number;
  unproven?: boolean;
  num_reviews?: number;
}

/** The CrowdCode service list, cached briefly and indexed by endpoint. */
class ServiceDirectory {
  private cache?: { fetchedAt: number; services: ListedService[] };
  private readonly idsByEndpoint = new Map<string, string>();

  constructor(private readonly fetcher: typeof fetch, readonly base: string) {}

  async list(force = false): Promise<ListedService[]> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < LIST_CACHE_MS) {
      return this.cache.services;
    }
    const response = await this.fetcher(`${this.base}/api/services`, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`CrowdCode service list unavailable (HTTP ${response.status})`);
    }
    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload) ? payload : objectValue(payload)?.services;
    const services = (Array.isArray(rows) ? rows : []).map(parseListedService).filter((row): row is ListedService => row !== undefined);
    for (const service of services) {
      this.idsByEndpoint.set(endpointKey(service.endpoint), service.service_id);
    }
    this.cache = { fetchedAt: Date.now(), services };
    return services;
  }

  /** Resolve a listed service id for a URL: remembered first, then a fresh list matched by origin+path. */
  async resolveServiceId(url: string): Promise<string | undefined> {
    const key = endpointKey(url);
    const known = this.idsByEndpoint.get(key);
    if (known) {
      return known;
    }
    await this.list(true).catch(() => []);
    return this.idsByEndpoint.get(key);
  }

  async detail(serviceId: string): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
    const response = await this.fetcher(`${this.base}/api/services/${encodeURIComponent(serviceId)}`, { headers: { accept: "application/json" } });
    const body = objectValue(await response.json().catch(() => undefined));
    return { status: response.status, body };
  }
}

export class HostedAgentCashAdapter implements AgentCashAdapter {
  /** Rails observed by inspection; `fetch` refuses anything but Base x402 regardless of the caller's rail. */
  private readonly inspectedRails = new Map<string, PaymentRail | "free">();

  constructor(
    private readonly directory: ServiceDirectory,
    private readonly socket: HostedBridgeOptions,
    private readonly fetcher: typeof fetch,
    private readonly reconcileDelayMs = RECONCILE_DELAY_MS
  ) {
    this.discovery = new BaseServiceDiscovery(async (query, options) => {
      const reply = await postHostedTool(this.socket, "economy.read", {
        url: "https://agentcash.dev/api/search", method: "POST", body: JSON.stringify({ query, ...options })
      });
      const result = reply.data as any;
      if (!reply.ok || result?.status !== 200) return { ok: false, error: reply.error ?? "AgentCash search unavailable" };
      return { ok: true, data: JSON.parse(result.body) };
    });
  }
  private readonly discovery: BaseServiceDiscovery;
  async read(url: string): Promise<McpCallResult> {
    const reply = await postHostedTool(this.socket, "economy.read", { url, method: "GET" });
    const result = reply.data as any;
    if (!reply.ok) return reply;
    return { ok: result.status < 400, data: decodeBody(result.body, result.content_type),
      error: result.status >= 400 ? `Read returned HTTP ${result.status}; no payment was made` : undefined };
  }

  async getBalance(): Promise<WalletStatusResult> {
    try {
      const reply = await postHostedTool(this.socket, "economy.balance", {});
      return reply.ok ? { ok: true, data: reply.data } : { ok: false, error: reply.error };
    } catch (error) {
      return { ok: false, error: `wallet status unavailable: ${(error as Error).message}` };
    }
  }

  discoverEndpoints(origin: string): Promise<McpCallResult> { return this.discovery.discoverEndpoints(origin); }
  search(query: string, options: { limit?: number; broad?: boolean } = {}): Promise<McpCallResult> { return this.discovery.search(query, options); }
  checkEndpointSchema(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult> { return this.discovery.inspect(input); }

  async fetch(request: PaidFetchRequest): Promise<PaidFetchResult> {
    const refuse = (error: string): PaidFetchResult => ({ ok: false, ambiguous: false, data: undefined, error });
    const inspected = this.inspectedRails.get(`${request.method.toUpperCase()} ${request.url}`);
    if (request.rail === "mppx" || inspected === "mppx") {
      return refuse("this service settles on MPP/Tempo; hosted agents can only pay x402 services on Base");
    }
    if (request.rail === "unsupported" || inspected === "unsupported") {
      return refuse("this service settles on a payment network hosted agents cannot pay (only x402 USDC on Base)");
    }
    const serviceId = await this.directory.resolveServiceId(request.url)
      ?? `url:${createHash("sha256").update(request.url).digest("hex")}`;
    const method = request.method.toUpperCase();
    const body = request.body === undefined ? undefined : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const hash = request.operationId ? createHash("sha256").update(`${this.socket.runId}:${request.operationId}`).digest("hex") : undefined;
    const purchaseId = hash ? `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}` : randomUUID();
    const payArgs = {
      purchase_request_id: purchaseId,
      service_id: serviceId,
      url: request.url,
      method,
      body,
      max_cost_cents: Math.ceil(request.maxAmountUsd * 100)
    };
    const timeoutMs = Math.min(request.timeoutMs ?? PAY_TIMEOUT_MS, PAY_TIMEOUT_MS);
    let reply, timedOut = false;
    try {
      reply = await postHostedTool(this.socket, "economy.pay", payArgs, { timeoutMs });
    } catch (error) {
      // The gateway keys every attempt by purchase_request_id and request
      // digest, so re-posting the identical request replays a finished
      // purchase instead of paying twice. One reconcile recovers an answer
      // that arrived after the socket was lost; anything else stays unknown.
      timedOut = error instanceof HostedToolTimeout;
      const recovered = await this.reconcile(error, payArgs, timeoutMs);
      if (!recovered) {
        return {
          ok: false,
          ambiguous: true,
          ambiguityReason: timedOut ? "timeout" : "transport",
          data: undefined,
          error: timedOut
            ? `the paid call did not answer within ${Math.round(timeoutMs / 1000)}s and its stored purchase has no final result yet`
            : `payment request to the supervisor failed in transport: ${(error as Error).message}`
        };
      }
      reply = recovered;
    }
    if (reply.ok) {
      const data = objectValue(reply.data) ?? {};
      const status = numberValue(data.status);
      const outcome = data.outcome === "paid_success" ? "paid_success" : "paid_failure";
      const paidAtomic = numberValue(data.amount_atomic);
      return {
        ok: outcome === "paid_success",
        ambiguous: false,
        status,
        data: decodeBody(data.body, data.content_type),
        authMode: "paid",
        error: outcome === "paid_success" ? undefined : `the paid call returned HTTP ${status ?? "?"}`,
        payment: {
          rail: "x402-base",
          paidUsd: paidAtomic === undefined ? undefined : paidAtomic / USDC_ATOMIC_PER_USD,
          reference: stringValue(data.transaction),
          payTo: stringValue(data.pay_to)
        }
      };
    }
    if (reply.code === "payment_declined") throw new SpendingDeclined();
    if (reply.code === "approval_required") throw new RuntimePause("waiting_for_approval", purchaseId, "Spending approval required. Review the quoted amount to continue.");
    if (reply.code === "expected_payment_required") {
      return this.fetchUnpaid(request.url, method, body, request.headers);
    }
    if (reply.code === "payment_unknown") {
      return {
        ok: false,
        ambiguous: true,
        ambiguityReason: timedOut ? "timeout" : "transport",
        data: undefined,
        error: timedOut
          ? `the paid call did not answer within ${Math.round(timeoutMs / 1000)}s and its stored purchase has no final result yet`
          : reply.error ?? "the supervisor could not determine whether the payment settled"
      };
    }
    return refuse(reply.code ? `${reply.error ?? "payment refused"} (${reply.code})` : reply.error ?? "payment refused");
  }

  /**
   * Re-post the same purchase once. A finished attempt replays from the ledger;
   * an attempt still in flight answers payment_unknown; a request that never
   * reached the supervisor is not reconciled because nothing was started.
   */
  private async reconcile(error: unknown, payArgs: Record<string, unknown>, timeoutMs: number) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return undefined;
    await new Promise(resolve => setTimeout(resolve, this.reconcileDelayMs));
    try {
      return await postHostedTool(this.socket, "economy.pay", payArgs, { timeoutMs });
    } catch {
      return undefined;
    }
  }

  /** The supervisor found no 402: the endpoint is free, so the worker fetches it itself. */
  private async fetchUnpaid(url: string, method: string, body: string | undefined, headers?: Record<string, string>): Promise<PaidFetchResult> {
    try {
      const response = await this.fetcher(url, {
        method,
        signal: AbortSignal.timeout(FREE_FETCH_TIMEOUT_MS),
        headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(headers ?? {}) },
        ...(body !== undefined && method !== "GET" ? { body } : {})
      });
      const text = await response.text();
      return {
        ok: response.status < 400,
        ambiguous: false,
        status: response.status,
        data: decodeBody(text, response.headers.get("content-type")),
        authMode: "free",
        error: response.status < 400 ? undefined : `HTTP ${response.status}`
      };
    } catch (error) {
      return { ok: false, ambiguous: false, data: undefined, authMode: "free", error: `unpaid request failed: ${(error as Error).message}` };
    }
  }

  async bridge(): Promise<McpCallResult> {
    return { ok: false, error: "USDC bridging is not available for hosted agents" };
  }
}

export class HostedCrowdCodeAdapter implements CrowdCodeAdapter {
  async manage(name: string, args: Record<string, unknown>) {
    return postHostedTool(this.socket, "economy.crowdcode", { name, ...args });
  }
  constructor(private readonly directory: ServiceDirectory, private readonly socket: HostedBridgeOptions) {}

  async getServiceScore(query: ServiceQuery): Promise<ServiceEvidence> {
    const unreviewed: ServiceEvidence = { ok: true, unproven: true, summary: "not yet reviewed on CrowdCode" };
    let serviceId = query.serviceId;
    if (!serviceId && query.apiEndpoint) {
      try {
        serviceId = await this.directory.resolveServiceId(query.apiEndpoint);
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    }
    if (!serviceId) {
      return unreviewed;
    }
    let detail: { status: number; body: Record<string, unknown> | undefined };
    try {
      detail = await this.directory.detail(serviceId);
    } catch (error) {
      return { ok: false, error: `CrowdCode is unreachable: ${(error as Error).message}` };
    }
    if (detail.status === 404) {
      return unreviewed;
    }
    if (detail.status >= 400 || !detail.body || detail.body.ok === false) {
      return { ok: false, error: `CrowdCode service lookup failed (HTTP ${detail.status})` };
    }
    const body = detail.body;
    return {
      ok: true,
      score: numberValue(body.score),
      nEff: numberValue(body.n_eff),
      unproven: typeof body.unproven === "boolean" ? body.unproven : undefined,
      summary: summarizeEvidence(body),
      raw: body
    };
  }

  async reviewService(review: ReviewSubmission): Promise<ReviewResult> {
    try {
      const reply = await postHostedTool(this.socket, "economy.review", {
        api_endpoint: review.apiEndpoint,
        payment_provider: review.paymentProvider,
        payment_target_ref: review.paymentTargetRef,
        payment_reference: review.paymentReference,
        review_nonce: review.reviewNonce,
        rating: review.rating,
        reason: review.reason,
        task_context: review.taskContext
      });
      return { ok: reply.ok, error: reply.error, raw: reply.data };
    } catch (error) {
      return { ok: false, error: `review request to the supervisor failed: ${(error as Error).message}` };
    }
  }
}

/** The hosted economy gateway: auto approval locally, with caps and ask mode enforced by the supervisor's gateway. */
export function createHostedEconomy(options: HostedEconomyOptions): EconomyGateway {
  const fetcher = options.fetcher ?? fetch;
  const socket = { socketPath: options.socketPath, runId: options.runId, sessionId: options.sessionId };
  const directory = new ServiceDirectory(fetcher, (options.crowdcodeBase ?? DEFAULT_CROWDCODE_BASE).replace(/\/+$/, ""));
  return new EconomyGateway({
    session: options.session,
    agentcash: new HostedAgentCashAdapter(directory, socket, fetcher, options.reconcileDelayMs),
    crowdcode: new HostedCrowdCodeAdapter(directory, socket),
    approvalMode: "auto",
    hostedSpending: true,
    minServiceScore: 2,
    // Hosted rules live with the agent's session, never in a user config dir.
    approvalRulesPath: join(options.session.sessionDir, "approval-rules.json")
  });
}

export { MAX_REVIEW_ATTEMPTS } from "./economy-tools.js";
export type { EconomyTools as HostedDynamicTools } from "./economy-tools.js";
/** Cloud exposes the same completion policy, excluding local wallet actions. */
export function hostedDynamicTools(economy: EconomyGateway) {
  const tools = economyTools(economy, { hidden: HIDDEN_HOSTED_TOOLS });
  return { ...tools, definitions: tools.definitions.map(tool => tool.name === "get_wallet_status"
    ? { ...tool, description: "Read this hosted agent's USDC wallet balance and authoritative current-run inference spending, service spending, payment holds and authorized budget. Read-only." } : tool) };
}


interface PaymentOffer {
  rail: PaymentRail;
  priceUsd?: number;
  payTo?: string;
  network?: string;
  inputSchema?: unknown;
  outputExample?: unknown;
  description?: string;
}

/**
 * Decode an x402 v2 `payment-required` header (base64 JSON) or, failing that,
 * a v1-style JSON body carrying the same `accepts` list. Parsed by hand; the
 * runtime takes no x402 client dependency for inspection.
 */
export function parsePaymentRequired(header: string | null, body: string): PaymentOffer | undefined {
  const decoded = header ? parseJson(Buffer.from(header, "base64").toString("utf8")) ?? parseJson(header) : undefined;
  const offer = objectValue(decoded) ?? objectValue(parseJson(body));
  const accepts = Array.isArray(offer?.accepts) ? offer.accepts.map(objectValue).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
  if (!offer || accepts.length === 0) {
    return undefined;
  }
  const networks = accepts.map((accept) => stringValue(accept.network)?.toLowerCase() ?? "");
  const rail: PaymentRail = networks.includes(BASE_NETWORK)
    ? "x402-base"
    : networks.some((network) => network.includes("tempo")) ? "mppx" : "unsupported";
  const onRail = rail === "x402-base"
    ? accepts.filter((accept) => stringValue(accept.network)?.toLowerCase() === BASE_NETWORK)
    : rail === "mppx" ? accepts.filter((accept) => stringValue(accept.network)?.toLowerCase().includes("tempo")) : accepts;
  const amounts = onRail
    .map((accept) => numberValue(accept.amount ?? accept.maxAmountRequired))
    .filter((amount): amount is number => amount !== undefined && amount >= 0);
  const cheapest = amounts.length ? onRail[amounts.indexOf(Math.min(...amounts))] : onRail[0];
  const resource = objectValue(offer.resource);
  // The x402 discovery extension carries the input/output schema under `info`.
  const info = Object.values(objectValue(offer.extensions) ?? {})
    .map((extension) => objectValue(objectValue(extension)?.info))
    .find((candidate) => candidate !== undefined);
  return {
    rail,
    priceUsd: amounts.length ? Math.min(...amounts) / USDC_ATOMIC_PER_USD : undefined,
    payTo: stringValue(cheapest?.payTo),
    network: stringValue(cheapest?.network),
    inputSchema: info?.input,
    outputExample: info?.output,
    description: stringValue(resource?.description) ?? stringValue(offer.description)
  };
}

function parseListedService(raw: unknown): ListedService | undefined {
  const row = objectValue(raw);
  if (!row) {
    return undefined;
  }
  const service = objectValue(row.service) ?? row;
  const serviceId = stringValue(service.service_id);
  const endpoint = stringValue(service.canonical_endpoint ?? service.endpoint);
  if (!serviceId || !endpoint) {
    return undefined;
  }
  return {
    service_id: serviceId,
    name: stringValue(service.name) ?? endpoint,
    endpoint,
    directory_slug: stringValue(service.directory_slug),
    payment_provider: stringValue(service.payment_provider) ?? "unknown",
    score: numberValue(row.score ?? service.score),
    n_eff: numberValue(row.n_eff ?? service.n_eff),
    unproven: typeof (row.unproven ?? service.unproven) === "boolean" ? Boolean(row.unproven ?? service.unproven) : undefined,
    num_reviews: numberValue(row.num_reviews ?? service.num_reviews)
  };
}

function endpointKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.toLowerCase();
  }
}

function decodeBody(body: unknown, contentType: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }
  if (typeof contentType === "string" && /json/i.test(contentType)) {
    return parseJson(body) ?? body;
  }
  return body;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
