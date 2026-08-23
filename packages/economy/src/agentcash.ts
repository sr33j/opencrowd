import { McpConnection, type McpCallResult } from "./mcp.js";

/**
 * Typed adapter over the AgentCash MCP server. AgentCash owns wallet custody,
 * discovery/inspection primitives, and SIWX/x402/MPP payment execution;
 * OpenCrowd consumes them through this typed surface only.
 */

export type PaymentRail = "x402-base" | "mppx" | "unsupported";

export interface PaidFetchRequest {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Hard ceiling for this one call, in USD. */
  maxAmountUsd: number;
  /** Restrict payment to a CrowdCode-verifiable rail. */
  rail: PaymentRail;
  timeoutMs?: number;
}

/**
 * Reconciled outcome of one fetch. `payment` is receipt evidence obtained by
 * the adapter — it is stored for reviews and never shown to the model.
 */
export interface PaidFetchResult {
  ok: boolean;
  /** Transport failure: the call may or may not have executed on the vendor side. */
  ambiguous: boolean;
  status?: number;
  /** Model-visible response body. */
  data: unknown;
  error?: string;
  authMode?: "free" | "siwx" | "paid";
  payment?: PaymentEvidence;
}

export interface PaymentEvidence {
  paidUsd?: number;
  rail?: PaymentRail;
  /** Settlement reference: x402 tx hash or MPP receipt reference. */
  reference?: string;
  /** Raw base64 receipt header (payment-response / Payment-Receipt). */
  proof?: string;
  /** The real payee from the payment challenge. */
  payTo?: string;
}

export interface WalletStatusResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentCashAdapter {
  /** Public balances, deposit addresses, and funding links. */
  getBalance(): Promise<WalletStatusResult>;
  /** List endpoints at a known origin. */
  discoverEndpoints(origin: string): Promise<McpCallResult>;
  /** Search for a capability across origins. */
  search(query: string, options?: { limit?: number; broad?: boolean }): Promise<McpCallResult>;
  /** Exact input/output schema, auth mode, and price information for one endpoint. */
  checkEndpointSchema(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult>;
  /** Execute one potentially-paid call. Never auto-retried. */
  fetch(request: PaidFetchRequest): Promise<PaidFetchResult>;
  /** Explicit USDC bridge between supported networks. */
  bridge(input: { from: string; to: string; amountUsd: number }): Promise<McpCallResult>;
}

export class McpAgentCashAdapter implements AgentCashAdapter {
  constructor(private readonly connection: McpConnection) {}

  async getBalance(): Promise<WalletStatusResult> {
    const result = await this.connection.call("get_balance", {});
    return { ok: result.ok, data: result.data, error: result.error };
  }

  async discoverEndpoints(origin: string): Promise<McpCallResult> {
    return this.connection.call("discover_api_endpoints", { url: origin });
  }

  async search(query: string, options: { limit?: number; broad?: boolean } = {}): Promise<McpCallResult> {
    return this.connection.call("search", {
      query,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.broad !== undefined ? { broad: options.broad } : {})
    });
  }

  async checkEndpointSchema(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult> {
    return this.connection.call("check_endpoint_schema", {
      url: input.url,
      ...(input.method ? { method: input.method } : {}),
      ...(input.body !== undefined ? { body: input.body } : {})
    });
  }

  async fetch(request: PaidFetchRequest): Promise<PaidFetchResult> {
    const railParams = request.rail === "mppx"
      ? { paymentNetwork: "tempo", paymentProtocol: "mpp" }
      : { paymentNetwork: "base", paymentProtocol: "x402" };
    const result = await this.connection.call("fetch", {
      url: request.url,
      method: request.method,
      ...(request.body !== undefined ? { body: request.body as Record<string, unknown> | string } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
      maxAmount: request.maxAmountUsd,
      ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
      ...railParams
    });
    if (!result.ok) {
      return {
        ok: false,
        ambiguous: result.transportError === true,
        data: undefined,
        error: result.error
      };
    }
    return parsePaidFetchResult(result.data, request.rail);
  }

  async bridge(input: { from: string; to: string; amountUsd: number }): Promise<McpCallResult> {
    return this.connection.call("bridge", { from: input.from, to: input.to, amount: input.amountUsd });
  }
}

/**
 * Reconcile a vendor fetch result into a free/SIWX/paid outcome with receipt
 * evidence. Field names are parsed defensively; the vendor payload shape is
 * not part of OpenCrowd's contract.
 */
export function parsePaidFetchResult(raw: unknown, requestedRail: PaymentRail): PaidFetchResult {
  const record = objectValue(raw) ?? {};
  const status = numberValue(record.status ?? record.statusCode);
  const ok = typeof record.ok === "boolean" ? record.ok : status !== undefined ? status < 400 : true;
  const payment = parsePaymentEvidence(record, requestedRail);
  const headers = objectValue(record.headers ?? record.responseHeaders) ?? {};
  const usedSiwx = Boolean(
    record.siwx ?? record.signInWithX ?? headers["sign-in-with-x"] ?? headers["x-sign-in-with-x"]
    ?? (typeof record.authMode === "string" && record.authMode.toLowerCase().includes("siwx"))
  );
  return {
    ok,
    ambiguous: false,
    status,
    data: record.data ?? record.body ?? record.response ?? raw,
    error: ok ? undefined : stringValue(record.error) ?? (status !== undefined ? `HTTP ${status}` : "request failed"),
    authMode: payment ? "paid" : usedSiwx ? "siwx" : "free",
    payment
  };
}

function parsePaymentEvidence(record: Record<string, unknown>, requestedRail: PaymentRail): PaymentEvidence | undefined {
  const payment = objectValue(record.payment ?? record.paymentDetails ?? record.payment_details);
  const headers = objectValue(record.headers ?? record.responseHeaders) ?? {};
  const proof = stringValue(
    payment?.proof ?? payment?.receipt
    ?? headers["payment-response"] ?? headers["x-payment-response"] ?? headers["payment-receipt"] ?? headers["Payment-Receipt"]
  );
  const reference = stringValue(
    payment?.txHash ?? payment?.tx_hash ?? payment?.transactionHash ?? payment?.reference ?? record.txHash ?? record.tx_hash
  );
  const paidUsd = numberValue(payment?.price ?? payment?.amount ?? payment?.paidUsd ?? payment?.amountUsd ?? record.paid ?? record.price);
  if (!payment && !proof && !reference && paidUsd === undefined) {
    return undefined;
  }
  const network = stringValue(payment?.network ?? record.network)?.toLowerCase();
  const protocol = stringValue(payment?.protocol ?? record.paymentProtocol)?.toLowerCase();
  const rail: PaymentRail = network === "tempo" || protocol === "mpp" || protocol === "mppx"
    ? "mppx"
    : network === "base" || protocol === "x402"
      ? "x402-base"
      : network === undefined && protocol === undefined
        ? requestedRail
        : "unsupported";
  return {
    paidUsd,
    rail,
    reference,
    proof,
    payTo: stringValue(payment?.payTo ?? payment?.pay_to ?? payment?.recipient)
  };
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
