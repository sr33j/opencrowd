import { checkEndpointSchema, discoverOriginSchema } from "@agentcash/discovery";
import type { PaymentNetwork } from "@opencrowd/core";
import type { PaymentRail } from "./agentcash.js";
import type { McpCallResult } from "./mcp.js";
import {
  BASE_NETWORK, classifyOffer, describeRails, localRails, NETWORK_CAIP2, networkLabel, payableNetworks, selectOffer,
  type OfferNetwork, type ServiceOffer
} from "./offers.js";

export interface DiscoveryOptions {
  /** Preferred settlement network when a service offers several (default base). */
  paymentNetwork?: PaymentNetwork;
  /** Rails the payer settles (default: the CLI's, see localRails). */
  rails?: readonly PaymentRail[];
  /** The payer picks the network at payment time (the hosted gateway), so the quote is the ceiling across payable offers. */
  negotiated?: boolean;
  /** Spendable USDC per network, read only when the preferred network is not offered. */
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
      price_usd: offer ? ceiling ?? 0 : read ? 0 : undefined,
      ...(offers.length ? { offers: offers.map((candidate) => ({ network: candidate.network_name ?? candidate.network, protocol: candidate.protocol,
        price_usd: candidate.price_usd, payable: payable.includes(candidate) })) } : {}),
      input_schema: advisory.inputSchema, output_schema: advisory.outputSchema, description: advisory.summary,
      note: read ? "Read with read_service; wallet authentication is automatic. Never resubmit a pending generation job." : this.note(offers, offer) };
    if (input.body === undefined) this.cache.set(key, { until: Date.now() + 60000, data });
    return { ok: true, data };
  }

  /** Balances are read only when they can change the choice: the preferred network is absent and several are payable. */
  private async select(offers: ServiceOffer[]): Promise<ServiceOffer | undefined> {
    const selection = { preferred: this.options.paymentNetwork, rails: this.rails };
    const networks = payableNetworks(offers, this.rails);
    const needsBalances = !this.options.negotiated && this.options.balances && networks.length > 1
      && !networks.includes(this.options.paymentNetwork ?? "base");
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
    return `Pays ${networkLabel(offer)}${offer.network_name === preferred ? "" : ` (${preferred} is not offered)`}. ${quote}`;
  }

  private async verified(candidates: any[], limit: number) {
    const services: any[] = [];
    // Small batches bound probes without serializing a whole provider catalog.
    for (let i = 0; i < candidates.length && services.length < limit; i += 4) {
      const batch = await Promise.all(candidates.slice(i, i + 4).map(async c => {
        try {
          const endpoint = c.endpoint ?? new URL(c.path, typeof c.origin === "string" ? c.origin : c.origin?.url).href;
          const inspection = await this.inspect({ url: endpoint, method: c.method });
          const schema = inspection.data as any;
          return inspection.ok && schema?.payable ? { endpoint, method: c.method ?? "POST", name: c.summary ?? c.name,
            price_usd: schema.price_usd, payment_provider: schema.rail === "mppx" ? "mppx" : "x402", network: schema.network ?? BASE_NETWORK, payable: true } : undefined;
        } catch { return undefined; }
      }));
      services.push(...batch.filter(Boolean));
    }
    return services.slice(0, limit);
  }

  async search(query: string, options: { limit?: number; broad?: boolean } = {}): Promise<McpCallResult> {
    const limit = Math.min(20, Math.max(1, options.limit ?? 8));
    const result = await this.searchApi(query, { ...options, limit: Math.min(50, limit * 3) });
    if (!result.ok) return result;
    const raw: any = result.data;
    const body = raw?.results?.results ? raw.results : raw?.data?.results ? raw.data : raw;
    const candidates = Array.isArray(body?.results) ? body.results : Array.isArray(body?.services) ? body.services : [];
    return { ok: true, data: { services: await this.verified(candidates, limit),
      note: `AgentCash discovery, verified ${describeRails(this.rails)}. New/unreviewed services are allowed. Inspect the chosen endpoint before paying.` } };
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
