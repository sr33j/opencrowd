import { VeniceClient } from "venice-x402-client";
import { SiweMessage } from "siwe";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createPaymentHeader } from "x402/client";
import { createSigner } from "x402/types";
import { loadConfig } from "./config.js";
import {
  activeStoredWallet,
  listStoredWallets,
  privateKeyForStoredWallet,
  setActiveStoredWallet,
  type StoredWallet,
  type WalletListEntry
} from "./wallets.js";

export interface PaymentRequest {
  resourceUrl: string;
  method: string;
  quotedCostCents: number;
  paymentKind?: "exact" | "upto";
  body?: unknown;
}

export interface SignedPayment {
  headers: Record<string, string>;
  paymentId?: string;
  txHash?: string;
}

export interface PaidHttpRequest {
  url: string;
  method: string;
  maxCostCents: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface PaidHttpResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  chargedCostCents?: number;
  paymentId?: string;
  txHash?: string;
}

export interface PaidHttpClient {
  request(request: PaidHttpRequest): Promise<PaidHttpResponse>;
}

export interface PaymentWallet extends PaidHttpClient {
  kind: "local-evm" | "agentic-wallet";
  address(): Promise<WalletAddress>;
  balance(): Promise<WalletBalance>;
}

export interface VeniceCreditBalance {
  balanceUsd: number;
  canConsume: boolean;
  suggestedTopUpUsd: number;
}

export interface PaymentAdapter {
  sign(request: PaymentRequest): Promise<SignedPayment>;
}

export class VeniceWalletPaidHttpClient implements PaymentWallet {
  readonly kind = "local-evm" as const;
  private readonly client: VeniceClient;
  private readonly timeoutMs: number;

  constructor(privateKey: string, options: { apiUrl?: string; timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.client = new VeniceClient(privateKey, { ...options, timeoutMs: this.timeoutMs });
    this.privateKey = privateKey;
  }

  private readonly privateKey: string;

  async request(request: PaidHttpRequest): Promise<PaidHttpResponse> {
    // Balance prechecks are a Venice-credit mechanism only; generic x402
    // endpoints settle per request and need no extra round trip.
    const isVenice = this.isVeniceApiUrl(request.url);
    const startedBalance = isVenice ? await this.balanceUsd().catch(() => undefined) : undefined;
    const response = await this.rawRequest(request);
    const bodyText = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    const chargedCostCents = chargedFromBalance(startedBalance, response.headers.get("x-balance-remaining") ?? undefined)
      ?? settledCostFromHeaders(response.headers)
      ?? (response.ok && isVenice ? Math.min(request.maxCostCents, 1) : undefined);
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      headers,
      body: parseMaybeJson(bodyText),
      chargedCostCents,
      paymentId: response.headers.get("x402-payment-id") ?? response.headers.get("x-payment-id") ?? undefined,
      txHash: response.headers.get("x402-transaction") ?? response.headers.get("x-transaction-hash") ?? undefined
    };
  }

  async walletAddress(): Promise<string> {
    return this.client.address;
  }

  async walletBalance(): Promise<VeniceCreditBalance> {
    return this.client.getBalance();
  }

  isVeniceApiUrl(url: string): boolean {
    return new URL(url).origin === new URL(this.client.apiUrl).origin;
  }

  private async balanceUsd(): Promise<number> {
    return (await this.client.getBalance()).balanceUsd;
  }

  private async rawRequest(request: PaidHttpRequest): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = new URL(this.client.apiUrl);
    const hasRequestBody = request.body !== undefined && !["GET", "HEAD"].includes(request.method.toUpperCase());
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: hasRequestBody ? requestBody(request.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs)
    };
    if (url.origin === baseUrl.origin) {
      return this.client.requestRaw(`${url.pathname}${url.search}`, init);
    }
    return genericX402Fetch(this.privateKey, request.url, init);
  }

  async address(): Promise<WalletAddress> {
    return {
      account: "local-evm",
      address: this.client.address,
      network: "base",
      asset: "USDC"
    };
  }

  async balance(): Promise<WalletBalance> {
    const [onchainBalance, x402Credit] = await Promise.all([
      baseUsdcBalance(this.client.address),
      this.client.getBalance().catch(() => undefined)
    ]);
    return {
      account: "local-evm",
      address: this.client.address,
      network: "base",
      asset: "USDC",
      spendable_balance: onchainBalance.display,
      spendable_balance_cents: onchainBalance.cents,
      onchain_balance: onchainBalance.display,
      onchain_balance_cents: onchainBalance.cents,
      x402_credit_balance: x402Credit?.balanceUsd.toFixed(2),
      x402_credit_balance_cents: x402Credit ? Math.round(x402Credit.balanceUsd * 100) : undefined
    };
  }
}

