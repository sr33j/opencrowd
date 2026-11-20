import { listPurchases } from "@opencrowd/economy";
import type { SessionState } from "@opencrowd/core";

/**
 * Paid calls in this run whose payment state is still unknown, said in the
 * final answer by the harness rather than left to the model (SRI-96).
 *
 * On 2026-11-06 an agent bought one $1.00 article "within the $1.00 limit",
 * and its answer said so, while $2.00 more was held for two purchases of
 * unknown state. Had the seller settled them, the task would have cost $3.00
 * and the owner would have read $1.00. A hold that may still be charged is
 * part of what the task spent until it resolves.
 */
export async function unresolvedHoldsNote(session: SessionState, since: string): Promise<string | undefined> {
  const purchases = await listPurchases(session).catch(() => []);
  const held = purchases.map((state) => state.record)
    .filter((record) => record.outcome === "unknown" && record.created_at >= since && record.charged_cost_cents > 0);
  if (!held.length) return undefined;
  const byEndpoint = new Map<string, { count: number; cents: number }>();
  for (const record of held) {
    const entry = byEndpoint.get(record.endpoint) ?? { count: 0, cents: 0 };
    entry.count += 1;
    entry.cents += record.charged_cost_cents;
    byEndpoint.set(record.endpoint, entry);
  }
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const total = held.reduce((sum, record) => sum + record.charged_cost_cents, 0);
  const lines = [...byEndpoint].map(([endpoint, { count, cents }]) => `${usd(cents)} for ${endpoint}${count > 1 ? ` (${count} calls)` : ""}`);
  return `Payment still resolving: ${lines.join("; ")}. ` +
    `This ${usd(total)} is held and counts as spent until it resolves: the seller answered without a settlement receipt, ` +
    "so it is charged only if the seller takes the payment before its authorization expires, and released otherwise.";
}

/** The final answer with the note after it, once. */
export function withHoldsNote(message: string, note: string | undefined): string {
  if (!note || message.includes(note)) return message;
  return message.trim() ? `${message.trimEnd()}\n\n${note}` : note;
}
