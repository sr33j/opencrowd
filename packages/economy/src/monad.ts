import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { requireAgentCashWallet } from "@opencrowd/core";
import type { PaidFetchRequest, PaidFetchResult, PaymentEvidence } from "./agentcash.js";

/**
 * Native x402 v2 `exact` payments on Monad mainnet. AgentCash cannot settle
 * on Monad, so OpenCrowd signs the EIP-3009 transferWithAuthorization itself
 * with the shared AgentCash wallet key (the same pattern as the model proxy)
 * and the service's facilitator settles it and pays gas. The agent only ever
 * holds USDC. This adapter only executes a call the gateway has already
 * inspected, checked, approved and reserved; it never pays more than the
 * request's ceiling.
 */

export const MONAD_NETWORK = "eip155:143";
export const MONAD_CHAIN_ID = 143;
export const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
export const DEFAULT_MONAD_RPC_URL = "https://rpc.monad.xyz";

export const isMonadOffer = (offer: any): boolean => (offer?.protocol === undefined || offer.protocol === "x402")
  && (offer?.scheme === undefined || offer.scheme === "exact")
  && offer?.network === MONAD_NETWORK
  && String(offer.asset).toLowerCase() === MONAD_USDC.toLowerCase();

/** The CrowdCode settlement reference for a Monad x402 payment. */
export function monadPaymentReference(transaction: string): string {
  return `x402:monad:${transaction}`;
}

export function monadRpcUrl(): string {
  return process.env.OPENCROWD_MONAD_RPC_URL ?? DEFAULT_MONAD_RPC_URL;
}

export interface MonadX402PayerOptions {
  fetchImpl?: typeof fetch;
  /** Test hook: sign without the AgentCash wallet file. */
  privateKey?: `0x${string}`;
  /** Test hook: seconds since epoch. */
  now?: () => number;
}

interface MonadOffer {
  scheme: "exact";
  network: typeof MONAD_NETWORK;
  amount: string;
  asset: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" }
] as const;

export class MonadX402Payer {
  constructor(private readonly options: MonadX402PayerOptions = {}) {}

  private async privateKey(): Promise<`0x${string}`> {
    return this.options.privateKey ?? (await requireAgentCashWallet()).privateKey;
  }

  async fetch(request: PaidFetchRequest): Promise<PaidFetchResult> {
    const fetcher = this.options.fetchImpl ?? fetch;
    const timeoutMs = request.timeoutMs ?? 300_000;
    const send = (extraHeaders: Record<string, string> = {}) => fetcher(request.url, {
      method: request.method,
      headers: {
        ...(request.body !== undefined && typeof request.body !== "string" ? { "content-type": "application/json" } : {}),
        ...request.headers,
        ...extraHeaders
      },
      ...(request.body !== undefined && request.method !== "GET" && request.method !== "HEAD"
        ? { body: typeof request.body === "string" ? request.body : JSON.stringify(request.body) }
        : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });

    // Nothing is signed yet, so a failure here cannot have moved funds.
    let challengeResponse: Response;
    try {
      challengeResponse = await send();
    } catch (error) {
      return { ok: false, ambiguous: false, data: undefined, error: `request failed before payment: ${(error as Error).message}` };
    }
    if (challengeResponse.status !== 402) {
      const data = await readBody(challengeResponse);
      return {
        ok: challengeResponse.ok,
        ambiguous: false,
        status: challengeResponse.status,
        data,
        authMode: "free",
        ...(challengeResponse.ok ? {} : { error: `HTTP ${challengeResponse.status}` })
      };
    }

    const challenge = await readChallenge(challengeResponse);
    if (!challenge) {
      return { ok: false, ambiguous: false, status: 402, data: undefined, error: "the service demanded payment without a parseable x402 v2 challenge" };
    }
    const offer = challenge.accepts.find(isMonadOffer) as MonadOffer | undefined;
    if (!offer) {
      return { ok: false, ambiguous: false, status: 402, data: undefined, error: "the service no longer offers x402 USDC on Monad (eip155:143); inspect it again" };
    }
    const quoteError = validateOffer(offer, request.maxAmountUsd);
    if (quoteError) {
      return { ok: false, ambiguous: false, status: 402, data: undefined, error: quoteError };
    }

    const header = await this.paymentHeader(offer, challenge.resource);
    let response: Response;
    try {
      response = await send({ "PAYMENT-SIGNATURE": header });
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      return {
        ok: false,
        ambiguous: true,
        ambiguityReason: timedOut ? "timeout" : "transport",
        data: undefined,
        error: `the signed Monad payment request failed: ${(error as Error).message}`
      };
    }
    const data = await readBody(response);
    const receipt = readReceipt(response);
    const settled = receipt && receipt.success !== false && typeof receipt.transaction === "string"
      && /^0x[0-9a-fA-F]{64}$/.test(receipt.transaction);
    if (response.status === 402 && !settled) {
      // The facilitator refused to settle: the authorization never moved funds.
      return {
        ok: false,
        ambiguous: false,
        status: 402,
        data,
        error: `the service rejected the Monad payment${receipt?.errorReason ? ` (${String(receipt.errorReason)})` : ""}; check the wallet's USDC balance on Monad`
      };
    }
    if (!settled) {
      return {
        ok: false,
        ambiguous: true,
        ambiguityReason: "missing_receipt",
        status: response.status,
        data,
        error: "the service accepted a signed Monad payment but returned no verifiable settlement receipt"
      };
    }
    if (receipt.network !== undefined && receipt.network !== MONAD_NETWORK) {
      return {
        ok: false,
        ambiguous: true,
        ambiguityReason: "unsupported_receipt",
        status: response.status,
        data,
        error: `the settlement receipt names network ${String(receipt.network)}, not ${MONAD_NETWORK}`
      };
    }
    const payment: PaymentEvidence = {
      paidUsd: Number(offer.amount) / 1e6,
      rail: "x402-monad",
      reference: monadPaymentReference(receipt.transaction as string),
      // CrowdCode verifies the decoded receipt JSON against the chain.
      proof: JSON.stringify({ ...receipt, network: MONAD_NETWORK }),
      payTo: offer.payTo
    };
    return {
      ok: response.ok,
      ambiguous: false,
      status: response.status,
      data,
      authMode: "paid",
      payment,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` })
    };
  }

  private async paymentHeader(offer: MonadOffer, resource: unknown): Promise<string> {
    const account = privateKeyToAccount(await this.privateKey());
    const now = Math.floor(this.options.now?.() ?? Date.now() / 1000);
    const authorization = {
      from: account.address,
      to: offer.payTo,
      value: offer.amount,
      validAfter: String(now - 600),
      validBefore: String(now + (offer.maxTimeoutSeconds ?? 300)),
      nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`
    };
    const signature = await account.signTypedData({
      domain: {
        name: offer.extra?.name ?? "USDC",
        version: offer.extra?.version ?? "2",
        chainId: MONAD_CHAIN_ID,
        verifyingContract: offer.asset as `0x${string}`
      },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message: {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore)
      }
    });
    // v2 servers deep-match `accepted` against their own offer, so echo it verbatim.
    return Buffer.from(JSON.stringify({
      x402Version: 2,
      ...(resource !== undefined ? { resource } : {}),
      accepted: offer,
      payload: { signature, authorization }
    })).toString("base64");
  }
}

