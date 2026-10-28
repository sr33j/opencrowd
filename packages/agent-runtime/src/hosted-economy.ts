import { economyTools } from "./economy-tools.js";
import { RuntimePause } from "./worker.js";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { SpendingDeclined, type SessionState } from "@opencrowd/core";
import {
  EconomyGateway, BaseServiceDiscovery, summarizeEvidence, classifyOffer, describeRails, HOSTED_RAILS, networkName, railForNetwork, selectOffer,
  type OfferNetwork,
  type ServiceOffer,
  type AgentCashAdapter,
  type CrowdCodeAdapter,
  type McpCallResult,
  type BridgeRequest,
  type PaidFetchRequest,
  type PaidFetchResult,
  type PaymentRail,
  type ReviewResult,
  type ReviewSubmission,
  type ServiceEvidence,
  type ServiceQuery,
  type ServiceSearch,
  type SearchOptions,
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
/** CrowdCode's search waits on public catalogs (about 8s each, in parallel). */
const FIND_TIMEOUT_MS = 20_000;
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
/** A move usually lands in seconds; past this the tool reports it pending with its id. */
const TRANSFER_WAIT_MS = 150_000;
const TRANSFER_POLL_MS = 3_000;
/** One move should fund many calls rather than one, so a move aims at a dollar. */
const PREFERRED_MOVE_USD = 1;
/** Relay keeps about $0.02-0.03; send this much over the price so it still lands. */
const MOVE_FEE_ALLOWANCE_USD = 0.05;
/** What a move costs, for judging whether a small one is worth starting. */
const MOVE_FEE_ESTIMATE_USD = 0.03;
/**
 * Under a dollar a move is still worth making while its fee stays a small
 * share of what moves: at a $0.03 fee that puts the floor near $0.15. The
 * point of the old flat $1 minimum was never the dollar, it was not handing a
 * third of the money to the bridge — and read as a hard floor it stranded a
 * wallet holding $0.90 in front of a $0.02 service on another network.
 */
const MAX_MOVE_FEE_SHARE = 0.2;
/** Held back on Base, which is where this agent's inference is paid from. */
const BASE_WORKING_RESERVE_USD = 0.25;
const RAIL_NETWORK: Partial<Record<PaymentRail, string>> = { "x402-base": "base", "x402-solana": "solana", mppx: "tempo" };

export interface HostedEconomyOptions extends HostedBridgeOptions {
  session: SessionState;
  fetcher?: typeof fetch;
  crowdcodeBase?: string;
  /** Test hook: delay before the single purchase reconcile after a lost socket. */
  reconcileDelayMs?: number;
  /** Test hook: how long and how often an executed transfer is followed. */
  transferWait?: { totalMs: number; pollMs: number };
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

  constructor(readonly fetcher: typeof fetch, readonly base: string) {}

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
  constructor(
    private readonly directory: ServiceDirectory,
    private readonly socket: HostedBridgeOptions,
    private readonly fetcher: typeof fetch,
    private readonly reconcileDelayMs = RECONCILE_DELAY_MS,
    private readonly transferWait: { totalMs: number; pollMs: number } = { totalMs: TRANSFER_WAIT_MS, pollMs: TRANSFER_POLL_MS }
  ) {
    this.discovery = new BaseServiceDiscovery(async (query, options) => {
      const reply = await postHostedTool(this.socket, "economy.read", {
        url: "https://agentcash.dev/api/search", method: "POST", body: JSON.stringify({ query, ...options })
      });
      const result = reply.data as any;
      if (!reply.ok || result?.status !== 200) return { ok: false, error: reply.error ?? "AgentCash search unavailable" };
      return { ok: true, data: JSON.parse(result.body) };
    // The hosted gateway negotiates Base, Solana or Tempo per call from the agent's per-network balances.
    }, { rails: HOSTED_RAILS, negotiated: true, balances: () => this.networkBalances() });
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

  /** Available USDC per network (balance minus open holds), for ranking search results. */
  private async networkBalances(): Promise<Partial<Record<OfferNetwork, number>>> {
    const reply = await postHostedTool(this.socket, "economy.balance", {});
    const networks = (reply.ok ? objectValue(reply.data)?.networks : undefined);
    const balances: Partial<Record<OfferNetwork, number>> = {};
    for (const entry of Array.isArray(networks) ? networks : []) {
      const row = objectValue(entry);
      const name = networkName(row?.network) ?? networkName(row?.caip2);
      const available = Number(row?.available_usd ?? row?.balance_usd);
      if (name && row?.available_usd != null && Number.isFinite(available)) balances[name] = available;
    }
    return balances;
  }

  discoverEndpoints(origin: string): Promise<McpCallResult> { return this.discovery.discoverEndpoints(origin); }
  search(query: string, options: SearchOptions = {}): Promise<McpCallResult> { return this.discovery.search(query, options); }
  checkEndpointSchema(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult> { return this.discovery.inspect(input); }

  async fetch(request: PaidFetchRequest): Promise<PaidFetchResult> {
    /**
     * The supervisor would not pay, so the service was never asked.
     *
     * `ours` marks the refusals that are a fact about us rather than about the
     * seller — no USDC on a network they accept, a rail hosted agents cannot
     * pay — and it is what keeps those out of the seller's reputation; see
     * `PaidFetchResult.callerError`. It is deliberately not the default: a
     * seller whose 402 challenge is malformed, say, has genuinely done
     * something wrong, and an agent should be able to say so.
     */
    const refuse = (error: string, ours = false): PaidFetchResult =>
      ({ ok: false, ambiguous: false, data: undefined, error, ...(ours ? { callerError: true } : {}) });
    // Refused before the bridge: the hosted gateway cannot settle these rails (Monad, other chains or tokens).
    if (!HOSTED_RAILS.includes(request.rail)) {
      return refuse(`this service settles on a payment network hosted agents cannot pay; hosted agents pay ${describeRails(HOSTED_RAILS)}`, true);
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
      // The gateway chose the network; an older gateway that omits it paid on Base.
      const network = stringValue(data.network);
      return {
        ok: outcome === "paid_success",
        ambiguous: false,
        status,
        data: decodeBody(data.body, data.content_type),
        authMode: "paid",
        error: outcome === "paid_success" ? undefined : `the paid call returned HTTP ${status ?? "?"}`,
        payment: {
          rail: network ? railForNetwork(network) ?? "unsupported" : "x402-base",
          paidUsd: paidAtomic === undefined ? undefined : paidAtomic / USDC_ATOMIC_PER_USD,
          // The bare transaction is how the hosted gateway finds its settled attempt for the review.
          reference: stringValue(data.transaction),
          payTo: stringValue(data.pay_to),
          payer: stringValue(data.payer)
        }
      };
    }
    if (reply.code === "payment_declined") throw new SpendingDeclined();
    if (reply.code === "approval_required") throw new RuntimePause("waiting_for_approval", purchaseId, "Spending approval required. Review the quoted amount to continue.");
    if (reply.code === "expected_payment_required") {
      return this.fetchUnpaid(request.url, method, body, request.headers);
    }
    if (reply.code === "funding_required") {
      return refuse(`${reply.error ?? "not enough USDC on this service's networks"} (funding_required)${await this.fundingHint(request)}`, true);
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

  /**
   * After funding_required: where the agent's money is, and the two ways
   * forward, cheaper first. An equivalent service on a network the agent
   * already funds costs nothing extra; a move costs a bridge fee. A funded
   * wallet must never be told to go and ask the owner for money, and a move
   * that would spend most of itself on the fee must never be made quietly.
   */
  private async fundingHint(request: PaidFetchRequest): Promise<string> {
    const wallet = await this.getBalance().catch(() => undefined);
    const networks = Array.isArray((wallet?.data as any)?.networks) ? (wallet!.data as any).networks as Record<string, unknown>[] : [];
    const available = networks.map((n) => ({ network: stringValue(n.network) ?? "?", usd: numberValue(n.available_usd ?? n.balance_usd) }))
      .filter((n): n is { network: string; usd: number } => n.usd !== undefined);
    if (!available.length) return " Check get_wallet_status for where your USDC is.";
    const total = available.reduce((sum, n) => sum + n.usd, 0);
    const line = ` Your available USDC: ${available.map((n) => `${n.network} ${n.usd.toFixed(2)}`).join(", ")} (total ${total.toFixed(2)}).`;
    const target = RAIL_NETWORK[request.rail];
    const funded = available.filter((n) => n.network !== target && n.usd >= request.maxAmountUsd).map((n) => n.network);
    const elsewhere = funded.length
      ? ` First look for an equivalent service you can already pay: find_paid_service lists every result's networks, and one on ${funded.join(" or ")} costs you no transfer fee.`
      : "";
    const move = target ? planFundingMove(target, request.maxAmountUsd, available) : undefined;
    if (!target || !move)
      return `${line}${elsewhere} No network of yours can cover a move to ${target ?? "a network this service accepts"} either, so if no equivalent service fits, tell the owner plainly that this service is sold only on ${target ?? "networks you do not hold"} and ask them to add USDC there.`;
    const cost = `about $${MOVE_FEE_ESTIMATE_USD.toFixed(2)}`, size = `$${move.amount.toFixed(2)}`;
    if (!move.worthwhile)
      return `${line}${elsewhere} Moving funds is the other way, but the most ${move.from} can spare is ${size}, and a fee of ${cost} is ${Math.round(move.feeShare * 100)}% of that — too much to spend without asking. If no equivalent service fits, say exactly that to the owner: this service is sold only on ${target}, moving ${size} there would cost ${cost} in fees, and ask whether to do it.`;
    return `${line}${elsewhere} Otherwise move the funds yourself and retry — a move this size is within the policy and is not something to ask the owner about, any more than paying for the call is: bridge_usdc {"from":"${move.from}","to":"${target}","amount_usd":${move.amount}} (fee ${cost}, counted as spending; the spending guard pauses it for approval by itself if the owner's mode requires that), then retry this call.`;
  }

  /**
   * Moves this agent's own USDC between its networks through the supervisor:
   * a quote, or an executed move keyed by the tool call that waits for the
   * funds to arrive. Control picks the destination (the agent's own address),
   * applies the owner's policy to the fee and signs.
   */
  async bridge(input: BridgeRequest): Promise<McpCallResult> {
    if (input.transferId) return this.transferStatus(input.transferId);
    const amountAtomic = Math.round(input.amountUsd * USDC_ATOMIC_PER_USD);
    if (!Number.isSafeInteger(amountAtomic) || amountAtomic < 1) return { ok: false, error: "amount_usd is too small or too large" };
    const move = { from: input.from, to: input.to, amount_atomic: String(amountAtomic) };
    if (input.quoteOnly) {
      const reply = await postHostedTool(this.socket, "economy.transfer", { action: "quote", ...move }, { timeoutMs: 60_000 });
      if (!reply.ok) return { ok: false, error: describeTransferError(reply) };
      const data = objectValue(reply.data) ?? {}, quote = objectValue(data.quote) ?? {}, approval = objectValue(data.approval) ?? {};
      return { ok: true, data: {
        quote: true, from: input.from, to: input.to, amount_usd: input.amountUsd, recipient: stringValue(quote.recipient),
        fee_usd: usd(quote.feeAtomic), expected_received_usd: usd(quote.expectedReceivedAtomic), minimum_received_usd: usd(quote.minimumReceivedAtomic),
        time_estimate_seconds: numberValue(quote.timeEstimateSeconds),
        needs_owner_approval: approval.required === true,
        note: approval.required === true
          ? "Executing will pause for the owner's approval of this move and its fee."
          : "Within the owner's limits: executing runs immediately. Nothing has moved yet."
      } };
    }
    const hash = createHash("sha256").update(`${this.socket.runId}:${input.operationId ?? randomUUID()}:transfer`).digest("hex");
    const operationId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const args = { action: "execute", ...move, operation_id: operationId };
    let reply;
    try {
      reply = await postHostedTool(this.socket, "economy.transfer", args, { timeoutMs: 100_000 });
    } catch {
      // Keyed by operation: re-posting returns the transfer the first request created instead of moving twice.
      await new Promise(resolve => setTimeout(resolve, this.reconcileDelayMs));
      try {
        reply = await postHostedTool(this.socket, "economy.transfer", args, { timeoutMs: 100_000 });
      } catch (error) {
        return { ok: false, error: `the transfer request was interrupted (${(error as Error).message}); its state is unknown. Check get_wallet_status before moving funds again.` };
      }
    }
    if (!reply.ok && reply.code === "approval_required") {
      throw new RuntimePause("waiting_for_approval", operationId, "Transfer approval required. Review the move and its fee to continue.");
    }
    if (!reply.ok) return { ok: false, error: describeTransferError(reply) };
    let transfer = objectValue(objectValue(reply.data)?.transfer) ?? {};
    const deadline = Date.now() + this.transferWait.totalMs;
    while (isPending(transfer) && stringValue(transfer.id) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.transferWait.pollMs));
      const next = await postHostedTool(this.socket, "economy.transfer", { action: "status", transfer_id: transfer.id }, { timeoutMs: 60_000 }).catch(() => undefined);
      if (next?.ok) transfer = objectValue(objectValue(next.data)?.transfer) ?? transfer;
    }
    return describeTransfer(transfer);
  }

  private async transferStatus(transferId: string): Promise<McpCallResult> {
    const reply = await postHostedTool(this.socket, "economy.transfer", { action: "status", transfer_id: transferId }, { timeoutMs: 60_000 });
    return reply.ok ? describeTransfer(objectValue(objectValue(reply.data)?.transfer) ?? {}) : { ok: false, error: describeTransferError(reply) };
  }
}

const usd = (atomic: unknown) => {
  const value = numberValue(atomic);
  return value === undefined ? undefined : value / USDC_ATOMIC_PER_USD;
};
const isPending = (transfer: Record<string, unknown>) => transfer.state === "quoted" || transfer.state === "submitted";
function describeTransferError(reply: { error?: string; code?: string }): string {
  return reply.code ? `${reply.error ?? "transfer refused"} (${reply.code})` : reply.error ?? "transfer refused";
}
/** The model-facing summary of a move: amounts in USD and both transactions. */
function describeTransfer(transfer: Record<string, unknown>): McpCallResult {
  const state = stringValue(transfer.state) ?? "unknown";
  const data = {
    transfer_id: stringValue(transfer.id), state, from: stringValue(transfer.from), to: stringValue(transfer.to),
    amount_usd: usd(transfer.amount_atomic), fee_usd: usd(transfer.fee_atomic),
    received_usd: usd(transfer.received_atomic), expected_received_usd: usd(transfer.expected_received_atomic),
    origin_transaction: stringValue(transfer.origin_transaction), destination_transaction: stringValue(transfer.destination_transaction),
    failure: stringValue(transfer.failure),
    note: state === "confirmed" ? "The funds arrived on the destination network and can be spent there now."
      : isPending(transfer) ? "Still moving. Check again later with bridge_usdc {transfer_id}; do not start another move meanwhile."
      : state === "refunded" ? "Relay refunded the move to the origin network."
      : "The move did not complete."
  };
  return state === "failed" ? { ok: false, data, error: `the transfer failed: ${data.failure ?? "no funds moved"}` } : { ok: true, data };
}

export class HostedCrowdCodeAdapter implements CrowdCodeAdapter {
  async manage(name: string, args: Record<string, unknown>) {
    return postHostedTool(this.socket, "economy.crowdcode", { name, ...args });
  }
  constructor(private readonly directory: ServiceDirectory, private readonly socket: HostedBridgeOptions) {}

  /** CrowdCode's cross-chain search and ranking over its public API. */
  async findServices(search: ServiceSearch): Promise<McpCallResult> {
    try {
      const response = await this.directory.fetcher(`${this.directory.base}/api/services/find`, {
        method: "POST", signal: AbortSignal.timeout(FIND_TIMEOUT_MS),
        headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(search)
      });
      const body = objectValue(await response.json().catch(() => undefined));
      return response.ok && body?.ok !== false ? { ok: true, data: body } : { ok: false, error: `CrowdCode search failed (HTTP ${response.status})` };
    } catch (error) {
      return { ok: false, error: `CrowdCode search unavailable: ${(error as Error).message}` };
    }
  }

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
    agentcash: new HostedAgentCashAdapter(directory, socket, fetcher, options.reconcileDelayMs, options.transferWait),
    crowdcode: new HostedCrowdCodeAdapter(directory, socket),
    approvalMode: "auto",
    hostedSpending: true,
    minServiceScore: 2,
    paymentRails: HOSTED_RAILS,
    // Hosted rules live with the agent's session, never in a user config dir.
    approvalRulesPath: join(options.session.sessionDir, "approval-rules.json")
  });
}

export { MAX_REVIEW_ATTEMPTS } from "./economy-tools.js";
export type { EconomyTools as HostedDynamicTools } from "./economy-tools.js";
/** Cloud exposes the same tools and completion policy; wallet status and bridging get their hosted descriptions. */
export function hostedDynamicTools(economy: EconomyGateway) {
  const tools = economyTools(economy);
  return { ...tools, definitions: tools.definitions.map(tool => tool.name === "get_wallet_status"
    ? { ...tool, description: "Read this hosted agent's USDC wallet: the total across networks, each network's balance (Base, Solana, Tempo), and authoritative current-run inference spending, service spending, transfer fees, payment holds and authorized budget. A payment on a network needs that network's balance. Read-only." }
    : tool.name === "bridge_usdc" ? HOSTED_BRIDGE_TOOL : tool) };
}

/**
 * The move that would make a purchase payable: as much as the richest other
 * network can spare, aiming at PREFERRED_MOVE_USD so one fee funds many later
 * calls, and never less than the price plus the bridge's cut.
 *
 * Base keeps a working reserve, because inference is paid from it and draining
 * it only buys a move back at another fee — but the reserve is dipped into as
 * far as the purchase needs rather than blocking it. `worthwhile` is false when
 * the fee would be a large share of the move; the agent asks the owner then
 * instead of spending most of the money on the transfer.
 */
export function planFundingMove(
  target: string,
  priceUsd: number,
  available: readonly { network: string; usd: number }[]
): { from: string; amount: number; feeShare: number; worthwhile: boolean } | undefined {
  const cents = (usd: number) => Math.floor(usd * 100) / 100;
  const needed = Math.ceil((priceUsd + MOVE_FEE_ALLOWANCE_USD) * 100) / 100;
  const source = available.filter((n) => n.network !== target).sort((a, b) => b.usd - a.usd)[0];
  if (!source) return undefined;
  const reserve = source.network === "base" ? BASE_WORKING_RESERVE_USD : 0;
  const spare = cents(Math.max(0, source.usd - reserve));
  const ceiling = Math.min(Math.max(needed, spare), cents(source.usd));
  const amount = Math.min(Math.max(PREFERRED_MOVE_USD, needed), ceiling);
  if (amount < needed) return undefined;
  const feeShare = MOVE_FEE_ESTIMATE_USD / amount;
  return { from: source.network, amount, feeShare, worthwhile: feeShare <= MAX_MOVE_FEE_SHARE };
}

/** The hosted counterpart of bridge_usdc: moves between the agent's own networks through the hosted gateway. */
const HOSTED_BRIDGE_TOOL = {
  name: "bridge_usdc",
  description: "Move your own USDC between your networks (base, solana, tempo); it always arrives at your own address. Use it when the owner asks, or when a paid call failed with funding_required and no equivalent service is sold on a network you already fund. quote_only shows the fee and expected amount without moving. Executing re-quotes, applies the owner's approval policy to the fee (it may pause for approval) and waits for the funds to arrive, usually within a minute. Fees are about $0.02-0.03 and count as spending, so aim for about $1 and one fee funds many calls; when the wallet holds less, move what the call needs plus the fee, as long as the fee stays under about a fifth of what moves (roughly $0.15 and up). A move within that rule needs no permission from the owner: the spending guard applies their approval mode to the fee by itself. Below the rule, quote_only first and ask, rather than spending most of the move on its fee. Pass transfer_id alone to check a pending move.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", enum: ["base", "solana", "tempo"] },
      to: { type: "string", enum: ["base", "solana", "tempo"] },
      amount_usd: { type: "number", description: "USDC sent; the fee comes out of it" },
      quote_only: { type: "boolean" },
      transfer_id: { type: "string" }
    },
    additionalProperties: false
  }
};


