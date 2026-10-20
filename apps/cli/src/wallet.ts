import { readAgentCashSolanaAddress, readAgentCashWallet } from "@opencrowd/core";
import { parseWalletAccounts, sharedEconomyRuntime, type WalletAccount } from "@opencrowd/economy";

/**
 * Public wallet info for display: address from the local AgentCash wallet
 * file, balances from the AgentCash vendor. Never touches secrets.
 */

export interface WalletSummary {
  address?: string;
  totalCents?: number;
  /** USDC on Monad (eip155:143) for the same address; AgentCash's total excludes it. */
  monadCents?: number;
  /** AgentCash's Solana address, which differs from the EVM address. */
  solanaAddress?: string;
  /** USDC on Solana for that address. */
  solanaCents?: number;
  /** Per-network AgentCash accounts (Base, Solana, Tempo) with their addresses. */
  accounts?: WalletAccount[];
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
  const [wallet, solanaFile] = await Promise.all([readAgentCashWallet(), readAgentCashSolanaAddress()]);
  try {
    const runtime = await sharedEconomyRuntime();
    const balance = await runtime.agentcash.getBalance();
    if (balance.ok) {
      const { monad, accounts: rawAccounts, ...agentcash } = (balance.data && typeof balance.data === "object" && !Array.isArray(balance.data)
        ? balance.data : { agentcash: balance.data }) as Record<string, unknown>;
      const monadUsdc = (monad as { usdc?: unknown } | undefined)?.usdc;
      const agentcashTotal = parseUsdCents("agentcash" in agentcash && Object.keys(agentcash).length === 1 ? agentcash.agentcash : agentcash);
      const monadCents = typeof monadUsdc === "number" ? Math.round(monadUsdc * 100) : undefined;
      const accounts = rawAccounts === undefined ? undefined : parseWalletAccounts(rawAccounts);
      const solana = accounts?.find((account) => account.network === "solana");
      return {
        address: wallet?.address,
        totalCents: agentcashTotal === undefined && monadCents === undefined ? undefined : (agentcashTotal ?? 0) + (monadCents ?? 0),
        monadCents,
        solanaAddress: solana?.address ?? solanaFile,
        solanaCents: solana?.usdc === undefined ? undefined : Math.round(solana.usdc * 100),
        accounts,
        raw: balance.data
      };
    }
    return { address: wallet?.address, solanaAddress: solanaFile, error: balance.error };
  } catch (error) {
    return { address: wallet?.address, solanaAddress: solanaFile, error: (error as Error).message };
  }
}

/** One row per network for display: AgentCash's accounts plus native Monad. */
export function walletNetworkRows(summary: WalletSummary): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const account of summary.accounts ?? []) {
    rows[account.network] = `${account.usdc === undefined ? "unknown" : `${account.usdc.toFixed(6)} USDC`}${account.address ? ` · ${account.address}` : ""}`;
  }
  if (summary.monadCents !== undefined) rows.monad = `${(summary.monadCents / 100).toFixed(2)} USDC · ${summary.address ?? "unknown"}`;
  return rows;
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
