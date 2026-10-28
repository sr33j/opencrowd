import { McpConnection, type McpCallResult } from "./mcp.js";
import { BaseServiceDiscovery, type SearchOptions } from "./discovery.js";
import { readAgentCashWallet, type PaymentNetwork } from "@opencrowd/core";
import { MONAD_NETWORK, MONAD_USDC, MonadX402Payer, monadUsdcBalance } from "./monad.js";
import { networkName, type OfferNetwork } from "./offers.js";

/**
 * Typed adapter over the AgentCash MCP server. AgentCash owns wallet custody,
 * discovery/inspection primitives, and SIWX/x402/MPP payment execution;
 * OpenCrowd consumes them through this typed surface only.
 */

export type PaymentRail = "x402-base" | "x402-solana" | "x402-monad" | "mppx" | "unsupported";

export interface PaidFetchRequest {
  operationId?: string;
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
  /** The payment state cannot be verified, so the call must not be retried. */
  ambiguous: boolean;
  /** Why the payment state is ambiguous. */
  ambiguityReason?: "transport" | "timeout" | "missing_receipt" | "unsupported_receipt";
  status?: number;
  /** Model-visible response body. */
  data: unknown;
  error?: string;
  /**
   * The call was refused on our side and never reached the service: no USDC on
   * a network it accepts, a spending cap, a rail hosted agents cannot pay.
   *
   * Nothing about such a failure is evidence about the provider, and on
   * 2026-10-28 an agent that hit `funding_required` went on to give the
   * provider one star for it. A review of a call the seller never saw is a
   * caller's own problem written into somebody else's reputation.
   */
  callerError?: boolean;
  authMode?: "free" | "siwx" | "paid";
  payment?: PaymentEvidence;
}

export interface PaymentEvidence {
  paidUsd?: number;
  rail?: PaymentRail;
  /** Settlement reference: x402 tx hash (`x402:<network>:<tx>` off Base) or MPP receipt reference. */
  reference?: string;
  /** Raw base64 receipt header (payment-response / Payment-Receipt). */
  proof?: string;
  /** The real payee from the payment challenge. */
  payTo?: string;
  /** The paying address from the settlement receipt (the Solana address for x402-solana). */
  payer?: string;
}

export interface WalletStatusResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentCashAdapter {
  read?(url: string): Promise<McpCallResult>;
  /** Public balances, deposit addresses, and funding links. */
  getBalance(): Promise<WalletStatusResult>;
  /** List endpoints at a known origin. */
  discoverEndpoints(origin: string): Promise<McpCallResult>;
  /** Search for a capability across origins. */
  search(query: string, options?: SearchOptions): Promise<McpCallResult>;
  /** Exact input/output schema, auth mode, and price information for one endpoint. */
  checkEndpointSchema(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult>;
  /** Execute one potentially-paid call. Never auto-retried. */
  fetch(request: PaidFetchRequest): Promise<PaidFetchResult>;
  /** Explicit USDC bridge between supported networks. */
  bridge(input: BridgeRequest): Promise<McpCallResult>;
}

/**
 * A move of the payer's own USDC between its networks. The hosted adapter
 * also quotes (`quoteOnly`), keys the move by the tool call (`operationId`) and
 * reports on a pending move (`transferId`); AgentCash only moves.
 */
export interface BridgeRequest {
  from: string;
  to: string;
  amountUsd: number;
  quoteOnly?: boolean;
  operationId?: string;
  transferId?: string;
}

export interface McpAgentCashAdapterOptions {
  /** Preferred settlement network when a service offers several (default base). */
  paymentNetwork?: PaymentNetwork;
  /** Native signer for Monad x402, which AgentCash cannot settle. */
  monad?: MonadX402Payer;
  /** Test hook: Monad USDC balance lookup. */
  monadBalance?: (address: string) => Promise<number>;
}

/** One AgentCash account: USDC on a network for the address AgentCash pays from there. */
export interface WalletAccount {
  network: string;
  address?: string;
  usdc?: number;
  depositLink?: string;
}

const ACCOUNTS_TTL_MS = 30_000;

export class McpAgentCashAdapter implements AgentCashAdapter {
  private readonly discovery: BaseServiceDiscovery;
  private readonly monad: MonadX402Payer;
  private accountsCache?: { until: number; accounts: Promise<WalletAccount[]> };
  constructor(private readonly connection: McpConnection, private readonly options: McpAgentCashAdapterOptions = {}) {
    this.discovery = new BaseServiceDiscovery((query, options) => this.connection.call("search", { query, ...options }),
      { paymentNetwork: options.paymentNetwork, balances: () => this.networkBalances() });
    this.monad = options.monad ?? new MonadX402Payer();
  }
  read(url: string): Promise<McpCallResult> {
    // AgentCash requires a positive ceiling. Below one atomic USDC unit,
    // no positive Base USDC payment can be authorized.
    return this.connection.call("fetch", { url, method: "GET", maxAmount: 0.000000001, paymentNetwork: "base", paymentProtocol: "x402" });
  }

