/**
 * Funding a whole task before buying any of it (SRI-88).
 *
 * On 2026-11-04 an agent asked to buy two or three Drip research pieces with
 * $2.00 on Base moved $1.00 Base→Tempo for Drip's free search, then $0.80
 * Tempo→Base for the article it bought, then could not afford the second
 * article: Base held $0.54, of which $0.257 was owed for hosting and $0.10 is
 * the hosting reserve. Each step was locally reasonable and the task as a
 * whole was not: nothing ever looked at every call the task would make and
 * every network each one accepts, against what each network could really
 * spend.
 *
 * `planTaskFunding` does that once. It replays the gateway's own choice for
 * each call in the order the agent will make them — the cheapest offer whose
 * network covers it, Base first on a tie (`selectOffer` in the gateway) — so
 * the plan predicts what will actually be paid where. If that leaves calls
 * unpaid, it finds the single move that fixes all of them: one destination,
 * one source, sized to what the task needs there plus the bridge's cut. A
 * call whose offer is free (a zero-amount identity proof) needs nothing on
 * any network and never causes a move.
 */

/** Network order the hosted gateway prefers on an equal price. */
export const GATEWAY_PREFERENCE = ["base", "solana", "tempo"] as const;
/** Relay keeps about $0.02-0.03; a move sends this much over what must arrive. */
export const PLAN_FEE_ALLOWANCE_USD = 0.05;
/** A run's own model calls are paid on Base; a plan never spends this. */
export const PLAN_INFERENCE_ALLOWANCE_USD = 0.25;
/** What a new run needs left for hosting (control's admission rule). */
export const HOSTING_RESERVE_USD = 0.1;

export interface PlanOffer {
  network: string;
  priceUsd: number;
  /** A zero-amount identity proof: signed, nothing moves. */
  free?: boolean;
}
export interface PlanCall {
  url: string;
  method: string;
  count: number;
  /** Payable offers only. */
  offers: PlanOffer[];
  /** Why this call could not be priced, when it could not. */
  error?: string;
}
export interface PlanFunds {
  network: string;
  /** Balance less open holds. On Base the holds include hosting owed (control's openHolds). */
  availableUsd: number;
  /** Hosting owed, already out of `availableUsd`: shown, never subtracted again. */
  hostingOwedUsd?: number;
  /** Held back: the hosting reserve and, on Base, the run's inference allowance. */
  keepUsd?: number;
}
export interface PlannedCall {
  url: string;
  method: string;
  count: number;
  network?: string;
  priceUsd?: number;
  totalUsd: number;
  free?: boolean;
  /** No network could pay it, even after the planned move. */
  unpaid?: boolean;
  error?: string;
}
export interface PlannedMove {
  from: string;
  to: string;
  amountUsd: number;
}
export interface FundingPlan {
  outcome: "no_move" | "one_move" | "short";
  calls: PlannedCall[];
  networks: { network: string; availableUsd: number; hostingOwedUsd: number; keepUsd: number; spendableUsd: number; plannedUsd: number; afterUsd: number }[];
  moves: PlannedMove[];
  /** With `short`: the cheapest addition that would let the whole task run. */
  short?: { network: string; amountUsd: number };
}

const cents = (usd: number) => Math.round(usd * 100) / 100;
const up = (usd: number) => Math.ceil(usd * 100 - 1e-9) / 100;
const rank = (network: string) => {
  const index = (GATEWAY_PREFERENCE as readonly string[]).indexOf(network);
  return index < 0 ? GATEWAY_PREFERENCE.length : index;
};

/** What each network can put toward this task. */
export function spendable(funds: PlanFunds): number {
  return Math.max(0, funds.availableUsd - (funds.keepUsd ?? 0));
}

/**
 * The gateway's choice for each call, in order, against a running balance:
 * the cheapest offer whose network still covers the call, Base first on a tie.
 */