function validateOffer(offer: MonadOffer, maxAmountUsd: number): string | undefined {
  if (typeof offer.amount !== "string" || !/^[1-9][0-9]*$/.test(offer.amount)) return "unsupported Monad payment quote: invalid amount";
  if (typeof offer.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(offer.payTo)) return "unsupported Monad payment quote: invalid payee";
  // USDC has 6 decimals; the approved ceiling is never exceeded.
  const ceiling = BigInt(Math.floor(maxAmountUsd * 1e6 + 1e-6));
  if (BigInt(offer.amount) > ceiling) {
    return `the Monad quote of $${(Number(offer.amount) / 1e6).toFixed(6)} exceeds the approved ceiling of $${maxAmountUsd.toFixed(6)}; inspect again`;
  }
  return undefined;
}

async function readChallenge(response: Response): Promise<{ accepts: unknown[]; resource?: unknown } | undefined> {
  const header = response.headers.get("payment-required");
  const fromHeader = header ? parseJson(Buffer.from(header, "base64").toString("utf8")) : undefined;
  const challenge = objectValue(fromHeader) ?? objectValue(await response.json().catch(() => undefined));
  if (!challenge || challenge.x402Version !== 2 || !Array.isArray(challenge.accepts)) return undefined;
  return { accepts: challenge.accepts, resource: challenge.resource };
}

function readReceipt(response: Response): Record<string, unknown> | undefined {
  const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  return header ? objectValue(parseJson(Buffer.from(header, "base64").toString("utf8"))) : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text === "") return undefined;
  return (response.headers.get("content-type") ?? "").includes("json") ? parseJson(text) ?? text : text;
}

/** Monad USDC balance (USD) of `address`, read directly from a Monad RPC. */
export async function monadUsdcBalance(address: string, options: { rpcUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<number> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid wallet address");
  const response = await (options.fetchImpl ?? fetch)(options.rpcUrl ?? monadRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      // balanceOf(address)
      params: [{ to: MONAD_USDC, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
  });
  const payload = objectValue(await response.json().catch(() => undefined));
  if (!response.ok || typeof payload?.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(payload.result)) {
    throw new Error(`Monad RPC balance read failed${payload?.error ? `: ${JSON.stringify(payload.error)}` : ` (HTTP ${response.status})`}`);
  }
  return Number(BigInt(payload.result === "0x" ? "0x0" : payload.result)) / 1e6;
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