export async function createDefaultPaidHttpClient(): Promise<PaymentWallet> {
  return activePaymentWallet();
}

export async function activePaymentWallet(): Promise<PaymentWallet> {
  const wallet = await activeStoredWallet();
  if (wallet.kind === "test") {
    throw new Error("Active wallet is a test wallet. Test wallets can only be used with --test-mode mock LLM and mock x402 services.");
  }
  const config = await loadConfig();
  return new VeniceWalletPaidHttpClient(await privateKeyForStoredWallet(wallet), { timeoutMs: config.x402LlmTimeoutMs });
}

export async function walletInit(): Promise<Record<string, unknown>> {
  const active = await activeWalletSummary().catch((error) => ({ error: (error as Error).message }));
  const wallets = await walletList().catch(() => []);
  return {
    configured: !("error" in active),
    active_wallet: active,
    wallets,
    next_steps: wallets.length === 0
      ? ["Run `opencrowd wallet new` to create a fresh OpenCrowd wallet."]
      : ["Run `opencrowd wallet list` to see wallets and balances."]
  };
}

export async function walletStatus(): Promise<Record<string, unknown>> {
  const active = await activeWalletSummary().catch((error) => ({ error: (error as Error).message }));
  const wallets = await listStoredWallets();
  return {
    configured: !("error" in active),
    active_wallet: active,
    wallet_count: wallets.length
  };
}

export interface WalletAddress {
  account: string;
  address: string;
  network: string;
  asset: string;
}

export interface WalletBalance {
  account: string;
  address?: string;
  network: string;
  asset: string;
  spendable_balance: string;
  spendable_balance_cents?: number;
  onchain_balance?: string;
  onchain_balance_cents?: number;
  x402_credit_balance?: string;
  x402_credit_balance_cents?: number;
}

export async function walletAddress(): Promise<WalletAddress> {
  const wallet = await activeStoredWallet();
  return walletAddressFromStored(wallet);
}

export async function walletBalance(): Promise<WalletBalance> {
  const wallet = await activeStoredWallet();
  return walletBalanceFromStored(wallet);
}

export async function walletList(): Promise<WalletListEntry[]> {
  const rows = await listStoredWallets();
  return Promise.all(rows.map(async (wallet) => ({
    ...wallet,
    ...(await walletBalanceFromStored(wallet).catch((error) => ({
      spendable_balance: `error: ${(error as Error).message}`
    })))
  })));
}

export interface UsdcSendResult {
  tx_hash: string;
  from: string;
  to: string;
  amount_usdc: number;
  network: "base";
}

/**
 * Send USDC from the active wallet by signing a plain ERC-20 transfer with
 * the shared key. Requires a little Base ETH for gas at the wallet address
 * (x402 payments are gasless via EIP-3009, but direct transfers are not).
 */
export async function sendUsdc(to: string, amountUsdc: number): Promise<UsdcSendResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error("recipient must be a 0x-prefixed EVM address");
  }
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error("amount must be greater than zero");
  }
  const wallet = await activeStoredWallet();
  if (wallet.kind === "test") {
    throw new Error("test wallets cannot send real USDC");
  }
  const account = privateKeyToAccount(await privateKeyForStoredWallet(wallet));
  const transport = http(process.env.OPENCROWD_BASE_RPC_URL ?? "https://mainnet.base.org");
  const publicClient = createPublicClient({ chain: base, transport });
  const amountAtomic = parseUnits(amountUsdc.toFixed(6), 6);
  const [ethBalance, usdcBalance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })
  ]);
  if (usdcBalance < amountAtomic) {
    throw new Error(`insufficient USDC: have ${formatUnits(usdcBalance, 6)}, sending ${amountUsdc.toFixed(6)}`);
  }
  if (ethBalance === 0n) {
    throw new Error([
      `the wallet has no Base ETH for gas.`,
      `Deposit ~$0.20 of ETH on Base to ${account.address} once, and sends will work from then on.`,
      "(x402 payments stay gasless and are unaffected.)"
    ].join(" "));
  }
  const walletClient = createWalletClient({ account, chain: base, transport });
  const txHash = await walletClient.writeContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to as `0x${string}`, amountAtomic]
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return { tx_hash: txHash, from: account.address, to, amount_usdc: amountUsdc, network: "base" };
}

export async function setActivePaymentWallet(wallet: string): Promise<{ wallet: string; address: string }> {
  const next = await setActiveStoredWallet(wallet);
  return { wallet: next.label, address: next.address };
}

