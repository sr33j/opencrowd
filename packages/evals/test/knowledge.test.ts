import { describe, expect, it } from "vitest";
import { parseTreeJson, validateTree } from "../src/knowledge.js";
import { paretoFrontier, pickParent, type Archive, type ArchiveEntry } from "../src/evolve.js";
import { seededSample } from "../src/tasks.js";
import type { EvidenceBundle } from "../src/evidence.js";

const EVIDENCE: EvidenceBundle = {
  fetched_at: "2026-09-14T00:00:00Z",
  source: "test",
  stats: { services: 2, reviews: 3, services_with_reviews: 2 },
  services: [
    { service_id: "svc_a", name: "Exa", endpoint: "https://stableenrich.dev/api/exa/search", origin: "https://stableenrich.dev", payment_provider: "x402", score: 4.2, n_eff: 12, unproven: false, num_reviews: 7, num_verified_reviews: 6, reviews: [] },
    { service_id: "svc_b", name: "Sketchy", endpoint: "https://sketchy.example/api", origin: "https://sketchy.example", payment_provider: "x402", score: 3.9, n_eff: 0.2, unproven: true, num_reviews: 1, num_verified_reviews: 0, reviews: [] }
  ]
};

describe("knowledge tree validation", () => {
  it("accepts a grounded tree", () => {
    const result = validateTree({
      "L0.md": "- web search -> POST https://stableenrich.dev/api/exa/search (score 4.2)",
      "INDEX.md": "- search -> categories/search.md",
      "categories/search.md": "# search\n- https://stableenrich.dev/api/exa/search svc_a#r1"
    }, EVIDENCE);
    expect(result.ok).toBe(true);
    expect(result.stats.referenced_services).toBe(2);
  });

  it("rejects hallucinated or unproven origins in L0, missing files, and secrets", () => {
    const result = validateTree({
      "L0.md": "- use https://made-up.example/api and https://sketchy.example/api",
      "INDEX.md": "- x -> categories/missing.md",
      "categories/x.md": "key 0x" + "a".repeat(64)
    }, EVIDENCE);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/absent from CrowdCode evidence/);
    expect(result.errors.join("\n")).toMatch(/unproven/);
    expect(result.errors.join("\n")).toMatch(/missing categories\/missing.md/);
    expect(result.errors.join("\n")).toMatch(/secret-looking/);
  });

  it("enforces the L0 token budget", () => {
    const result = validateTree({ "L0.md": "x".repeat(5000), "INDEX.md": "" }, EVIDENCE);
    expect(result.errors.join("\n")).toMatch(/L0.md is/);
  });

  it("parses fenced JSON proposals", () => {
    const tree = parseTreeJson("```json\n{\"L0.md\": \"a\", \"./INDEX.md\": \"b\"}\n```");
    expect(tree).toEqual({ "L0.md": "a", "INDEX.md": "b" });
  });
});

describe("evolution selection", () => {
  const entry = (id: string, score: number, cost: number, children = 0): ArchiveEntry => ({
    id, dir: `/t/${id}`, generation: 1, children, status: "evaluated",
    metrics: { tasks: 10, correct: score * 10, accuracy: score, mean_score: score, total_cost_cents: cost, mean_turns: 3, paid_calls: 0, unnecessary_purchases: 0, errors: 0, fitness: score * 10 - cost / 100 }
  });

  it("keeps only non-dominated trees on the frontier", () => {
    const frontier = paretoFrontier([entry("a", 0.8, 50), entry("b", 0.7, 40), entry("c", 0.6, 60), entry("d", 0.8, 45)]);
    expect(frontier.map((e) => e.id).sort()).toEqual(["b", "d"]);
  });

  it("picks parents deterministically per slot from the frontier", () => {
    const archive: Archive = { started_at: "s", agent_model: "m", evidence_hash: "h", entries: [entry("a", 0.8, 50), entry("b", 0.7, 40, 5)] };
    const first = pickParent(archive, "1:0");
    expect(first).toBeDefined();
    expect(pickParent(archive, "1:0")?.id).toBe(first?.id);
  });
});

describe("seeded sampling", () => {
  it("is deterministic and order-independent", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}` }));
    const a = seededSample(items, 5, "seed", (item) => item.id).map((item) => item.id);
    const b = seededSample([...items].reverse(), 5, "seed", (item) => item.id).map((item) => item.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
  });
});
