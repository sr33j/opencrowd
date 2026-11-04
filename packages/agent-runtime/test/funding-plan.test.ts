import { describe, expect, it } from "vitest";
import { describePlan, planTaskFunding, type PlanCall, type PlanFunds } from "../src/funding-plan.js";

const KEEP = 0.35; // hosting reserve + the run's own model allowance, on Base
const funds = (base: number, solana = 0, tempo = 0, owed = 0): PlanFunds[] => [
  { network: "base", availableUsd: base, hostingOwedUsd: owed, keepUsd: KEEP },
  { network: "solana", availableUsd: solana },
  { network: "tempo", availableUsd: tempo },
];
const article = (count: number, networks = ["base", "solana", "tempo"], price = 0.7): PlanCall =>
  ({ url: "https://drip.test/post", method: "GET", count, offers: networks.map((network) => ({ network, priceUsd: price })) });
const search: PlanCall = { url: "https://drip.test/search", method: "GET", count: 1, offers: [{ network: "tempo", priceUsd: 0, free: true }] };

describe("planning a task's funding once (SRI-88)", () => {
  it("never moves anything for a free, signed call, whatever the network", () => {
    const plan = planTaskFunding([search, article(2)], funds(2.0));
    expect(plan).toMatchObject({ outcome: "no_move", moves: [] });
    expect(plan.calls[0]).toMatchObject({ free: true, totalUsd: 0, network: "tempo" });
    expect(plan.calls[1]).toMatchObject({ network: "base", count: 2, totalUsd: 1.4 });
    expect(describePlan(plan).instruction).toMatch(/No move is needed.*Do not call bridge_usdc/);
  });

  it("pays where the funds already are before it moves any", () => {
    // Sold on Base and Tempo: Base is short, Tempo is not, so nothing moves.
    const plan = planTaskFunding([article(2, ["base", "tempo"])], funds(0.4, 0, 1.8));
    expect(plan).toMatchObject({ outcome: "no_move" });
    expect(plan.calls).toEqual([expect.objectContaining({ network: "tempo", count: 2, totalUsd: 1.4 })]);
  });

  it("makes one move, sized to the whole task, when the seller sells only where the money is not", () => {
    const plan = planTaskFunding([search, article(2, ["base"])], funds(0.4, 0, 1.8));
    expect(plan.outcome).toBe("one_move");
    // 1.40 of articles, less the 0.05 Base can already spare, plus the bridge's cut.
    expect(plan.moves).toEqual([{ from: "tempo", to: "base", amountUsd: 1.4 }]);
    const base = plan.networks.find((n) => n.network === "base")!;
    expect(base.afterUsd).toBeGreaterThanOrEqual(0);
    expect(describePlan(plan).instruction).toContain('bridge_usdc {"from":"tempo","to":"base","amount_usd":1.4}');
  });

  it("counts what Base must keep, so a move into Base also covers it instead of buying a second move later", () => {
    // Base holds 0.10 against 0.35 kept: the move restores the 0.25 too.
    const plan = planTaskFunding([article(1, ["base"])], funds(0.1, 0, 2));
    expect(plan.moves).toEqual([{ from: "tempo", to: "base", amountUsd: 1.0 }]);
  });

  it("is the run that went wrong: $0.49 spendable after hosting is not two $0.70 articles", () => {
    // Base held 0.749654 with 0.257 owed (already out of its available figure).
    const plan = planTaskFunding([search, article(2, ["base", "solana", "tempo"])], funds(0.49, 0, 0, 0.257));
    expect(plan.outcome).toBe("short");
    expect(plan.short).toEqual({ network: "base", amountUsd: 1.26 });
    expect(plan.networks.find((n) => n.network === "base")).toMatchObject({ hostingOwedUsd: 0.26, spendableUsd: 0.14 });
    const said = describePlan(plan);
    expect(said.instruction).toMatch(/add \$1\.26 on base.*Do not move funds back and forth/);
    expect(said.note).toContain("hosting owed");
  });

  it("replays the gateway's own choice per call, so a later call is not counted on money an earlier one spent", () => {
    // A is sold on Base and Solana, and the gateway takes Base on a tie; B is sold only on Base.
    const a: PlanCall = { url: "https://x.test/a", method: "GET", count: 1, offers: [{ network: "base", priceUsd: 0.5 }, { network: "solana", priceUsd: 0.5 }] };
    const b: PlanCall = { url: "https://x.test/b", method: "GET", count: 1, offers: [{ network: "base", priceUsd: 0.5 }] };
    const plan = planTaskFunding([a, b], funds(1.1, 0.4, 0));
    // Base covers A, then B is short: one move into Base, not a guess that A goes to Solana.
    expect(plan.outcome).toBe("one_move");
    expect(plan.moves[0]).toMatchObject({ to: "base" });
    expect(plan.moves[0].amountUsd).toBeLessThanOrEqual(0.4);
  });

  it("says which calls cannot be priced rather than planning around them", () => {
    const broken: PlanCall = { url: "https://x.test/down", method: "GET", count: 1, offers: [], error: "the endpoint could not be probed" };
    const plan = planTaskFunding([broken, article(1)], funds(2));
    expect(plan.outcome).toBe("no_move");
    expect(describePlan(plan).steps[0]).toContain("could not be probed");
  });
});
