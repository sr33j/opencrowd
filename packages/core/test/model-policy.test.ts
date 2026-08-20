import { describe, expect, it } from "vitest";
import { resolveModelPolicy, SUBAGENT_CONTEXT_FLOOR_TOKENS, type LlmModel } from "../src/index.js";

const CATALOG: LlmModel[] = [
  { id: "zai-org-glm-4.7-flash", output_cost_cents_per_1k: 1, input_cost_cents_per_1k: 1, context_window_tokens: 128_000 },
  { id: "tiny-model", output_cost_cents_per_1k: 0, input_cost_cents_per_1k: 0, context_window_tokens: SUBAGENT_CONTEXT_FLOOR_TOKENS - 1 },
  { id: "claude-sonnet-5", output_cost_cents_per_1k: 15, input_cost_cents_per_1k: 3, context_window_tokens: 200_000 },
  { id: "gpt-5", output_cost_cents_per_1k: 10, input_cost_cents_per_1k: 2, context_window_tokens: 200_000 }
];

describe("resolveModelPolicy", () => {
  it("auto picks the most capable frontier main and the cheapest subagent above the context floor", () => {
    const resolved = resolveModelPolicy(CATALOG, { mode: "auto", main: "auto", subagent: "auto" });
    expect(resolved.main).toBe("claude-sonnet-5");
    expect(resolved.subagent).toBe("zai-org-glm-4.7-flash");
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it("auto mode reports a missing frontier model instead of degrading", () => {
    const midTierOnly = CATALOG.filter((model) => !model.id.includes("claude") && !model.id.includes("gpt-5"));
    expect(() => resolveModelPolicy(midTierOnly, { mode: "auto", main: "auto", subagent: "auto" }))
      .toThrow(/frontier/);
  });

  it("manual mode validates explicit models against the catalog", () => {
    const resolved = resolveModelPolicy(CATALOG, { mode: "manual", main: "gpt-5", subagent: "zai-org-glm-4.7-flash" });
    expect(resolved.main).toBe("gpt-5");
    expect(resolved.subagent).toBe("zai-org-glm-4.7-flash");
    expect(() => resolveModelPolicy(CATALOG, { mode: "manual", main: "missing-model", subagent: "auto" }))
      .toThrow(/not available/);
  });

  it("rejects an empty catalog", () => {
    expect(() => resolveModelPolicy([], { mode: "auto", main: "auto", subagent: "auto" })).toThrow(/no models/);
  });
});