interface PaymentOffer {
  /** The rail the hosted gateway would most likely settle (Base, then Solana, then Tempo); `unsupported` when none is payable. */
  rail: PaymentRail;
  /** Cheapest payable price; with no payable offer, the cheapest offered price. */
  priceUsd?: number;
  payTo?: string;
  network?: string;
  /** Every offer, x402 and MPP, with its network, price and rail. */
  offers: ServiceOffer[];
  inputSchema?: unknown;
  outputExample?: unknown;
  description?: string;
}

/**
 * Decode a 402 into its payment offers: an x402 v2 `payment-required` header
 * (base64 JSON) or a v1-style JSON body carrying the same `accepts` list,
 * plus MPP challenges from `WWW-Authenticate: Payment` (one per method).
 * Parsed by hand; the runtime takes no x402 or MPP client dependency.
 */
export function parsePaymentRequired(header: string | null, body: string, wwwAuthenticate?: string | null): PaymentOffer | undefined {
  const decoded = header ? parseJson(Buffer.from(header, "base64").toString("utf8")) ?? parseJson(header) : undefined;
  const offer = objectValue(decoded) ?? objectValue(parseJson(body));
  const accepts = Array.isArray(offer?.accepts) ? offer.accepts.map(objectValue).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
  const options = [...accepts.map((accept) => ({ ...accept, protocol: "x402" })), ...mppChallenges(wwwAuthenticate)];
  if (options.length === 0) {
    return undefined;
  }
  const offers = options.map(classifyOffer);
  const chosen = selectOffer(offers, { rails: HOSTED_RAILS });
  const payable = offers.filter((candidate) => candidate.rail !== "unsupported" && HOSTED_RAILS.includes(candidate.rail));
  const prices = (payable.length ? payable : offers).map((candidate) => candidate.price_usd).filter((price): price is number => price !== undefined);
  const resource = objectValue(offer?.resource);
  // The x402 discovery extension carries the input/output schema under `info`.
  const info = Object.values(objectValue(offer?.extensions) ?? {})
    .map((extension) => objectValue(objectValue(extension)?.info))
    .find((candidate) => candidate !== undefined);
  const shown = chosen ?? offers[0];
  return {
    rail: chosen?.rail ?? "unsupported",
    priceUsd: prices.length ? Math.min(...prices) : undefined,
    payTo: shown?.pay_to,
    network: shown?.network,
    offers,
    inputSchema: info?.input,
    outputExample: info?.output,
    description: stringValue(resource?.description) ?? stringValue(offer?.description)
  };
}

/** `Payment method="tempo", intent="charge", request="<base64url JSON>"` challenges as discovery-style MPP options. */
function mppChallenges(header: string | null | undefined): Record<string, unknown>[] {
  if (!header) return [];
  return header.split(/,\s*(?=Payment\s)/i).filter((segment) => /^\s*Payment\s/i.test(segment)).flatMap((segment) => {
    const params: Record<string, string> = {};
    for (const match of segment.replace(/^\s*Payment\s+/i, "").matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) params[match[1]] = match[2] ?? match[3] ?? "";
    const request = objectValue(params.request ? parseJson(Buffer.from(params.request, "base64url").toString("utf8")) : undefined);
    if (!params.method || !request) return [];
    const details = objectValue(request.methodDetails);
    const chainId = typeof details?.chainId === "number" ? details.chainId : 4217;
    return [{ protocol: "mpp", paymentMethod: params.method, intent: params.intent, network: params.method === "tempo" ? `tempo:${chainId}` : params.method,
      asset: request.currency, amount: request.amount, ...(typeof request.decimals === "number" ? { decimals: request.decimals } : {}), payTo: request.recipient }];
  });
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
