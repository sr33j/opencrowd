import type { PaymentNetwork } from "@opencrowd/core";
import type { PaymentRail } from "./agentcash.js";
import { MONAD_NETWORK, MONAD_USDC } from "./monad.js";

/**
 * Payment offers advertised by a service (x402 `accepts` entries and MPP
 * `WWW-Authenticate: Payment` challenges), classified into the rails OpenCrowd
 * can settle. Both homes share this classifier: the CLI pays through
 * AgentCash (Base, Solana, Tempo) or natively (Monad); hosted agents hand the
 * call to the hosted gateway, which negotiates Base, Solana or Tempo itself.
 */

export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TEMPO_NETWORK = "eip155:4217";
/** Stargate-bridged USDC.e, the only Tempo token AgentCash and the hosted gateway pay with. */
export const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";

export type OfferNetwork = "base" | "solana" | "tempo" | "monad";

export interface ServiceOffer {
  /** Network as advertised (CAIP-2 or vendor alias). */
  network: string;
  /** Recognised network, when it is one OpenCrowd knows. */
  network_name?: OfferNetwork;
  protocol: "x402" | "mpp";
  /** The rail that would settle this offer; `unsupported` for unknown chains, tokens or schemes. */
  rail: PaymentRail;
  price_usd?: number;
  pay_to?: string;
}

export const RAIL_NETWORK: Record<Exclude<PaymentRail, "unsupported">, OfferNetwork> = {
  "x402-base": "base", "x402-solana": "solana", "x402-monad": "monad", mppx: "tempo"
};
/** Canonical CAIP-2 id per network, as recorded on purchases and receipts. */
export const NETWORK_CAIP2: Record<OfferNetwork, string> = { base: BASE_NETWORK, solana: SOLANA_NETWORK, tempo: TEMPO_NETWORK, monad: MONAD_NETWORK };
const NETWORK_RAIL: Record<OfferNetwork, PaymentRail> = { base: "x402-base", solana: "x402-solana", monad: "x402-monad", tempo: "mppx" };
const NETWORK_LABEL: Record<OfferNetwork, string> = {
  base: "x402 USDC on Base", solana: "x402 USDC on Solana", tempo: "MPP USDC.e on Tempo", monad: "x402 USDC on Monad"
};
/** Fallback order when the preferred network is not offered. */
const FALLBACK_ORDER: OfferNetwork[] = ["base", "solana", "tempo", "monad"];

/** Rails the hosted gateway negotiates and pays itself. */
export const HOSTED_RAILS: readonly PaymentRail[] = ["x402-base", "x402-solana", "mppx"];
/** Rails the CLI pays: AgentCash's Base, Solana and Tempo, plus native Monad only when preferred. */
export function localRails(preferred: PaymentNetwork = "base"): PaymentRail[] {
  return preferred === "monad" ? ["x402-base", "x402-solana", "mppx", "x402-monad"] : ["x402-base", "x402-solana", "mppx"];
}

export function describeRails(rails: readonly PaymentRail[]): string {
  const labels = rails.filter((rail): rail is Exclude<PaymentRail, "unsupported"> => rail !== "unsupported").map((rail) => NETWORK_LABEL[RAIL_NETWORK[rail]]);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : labels[0] ?? "nothing";
}

export function networkLabel(offer: Pick<ServiceOffer, "network" | "network_name" | "protocol" | "rail">): string {
  if (!offer.network_name) return `${offer.protocol} on ${offer.network || "an unknown network"}`;
  return offer.rail === "unsupported" ? `${offer.protocol} on ${offer.network_name} (unsupported token or scheme)` : NETWORK_LABEL[offer.network_name];
}

/** Short network name for a CAIP-2 id or AgentCash alias (`base`, `solana`, `tempo`, `tempo:4217`). */
export function networkName(value: unknown): OfferNetwork | undefined {
  const network = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (network === BASE_NETWORK || network === "base") return "base";
  if (network === SOLANA_NETWORK.toLowerCase() || network === "solana" || network === "solana:mainnet") return "solana";
  if (network === TEMPO_NETWORK || network === "tempo" || network === "tempo:4217" || network === "tempo:mainnet") return "tempo";
  if (network === MONAD_NETWORK || network === "monad") return "monad";
  return undefined;
}

