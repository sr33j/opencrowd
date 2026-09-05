import { z } from "zod";

/** Opaque identifier (command, run, session, operation, checkpoint, ...). */
export const IdSchema = z.string().min(1).max(256);
export type Id = z.infer<typeof IdSchema>;

/**
 * Per-stream sequence number. Each side of the process boundary owns its own
 * stream (commands from the supervisor, events from the worker); within one
 * stream `seq` must be strictly increasing. See `createSeqTracker`.
 */
export const SeqSchema = z.int().nonnegative();
export type Seq = z.infer<typeof SeqSchema>;

/** RFC 3339 / ISO 8601 date-time with `Z` or a numeric offset. */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * Monetary amount in USDC atomic units (6 decimals: 1 USDC = "1000000"),
 * carried as a base-10 integer string so it is bigint-safe and never a float.
 */
export const UsdcAmountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "USDC amount must be a base-10 integer string of atomic units, never a float");
export type UsdcAmount = z.infer<typeof UsdcAmountSchema>;

export function usdcAmountToBigInt(amount: UsdcAmount): bigint {
  return BigInt(UsdcAmountSchema.parse(amount));
}

export function bigIntToUsdcAmount(value: bigint): UsdcAmount {
  if (value < 0n) {
    throw new RangeError(`USDC amount must not be negative: ${value}`);
  }
  return value.toString(10);
}

/** Any JSON value; used for tool inputs/outputs and diagnostic details. */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

/** Mirrors `ApprovalMode` in `@opencrowd/core` without depending on it. */
export const ApprovalModeSchema = z.enum(["ask", "auto", "off"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** Provider/model preferences. Absent or "auto" lets the runtime choose. */
export const ModelPolicySchema = z.looseObject({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  submodel: z.string().min(1).optional()
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

export const BudgetSchema = z.looseObject({
  /** Total spend allowed for the run's session. */
  limit: UsdcAmountSchema,
  /** Optional cap on any single paid request. */
  perPurchaseLimit: UsdcAmountSchema.optional()
});
export type Budget = z.infer<typeof BudgetSchema>;
