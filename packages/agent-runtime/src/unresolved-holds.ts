import { listPurchases } from "@opencrowd/economy";
import type { SessionState } from "@opencrowd/core";
import type { FinancialState } from "@opencrowd/protocol";

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

/**
 * A final answer that stops for money (SRI-96 follow-up): short, out, waiting
 * for money to come back or arrive. CrowdCode's reconciler reads the same
 * words to decide whether to wake the run when its holds are released.
 */
export const STOPS_FOR_MONEY = new RegExp([
  String.raw`\bout of (?:money|funds|usdc|budget)\b`, String.raw`\bran out\b`, String.raw`\brunning (?:low|out)\b`,
  String.raw`\bnot enough (?:money|funds|usdc|balance)\b`, String.raw`\binsufficient (?:funds|balance|money)\b`,
  String.raw`\bcan(?:'|no)?t afford\b`, String.raw`\b(?:money|funds|wallet|budget|balance)\b[^.]{0,40}\b(?:low|short|tight|exhausted)\b`,
  String.raw`\bnot (?:yet )?collected\b`, String.raw`\buncollected\b`, String.raw`\b(?:new|more) (?:money|funds|usdc)\b`,
  String.raw`\b(?:once|until|when)\b[^.]{0,60}\b(?:released|returned|freed|comes? back)\b`, String.raw`\btop[- ]?up\b`,
].join("|"), "i");

/**
 * Asked once when a run is about to finish for lack of money while some of
 * its wallet is only held by payments still resolving: that money has not been
 * spent and usually comes back within minutes.
 */
export function heldStopNudge(financial: FinancialState, finalMessage: string | undefined): string | undefined {
  if (financial.status !== "available" || !finalMessage || !STOPS_FOR_MONEY.test(finalMessage)) return undefined;
  const held = Math.max(Number(financial.wallet.reserved_usdc ?? 0), Number(financial.current_run.reserved_usdc ?? 0));
  if (!(held > 0)) return undefined;
  return `Before you stop for money: $${held.toFixed(2)} of this wallet is only held by payments still resolving. It is not spent: ` +
    "whatever the sellers don't take comes back, usually within about ten minutes, and a seller that did not settle never takes it. " +
    "Don't give up on the task for that. If the rest of the work needs that money, wait for it: check the Money line again after a few minutes " +
    "(run_shell sleep 120, then get_wallet_status) and continue when it is free. If you finish now anyway, say what is left to do: " +
    "CrowdCode wakes you once when the held money comes back.";
}
