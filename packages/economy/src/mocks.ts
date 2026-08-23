import type { McpCallResult } from "./mcp.js";
import type { AgentCashAdapter, PaidFetchRequest, PaidFetchResult, WalletStatusResult } from "./agentcash.js";
import type { CrowdCodeAdapter, ReviewResult, ReviewSubmission, ServiceEvidence, ServiceQuery } from "./crowdcode.js";

/**
 * In-memory mock adapters for tests and demo mode. No wallet registry, no
 * network, no real money — the gateway lifecycle runs unmodified on top.
 */

export interface MockAgentCashOptions {
  balance?: unknown;
  endpoints?: Record<string, unknown>;
  searchResults?: unknown;
  schemas?: Record<string, unknown>;
  /** Scripted fetch outcomes keyed by URL; a function receives the request. */
  fetchResults?: Record<string, PaidFetchResult | ((request: PaidFetchRequest) => PaidFetchResult)>;
  defaultFetchResult?: PaidFetchResult;
}

export class MockAgentCashAdapter implements AgentCashAdapter {
  readonly fetchCalls: PaidFetchRequest[] = [];

  constructor(private readonly options: MockAgentCashOptions = {}) {}

  async getBalance(): Promise<WalletStatusResult> {
    return {
      ok: true,
      data: this.options.balance ?? {
        total_usd: 25,
        networks: { base: { usdc: 25, address: "0xmock" } },
        mock: true
      }
    };
  }

  async discoverEndpoints(origin: string): Promise<McpCallResult> {
    return { ok: true, data: this.options.endpoints?.[origin] ?? { origin, endpoints: [], mock: true } };
  }

  async search(query: string): Promise<McpCallResult> {
    return { ok: true, data: this.options.searchResults ?? { query, results: [], mock: true } };
  }

  async checkEndpointSchema(input: { url: string }): Promise<McpCallResult> {
    return {
      ok: true,
      data: this.options.schemas?.[input.url] ?? { url: input.url, auth: "paid x402 base", price: 0.05, mock: true }
    };
  }

  async fetch(request: PaidFetchRequest): Promise<PaidFetchResult> {
    this.fetchCalls.push(request);
    const scripted = this.options.fetchResults?.[request.url];
    if (typeof scripted === "function") {
      return scripted(request);
    }
    if (scripted) {
      return scripted;
    }
    return this.options.defaultFetchResult ?? {
      ok: true,
      ambiguous: false,
      status: 200,
      data: { mock: true, url: request.url },
      authMode: "paid",
      payment: {
        paidUsd: Math.min(request.maxAmountUsd, 0.05),
        rail: request.rail,
        reference: `0xmock${this.fetchCalls.length}`,
        proof: "bW9jay1wcm9vZg==",
        payTo: "0xmockpayee"
      }
    };
  }

  async bridge(input: { from: string; to: string; amountUsd: number }): Promise<McpCallResult> {
    return { ok: true, data: { bridged: input.amountUsd, from: input.from, to: input.to, mock: true } };
  }
}

export interface MockCrowdCodeOptions {
  evidence?: ServiceEvidence | ((query: ServiceQuery) => ServiceEvidence);
  outage?: boolean;
  failReviews?: boolean;
}

export class MockCrowdCodeAdapter implements CrowdCodeAdapter {
  readonly scoreQueries: ServiceQuery[] = [];
  readonly reviews: ReviewSubmission[] = [];

  constructor(private readonly options: MockCrowdCodeOptions = {}) {}

  async getServiceScore(query: ServiceQuery): Promise<ServiceEvidence> {
    this.scoreQueries.push(query);
    if (this.options.outage) {
      return { ok: false, error: "mock CrowdCode outage" };
    }
    const evidence = this.options.evidence;
    if (typeof evidence === "function") {
      return evidence(query);
    }
    return evidence ?? { ok: true, score: 4.5, nEff: 12, unproven: false, summary: "mock: reliable service" };
  }

  async reviewService(review: ReviewSubmission): Promise<ReviewResult> {
    if (this.options.failReviews) {
      return { ok: false, error: "mock review submission failure" };
    }
    this.reviews.push(review);
    return { ok: true, raw: { accepted: true } };
  }
}