  async getBalance(): Promise<WalletStatusResult> {
    const [result, monad, accounts] = await Promise.all([this.connection.call("get_balance", {}), this.monadBalance(),
      this.accounts(true).catch(() => undefined)]);
    if (!result.ok) return { ok: false, data: result.data, error: result.error };
    // AgentCash does not know Monad; report its USDC for the same address alongside.
    // Accounts carry each network's address (Solana differs from the EVM one) and USDC.
    const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? { ...(result.data as Record<string, unknown>), ...(accounts ? { accounts } : {}), monad }
      : { agentcash: result.data, ...(accounts ? { accounts } : {}), monad };
    return { ok: true, data };
  }

  /** AgentCash's per-network accounts (`list_accounts`), briefly cached for offer selection. */
  accounts(refresh = false): Promise<WalletAccount[]> {
    if (!refresh && this.accountsCache && this.accountsCache.until > Date.now()) return this.accountsCache.accounts;
    const accounts = this.connection.call("list_accounts", {}).then((result) => {
      if (!result.ok) throw new Error(result.error ?? "list_accounts failed");
      return parseWalletAccounts(result.data);
    });
    this.accountsCache = { until: Date.now() + ACCOUNTS_TTL_MS, accounts };
    accounts.catch(() => { this.accountsCache = undefined; });
    return accounts;
  }

  /** Spendable USDC per network, for choosing among a service's offers. */
  async networkBalances(): Promise<Partial<Record<OfferNetwork, number>>> {
    const balances: Partial<Record<OfferNetwork, number>> = {};
    for (const account of await this.accounts()) {
      const name = networkName(account.network);
      if (name && account.usdc !== undefined) balances[name] = (balances[name] ?? 0) + account.usdc;
    }
    if (this.options.paymentNetwork === "monad") {
      const monad = await this.monadBalance();
      if (typeof monad.usdc === "number") balances.monad = monad.usdc;
    }
    return balances;
  }

  private async monadBalance(): Promise<Record<string, unknown>> {
    const preferred = this.options.paymentNetwork === "monad";
    try {
      const wallet = await readAgentCashWallet();
      if (!wallet) return { network: MONAD_NETWORK, error: "no AgentCash wallet" };
      const usdc = await (this.options.monadBalance ?? monadUsdcBalance)(wallet.address);
      return { network: MONAD_NETWORK, address: wallet.address, asset: MONAD_USDC, usdc, preferred };
    } catch (error) {
      return { network: MONAD_NETWORK, error: (error as Error).message, preferred };
    }
  }

  async discoverEndpoints(origin: string): Promise<McpCallResult> {
    return this.discovery.discoverEndpoints(origin);
  }

  async search(query: string, options: SearchOptions = {}): Promise<McpCallResult> {
    return this.discovery.search(query, options);
  }

  async checkEndpointSchema(input: { url: string; method?: string; body?: unknown }): Promise<McpCallResult> {
    return this.discovery.inspect(input);
  }

