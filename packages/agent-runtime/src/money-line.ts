import type { FinancialState } from "@opencrowd/protocol";

/**
 * The one line of money every hosted turn carries (SRI-128).
 *
 * Agents used to get the whole financial snapshot as JSON twice per tool
 * result, before and after, about 1,200 bytes. It included a run "budget"
 * that orgs no longer have, and it had no price in it. On 2026-11-19 a chief
 * of staff made 309 model calls at about $0.017 each, never asked for money,
 * and was refused at $0.0017 with no warning. This line is the replacement:
 * the wallet, what this run has spent, what a call costs, how many calls are
 * left and, when that number is low, what is being done about it.
 *
 * It is attached to the newest message only (a tool result, or the note on
 * the latest user message), never written back into older ones, so the
 * history before it stays byte-identical and cached.
 */

/** What the runtime itself has seen this run, for when control sends no runway. */
export interface MoneyTrack {
  /** Model calls answered in this run. */
  calls: number;
  /** Cost of each recent model call, as inference spend deltas (USD), newest last. */
  recent: number[];
}

export function newMoneyTrack(): MoneyTrack {
  return { calls: 0, recent: [] };
}

/** Record one answered model call, given inference spend (USD) before and after it. */
export function trackModelCall(track: MoneyTrack, before: number | undefined, after: number | undefined) {
  track.calls += 1;
  if (before === undefined || after === undefined || after < before) return;
  track.recent.push(after - before);
  if (track.recent.length > 5) track.recent.shift();
}

export function inferenceSpent(financial: FinancialState): number | undefined {
  return financial.status === "available" ? Number(financial.current_run.inference_spent_usdc) : undefined;
}

/** Dollars as an agent should read them: cents for whole amounts, four places below a dollar, six below a tenth of a cent. */
export function usd(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$?";
  const abs = Math.abs(n);
  return `$${n.toFixed(abs >= 10 ? 2 : abs >= 0.001 || abs === 0 ? 4 : 6)}`;
}

/** Calls-left tiers (Budget Tracker's HIGH/MEDIUM/LOW/CRITICAL), and the one action at the low two. Control sends its own; these match. */
export function tierOf(callsLeft: number): { tier: "HIGH" | "MEDIUM" | "LOW" | "CRITICAL"; action?: string } {
  if (callsLeft >= 40) return { tier: "HIGH" };
  if (callsLeft >= 15) return { tier: "MEDIUM" };
  if (callsLeft >= 5) return { tier: "LOW", action: "verify before branching" };
  return { tier: "CRITICAL", action: "wrap up" };
}

/**
 * The line, or undefined when the operator turned it off for this org (an
 * A/B control). It leads with what an agent paces by: about how many calls
 * the wallet covers, and the tier. It names the next call's cost, never a
 * fixed "cost per call": a call costs more as the history grows.
 */
export function moneyLine(financial: FinancialState, track: MoneyTrack = newMoneyTrack()): string | undefined {
  if (financial.status !== "available") return `Money: unknown right now (${financial.reason.slice(0, 160)}). Don't assume a balance of zero.`;
  const { wallet, current_run: run, runway } = financial;
  if (runway?.money_line === false) return undefined;
  // The newest call is the best guess at the next one: costs only grow with the history.
  const last = track.recent.at(-1);
  const callsLeft = runway ? runway.calls_left
    : last && last > 0 && wallet.available_usdc !== null ? Math.min(999, Math.floor(Number(wallet.available_usdc) / last + 1e-6)) : undefined;
  const parts: string[] = [];
  if (callsLeft !== undefined) {
    const { tier, action } = runway?.tier ? { tier: runway.tier, action: runway.action } : tierOf(callsLeft);
    parts.push(`≈${callsLeft}${callsLeft >= 999 ? "+" : ""} calls left (${tier}${action ? `: ${action}` : ""})`);
  }
  if (wallet.available_usdc === null) parts.push("wallet balance unavailable");
  else {
    const funded = (wallet.networks ?? []).filter(n => Number(n.available_usdc ?? n.balance_usdc ?? 0) > 0);
    const split = funded.length > 1 ? ` (${funded.map(n => `${n.network} ${usd(n.available_usdc ?? n.balance_usdc ?? 0)}`).join(", ")})` : "";
    parts.push(`wallet ${usd(wallet.available_usdc)} free${split}`);
  }
  const calls = track.calls ? ` over ${track.calls} model call${track.calls === 1 ? "" : "s"}` : "";
  parts.push(`this run spent ${usd(run.total_spent_usdc)}${calls}`);
  if (runway) parts.push(`next call ≈${usd(runway.next_call_usdc)} on ${runway.model}`);
  else if (last) parts.push(`last call ${usd(last)}`);
  // Held is not spent: what the sellers do not take comes back (SRI-96 follow-up).
  const held = Math.max(Number(run.reserved_usdc ?? 0), Number(wallet.reserved_usdc ?? 0));
  if (held > 0) parts.push(`${usd(held.toFixed(6))} held for payments in flight (not spent: returned if the sellers don't take it)`);
  if (run.approval_mode !== "auto" || Number(run.per_call_approval_threshold_usdc) > 0)
    parts.push(run.approval_mode === "off" ? "paid calls are off" : `paid calls above ${usd(run.per_call_approval_threshold_usdc)} need approval`);
  return `Money: ${parts.join(" · ")}.`;
}
