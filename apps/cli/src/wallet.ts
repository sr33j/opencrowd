import { readAgentCashWallet } from "@opencrowd/core";
import { sharedEconomyRuntime } from "@opencrowd/economy";

/**
 * Public wallet info for display: address from the local AgentCash wallet
 * file, balances from the AgentCash vendor. Never touches secrets.
 */

export interface WalletSummary {
  address?: string;
  totalCents?: number;
  raw?: unknown;
  error?: string;
}

const BALANCE_TTL_MS = 15_000;
let cachedSummary: { at: number; value: WalletSummary } | undefined;
let inFlight: Promise<WalletSummary> | undefined;

/**
 * Balance calls are deduplicated: concurrent callers share one in-flight
 * vendor request, and results are reused for a short TTL so the status bar,
 * funding wizard, and /status never stack up balance lookups.
 */
export async function walletSummary(options: { refresh?: boolean } = {}): Promise<WalletSummary> {
  if (!options.refresh && cachedSummary && Date.now() - cachedSummary.at < BALANCE_TTL_MS) {
    return cachedSummary.value;
  }
  if (!inFlight) {
    inFlight = fetchWalletSummary().then((value) => {
      cachedSummary = { at: Date.now(), value };
      inFlight = undefined;
      return value;
    }, (error) => {
      inFlight = undefined;
      throw error;
    });
  }
  return inFlight;
}

async function fetchWalletSummary(): Promise<WalletSummary> {
  const wallet = await readAgentCashWallet();
  try {
    const runtime = await sharedEconomyRuntime();
    const balance = await runtime.agentcash.getBalance();
    if (balance.ok) {
      return { address: wallet?.address, totalCents: parseUsdCents(balance.data), raw: balance.data };
    }
    return { address: wallet?.address, error: balance.error };
  } catch (error) {
    return { address: wallet?.address, error: (error as Error).message };
  }
}

/** Best-effort total USD (in cents) from an AgentCash balance payload. */
export function parseUsdCents(data: unknown): number | undefined {
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  if (!record) {
    if (typeof data === "number" && Number.isFinite(data)) {
      return Math.round(data * 100);
    }
    return undefined;
  }
  for (const key of ["total_usd", "totalUsd", "total_usdc", "totalUsdc", "total", "usdc", "balance", "balanceUsd", "balance_usd"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value * 100);
    }
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Math.round(Number(value) * 100);
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const nested = parseUsdCents(value);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}
