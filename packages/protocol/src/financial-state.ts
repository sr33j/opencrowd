import { z } from "zod";

// Decimal USDC strings retain sub-cent payments without floating point rounding.
const usdc = z.string().regex(/^\d+\.\d{6}$/);
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
    }),
    current_run: z.object({
      inference_spent_usdc: usdc,
      service_spent_usdc: usdc,
      total_spent_usdc: usdc,
      reserved_usdc: usdc,
      budget_limit_usdc: usdc,
      remaining_budget_usdc: usdc,
      per_call_approval_threshold_usdc: usdc,
      approval_mode: z.enum(["auto", "ask", "off"]),
    }),
  }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type FinancialState = z.infer<typeof FinancialStateSchema>;

export function atomicUsdc(value: string | bigint): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}
