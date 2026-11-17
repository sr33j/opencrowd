import { describe, expect, it } from "vitest";
import { bestOf, metricsOfRows, paretoFrontier, pickParentFrom, type Scored } from "../src/selection.js";
import { pickParent, type Archive } from "../src/evolve.js";

const entry = (id: string, score: number, cents: number, children = 0): Scored => ({
  id, status: "evaluated", children,
  metrics: { ...metricsOfRows([{ score, correct: score >= 0.5, cost_cents: cents }]), mean_score: score }
});

describe("selection", () => {
  it("keeps the non-dominated candidates and picks the fittest, cheaper on a tie", () => {
    const a = entry("a", 0.9, 30), b = entry("b", 0.9, 20), c = entry("c", 0.5, 5), d = entry("d", 0.4, 10);
    expect(paretoFrontier([a, b, c, d]).map((e) => e.id)).toEqual(["b", "c"]);
    expect(bestOf([a, b, c, d])?.id).toBe("b");
  });

  it("chooses parents from the frontier, deterministically per seed, and only eligible ones", () => {
    const pool = [entry("a", 0.9, 20), entry("b", 0.6, 1), entry("c", 0.1, 50)];
    const first = pickParentFrom(pool, "seed-1");
    expect(first && ["a", "b"]).toContain(first!.id);
    expect(pickParentFrom(pool, "seed-1")?.id).toBe(first!.id);
    expect(pickParentFrom(pool, "seed-1", (e) => e.id === "c")?.id).toBe("c");
    expect(pickParentFrom([], "x")).toBeUndefined();
  });

  it("is what evolve.ts uses: a parent needs a tree directory", () => {
    const archive: Archive = { started_at: "t", agent_model: "m", evidence_hash: "h",
      entries: [{ ...entry("baseline", 0.9, 1), generation: 0 } as never, { ...entry("g0", 0.8, 1), generation: 0, dir: "/trees/g0" } as never] };
    expect(pickParent(archive, "0:0")?.id).toBe("g0");
  });
});