function simulate(calls: readonly PlanCall[], start: Map<string, number>) {
  const left = new Map(start);
  const assigned: PlannedCall[] = [];
  for (const call of calls) {
    const free = call.offers.find((offer) => offer.free);
    if (free) {
      assigned.push({ url: call.url, method: call.method, count: call.count, network: free.network, priceUsd: 0, totalUsd: 0, free: true });
      continue;
    }
    if (!call.offers.length) {
      assigned.push({ url: call.url, method: call.method, count: call.count, totalUsd: 0, unpaid: true, error: call.error ?? "no payable offer" });
      continue;
    }
    // Each repetition is its own purchase, so a later one may land elsewhere.
    for (let i = 0; i < call.count; i++) {
      const offer = [...call.offers]
        .filter((candidate) => (left.get(candidate.network) ?? 0) + 1e-9 >= candidate.priceUsd)
        .sort((a, b) => a.priceUsd - b.priceUsd || rank(a.network) - rank(b.network))[0];
      const previous = assigned[assigned.length - 1];
      const sameAsPrevious = i > 0 && previous && previous.network === offer?.network && !previous.unpaid;
      if (offer) left.set(offer.network, (left.get(offer.network) ?? 0) - offer.priceUsd);
      if (sameAsPrevious) {
        previous.count += 1;
        previous.totalUsd = cents(previous.totalUsd + offer!.priceUsd);
        continue;
      }
      const cheapest = [...call.offers].sort((a, b) => a.priceUsd - b.priceUsd || rank(a.network) - rank(b.network))[0];
      assigned.push(offer
        ? { url: call.url, method: call.method, count: 1, network: offer.network, priceUsd: offer.priceUsd, totalUsd: offer.priceUsd }
        : { url: call.url, method: call.method, count: 1, priceUsd: cheapest.priceUsd, totalUsd: cheapest.priceUsd, unpaid: true });
    }
  }
  // Merge consecutive unpaid repetitions of one call for a readable plan.
  const merged: PlannedCall[] = [];
  for (const call of assigned) {
    const last = merged[merged.length - 1];
    if (last && last.unpaid && call.unpaid && last.url === call.url && last.method === call.method && !last.error && !call.error) {
      last.count += call.count;
      last.totalUsd = cents(last.totalUsd + call.totalUsd);
    } else merged.push({ ...call });
  }
  return { calls: merged, left, unpaid: merged.some((call) => call.unpaid && !call.error) };
}

/**
 * Not floored: a network holding less than it must keep starts below zero, so
 * a move into it also restores what it keeps. Moving $0.70 to a Base that is
 * short of its own model allowance would only buy a second move later, when
 * the run's next model call tops Base up.
 */
const headroom = (funds: PlanFunds) => funds.availableUsd - (funds.keepUsd ?? 0);

export function planTaskFunding(calls: readonly PlanCall[], funds: readonly PlanFunds[]): FundingPlan {
  const start = new Map(funds.map((entry) => [entry.network, headroom(entry)]));
  const report = (planned: ReturnType<typeof simulate>, moves: PlannedMove[], outcome: FundingPlan["outcome"], short?: FundingPlan["short"]): FundingPlan => ({
    outcome,
    calls: planned.calls,
    moves,
    ...(short ? { short } : {}),
    networks: funds.map((entry) => {
      const moved = moves.reduce((sum, move) => sum + (move.to === entry.network ? move.amountUsd - PLAN_FEE_ALLOWANCE_USD : 0) - (move.from === entry.network ? move.amountUsd : 0), 0);
      const plannedUsd = planned.calls.filter((call) => call.network === entry.network && !call.unpaid).reduce((sum, call) => sum + call.totalUsd, 0);
      return {
        network: entry.network,
        availableUsd: cents(entry.availableUsd),
        hostingOwedUsd: cents(entry.hostingOwedUsd ?? 0),
        keepUsd: cents(entry.keepUsd ?? 0),
        spendableUsd: cents(spendable(entry)),
        plannedUsd: cents(plannedUsd),
        afterUsd: cents(headroom(entry) + moved - plannedUsd),
      };
    }),
  });
  const now = simulate(calls, start);
  if (!now.unpaid) return report(now, [], "no_move");

  // One move into one network. For each network an unpaid call accepts, find
  // what the task would spend there with no limit, and so how much has to
  // arrive; then the source that can spare it after its own share of the task.
  const targets = [...new Set(now.calls.filter((call) => call.unpaid && !call.error)
    .flatMap((call) => calls.find((c) => c.url === call.url && c.method === call.method)?.offers.map((offer) => offer.network) ?? []))];
  let best: { move: PlannedMove; planned: ReturnType<typeof simulate> } | undefined;
  let closest: { network: string; amountUsd: number } | undefined;
  for (const target of targets.sort((a, b) => rank(a) - rank(b))) {
    const unlimited = simulate(calls, new Map([...start, [target, Number.MAX_SAFE_INTEGER]]));
    if (unlimited.unpaid) continue;
    const used = new Map<string, number>();
    for (const call of unlimited.calls) if (call.network && !call.unpaid) used.set(call.network, (used.get(call.network) ?? 0) + call.totalUsd);
    const arrive = Math.max(0, (used.get(target) ?? 0) - (start.get(target) ?? 0));
    const amountUsd = up(arrive + PLAN_FEE_ALLOWANCE_USD);
    const sources = funds.filter((entry) => entry.network !== target)
      .map((entry) => ({ network: entry.network, spare: (start.get(entry.network) ?? 0) - (used.get(entry.network) ?? 0) }))
      .sort((a, b) => b.spare - a.spare);
    const source = sources[0];
    const gap = source ? amountUsd - source.spare : amountUsd;
    if (!closest || gap < closest.amountUsd) closest = { network: target, amountUsd: up(Math.max(0, gap)) };
    if (!source || source.spare + 1e-9 < amountUsd) continue;
    const move = { from: source.network, to: target, amountUsd };
    const after = simulate(calls, new Map([...start, [target, (start.get(target) ?? 0) + arrive], [source.network, (start.get(source.network) ?? 0) - amountUsd]]));
    if (after.unpaid) continue;
    if (!best || amountUsd < best.move.amountUsd) best = { move, planned: after };
  }
  if (best) return report(best.planned, [best.move], "one_move");
  // Nothing the agent holds covers the task with one move. The cheapest way
  // out is adding the gap where the task needs it, which is the owner's call.
  const direct = targets.map((network) => {
    const unlimited = simulate(calls, new Map([...start, [network, Number.MAX_SAFE_INTEGER]]));
    const used = unlimited.calls.filter((call) => call.network === network && !call.unpaid).reduce((sum, call) => sum + call.totalUsd, 0);
    return { network, amountUsd: up(Math.max(0, used - (start.get(network) ?? 0))) };
  }).sort((a, b) => a.amountUsd - b.amountUsd || rank(a.network) - rank(b.network))[0];
  return report(now, [], "short", direct ?? closest);
}

