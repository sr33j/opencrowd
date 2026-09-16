import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SessionState } from "@opencrowd/core";
import {
  EconomyGateway,
  originOf,
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
import type { DynamicToolsOption } from "./index.js";
import { postHostedTool, type HostedBridgeOptions } from "./hosted-provider.js";

/**
 * Hosted adapters for the economy gateway. The same enforced purchase
 * lifecycle runs in the worker; discovery and inspection use CrowdCode's
 * public API and an unauthenticated probe, while every credentialed step
 * (payment, signed review, balance) crosses the supervisor socket as an
 * `economy.*` tool. The agent process never holds a wallet.
 */

export const DEFAULT_CROWDCODE_BASE = "https://crowdcode-backend.onrender.com";
const LIST_CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const PAY_TIMEOUT_MS = 120_000;
const FREE_FETCH_TIMEOUT_MS = 30_000;
const USDC_ATOMIC_PER_USD = 1_000_000;
const BASE_NETWORK = "eip155:8453";
/** Gateway tools that have no hosted counterpart worth advertising. */
const HIDDEN_HOSTED_TOOLS = new Set(["bridge_usdc", "get_wallet_status"]);

export interface HostedEconomyOptions extends HostedBridgeOptions {
  session: SessionState;
  fetcher?: typeof fetch;
  crowdcodeBase?: string;
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
    private readonly fetcher: typeof fetch
  ) {}

  async getBalance(): Promise<WalletStatusResult> {
    try {
      const reply = await postHostedTool(this.socket, "economy.balance", {});
      return reply.ok ? { ok: true, data: reply.data } : { ok: false, error: reply.error };
    } catch (error) {
      return { ok: false, error: `wallet status unavailable: ${(error as Error).message}` };
    }
  }

  async discoverEndpoints(origin: string): Promise<McpCallResult> {
    let services: ListedService[];
    try {
      services = await this.directory.list();
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    const wanted = originOf(origin.includes("://") ? origin : `https://${origin}`).toLowerCase();
    const matches = services.filter((service) => originOf(service.endpoint).toLowerCase() === wanted);
    return {
      ok: true,
      data: {
        services: matches.map((service) => presentService(service, 0)),
        note: matches.length === 0
          ? `no CrowdCode-listed services at ${wanted}; only listed x402 services can be paid from a hosted agent`
          : PAYABLE_NOTE
      }
    };
  }

  async search(query: string, options: { limit?: number; broad?: boolean } = {}): Promise<McpCallResult> {
    let services: ListedService[];
    try {
      services = await this.directory.list();
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    const tokens = tokenize(query);
    const ranked = services
      .map((service) => ({ service, score: overlapScore(tokens, service) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score
        || Number(right.service.payment_provider === "x402") - Number(left.service.payment_provider === "x402")
        || (right.service.score ?? 0) - (left.service.score ?? 0))
      .slice(0, options.limit ?? 8);
    return {
      ok: true,
      data: {
        services: ranked.map((entry) => presentService(entry.service, entry.score)),
        note: ranked.length === 0
          ? "no CrowdCode-listed services matched; try different words or pass a known origin"
          : PAYABLE_NOTE
      }
    };
  }

  async checkEndpointSchema(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult> {
    const method = (input.method ?? "POST").toUpperCase();
    let response: Response;
    try {
      response = await this.fetcher(input.url, {
        method,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        ...(input.body !== undefined && method !== "GET"
          ? { headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input.body) }
          : { headers: { accept: "application/json" } })
      });
    } catch (error) {
      return { ok: false, error: `could not reach ${input.url}: ${(error as Error).message}` };
    }
    const text = await response.text().catch(() => "");
    const key = `${method} ${input.url}`;
    const serviceId = await this.directory.resolveServiceId(input.url);
    if (response.status === 402) {
      const offer = parsePaymentRequired(response.headers.get("payment-required") ?? response.headers.get("x-payment-required"), text);
      if (!offer) {
        return { ok: false, error: `${input.url} requires payment but sent no decodable x402 payment-required offer` };
      }
      this.inspectedRails.set(key, offer.rail);
      return {
        ok: true,
        data: {
          status: 402,
          rail: offer.rail,
          payable: offer.rail === "x402-base" && serviceId !== undefined,
          price_usd: offer.priceUsd,
          payTo: offer.payTo,
          network: offer.network,
          input_schema: offer.inputSchema,
          output_example: offer.outputExample,
          description: offer.description,
          service_id: serviceId,
          note: offer.rail === "x402-base"
            ? (serviceId ? undefined : "not a CrowdCode-listed service; hosted agents can only pay listed x402 services")
            : offer.rail === "mppx"
              ? "settles on MPP/Tempo, which hosted agents cannot pay"
              : "settles on a payment network hosted agents cannot pay"
        }
      };
    }
    if (response.ok) {
      this.inspectedRails.set(key, "free");
      return {
        ok: true,
        data: {
          status: response.status,
          rail: "free",
          price_usd: 0,
          note: "the endpoint answered without requiring payment",
          service_id: serviceId,
          output_example: previewBody(text, response.headers.get("content-type"))
        }
      };
    }
    return { ok: false, error: `${input.url} answered HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
  }

  async fetch(request: PaidFetchRequest): Promise<PaidFetchResult> {
    const refuse = (error: string): PaidFetchResult => ({ ok: false, ambiguous: false, data: undefined, error });
    const inspected = this.inspectedRails.get(`${request.method.toUpperCase()} ${request.url}`);
    if (request.rail === "mppx" || inspected === "mppx") {
      return refuse("this service settles on MPP/Tempo; hosted agents can only pay x402 services on Base");
    }
    if (request.rail === "unsupported" || inspected === "unsupported") {
      return refuse("this service settles on a payment network hosted agents cannot pay (only x402 USDC on Base)");
    }
    const serviceId = await this.directory.resolveServiceId(request.url);
    if (!serviceId) {
      return refuse("not a CrowdCode-listed service; only listed x402 services can be paid");
    }
    const method = request.method.toUpperCase();
    const body = request.body === undefined ? undefined : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    let reply;
    try {
      reply = await postHostedTool(this.socket, "economy.pay", {
        purchase_request_id: randomUUID(),
        service_id: serviceId,
        url: request.url,
        method,
        body,
        max_cost_cents: Math.ceil(request.maxAmountUsd * 100)
      }, { timeoutMs: request.timeoutMs ?? PAY_TIMEOUT_MS });
    } catch (error) {
      return {
        ok: false,
        ambiguous: true,
        ambiguityReason: "transport",
        data: undefined,
        error: `payment request to the supervisor failed in transport: ${(error as Error).message}`
      };
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
    if (reply.code === "expected_payment_required") {
      return this.fetchUnpaid(request.url, method, body, request.headers);
    }
    if (reply.code === "payment_unknown") {
      return {
        ok: false,
        ambiguous: true,
        ambiguityReason: "transport",
        data: undefined,
        error: reply.error ?? "the supervisor could not determine whether the payment settled"
      };
    }
    return refuse(reply.code ? `${reply.error ?? "payment refused"} (${reply.code})` : reply.error ?? "payment refused");
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
        payment_provider: "x402",
        payment_target_ref: review.paymentTargetRef,
        payment_reference: review.paymentReference,
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
    agentcash: new HostedAgentCashAdapter(directory, socket, fetcher),
    crowdcode: new HostedCrowdCodeAdapter(directory, socket),
    approvalMode: "auto",
    minServiceScore: 2,
    // Hosted rules live with the agent's session, never in a user config dir.
    approvalRulesPath: join(options.session.sessionDir, "approval-rules.json")
  });
}

/** Failed review submissions tolerated before a run may finish with the review still pending. */
export const MAX_REVIEW_ATTEMPTS = 2;

export interface HostedDynamicTools extends DynamicToolsOption {
  /** Blocks completion while a paid purchase awaits its review, until CrowdCode has rejected the review twice. */
  completionGate(): Promise<string | undefined>;
}

/**
 * The gateway's dynamic tool surface for a hosted run, minus tools that have
 * no hosted counterpart. A review the backend keeps rejecting must not hold
 * the user's answer hostage, so the gate releases after repeated failures.
 */
export function hostedDynamicTools(economy: EconomyGateway): HostedDynamicTools {
  let failedReviews = 0;
  return {
    definitions: economy.definitions().filter((definition) => !HIDDEN_HOSTED_TOOLS.has(definition.name)),
    execute: async (name, args) => {
      const result = await economy.execute(name, args);
      if (name === "review_paid_service" && !result.ok) failedReviews += 1;
      return result;
    },
    completionGate: async () => {
      if (failedReviews >= MAX_REVIEW_ATTEMPTS || !(await economy.hasPendingRequiredReviews())) return undefined;
      return "a paid purchase still needs its review_paid_service call";
    }
  };
}

const PAYABLE_NOTE = "payable=true means x402 on Base, which hosted agents pay automatically; MPP/Tempo listings are shown for reference only";

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

function presentService(service: ListedService, score: number): Record<string, unknown> {
  return {
    service_id: service.service_id,
    name: service.name,
    endpoint: service.endpoint,
    payment_provider: service.payment_provider,
    payable: service.payment_provider === "x402",
    match: score,
    crowdcode_score: service.score,
    n_eff: service.n_eff,
    unproven: service.unproven,
    num_reviews: service.num_reviews
  };
}

function summarizeEvidence(body: Record<string, unknown>): string | undefined {
  const summary = objectValue(body.summary);
  const lines = [...stringList(summary?.strengths), ...stringList(summary?.caveats)];
  if (lines.length) {
    return lines.slice(0, 4).join(" ");
  }
  return stringValue(body.summary);
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1))];
}

/** Count query tokens present in the listing's name, endpoint, and slug (case-insensitive). */
function overlapScore(tokens: string[], service: ListedService): number {
  const haystack = `${service.name} ${service.endpoint} ${service.directory_slug ?? ""}`.toLowerCase();
  return tokens.filter((token) => haystack.includes(token)).length;
}

/** Origin plus path, ignoring case, trailing slashes, and query strings. */
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

function previewBody(text: string, contentType: string | null): unknown {
  const parsed = contentType && /json/i.test(contentType) ? parseJson(text) : undefined;
  return parsed ?? (text ? text.slice(0, 500) : undefined);
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