function walletAddressFromStored(wallet: StoredWallet): WalletAddress {
  return {
    account: wallet.label,
    address: wallet.address,
    network: wallet.network,
    asset: wallet.asset
  };
}

async function walletBalanceFromStored(wallet: StoredWallet): Promise<WalletBalance> {
  if (wallet.kind === "test") {
    const cents = wallet.mock_balance_cents ?? 0;
    return {
      account: wallet.label,
      address: wallet.address,
      network: wallet.network,
      asset: wallet.asset,
      spendable_balance: (cents / 100).toFixed(2),
      spendable_balance_cents: cents
    };
  }
  return new VeniceWalletPaidHttpClient(await privateKeyForStoredWallet(wallet)).balance();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function centsValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.round(Number(value));
  }
  return undefined;
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

function trimDecimal(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function requestBody(body: unknown): RequestInit["body"] {
  if (typeof body === "string") {
    return body;
  }
  return JSON.stringify(body);
}

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function baseUsdcBalance(address: string): Promise<{ display: string; cents: number }> {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.OPENCROWD_BASE_RPC_URL ?? "https://mainnet.base.org")
  });
  const balance = await client.readContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`]
  });
  const display = trimDecimal(formatUnits(balance, 6));
  return {
    display,
    cents: Math.floor(Number(formatUnits(balance, 6)) * 100)
  };
}

const TRANSPORT_RETRY_DELAYS_MS = [500, 1500];

/**
 * Retries network-level failures (connection resets, cold-start drops). Safe
 * even when an X-PAYMENT header is attached: the EIP-3009 authorization nonce
 * is single-use on-chain, so re-sending the same header can never settle twice.
 */
async function fetchWithTransportRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      const name = (error as Error).name;
      if (name === "AbortError" || name === "TimeoutError" || attempt >= TRANSPORT_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAYS_MS[attempt]));
    }
  }
}

const INITIAL_PROBE_TIMEOUT_MS = 30_000;

/**
 * The unpaid first request normally returns its 402 quote in under a second;
 * a hung connection here otherwise waits out undici's 5-minute headers
 * timeout. Nothing has been paid yet, so abort fast and retry uncapped —
 * a genuinely slow free endpoint still succeeds on the uncapped retry.
 */
async function initialProbeFetch(url: string, init: RequestInit): Promise<Response> {
  const probeSignal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(INITIAL_PROBE_TIMEOUT_MS)])
    : AbortSignal.timeout(INITIAL_PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: probeSignal });
  } catch (error) {
    if (init.signal?.aborted) {
      throw error;
    }
    return fetchWithTransportRetry(url, init);
  }
}

async function genericX402Fetch(privateKey: string, url: string, init: RequestInit): Promise<Response> {
  const first = await initialProbeFetch(url, init);
  if (first.status !== 402) {
    return first;
  }
  const challenge = await x402ChallengeFromResponse(first);
  const siwxHeader = await signInWithXHeader(privateKey, challenge);
  if (siwxHeader) {
    const headers = new Headers(init.headers);
    headers.set("SIGN-IN-WITH-X", siwxHeader);
    headers.set("X-Sign-In-With-X", siwxHeader);
    const authenticated = await fetchWithTransportRetry(url, { ...init, headers });
    if (authenticated.status !== 402) {
      return authenticated;
    }
  }
  const paymentChallenge = x402Challenge(challenge);
  if (!paymentChallenge?.accepts.length) {
    return first;
  }
  const selectedRequirement = selectBasePaymentRequirement(paymentChallenge.accepts);
  const mergedRequirement = mergeChallengeRequirement(selectedRequirement, paymentChallenge.resource, url);
  const requirement = normalizePaymentRequirement(mergedRequirement);
  const signer = await createSigner("base", privateKey);
  const rawHeader = await createPaymentHeader(
    signer,
    paymentChallenge.x402Version,
    requirement as never
  );
  // Try the requirement exactly as the service offered it first (standard
  // x402 v2 middleware deep-matches `accepted` against its own offer), then
  // fall back to the resource-merged variant some facilitators expect.
  const headerVariants = [...new Set([
    compatiblePaymentHeader(rawHeader, paymentChallenge.x402Version, selectedRequirement, url),
    compatiblePaymentHeader(rawHeader, paymentChallenge.x402Version, mergedRequirement, url)
  ])];
  let paid: Response | undefined;
  for (const header of headerVariants) {
    const headers = new Headers(init.headers);
    headers.set("X-PAYMENT", header);
    headers.set("PAYMENT-SIGNATURE", header);
    headers.set("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
    paid = await fetchWithTransportRetry(url, { ...init, headers });
    if (paid.status !== 402) {
      return paid;
    }
  }
  if (paid && paid.status === 402) {
    const retryChallenge = await x402ChallengeFromResponse(paid);
    const notes = paymentChallengeSummary(retryChallenge);
    if (notes) {
      const responseHeaders = new Headers(paid.headers);
      responseHeaders.set("x-opencrowd-payment-error", notes);
      return new Response(await paid.arrayBuffer(), {
        status: paid.status,
        statusText: paid.statusText,
        headers: responseHeaders
      });
    }
  }
  return paid ?? first;
}

async function signInWithXHeader(privateKey: string, challenge: unknown): Promise<string | undefined> {
  const extension = signInWithXExtension(challenge);
  const info = unknownRecord(extension?.info);
  const selectedChain = Array.isArray(extension?.supportedChains)
    ? extension.supportedChains.find((chain) => {
      const record = unknownRecord(chain);
      return record.chainId === "eip155:8453" && record.type === "eip191";
    })
    : undefined;
  if (!info.domain || !info.uri || !info.version || !info.nonce || !info.issuedAt || !selectedChain) {
    return undefined;
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const chainId = Number(String(unknownRecord(selectedChain).chainId).replace("eip155:", ""));
  if (!Number.isInteger(chainId)) {
    return undefined;
  }
  const siwe = new SiweMessage({
    domain: String(info.domain),
    address: account.address,
    statement: stringValue(info.statement),
    uri: String(info.uri),
    version: String(info.version),
    chainId,
    nonce: String(info.nonce),
    issuedAt: String(info.issuedAt),
    expirationTime: stringValue(info.expirationTime),
    notBefore: stringValue(info.notBefore),
    requestId: stringValue(info.requestId),
    resources: Array.isArray(info.resources) ? info.resources.map(String) : undefined
  });
  const signature = await account.signMessage({ message: siwe.prepareMessage() });
  return Buffer.from(JSON.stringify({
    ...info,
    address: account.address,
    chainId: "eip155:8453",
    type: "eip191",
    signature
  })).toString("base64");
}

function signInWithXExtension(challenge: unknown): Record<string, unknown> | undefined {
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) {
    return undefined;
  }
  const record = challenge as Record<string, unknown>;
  const candidate = record.x402 && typeof record.x402 === "object" && !Array.isArray(record.x402)
    ? record.x402 as Record<string, unknown>
    : record;
  const extensions = unknownRecord(candidate.extensions ?? record.extensions);
  const extension = extensions["sign-in-with-x"];
  return extension && typeof extension === "object" && !Array.isArray(extension)
    ? extension as Record<string, unknown>
    : undefined;
}

async function x402ChallengeFromResponse(response: Response): Promise<unknown> {
  const bodyChallenge = await response.clone().json().catch(() => undefined);
  if (bodyChallenge && isUsableChallenge(bodyChallenge)) {
    return bodyChallenge;
  }
  const paymentRequired = response.headers.get("payment-required") ?? response.headers.get("x-payment-required");
  if (paymentRequired) {
    const headerChallenge = parseBase64Json(paymentRequired) ?? parseMaybeJson(paymentRequired);
    if (headerChallenge) {
      return headerChallenge;
    }
  }
  return bodyChallenge;
}

function isUsableChallenge(challenge: unknown): boolean {
  return Boolean(x402Challenge(challenge)?.accepts.length) || signInWithXExtension(challenge) !== undefined;
}

function x402Challenge(challenge: unknown): { x402Version: number; accepts: unknown[]; resource?: unknown } | undefined {
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) {
    return undefined;
  }
  const record = challenge as Record<string, unknown>;
  const candidate = Array.isArray(record.accepts)
    ? record
    : record.x402 && typeof record.x402 === "object" && !Array.isArray(record.x402) && Array.isArray((record.x402 as Record<string, unknown>).accepts)
      ? record.x402 as Record<string, unknown>
      : undefined;
  if (!candidate) {
    return undefined;
  }
  return {
    x402Version: numberValue(candidate.x402Version ?? record.x402Version) ?? 1,
    accepts: candidate.accepts as unknown[],
    resource: candidate.resource ?? record.resource
  };
}

function selectBasePaymentRequirement(accepts: unknown[]): unknown {
  return accepts.find((item) => item && typeof item === "object" && (item as { scheme?: unknown }).scheme === "exact" && ["eip155:8453", "base"].includes(String((item as { network?: unknown }).network)))
    ?? accepts.find((item) => item && typeof item === "object" && ["eip155:8453", "base"].includes(String((item as { network?: unknown }).network)))
    ?? accepts[0];
}

function mergeChallengeRequirement(requirement: unknown, challengeResource?: unknown, fallbackUrl?: string): unknown {
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
    return requirement;
  }
  const record = requirement as Record<string, unknown>;
  return {
    ...record,
    resource: record.resource ?? challengeResource ?? (fallbackUrl ? { url: fallbackUrl } : undefined)
  };
}

function normalizePaymentRequirement(requirement: unknown): unknown {
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
    return requirement;
  }
  const record = requirement as Record<string, unknown>;
  const resource = resourceUrl(record.resource);
  const amount = stringValue(record.maxAmountRequired ?? record.amount);
  return {
    ...record,
    network: normalizeX402Network(record.network),
    maxAmountRequired: amount,
    resource,
    description: stringValue(record.description) ?? "x402 paid resource",
    mimeType: stringValue(record.mimeType) ?? "application/json"
  };
}

function resourceUrl(resource: unknown): string | undefined {
  if (resource && typeof resource === "object" && !Array.isArray(resource)) {
    return stringValue((resource as Record<string, unknown>).url);
  }
  return stringValue(resource);
}

function normalizeX402Network(network: unknown): unknown {
  switch (network) {
    case "eip155:8453":
      return "base";
    case "eip155:84532":
      return "base-sepolia";
    default:
      return network;
  }
}

export function compatiblePaymentHeader(header: string, x402Version: number, originalRequirement: unknown, resourceUrl: string): string {
  if (x402Version >= 2) {
    return v2PaymentHeader(header, x402Version, originalRequirement, resourceUrl);
  }
  return preserveChallengeNetwork(header, originalRequirement);
}

function v2PaymentHeader(header: string, x402Version: number, originalRequirement: unknown, _resourceUrl: string): string {
  if (!originalRequirement || typeof originalRequirement !== "object" || Array.isArray(originalRequirement)) {
    return header;
  }
  try {
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: unknown };
    // `accepted` must round-trip the requirement exactly as the service
    // offered it: standard x402 v2 middleware deep-matches it against its
    // own offers and rejects envelopes with extra fields.
    return Buffer.from(JSON.stringify({
      x402Version,
      accepted: originalRequirement,
      payload: payment.payload
    })).toString("base64");
  } catch {
    return header;
  }
}

function preserveChallengeNetwork(header: string, originalRequirement: unknown): string {
  if (!originalRequirement || typeof originalRequirement !== "object" || Array.isArray(originalRequirement)) {
    return header;
  }
  const originalNetwork = stringValue((originalRequirement as Record<string, unknown>).network);
  if (!originalNetwork || !originalNetwork.startsWith("eip155:")) {
    return header;
  }
  try {
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    payment.network = originalNetwork;
    return Buffer.from(JSON.stringify(payment)).toString("base64");
  } catch {
    return header;
  }
}

function parseBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function paymentChallengeSummary(challenge: unknown): string | undefined {
  const parsed = x402Challenge(challenge);
  if (!parsed) {
    return "x402 retry returned HTTP 402 without a parseable challenge";
  }
  return `x402 retry returned HTTP 402; challenge version ${parsed.x402Version}; accepts ${parsed.accepts.length}`;
}

async function activeWalletSummary(): Promise<Record<string, unknown>> {
  const wallet = await activePaymentWallet();
  return {
    kind: wallet.kind,
    address: await wallet.address(),
    balance: await wallet.balance()
  };
}

/**
 * Actual settled cost reported by generic x402 services that reconcile a
 * ceiling to real usage (e.g. an `upto` payment). Fractional cents are kept
 * so micro-priced calls aren't rounded up per call.
 */
function settledCostFromHeaders(headers: Headers): number | undefined {
  for (const name of ["x-billed-usd", "x-charged-usd", "x-settled-usd"]) {
    const value = headers.get(name);
    if (value !== null && Number.isFinite(Number(value))) {
      return Number(value) * 100;
    }
  }
  const paymentResponse = headers.get("x-payment-response");
  if (paymentResponse) {
    const parsed = parseBase64Json(paymentResponse);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const usd = numberValue(record.billedUsd ?? record.amountUsd ?? record.settledUsd);
      if (usd !== undefined) {
        return usd * 100;
      }
    }
  }
  return undefined;
}

function chargedFromBalance(startedBalance: number | undefined, remainingBalance: string | undefined): number | undefined {
  if (startedBalance === undefined || remainingBalance === undefined || !Number.isFinite(Number(remainingBalance))) {
    return undefined;
  }
  const deltaUsd = startedBalance - Number(remainingBalance);
  if (deltaUsd <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(deltaUsd * 100));
}

function objectRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}

function unknownRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

