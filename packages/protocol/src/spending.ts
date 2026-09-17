/** USDC atomic units; shared by the hosted gateway and local wallet runtime. */
export const DEFAULT_PER_CALL_ATOMIC = "1000000";
export const DEFAULT_PER_QUERY_ATOMIC = "10000000";

export function spendingDecision(input: {
  amount: string; perCall: string; queryLimit: string; queryCommitted: string;
}) {
  const amount = BigInt(input.amount), committed = BigInt(input.queryCommitted);
  if (amount < 0n || committed < 0n || BigInt(input.perCall) < 0n || BigInt(input.queryLimit) < 0n)
    throw new Error("Spending amounts must be non-negative");
  const reasons: ("per_call" | "per_query")[] = [];
  if (amount > BigInt(input.perCall)) reasons.push("per_call");
  if (committed + amount > BigInt(input.queryLimit)) reasons.push("per_query");
  return { approvalRequired: reasons.length > 0, reasons, projected: String(committed + amount) };
}
