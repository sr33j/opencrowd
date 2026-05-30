import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VeniceClient } from "venice-x402-client";
import { SiweMessage } from "siwe";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createPaymentHeader } from "x402/client";
import { createSigner } from "x402/types";
import { reserveBudget, finalizeReservation, releaseReservation } from "./budget.js";
import { loadConfig, updateConfig, type OpenCrowdConfig } from "./config.js";
import { appendLedgerEntry } from "./ledger.js";
import type { SessionState } from "./types.js";

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

export interface VeniceCreditWallet {
  walletAddress(): Promise<string>;
  walletBalance(): Promise<VeniceCreditBalance>;
  topUpVeniceCredit(amountCents: number): Promise<void>;
}

export interface VeniceCreditTopUpResult {
  top_up_required: boolean;
  threshold_cents: number;
  target_cents: number;
  minimum_top_up_cents: number;
  before_balance_cents: number;
  top_up_cents: number;
  after_balance_cents?: number;
}

export interface PaymentAdapter {
  sign(request: PaymentRequest): Promise<SignedPayment>;
}

export class OwsPaymentAdapter implements PaymentAdapter {
  constructor(
    private readonly command: string,
    private readonly account?: string
  ) {}

  async sign(request: PaymentRequest): Promise<SignedPayment> {
    if (!this.account) {
      throw new Error("OWS account is not configured. Run `opencrowd wallet account set <account>` first.");
    }
    const args = [
      "x402",
      "sign",
      "--account",
      this.account,
      "--resource-url",
      request.resourceUrl,
      "--method",
      request.method,
      request.paymentKind === "upto" ? "--upto-cost-cents" : "--cost-cents",
      String(request.quotedCostCents),
      "--body-sha256",
      sha256(JSON.stringify(request.body ?? null))
    ];
    const result = await runJsonCommand(this.command, args);
    const headers = result.headers;
    if (!headers || typeof headers !== "object") {
      throw new Error("OWS did not return payment headers");
    }
    return {
      headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])),
      paymentId: stringValue(result.payment_id ?? result.paymentId ?? result.id),
      txHash: stringValue(result.tx_hash ?? result.txHash)
    };
  }
}

export async function createOwsPaymentAdapter(): Promise<OwsPaymentAdapter> {
  const config = await loadConfig();
  return new OwsPaymentAdapter(config.owsCommand, config.owsAccount);
}

export class AgenticWalletPaidHttpClient implements PaymentWallet {
  readonly kind = "agentic-wallet" as const;

  constructor(private readonly config: OpenCrowdConfig) {}

  async request(request: PaidHttpRequest): Promise<PaidHttpResponse> {
    const args = [
      "x402",
      "pay",
      request.url,
      "--method",
      request.method,
      "--max-amount",
      String(centsToAtomicUsdc(request.maxCostCents)),
      "--json"
    ];
    if (request.body !== undefined) {
      args.push("--data", JSON.stringify(request.body));
    }
    if (request.headers && Object.keys(request.headers).length > 0) {
      args.push("--headers", JSON.stringify(request.headers));
    }
    const raw = await runAgenticWalletJson(this.config, args);
    return normalizePaidHttpResponse(raw);
  }

  async address(): Promise<WalletAddress> {
    const result = await runAgenticWalletJson(this.config, ["address", "--chain", this.config.x402PaymentNetwork, "--json"]);
    const address = stringValue(result.address ?? result.evm ?? result.evmAddress ?? result.account_address ?? result.wallet_address);
    if (!address) {
      throw new Error("Agentic Wallet did not return a wallet address. Run `opencrowd wallet init` and complete sign-in first.");
    }
    return {
      account: "agentic-wallet",
      address,
      network: stringValue(result.network ?? result.chain ?? result.chain_id) ?? this.config.x402PaymentNetwork,
      asset: stringValue(result.asset ?? result.token ?? result.currency) ?? this.config.x402PaymentAsset
    };
  }

  async balance(): Promise<WalletBalance> {
    const result = await runAgenticWalletJson(this.config, [
      "balance",
      "--asset",
      this.config.x402PaymentAsset.toLowerCase(),
      "--chain",
      this.config.x402PaymentNetwork,
      "--json"
    ]);
    const spendable = result.spendable_balance ?? result.available ?? result.balance ?? result.amount;
    if (spendable === undefined || spendable === null) {
      throw new Error("Agentic Wallet did not return a spendable wallet balance. Run `opencrowd wallet init` and complete sign-in first.");
    }
    return {
      account: "agentic-wallet",
      address: stringValue(result.address ?? result.account_address ?? result.wallet_address),
      network: stringValue(result.network ?? result.chain ?? result.chain_id) ?? this.config.x402PaymentNetwork,
      asset: stringValue(result.asset ?? result.token ?? result.currency) ?? this.config.x402PaymentAsset,
      spendable_balance: String(spendable),
      spendable_balance_cents: centsValue(result.spendable_balance_cents ?? result.available_cents ?? result.balance_cents)
    };
  }
}

