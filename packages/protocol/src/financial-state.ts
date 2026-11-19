import { z } from "zod";

// Decimal USDC strings retain sub-cent payments without floating point rounding.
const usdc = z.string().regex(/^\d+\.\d{6}$/);
/**
 * USDC on one of the agent's networks (base, solana, tempo). A payment on a
 * network needs that network's available balance; the wallet totals above are
 * for display and "has any funds" checks only.
 */
export const NetworkBalanceSchema = z.object({
  network: z.string().min(1).max(40),
  caip2: z.string().max(100).optional(),
  address: z.string().max(100).nullable().optional(),
  balance_status: z.enum(["available", "unavailable", "no_address"]),
  balance_usdc: usdc.nullable(),
  reserved_usdc: usdc.optional(),
  available_usdc: usdc.nullable().optional(),
});
export type NetworkBalance = z.infer<typeof NetworkBalanceSchema>;
/**
 * How far the wallet goes at the run's model, as control estimates it from
 * this session's own charges and the catalogue (SRI-128). Prices include
 * CrowdCode's markup: they are what the wallet actually loses per call. The
 * runtime renders it as one short line on every turn, so an agent knows what
 * its next call costs and asks for money before a call is refused.
 */
export const RunwaySchema = z.object({
  model: z.string().min(1).max(200),
  /** What the next model call is expected to cost. */
  next_call_usdc: usdc,
  /** What must be free on the paying network for the next call to start (the seller's hold). */
  next_hold_usdc: usdc.optional(),
  /** The recent average cost of one model call in this conversation. */
  per_call_usdc: usdc,
  /** About how many more model calls the wallet covers. */
  calls_left: z.number().int().min(0).max(999),
  /** At or below `ask_at_calls` calls left, money is asked for (see `advice`). */
  ask_at_calls: z.number().int().min(0).max(999).optional(),
  low: z.boolean(),
  /** One sentence on what is being done about it, or what the agent should do. */
  advice: z.string().max(400).optional(),
  /** Share of this run's input tokens the seller served from its prompt cache. */
  cache_hit_rate: z.number().min(0).max(1).optional(),
});
export type Runway = z.infer<typeof RunwaySchema>;

export const FinancialStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    run_id: z.string().uuid(),
    observed_at: z.string().datetime(),
    currency: z.literal("USDC"),
    wallet: z.object({
      balance_status: z.enum(["available", "unavailable"]),
      balance_usdc: usdc.nullable(),
      reserved_usdc: usdc,
      available_usdc: usdc.nullable(),
      networks: z.array(NetworkBalanceSchema).max(16).optional(),
    }),
    current_run: z.object({
      inference_spent_usdc: usdc,
      service_spent_usdc: usdc,
      /** Fees of moves between the agent's own networks started by this run (included in total_spent_usdc). */
      transfer_fees_usdc: usdc.optional(),
      total_spent_usdc: usdc,
      reserved_usdc: usdc,
      budget_limit_usdc: usdc,
      remaining_budget_usdc: usdc,
      per_call_approval_threshold_usdc: usdc,
      approval_mode: z.enum(["auto", "ask", "off"]),
    }),
    runway: RunwaySchema.optional(),
  }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type FinancialState = z.infer<typeof FinancialStateSchema>;

export function atomicUsdc(value: string | bigint): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}

const atomic = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d+$/.test(value) ? atomicUsdc(value)
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? atomicUsdc(BigInt(value)) : undefined;
const decimal = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d+\.\d{6}$/.test(value) ? value : undefined;

/**
 * Per-network balances from a control wallet reply, accepting the snapshot
 * shape above or the raw `{ network, caip2, address, balanceAtomic, status }`
 * rows control reads from each chain. Unparseable rows are dropped; an absent
 * list returns undefined so older control replies keep working.
 */
export function parseNetworkBalances(raw: unknown): NetworkBalance[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows = raw.flatMap((entry): NetworkBalance[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const balance = decimal(row.balance_usdc) ?? atomic(row.balance_atomic ?? row.balanceAtomic);
    const reserved = decimal(row.reserved_usdc) ?? atomic(row.reserved_atomic ?? row.reservedAtomic);
    const available = decimal(row.available_usdc) ?? atomic(row.available_atomic ?? row.availableAtomic);
    const status = row.balance_status ?? row.status;
    const parsed = NetworkBalanceSchema.safeParse({
      network: row.network,
      ...(typeof row.caip2 === "string" ? { caip2: row.caip2 } : {}),
      ...(typeof row.address === "string" || row.address === null ? { address: row.address } : {}),
      balance_status: status === "available" || status === "unavailable" || status === "no_address" ? status : balance ? "available" : "unavailable",
      balance_usdc: balance ?? null,
      ...(reserved ? { reserved_usdc: reserved } : {}),
      ...(available ? { available_usdc: available } : {}),
    });
    return parsed.success ? [parsed.data] : [];
  });
  return rows.length ? rows : undefined;
}
