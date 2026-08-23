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

export async function walletSummary(): Promise<WalletSummary> {
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
