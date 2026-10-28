import { checkEndpointSchema, discoverOriginSchema } from "@agentcash/discovery";
import type { PaymentNetwork } from "@opencrowd/core";
import type { PaymentRail } from "./agentcash.js";
import type { ServiceSearch } from "./crowdcode.js";
import type { McpCallResult } from "./mcp.js";
import {
  BASE_NETWORK, classifyOffer, describeRails, localRails, NETWORK_CAIP2, networkLabel, payableNetworks, RAIL_NETWORK, selectOffer,
  type OfferNetwork, type ServiceOffer
} from "./offers.js";

/** CrowdCode's cross-chain ranking of a search (`find_service`), supplied by the gateway when CrowdCode is on. */
export type ServiceRanker = (search: ServiceSearch) => Promise<McpCallResult>;

export interface SearchOptions {
  limit?: number;
  broad?: boolean;
  /** Rank across chains with CrowdCode; without it AgentCash's order stands. */
  rank?: ServiceRanker;
}

export const RANKED_NOTE = "Ranked by CrowdCode across Base, Solana and Tempo (AgentCash, Coinbase's x402 catalog, MPP catalog and CrowdCode reviews): quality first, then effective price on best_network (including about $0.03 to move USDC between your own networks when that network's balance is short), then your balance there. Prefer the highest-ranked service that fits the task, whatever its network. Each result's `networks` are the networks it can be paid on; between results that fit the task equally well, one you can pay from a balance you already hold beats one that needs a transfer first. transfer_needed means your balance on best_network is short: move USDC between your own networks first if you have a tool for that; otherwise say which network needs funds. New/unreviewed services are allowed. Inspect the chosen endpoint before paying.";

export interface DiscoveryOptions {
  /** Preferred settlement network when a service offers several (default base). */
  paymentNetwork?: PaymentNetwork;
  /** Rails the payer settles (default: the CLI's, see localRails). */
  rails?: readonly PaymentRail[];
  /** The payer picks the network at payment time (the hosted gateway), so the quote is the ceiling across payable offers. */
  negotiated?: boolean;
  /** Spendable USDC per network: chooses among a service's offers and informs search ranking. */
  balances?: () => Promise<Partial<Record<OfferNetwork, number>>>;
}

/** One discovery implementation for both homes. Search ranking comes from
 * AgentCash; actual endpoint offers determine eligibility, never URL keywords. */
export class BaseServiceDiscovery {
  private cache = new Map<string, { until: number; data: Record<string, any> }>();
  private readonly rails: readonly PaymentRail[];
  constructor(
    private readonly searchApi: (query: string, options: { limit?: number; broad?: boolean; page?: number }) => Promise<McpCallResult>,
    private readonly options: DiscoveryOptions = {}
  ) {
    this.rails = options.rails ?? localRails(options.paymentNetwork);
  }

