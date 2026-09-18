import { checkEndpointSchema, discoverOriginSchema } from "@agentcash/discovery";
import type { McpCallResult } from "./mcp.js";

export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BASE_NETWORK = "eip155:8453";
export const isBaseOffer = (offer: any): boolean => offer?.protocol === "x402"
  && [BASE_NETWORK, "base"].includes(offer.network)
  && String(offer.asset).toLowerCase() === BASE_USDC;

/** One discovery implementation for both homes. Search ranking comes from
 * AgentCash; actual endpoint offers determine eligibility, never URL keywords. */
export class BaseServiceDiscovery {
  private cache = new Map<string, { until: number; data: Record<string, any> }>();
  constructor(private readonly searchApi: (query: string, options: { limit?: number; broad?: boolean; page?: number }) => Promise<McpCallResult>) {}

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
    const offer = advisory.paymentOptions?.find(isBaseOffer);
    const read = ["siwx", "unprotected"].includes(advisory.authMode ?? "");
    const data = { endpoint: input.url, method: advisory.method, rail: offer || read ? "x402-base" : "unsupported",
      payable: !!offer, authMode: advisory.authMode,
      price_usd: offer ? Number("amount" in offer ? offer.amount : "maxAmountRequired" in offer ? offer.maxAmountRequired : 0) / 1e6 : read ? 0 : undefined,
      input_schema: advisory.inputSchema, output_schema: advisory.outputSchema, description: advisory.summary,
      note: read ? "Read with read_service; wallet authentication is automatic. Never resubmit a pending generation job." : "Only x402 USDC on Base is enabled. Inspect with sample_body for the exact quote." };
    if (input.body === undefined) this.cache.set(key, { until: Date.now() + 60000, data });
    return { ok: true, data };
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
            price_usd: schema.price_usd, payment_provider: "x402", network: BASE_NETWORK, payable: true } : undefined;
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
      note: "AgentCash discovery, verified x402 USDC on Base. New/unreviewed services are allowed. Inspect the chosen endpoint before paying." } };
  }

  async discoverEndpoints(origin: string): Promise<McpCallResult> {
    const result = await discoverOriginSchema({ target: origin, signal: AbortSignal.timeout(10000) });
    if (!result.found) return { ok: false, error: result.message ?? "Provider discovery failed" };
    const candidates = result.endpoints.filter(e => e.protocols?.includes("x402")).map(e => ({ ...e, origin: result.origin }));
    return { ok: true, data: { services: await this.verified(candidates, 50), guidance: result.guidance,
      reads: result.endpoints.filter(e => ["siwx", "unprotected"].includes(e.authMode ?? "")),
      note: "Use read_service to poll job URLs. Do not buy the same generation twice." } };
  }
}