export async function createAgenticWalletPaidHttpClient(): Promise<AgenticWalletPaidHttpClient> {
  return new AgenticWalletPaidHttpClient(await loadConfig());
}

export class VeniceWalletPaidHttpClient implements PaymentWallet {
  readonly kind = "local-evm" as const;
  private readonly client: VeniceClient;

  constructor(privateKey: string, options: { apiUrl?: string } = {}) {
    this.client = new VeniceClient(privateKey, options);
    this.privateKey = privateKey;
  }

  private readonly privateKey: string;

  async request(request: PaidHttpRequest): Promise<PaidHttpResponse> {
    const startedBalance = await this.balanceUsd().catch(() => undefined);
    const response = await this.rawRequest(request);
    const bodyText = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    const chargedCostCents = chargedFromBalance(startedBalance, response.headers.get("x-balance-remaining") ?? undefined)
      ?? (response.ok ? Math.min(request.maxCostCents, 1) : 0);
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

  async topUpVeniceCredit(amountCents: number): Promise<void> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error("Venice credit top-up amount must be a positive integer number of cents");
    }
    await this.client.topUp(amountCents / 100);
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
      body: hasRequestBody ? requestBody(request.body) : undefined
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

export async function ensureVeniceCreditTopUp(
  session: SessionState,
  wallet: VeniceCreditWallet,
  config: OpenCrowdConfig
): Promise<VeniceCreditTopUpResult | undefined> {
  if (!config.veniceAutoTopUpEnabled) {
    return undefined;
  }
  const thresholdCents = config.veniceAutoTopUpThresholdCents;
  const targetCents = config.veniceAutoTopUpTargetCents;
  const minimumTopUpCents = Math.max(0, config.veniceAutoTopUpMinimumCents);
  if (
    !Number.isInteger(thresholdCents)
    || !Number.isInteger(targetCents)
    || !Number.isInteger(minimumTopUpCents)
    || thresholdCents < 0
    || targetCents <= thresholdCents
  ) {
    throw new Error("Venice auto top-up requires a non-negative threshold and minimum, and a target above the threshold");
  }

  const before = await wallet.walletBalance();
  const beforeBalanceCents = Math.max(0, Math.round(before.balanceUsd * 100));
  if (beforeBalanceCents >= thresholdCents) {
    return {
      top_up_required: false,
      threshold_cents: thresholdCents,
      target_cents: targetCents,
      minimum_top_up_cents: minimumTopUpCents,
      before_balance_cents: beforeBalanceCents,
      top_up_cents: 0,
      after_balance_cents: beforeBalanceCents
    };
  }

  const topUpCents = Math.max(targetCents - beforeBalanceCents, minimumTopUpCents);
  const reservation = await reserveBudget(session, topUpCents);
  const started = Date.now();
  const endpoint = new URL("/api/v1/x402/top-up", config.x402LlmBaseUrl).toString();
  try {
    await wallet.topUpVeniceCredit(topUpCents);
    const after = await wallet.walletBalance().catch(() => undefined);
    const afterBalanceCents = after ? Math.max(0, Math.round(after.balanceUsd * 100)) : undefined;
    await finalizeReservation(session, reservation, topUpCents);
    await appendLedgerEntry(session.ledgerPath, {
      session_id: session.sessionId,
      type: "wallet_top_up",
      endpoint,
      method: "POST",
      quoted_cost_cents: topUpCents,
      charged_cost_cents: topUpCents,
      status: "charged",
      permission_mode: session.permissionMode,
      latency_ms: Date.now() - started,
      notes: `Venice x402 credit auto top-up from ${formatCents(beforeBalanceCents)} to target ${formatCents(targetCents)}`
    });
    return {
      top_up_required: true,
      threshold_cents: thresholdCents,
      target_cents: targetCents,
      minimum_top_up_cents: minimumTopUpCents,
      before_balance_cents: beforeBalanceCents,
      top_up_cents: topUpCents,
      after_balance_cents: afterBalanceCents
    };
  } catch (error) {
    await releaseReservation(session, reservation);
    await appendLedgerEntry(session.ledgerPath, {
      session_id: session.sessionId,
      type: "wallet_top_up",
      endpoint,
      method: "POST",
      quoted_cost_cents: topUpCents,
      charged_cost_cents: 0,
      status: "failed",
      permission_mode: session.permissionMode,
      latency_ms: Date.now() - started,
      notes: (error as Error).message
    });
    throw error;
  }
}

export async function createDefaultPaidHttpClient(): Promise<PaymentWallet> {
  return activePaymentWallet();
}

export async function activePaymentWallet(): Promise<PaymentWallet> {
  const config = await loadConfig();
  if (config.paymentWallet === "local-evm" || config.paymentWallet === "auto") {
    const privateKey = await loadWalletPrivateKey();
    if (privateKey) {
      return new VeniceWalletPaidHttpClient(privateKey);
    }
    if (config.paymentWallet === "local-evm") {
      throw new Error("Local EVM wallet is selected but WALLET_PRIVATE_KEY is not configured.");
    }
  }
  if (config.paymentWallet === "agentic-wallet" || config.paymentWallet === "auto") {
    return new AgenticWalletPaidHttpClient(config);
  }
  const privateKey = await loadWalletPrivateKey();
  if (privateKey) {
    return new VeniceWalletPaidHttpClient(privateKey);
  }
  return new AgenticWalletPaidHttpClient(config);
}

export async function walletInit(): Promise<Record<string, unknown>> {
  let config = await loadConfig();
  const localWallet = await localVeniceWalletSummary();
  if (config.paymentWallet === "auto") {
    config = await updateConfig({ paymentWallet: "agentic-wallet" });
  }
  const status = await runAgenticWalletJson(config, ["status", "--json"]).catch((error) => ({
    error: (error as Error).message,
    auth: { authenticated: false }
  }));
  const authenticated = Boolean((status.auth as { authenticated?: unknown } | undefined)?.authenticated);
  const explicitLocalWallet = config.paymentWallet === "local-evm" && Boolean(localWallet);
  const active = authenticated || explicitLocalWallet
    ? await activeWalletSummary().catch((error) => ({ error: (error as Error).message }))
    : { error: "Authenticate Agentic Wallet to create and reveal a funding address." };
  const address = walletAddressFromSummary(active);
  const network = address?.network ?? config.x402PaymentNetwork;
  const asset = address?.asset ?? config.x402PaymentAsset;
  const fundingInstructions = address?.address
    ? [
      `Send ${asset} on ${network} to ${address.address}.`,
      "Use Base USDC for the default x402 LLM and service payments.",
      "Run `opencrowd wallet balance` after the transfer confirms."
    ]
    : [
      "Run `npx awal auth login <email>` and complete the OTP verification.",
      "Run `opencrowd wallet init` again to show the new funding address.",
      `Fund the displayed address with ${asset} on ${network}.`
    ];
  return {
    ok: true,
    selected_wallet: config.paymentWallet,
    active_wallet: active,
    network,
    asset,
    command: [config.agenticWalletCommand, ...config.agenticWalletArgs].join(" "),
    status,
    local_wallet: localWallet,
    funding_instructions: fundingInstructions,
    local_private_key_warning: localWallet
      ? "A local private-key wallet was detected. It is supported as a legacy fallback; the recommended setup is Agentic Wallet via `opencrowd wallet init`."
      : undefined,
    next_steps: authenticated || explicitLocalWallet
      ? ["Fund the address above, then run `opencrowd wallet balance`."]
      : [
        "Complete Agentic Wallet authentication with `npx awal auth login <email>`.",
        "Verify the OTP with the command printed by Agentic Wallet.",
        "Run `opencrowd wallet init` again to display the funding address."
      ]
  };
}

export async function walletStatus(): Promise<Record<string, unknown>> {
  const config = await loadConfig();
  const status = await runAgenticWalletJson(config, ["status", "--json"]);
  const localWallet = await localVeniceWalletSummary();
  const active = await activeWalletSummary().catch((error) => ({ error: (error as Error).message }));
  return {
    configured: !("error" in active),
    selected_wallet: config.paymentWallet,
    active_wallet: active,
    command: [config.agenticWalletCommand, ...config.agenticWalletArgs].join(" "),
    status,
    local_wallet: localWallet,
    local_private_key_warning: localWallet
      ? "A local private-key wallet was detected. It works, but new users should prefer `opencrowd wallet init` with Agentic Wallet funding."
      : undefined
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
  return (await activePaymentWallet()).address();
}

export async function walletBalance(): Promise<WalletBalance> {
  return (await activePaymentWallet()).balance();
}

export async function setWalletAccount(account: string): Promise<{ account: string }> {
  await updateConfig({ owsAccount: account });
  return { account };
}

export async function setActivePaymentWallet(wallet: "auto" | "local-evm" | "agentic-wallet"): Promise<{ wallet: string }> {
  await updateConfig({ paymentWallet: wallet });
  return { wallet };
}

async function runAgenticWalletJson(config: OpenCrowdConfig, args: string[]): Promise<Record<string, unknown>> {
  try {
    const text = await runTextCommand(config.agenticWalletCommand, [...config.agenticWalletArgs, ...args]);
    return parseJsonObject(text, `${config.agenticWalletCommand} ${[...config.agenticWalletArgs, ...args].join(" ")}`);
  } catch (error) {
    throw normalizeAgenticWalletError(error, config, args);
  }
}

async function runAgenticWalletJsonOrLocal(config: OpenCrowdConfig, args: string[]): Promise<Record<string, unknown>> {
  try {
    return await runAgenticWalletJson(config, args);
  } catch (error) {
    if (!/Authentication required/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    const localWallet = await localVeniceWalletSummary();
    if (!localWallet) {
      throw error;
    }
    return { __localVeniceWallet: true, ...localWallet };
  }
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

function centsToAtomicUsdc(cents: number): number {
  return Math.round((cents / 100) * 1_000_000);
}

function trimDecimal(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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

function normalizePaidHttpResponse(raw: Record<string, unknown>): PaidHttpResponse {
  const status = centsValue(raw.status ?? raw.statusCode ?? raw.response_status) ?? 200;
  const body = parseMaybeJson(raw.body ?? raw.data ?? raw.response ?? raw.result ?? raw);
  const headers = objectRecord(raw.headers ?? raw.responseHeaders);
  const charged = centsValue(raw.charged_cost_cents ?? raw.chargedCostCents ?? raw.cost_cents);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: stringValue(raw.statusText ?? raw.status_text) ?? "",
    headers,
    body,
    chargedCostCents: charged,
    paymentId: stringValue(raw.payment_id ?? raw.paymentId ?? raw.id),
    txHash: stringValue(raw.tx_hash ?? raw.txHash ?? raw.transactionHash)
  };
}

async function genericX402Fetch(privateKey: string, url: string, init: RequestInit): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 402) {
    return first;
  }
  const challenge = await x402ChallengeFromResponse(first);
  const siwxHeader = await signInWithXHeader(privateKey, challenge);
  if (siwxHeader) {
    const headers = new Headers(init.headers);
    headers.set("SIGN-IN-WITH-X", siwxHeader);
    headers.set("X-Sign-In-With-X", siwxHeader);
    const authenticated = await fetch(url, { ...init, headers });
    if (authenticated.status !== 402) {
      return authenticated;
    }
  }
  const paymentChallenge = x402Challenge(challenge);
  if (!paymentChallenge?.accepts.length) {
    return first;
  }
  const selectedRequirement = selectBasePaymentRequirement(paymentChallenge.accepts);
  const originalRequirement = mergeChallengeRequirement(selectedRequirement, paymentChallenge.resource, url);
  const requirement = normalizePaymentRequirement(originalRequirement);
  const signer = await createSigner("base", privateKey);
  const header = compatiblePaymentHeader(await createPaymentHeader(
    signer,
    paymentChallenge.x402Version,
    requirement as never
  ), paymentChallenge.x402Version, originalRequirement, url);
  const headers = new Headers(init.headers);
  headers.set("X-PAYMENT", header);
  headers.set("PAYMENT-SIGNATURE", header);
  headers.set("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  const paid = await fetch(url, { ...init, headers });
  if (paid.status === 402) {
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
  return paid;
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
  if (bodyChallenge) {
    return bodyChallenge;
  }
  const paymentRequired = response.headers.get("payment-required") ?? response.headers.get("x-payment-required");
  if (paymentRequired) {
    return parseBase64Json(paymentRequired) ?? parseMaybeJson(paymentRequired);
  }
  return undefined;
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

function v2PaymentHeader(header: string, x402Version: number, originalRequirement: unknown, resourceUrl: string): string {
  if (!originalRequirement || typeof originalRequirement !== "object" || Array.isArray(originalRequirement)) {
    return header;
  }
  try {
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: unknown };
    return Buffer.from(JSON.stringify({
      x402Version,
      accepted: v2AcceptedRequirement(originalRequirement, resourceUrl),
      payload: payment.payload
    })).toString("base64");
  } catch {
    return header;
  }
}

function v2AcceptedRequirement(originalRequirement: unknown, resourceUrl: string): Record<string, unknown> {
  const record = originalRequirement as Record<string, unknown>;
  return {
    ...record,
    resource: record.resource ?? { url: resourceUrl }
  };
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

async function localVeniceWalletSummary(): Promise<Record<string, unknown> | undefined> {
  const privateKey = await loadWalletPrivateKey();
  if (!privateKey) {
    return undefined;
  }
  const client = new VeniceWalletPaidHttpClient(privateKey);
  const [wallet, x402Credit] = await Promise.all([
    client.balance(),
    client.walletBalance().catch(() => undefined)
  ]);
  return {
    ...(await client.address()),
    ...wallet,
    canConsume: x402Credit?.canConsume,
    suggestedTopUpUsd: x402Credit?.suggestedTopUpUsd
  };
}

async function activeWalletSummary(): Promise<Record<string, unknown>> {
  const wallet = await activePaymentWallet();
  return {
    kind: wallet.kind,
    address: await wallet.address(),
    balance: await wallet.balance()
  };
}

function walletAddressFromSummary(summary: unknown): WalletAddress | undefined {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return undefined;
  }
  const address = (summary as Record<string, unknown>).address;
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    return undefined;
  }
  const record = address as Record<string, unknown>;
  if (typeof record.address !== "string") {
    return undefined;
  }
  return {
    account: stringValue(record.account) ?? "wallet",
    address: record.address,
    network: stringValue(record.network) ?? "base",
    asset: stringValue(record.asset) ?? "USDC"
  };
}

async function loadWalletPrivateKey(): Promise<string | undefined> {
  const direct = process.env.OPENCROWD_WALLET_PRIVATE_KEY ?? process.env.WALLET_PRIVATE_KEY;
  if (isPrivateKey(direct)) {
    return direct;
  }
  for (const path of walletEnvPaths()) {
    const parsed = await readEnvFile(path).catch(() => undefined);
    const value = parsed?.OPENCROWD_WALLET_PRIVATE_KEY ?? parsed?.WALLET_PRIVATE_KEY;
    if (isPrivateKey(value)) {
      return value;
    }
  }
  return undefined;
}

function walletEnvPaths(): string[] {
  if (process.env.OPENCROWD_WALLET_ENV_PATH) {
    return [process.env.OPENCROWD_WALLET_ENV_PATH];
  }
  if (process.env.OPENCROWD_CONFIG_DIR) {
    return [];
  }
  return [join(process.cwd(), ".env"), join(process.cwd(), "scratch", ".env")];
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8");
  const entries = text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return [];
    }
    const index = trimmed.indexOf("=");
    if (index < 1) {
      return [];
    }
    const key = trimmed.slice(0, index);
    const rawValue = trimmed.slice(index + 1).trim();
    return [[key, unquoteEnvValue(rawValue)]];
  });
  return Object.fromEntries(entries);
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isPrivateKey(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function runJsonCommand(command: string, args: string[]): Promise<Record<string, unknown>> {
  const text = await runTextCommand(command, args);
  return parseJsonObject(text, `${command} ${args.join(" ")}`);
}

function parseJsonObject(text: string, commandText: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
      } catch {
        // Fall through to the clear error below.
      }
    }
    throw new Error(`Command returned non-JSON output for ${commandText}`);
  }
}

function runTextCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalEnv()
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(new Error(`Required command could not be started: ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

function normalizeAgenticWalletError(error: unknown, config: OpenCrowdConfig, args: string[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/Authentication required|not authenticated|auth login/i.test(message)) {
    return new Error([
      "Authentication required for Agentic Wallet.",
      "Run `opencrowd wallet init`, then complete the `npx awal auth login <email>` and `npx awal auth verify <flow-id> <code>` steps."
    ].join(" "));
  }
  if (/Command returned non-JSON output/i.test(message)) {
    return new Error(`Agentic Wallet returned an unexpected response for ${[config.agenticWalletCommand, ...config.agenticWalletArgs, ...args].join(" ")}.`);
  }
  return error instanceof Error ? error : new Error(message);
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER
  };
}