  async fetch(request: PaidFetchRequest): Promise<PaidFetchResult> {
    if (request.rail === "x402-monad") return this.monad.fetch(request);
    // Pin AgentCash to the inspected network so it never pays on another chain.
    const railParams = request.rail === "mppx"
      ? { paymentNetwork: "tempo", paymentProtocol: "mpp" }
      : request.rail === "x402-solana"
        ? { paymentNetwork: "solana", paymentProtocol: "x402" }
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
        ...(result.transportError === true ? { ambiguityReason: "transport" as const } : {}),
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
 * not part of OpenCrowd's contract. The vendor may deliver the response body
 * and the payment metadata as separate MCP content blocks (an array here), a
 * single object, or a pre-joined string; all three shapes reconcile the same
 * way, and a settlement that arrives with a 200 response still produces paid
 * evidence.
 */
export function parsePaidFetchResult(raw: unknown, requestedRail: PaymentRail): PaidFetchResult {
  const { body, record } = splitFetchPayload(raw);
  const status = numberValue(record.status ?? record.statusCode);
  const ok = typeof record.ok === "boolean" ? record.ok : status !== undefined ? status < 400 : true;
  const payment = parsePaymentEvidence(record, requestedRail);
  const paymentClaimed = indicatesPayment(record);
  const unsupportedReceipt = payment?.rail === "unsupported";
  const headers = objectValue(record.headers ?? record.responseHeaders) ?? {};
  const usedSiwx = Boolean(
    record.siwx ?? record.signInWithX ?? headers["sign-in-with-x"] ?? headers["x-sign-in-with-x"]
    ?? (typeof record.authMode === "string" && record.authMode.toLowerCase().includes("siwx"))
  );
  return {
    ok,
    // A price/protocol marker says a payment happened, but it is not a
    // settlement receipt. Without a verifiable reference, conservatively
    // record the payment state as unknown and never retry the call.
    ambiguous: (paymentClaimed && !payment) || unsupportedReceipt,
    ...(paymentClaimed && !payment
      ? { ambiguityReason: "missing_receipt" as const }
      : unsupportedReceipt ? { ambiguityReason: "unsupported_receipt" as const } : {}),
    status,
    data: body,
    error: paymentClaimed && !payment
      ? "the service indicated payment but supplied no verifiable settlement receipt"
      : unsupportedReceipt
        ? "the settlement receipt used an unsupported payment rail"
        : ok ? undefined : stringValue(record.error) ?? (status !== undefined ? `HTTP ${status}` : "request failed"),
    authMode: paymentClaimed ? "paid" : usedSiwx ? "siwx" : "free",
    payment
  };
}

/** Payment-like metadata is a claim, not proof; only a reference makes it reviewable. */
function indicatesPayment(record: Record<string, unknown>): boolean {
  const payment = objectValue(record.payment ?? record.paymentDetails ?? record.payment_details);
  const headers = normalizedHeaders(record.headers ?? record.responseHeaders);
  return payment !== undefined
    || stringValue(headers["payment-response"] ?? headers["x-payment-response"] ?? headers["payment-receipt"]) !== undefined
    || stringValue(record.txHash ?? record.tx_hash ?? record.transactionHash ?? record.transaction) !== undefined
    || (typeof record.protocol === "string" && (record.price !== undefined || record.paid !== undefined));
}

/**
 * Separate the model-visible response body from the payment/transport
 * metadata, whichever shape the vendor used.
 */
function splitFetchPayload(raw: unknown): { body: unknown; record: Record<string, unknown> } {
  if (Array.isArray(raw)) {
    const record: Record<string, unknown> = {};
    const bodies: unknown[] = [];
    for (const block of raw) {
      const object = objectValue(block);
      if (object && looksLikePaymentMetadata(object)) {
        Object.assign(record, object);
      } else {
        bodies.push(block);
      }
    }
    return { body: bodies.length === 1 ? bodies[0] : bodies, record };
  }
  if (typeof raw === "string") {
    return splitEmbeddedMetadata(raw) ?? { body: raw, record: {} };
  }
  const record = objectValue(raw) ?? {};
  return { body: record.data ?? record.body ?? record.response ?? raw, record };
}

function looksLikePaymentMetadata(record: Record<string, unknown>): boolean {
  if (objectValue(record.payment ?? record.paymentDetails ?? record.payment_details)) {
    return true;
  }
  const headers = objectValue(record.headers ?? record.responseHeaders);
  if (headers && Object.keys(headers).some((key) => /^(x-)?payment-(response|receipt|required)$/i.test(key))) {
    return true;
  }
  return typeof record.protocol === "string"
    && (record.price !== undefined || typeof record.network === "string");
}

/**
 * A pre-joined payload is "<body>\n<pretty-printed JSON metadata>". Scan
 * newline+brace boundaries from the end and take the first suffix that
 * parses to a payment-metadata object.
 */
function splitEmbeddedMetadata(text: string): { body: unknown; record: Record<string, unknown> } | undefined {
  for (let index = text.lastIndexOf("\n{"); index >= 0; index = text.lastIndexOf("\n{", index - 1)) {
    const candidate = objectValue(parseMaybeJson(text.slice(index + 1)));
    if (candidate && looksLikePaymentMetadata(candidate)) {
      const bodyText = text.slice(0, index).trim();
      return { body: parseMaybeJson(bodyText), record: candidate };
    }
  }
  return undefined;
}

function parsePaymentEvidence(record: Record<string, unknown>, requestedRail: PaymentRail): PaymentEvidence | undefined {
  const payment = objectValue(record.payment ?? record.paymentDetails ?? record.payment_details);
  const headers = normalizedHeaders(record.headers ?? record.responseHeaders);
  const proof = stringValue(
    payment?.proof ?? payment?.receipt
    ?? headers["payment-response"] ?? headers["x-payment-response"] ?? headers["payment-receipt"]
  );
  let reference = stringValue(
    payment?.txHash ?? payment?.tx_hash ?? payment?.transactionHash ?? payment?.transaction_hash
    ?? payment?.transaction ?? payment?.reference
    ?? record.txHash ?? record.tx_hash ?? record.transactionHash ?? record.transaction
  );
  const paidUsd = moneyValue(payment?.price ?? payment?.amount ?? payment?.paidUsd ?? payment?.amountUsd ?? record.paid ?? record.price);
  // The base64 receipt header carries the settlement facts authoritatively;
  // fill anything the surrounding metadata omitted from it.
  const receipt = proof ? objectValue(parseMaybeJson(decodeBase64(proof) ?? "")) : undefined;
  reference ??= stringValue(receipt?.transaction ?? receipt?.transactionHash ?? receipt?.txHash ?? receipt?.reference);
  // Price, protocol, or even a bare `payment: {success: true}` object is not
  // enough for CrowdCode to verify a review. Do not turn it into a confirmed
  // paid outcome unless a settlement reference was actually supplied.
  if (!reference) {
    return undefined;
  }
  const network = stringValue(payment?.network ?? record.network ?? receipt?.network)?.toLowerCase();
  const protocol = stringValue(payment?.protocol ?? record.protocol ?? record.paymentProtocol)?.toLowerCase();
  const named = networkName(network);
  const rail: PaymentRail = named === "tempo" || protocol === "mpp" || protocol === "mppx"
    ? "mppx"
    : named === "solana"
      ? "x402-solana"
      : named === "base" || (network === undefined && protocol === "x402")
        ? (requestedRail === "x402-solana" && named === undefined ? "x402-solana" : "x402-base")
        : network === undefined && protocol === undefined
          ? requestedRail
          : "unsupported";
  // CrowdCode verifies off-Base x402 settlements from a chain-qualified reference.
  if (rail === "x402-solana" && !reference.startsWith("x402:")) reference = `x402:solana:${reference}`;
  return {
    paidUsd,
    rail,
    reference,
    payer: stringValue(payment?.payer ?? receipt?.payer),
    proof,
    payTo: stringValue(
      payment?.payTo ?? payment?.pay_to ?? payment?.recipient
      ?? receipt?.payTo ?? receipt?.pay_to ?? receipt?.recipient ?? receipt?.payee
    )
  };
}

/** AgentCash `list_accounts`: `{ accounts: [{ network, address, balance, depositLink }] }`. */
export function parseWalletAccounts(data: unknown): WalletAccount[] {
  const record = objectValue(data);
  const rows = Array.isArray(data) ? data : Array.isArray(record?.accounts) ? record.accounts : [];
  return rows.map(objectValue).filter((row): row is Record<string, unknown> => row !== undefined && stringValue(row.network) !== undefined)
    .map((row) => {
      const usdc = numberValue(row.balance ?? row.usdc ?? row.balanceUsd);
      return {
        network: stringValue(row.network)!,
        ...(stringValue(row.address) ? { address: stringValue(row.address) } : {}),
        ...(usdc !== undefined ? { usdc } : {}),
        ...(stringValue(row.depositLink) ? { depositLink: stringValue(row.depositLink) } : {})
      };
    });
}

function normalizedHeaders(value: unknown): Record<string, unknown> {
  const headers = objectValue(value) ?? {};
  return Object.fromEntries(Object.entries(headers).map(([key, child]) => [key.toLowerCase(), child]));
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function decodeBase64(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64").toString("utf8");
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

/** Like numberValue, but also accepts money strings such as "$0.01" or "0.01 USD". */
function moneyValue(value: unknown): number | undefined {
  const direct = numberValue(value);
  if (direct !== undefined) {
    return direct;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.replace(/[$,\s]|usd(c?)/gi, "");
  return cleaned === "" ? undefined : numberValue(cleaned);
}