export function railForNetwork(value: unknown): PaymentRail | undefined {
  const name = networkName(value);
  return name ? NETWORK_RAIL[name] : undefined;
}

/** Classify one discovery payment option (x402 v1/v2 or MPP). */
export function classifyOffer(option: Record<string, any>): ServiceOffer {
  const protocol = option?.protocol === "mpp" ? "mpp" : "x402";
  const network = String(option?.network ?? "");
  const name = networkName(network);
  const asset = String(option?.asset ?? "");
  const atomic = Number(option?.amount ?? option?.maxAmountRequired);
  const decimals = typeof option?.decimals === "number" ? option.decimals : 6;
  const price_usd = Number.isFinite(atomic) && atomic >= 0 ? atomic / 10 ** decimals : undefined;
  const scheme = option?.scheme;
  let rail: PaymentRail = "unsupported";
  if (protocol === "x402" && name === "base" && asset.toLowerCase() === BASE_USDC) rail = "x402-base";
  // AgentCash and the hosted gateway register only the SVM `exact` scheme.
  else if (protocol === "x402" && name === "solana" && asset === SOLANA_USDC && (scheme === undefined || scheme === "exact")) rail = "x402-solana";
  else if (protocol === "x402" && name === "monad" && asset.toLowerCase() === MONAD_USDC.toLowerCase() && (scheme === undefined || scheme === "exact")) rail = "x402-monad";
  // A charge settles once with a reference receipt; sessions open payment channels.
  else if (protocol === "mpp" && name === "tempo" && asset.toLowerCase() === TEMPO_USDC
    && (option.paymentMethod === undefined || option.paymentMethod === "tempo") && (option.intent === undefined || option.intent === "charge")) rail = "mppx";
  return { network, ...(name ? { network_name: name } : {}), protocol, rail, ...(price_usd !== undefined ? { price_usd } : {}),
    ...(typeof option?.payTo === "string" ? { pay_to: option.payTo } : {}) };
}

export interface OfferSelection {
  /** Preferred network; its offer wins whenever it is payable and its balance covers it. */
  preferred?: PaymentNetwork;
  /** Rails this payer can settle. */
  rails: readonly PaymentRail[];
  /** Spendable USDC per network. */
  balances?: Partial<Record<OfferNetwork, number>>;
}

/**
 * Choose the offer to pay: the first network, preferred (default Base) then
 * Base, Solana, Tempo, Monad, whose balance covers its price. Without balance
 * information, or with none sufficient, the preferred network when offered,
 * else the first payable network.
 */
export function selectOffer(offers: ServiceOffer[], selection: OfferSelection): ServiceOffer | undefined {
  const preferred = selection.preferred ?? "base";
  const payable = offers.filter((offer) => offer.rail !== "unsupported" && selection.rails.includes(offer.rail));
  const cheapest = (name: OfferNetwork) => payable.filter((offer) => offer.network_name === name)
    .sort((a, b) => (a.price_usd ?? Infinity) - (b.price_usd ?? Infinity))[0];
  const order = [preferred, ...FALLBACK_ORDER.filter((name) => name !== preferred)];
  const candidates = order.map(cheapest).filter((offer): offer is ServiceOffer => offer !== undefined);
  const balances = selection.balances;
  return (balances && candidates.find((offer) => (balances[offer.network_name!] ?? 0) >= (offer.price_usd ?? 0))) || candidates[0];
}

export function payableNetworks(offers: ServiceOffer[], rails: readonly PaymentRail[]): OfferNetwork[] {
  return [...new Set(offers.filter((offer) => offer.rail !== "unsupported" && rails.includes(offer.rail)).map((offer) => offer.network_name!))];
}