  async inspect(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult> {
    const key = `${input.method ?? "POST"} ${input.url}`;
    const cached = this.cache.get(key);
    if (input.body === undefined && cached && cached.until > Date.now()) return { ok: true, data: cached.data };
    const result = await checkEndpointSchema({ url: input.url, probe: true,
      sampleInputBody: input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : undefined,
      signal: AbortSignal.timeout(10000) });
    if (!result.found) return { ok: false, error: result.message ?? "Endpoint inspection failed" };
    const advisory = result.advisories.find(a => a.method === (input.method ?? "POST").toUpperCase());
    if (!advisory) return { ok: false, error: "The endpoint does not advertise this method" };
    // x402 `accepts` and MPP `WWW-Authenticate: Payment` challenges arrive as one list.
    const offers = (advisory.paymentOptions ?? []).map((option) => classifyOffer(option as Record<string, any>));
    const offer = await this.select(offers);
    const payable = offers.filter((candidate) => candidate.rail !== "unsupported" && this.rails.includes(candidate.rail));
    const ceiling = this.options.negotiated && offer ? Math.max(...payable.map((candidate) => candidate.price_usd ?? 0)) : offer?.price_usd;
    const read = ["siwx", "unprotected"].includes(advisory.authMode ?? "");
    const data = { endpoint: input.url, method: advisory.method, rail: offer ? offer.rail : read ? "x402-base" : "unsupported",
      payable: !!offer, authMode: advisory.authMode, network: offer?.network_name ? NETWORK_CAIP2[offer.network_name] : undefined,
      // The payee of the selected offer: receipts on some rails (x402 Solana) omit it, and reviews need it.
      ...(offer?.pay_to ? { pay_to: offer.pay_to } : {}),
      price_usd: offer ? ceiling ?? 0 : read ? 0 : undefined,
      ...(offers.length ? { offers: offers.map((candidate) => ({ network: candidate.network_name ?? candidate.network, protocol: candidate.protocol,
        price_usd: candidate.price_usd, payable: payable.includes(candidate) })) } : {}),
      input_schema: advisory.inputSchema, output_schema: advisory.outputSchema, description: advisory.summary,
      note: read ? "Read with read_service; wallet authentication is automatic. Never resubmit a pending generation job." : this.note(offers, offer) };
    if (input.body === undefined) this.cache.set(key, { until: Date.now() + 60000, data });
    return { ok: true, data };
  }

  /** Balances are read only when they can change the choice: several networks are payable. */
  private async select(offers: ServiceOffer[]): Promise<ServiceOffer | undefined> {
    const selection = { preferred: this.options.paymentNetwork, rails: this.rails };
    const networks = payableNetworks(offers, this.rails);
    const needsBalances = !this.options.negotiated && this.options.balances && networks.length > 1;
    const balances = needsBalances ? await this.options.balances!().catch(() => undefined) : undefined;
    return selectOffer(offers, { ...selection, balances });
  }

  private note(offers: ServiceOffer[], offer: ServiceOffer | undefined): string {
    const quote = "Inspect with sample_body for the exact quote.";
    if (!offer) {
      const offered = [...new Set(offers.map(networkLabel))];
      return `${offered.length ? `This service offers ${offered.join(", ")}` : "This service advertises no recognised payment option"}; payable here: ${describeRails(this.rails)}. ${quote}`;
    }
    if (this.options.negotiated) {
      const networks = payableNetworks(offers, this.rails).map((name) => networkLabel({ ...offer, network_name: name, rail: "x402-base" }));
      return `The hosted gateway pays the cheapest of ${networks.join(", ")} that your balance on that network covers; price_usd is the ceiling across them. ${quote}`;
    }
    const preferred = this.options.paymentNetwork ?? "base";
    const reason = payableNetworks(offers, this.rails).includes(preferred) ? `your ${preferred} balance does not cover it` : `${preferred} is not offered`;
    return `Pays ${networkLabel(offer)}${offer.network_name === preferred ? "" : ` (${reason})`}. ${quote}`;
  }

  /** Probe candidates in order and keep the first `limit` this payer can settle. */
  private async verified(candidates: any[], limit: number) {
    const services: any[] = [];
    // Small batches bound probes without serializing a whole provider catalog.
    for (let i = 0; i < candidates.length && services.length < limit; i += 4) {
      const batch = await Promise.all(candidates.slice(i, i + 4).map(async c => {
        try {
          const endpoint = c.endpoint ?? new URL(c.path, typeof c.origin === "string" ? c.origin : c.origin?.url).href;
          // Catalogs do not always name the method: try POST, then GET.
          let method = c.method ?? "POST";
          let inspection = await this.inspect({ url: endpoint, method });
          if (!inspection.ok && !c.method) inspection = await this.inspect({ url: endpoint, method: method = "GET" });
          const schema = inspection.data as any;
          if (!inspection.ok || !schema?.payable) return undefined;
          // Every network this service can be paid on, so a caller short on
          // one can prefer an equal service it already funds over a transfer.
          const networks = Array.isArray(schema.offers)
            ? [...new Set(schema.offers.filter((offer: any) => offer.payable).map((offer: any) => String(offer.network)))]
            : [];
          const service: Record<string, unknown> = { endpoint, method, name: c.summary ?? c.name,
            price_usd: schema.price_usd, payment_provider: schema.rail === "mppx" ? "mppx" : "x402", network: schema.network ?? BASE_NETWORK,
            ...(networks.length ? { networks } : {}), payable: true };
          return c.ranking ? { ...service, ...ranked(c.ranking, schema) } : service;
        } catch { return undefined; }
      }));
      services.push(...batch.filter(Boolean));
    }
    return services.slice(0, limit);
  }

  /** The networks this payer settles, as CrowdCode names them. */
  private networks(): string[] {
    return [...new Set(this.rails.filter((rail) => rail !== "unsupported").map((rail) => RAIL_NETWORK[rail as Exclude<PaymentRail, "unsupported">]))];
  }

  /**
   * AgentCash search, ranked across chains by CrowdCode when a ranker is
   * supplied: CrowdCode adds Coinbase's x402 catalog, the MPP catalog and its
   * reviewed services, then orders everything by quality, effective price and
   * balance. Without a ranker, or if ranking fails, AgentCash's order stands.
   */
  async search(query: string, options: SearchOptions = {}): Promise<McpCallResult> {
    const limit = Math.min(20, Math.max(1, options.limit ?? 8));
    const { rank, ...searchOptions } = options;
    const [result, balances] = await Promise.all([
      this.searchApi(query, { ...searchOptions, limit: Math.min(50, limit * 3) })
        .catch((error: Error): McpCallResult => ({ ok: false, error: error.message })),
      rank && this.options.balances ? this.options.balances().catch(() => undefined) : Promise.resolve(undefined)
    ]);
    const candidates = result.ok ? searchResults(result.data) : [];
    if (rank) {
      const ranking = await rank({ query, networks: this.networks(), ...(balances ? { balances } : {}),
        candidates: candidates.map(agentCashCandidate).filter((candidate): candidate is Record<string, unknown> => candidate !== undefined),
        limit: Math.min(25, limit * 2) }).catch((error: Error): McpCallResult => ({ ok: false, error: error.message }));
      const services = (ranking.data as { services?: unknown } | undefined)?.services;
      if (ranking.ok && Array.isArray(services)) {
        const ordered = services.filter((service: any) => typeof service?.endpoint === "string")
          .map((service: any) => ({ endpoint: service.endpoint, method: service.method ?? undefined, name: service.name, ranking: service }));
        return { ok: true, data: { services: await this.verified(ordered, limit), note: RANKED_NOTE } };
      }
    }
    if (!result.ok) return result;
    return { ok: true, data: { services: await this.verified(candidates, limit),
      note: `AgentCash discovery${rank ? " (CrowdCode ranking unavailable)" : ""}, verified ${describeRails(this.rails)}. New/unreviewed services are allowed. Inspect the chosen endpoint before paying.` } };
  }

  async discoverEndpoints(origin: string): Promise<McpCallResult> {
    const result = await discoverOriginSchema({ target: origin, signal: AbortSignal.timeout(10000) });
    if (!result.found) return { ok: false, error: result.message ?? "Provider discovery failed" };
    const candidates = result.endpoints.filter(e => e.protocols?.some(protocol => protocol === "x402" || protocol === "mpp")).map(e => ({ ...e, origin: result.origin }));
    return { ok: true, data: { services: await this.verified(candidates, 50), guidance: result.guidance,
      reads: result.endpoints.filter(e => ["siwx", "unprotected"].includes(e.authMode ?? "")),
      note: "Use read_service to poll job URLs. Do not buy the same generation twice." } };
  }
}

function searchResults(raw: any): any[] {
  const body = raw?.results?.results ? raw.results : raw?.data?.results ? raw.data : raw;
  return Array.isArray(body?.results) ? body.results : Array.isArray(body?.services) ? body.services : [];
}

/** An AgentCash search result as a CrowdCode ranking candidate. */
function agentCashCandidate(result: any): Record<string, unknown> | undefined {
  try {
    const endpoint = result.endpoint ?? new URL(result.path, typeof result.origin === "string" ? result.origin : result.origin?.url).href;
    const usage = result.signals?.originUsage?.uniqueUserCount;
    return { endpoint, method: result.method, name: result.summary ?? result.name, source: "agentcash",
      ...(result.price !== undefined ? { price_usd: Number.parseFloat(String(result.price)) || undefined } : {}),
      ...(Array.isArray(result.origin?.protocols) ? { protocols: result.origin.protocols } : {}),
      ...(typeof usage === "number" ? { unique_payers: usage } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * CrowdCode's ranking fields for a verified service. `network` stays what this
 * payer would pay on; `best_network` is CrowdCode's choice when the endpoint offers it.
 */
function ranked(ranking: any, schema: any): Record<string, unknown> {
  const best = ranking.best ?? {};
  const offered = Array.isArray(schema.offers) && schema.offers.some((offer: any) => offer.payable && offer.network === best.network);
  const quality = ranking.quality ?? {};
  return {
    rank: ranking.rank,
    ...(offered ? { best_network: best.network } : {}),
    ...(typeof best.effective_price_usd === "number" ? { effective_price_usd: best.effective_price_usd } : {}),
    ...(best.transfer_needed ? { transfer_needed: true } : {}),
    quality: { score: quality.score, n_eff: quality.n_eff, reviews: quality.num_reviews, verified_reviews: quality.num_verified_reviews,
      ...(quality.unique_payers_30d != null ? { payers_30d: quality.unique_payers_30d } : {}),
      ...(quality.below_floor ? { below_floor: true } : {}) },
    sources: ranking.sources
  };
}