/** What the model reads: the plan, in words and numbers, with the exact next steps. */
export function describePlan(plan: FundingPlan) {
  const money = (usd: number) => `$${usd.toFixed(2)}`;
  const steps = plan.calls.map((call) => call.free
    ? `${call.method} ${call.url}: free (a signed wallet-identity proof on ${call.network}; nothing moves, no balance needed)`
    : call.error ? `${call.method} ${call.url}: ${call.error}`
      : call.unpaid ? `${call.count}× ${call.method} ${call.url}: not payable with these funds (${money(call.totalUsd)})`
        : `${call.count}× ${call.method} ${call.url}: pays ${money(call.totalUsd)} on ${call.network}`);
  const move = plan.moves[0];
  const instruction = plan.outcome === "no_move"
    ? "No move is needed: every planned call is payable where the funds already are. Do not call bridge_usdc for this task."
    : plan.outcome === "one_move"
      ? `Make exactly this one move, once, before the first purchase: bridge_usdc {"from":"${move.from}","to":"${move.to}","amount_usd":${move.amountUsd}} (about $0.03 of it is the fee). Then make the calls; do not move funds again, and never back the other way, in this run.`
      : `These funds cannot pay for the whole task with one move. Do the part that is payable without any move if it is worth doing alone, and tell the owner the exact gap: add ${money(plan.short?.amountUsd ?? 0)} on ${plan.short?.network ?? "the network the service is sold on"}. Do not move funds back and forth to make up the difference.`;
  return {
    outcome: plan.outcome,
    steps,
    moves: plan.moves.map((m) => ({ from: m.from, to: m.to, amount_usd: m.amountUsd })),
    ...(plan.short ? { short: { network: plan.short.network, amount_usd: plan.short.amountUsd } } : {}),
    networks: plan.networks.map((n) => ({
      network: n.network, available_usd: n.availableUsd, hosting_owed_usd: n.hostingOwedUsd, kept_usd: n.keepUsd,
      spendable_usd: n.spendableUsd, planned_usd: n.plannedUsd, left_after_usd: n.afterUsd,
    })),
    instruction,
    note: `spendable = available (balance less payment holds and, on Base, hosting owed) less what is kept: the $${HOSTING_RESERVE_USD.toFixed(2)} hosting reserve, and $${PLAN_INFERENCE_ALLOWANCE_USD.toFixed(2)} on Base for this run's own model calls.`,
  };
}

export const PLAN_FUNDING_TOOL = {
  name: "plan_funding",
  description: "Plan a task's funding once, before its first purchase, whenever the task will make more than one paid call or a call on a network you hold little on. List every call you intend to make (url, method, how many times). It reads every network and protocol each endpoint accepts — including free calls that only need a signed wallet-identity proof — and what each of your networks can really spend (balance less holds, hosting owed, the hosting reserve and an allowance for your own model calls), then says which network will pay each call and the at most one bridge_usdc move the task needs, sized to it. Read-only: nothing is paid or moved.",
  parameters: {
    type: "object",
    properties: {
      calls: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            url: { type: "string", description: "Exact endpoint URL, as you will call it" },
            method: { type: "string", enum: ["GET", "POST"] },
            count: { type: "integer", minimum: 1, maximum: 20, description: "How many times you will call it (default 1)" },
            sample_body: { type: "object", description: "For POST: a representative body, for the exact quote" }
          },
          required: ["url"],
          additionalProperties: false
        }
      }
    },
    required: ["calls"],
    additionalProperties: false
  }
};
