import { createPublicClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { requireAgentCashWallet } from "@opencrowd/core";
import {
  normalizeProviderModels, parseChatCompletionResponse, PaymentUncertainError, toWireChatMessage,
  type CompletionRequest, type ProviderCompletion, type ProviderModel, type TypedLlmProvider
} from "./providers.js";

/**
 * Venice through CrowdCode: the `venice-reseller` agent's x402 service.
 *
 * Venice sells inference only as $5 of prepaid credit bound to one wallet.
 * CrowdCode's reseller carries that credit and sells each request: this
 * provider asks it for a quote (an x402 402 for this exact request), signs an
 * `upto` payment for it with the AgentCash wallet, and is settled for the
 * tokens actually used at Venice's price plus 20%, never more than the quote
 * and never less than $0.001. No minimum, nothing prepaid, the same models.
 * `venice-direct` is the old path for anyone who wants their own credit.
 *
 * Two things every `upto` buyer has to get right, learned on mainnet:
 *  - one payment at a time per wallet. Each signs an EIP-2612 permit with the
 *    wallet's USDC nonce, which two payments in flight would both use;
 *  - the nonce is read at a block no older than the wallet's last settlement.
 *    A load-balanced RPC node a block behind reports the nonce the last
 *    settlement just spent, and the payment is refused.
 */
export const CROWDCODE_VENICE_URL = "https://crowdcode.app/s/venice-reseller/chat/completions";
/** The reseller agent's wallet: the only payee this provider pays. */
export const CROWDCODE_VENICE_PAYEE = "0xeEc135BDe3C69e48Ce6Cf5b9e4520d65baf90FC3";
const VENICE_MODELS_URL = "https://api.venice.ai/api/v1/models?type=text";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** The reseller's margin over Venice's list price, shown in the catalogue so budgets are honest. */
export const CROWDCODE_VENICE_MARGIN = 1.2;
const DEFAULT_MAX_TOKENS = 4096;

export interface CrowdCodeVeniceOptions {
  url?: string;
  payee?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Base RPC for the permit reads; a public endpoint by default. */
  rpcUrl?: string;
  /** Test hooks. */
  privateKey?: Hex;
  readContract?: (args: any) => Promise<any>;
  waitForReceipt?: (hash: Hex) => Promise<{ blockNumber: bigint }>;
}

export class CrowdCodeVeniceProvider implements TypedLlmProvider {
  readonly id = "venice" as const;
  readonly quotesPayments = true;
  private modelsCache?: ProviderModel[];
  /** One payment in flight per wallet; see above. */
  private lane: Promise<unknown> = Promise.resolve();
  private lastSettlement?: Hex;
  private client?: { readContract(args: any): Promise<any>; waitForTransactionReceipt(args: { hash: Hex; timeout?: number }): Promise<{ blockNumber: bigint }> };

  constructor(private readonly options: CrowdCodeVeniceOptions = {}) {}

  private get url() { return this.options.url ?? process.env.OPENCROWD_VENICE_URL ?? CROWDCODE_VENICE_URL; }
  private get payee() { return getAddress(this.options.payee ?? process.env.OPENCROWD_VENICE_PAYEE ?? CROWDCODE_VENICE_PAYEE); }
  private get fetcher() { return this.options.fetchImpl ?? fetch; }
  private chain() {
    this.client ??= createPublicClient({ chain: base, transport: http(this.options.rpcUrl ?? process.env.OPENCROWD_BASE_RPC_URL ?? "https://mainnet.base.org") }) as any;
    return this.client!;
  }

  /** Venice's public catalogue, priced as the reseller charges for it. */
  async listModels(options: { refresh?: boolean } = {}): Promise<ProviderModel[]> {
    if (!this.modelsCache || options.refresh) {
      const response = await this.fetcher(VENICE_MODELS_URL, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000) });
      if (!response.ok) throw new Error(`Venice model list failed: HTTP ${response.status}. Run \`opencrowd doctor\`.`);
      this.modelsCache = normalizeProviderModels(await response.json().catch(() => undefined)).map((model) => ({
        ...model,
        ...(model.inputCostCentsPer1k === undefined ? {} : { inputCostCentsPer1k: model.inputCostCentsPer1k * CROWDCODE_VENICE_MARGIN }),
        ...(model.outputCostCentsPer1k === undefined ? {} : { outputCostCentsPer1k: model.outputCostCentsPer1k * CROWDCODE_VENICE_MARGIN }),
      }));
    }
    return this.modelsCache;
  }

  async complete(request: CompletionRequest): Promise<ProviderCompletion> {
    const turn = this.lane.then(() => this.paidCall(request));
    this.lane = turn.catch(() => undefined);
    return turn;
  }

  private async paidCall(request: CompletionRequest, retried = false): Promise<ProviderCompletion> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages.map(toWireChatMessage),
      ...(request.tools.length ? {
        tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
        tool_choice: "auto",
      } : {}),
      // The ceiling the quote assumes and Venice enforces; upto settles what is used.
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    });
    const timeout = this.options.timeoutMs ?? 300_000;
    const send = (signature?: string) => this.fetcher(this.url, {
      method: "POST", body,
      headers: { "content-type": "application/json", ...(signature ? { "payment-signature": signature } : {}) },
      signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    const quoted = await send();
    if (quoted.status !== 402) {
      const text = await quoted.text();
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      // Refusals come before any payment: a context the model cannot hold, an
      // unknown model, a ceiling above the model's own.
      const message = parsed?.message ?? parsed?.detail ?? text.slice(0, 300);
      throw new Error(`Venice (via CrowdCode) refused the request before payment (HTTP ${quoted.status}${parsed?.code ? `, ${parsed.code}` : ""}): ${message}`);
    }
    const required = decodePaymentRequiredHeader(quoted.headers.get("payment-required") ?? "");
    const offer = (required.accepts as any[]).find((a) => a.scheme === "upto" && a.network === "eip155:8453"
      && String(a.asset).toLowerCase() === BASE_USDC && getAddress(a.payTo) === this.payee && /^[1-9][0-9]*$/.test(String(a.amount)));
    if (!offer) throw new Error(`Venice (via CrowdCode) offered no upto payment on Base to ${this.payee}; not paying anyone else`);
    const quotedCents = Number(offer.amount) / 10_000;
    await request.authorizePayment?.(quotedCents, JSON.stringify({ url: this.url, model: request.model, offer }));
    request.signal?.throwIfAborted();
    const wallet = this.options.privateKey ? undefined : await requireAgentCashWallet();
    const account = privateKeyToAccount((this.options.privateKey ?? wallet!.privateKey) as Hex);
    const read = await this.permitReader(account.address);
    const scheme = new UptoEvmScheme({ address: account.address, signTypedData: (data: any) => account.signTypedData(data), readContract: read } as any);
    const payload = await scheme.createPaymentPayload(2, offer, { extensions: required.extensions } as any);
    const signature = encodePaymentSignatureHeader({ ...payload, x402Version: 2, accepted: offer, resource: required.resource } as any);
    let paid: Response;
    try { paid = await send(signature); }
    catch (error) { throw new PaymentUncertainError(`The paid Venice request did not return: ${(error as Error).message}; not retried automatically`); }
    if (paid.status === 402 && !retried) {
      // The payment itself was refused (e.g. a permit read from a lagging
      // node). Nothing was charged; read again a moment later and try once more.
      await paid.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return this.paidCall(request, true);
    }
    const text = await paid.text();
    if (!paid.ok) throw new Error(`Venice (via CrowdCode) answered HTTP ${paid.status}; the payment was cancelled, nothing was charged: ${text.slice(0, 300)}`);
    const settlement = paid.headers.get("payment-response") ? decodePaymentResponseHeader(paid.headers.get("payment-response")!) as { amount?: string; transaction?: Hex } : undefined;
    if (settlement?.transaction) this.lastSettlement = settlement.transaction;
    let completion: ProviderCompletion;
    try { completion = parseChatCompletionResponse(JSON.parse(text)); }
    catch { throw new PaymentUncertainError("The paid Venice answer could not be read"); }
    // What was actually settled, from the settlement itself.
    completion.usage.costCents = settlement?.amount ? Number(settlement.amount) / 10_000 : quotedCents;
    if (request.onTextDelta && completion.content) request.onTextDelta(completion.content);
    return completion;
  }

  /** Reads for this wallet's permit, at a block no older than its last settlement. */
  private async permitReader(owner: string) {
    const client = this.chain();
    const readContract = this.options.readContract ?? ((args: any) => client.readContract(args));
    const settled = this.lastSettlement;
    if (!settled) return readContract;
    const receipt = await (this.options.waitForReceipt ?? ((hash: Hex) => client.waitForTransactionReceipt({ hash, timeout: 30_000 })))(settled).catch(() => undefined);
    if (!receipt) return readContract;
    return async (args: any) => {
      if (String(args?.args?.[0] ?? "").toLowerCase() !== owner.toLowerCase()) return readContract(args);
      for (let attempt = 0; attempt < 8; attempt++) {
        try { return await readContract({ ...args, blockNumber: receipt.blockNumber }); }
        catch { await new Promise((resolve) => setTimeout(resolve, 750)); }
      }
      return readContract(args);
    };
  }
}
