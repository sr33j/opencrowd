import { describe, expect, it } from "vitest";
import { scoreAssistantBench, scoreTask } from "../src/scoring.js";
import type { EvalTask } from "../src/tasks.js";

function task(scorer: EvalTask["scorer"], expected = "x"): EvalTask {
  return { task_id: "t", suite: "usage", question: "q", expected, scorer, held_out: false };
}

describe("task scoring", () => {
  it("gaia exact match on lists of numbers", async () => {
    const result = await scoreTask(task({ type: "gaia" }, "64.1, -21.9"), "FINAL ANSWER: 64.1, -21.9");
    expect(result.correct).toBe(true);
    expect((await scoreTask(task({ type: "gaia" }, "64.1, -21.9"), "FINAL ANSWER: 64.15, -21.9")).correct).toBe(false);
  });

  it("contains_all is case-insensitive", async () => {
    expect((await scoreTask(task({ type: "contains_all", terms: ["zug", "neun"] }), "FINAL ANSWER: Der Zug fährt um neun ab")).correct).toBe(true);
    expect((await scoreTask(task({ type: "contains_all", terms: ["zug", "neun"] }), "FINAL ANSWER: Der Zug fährt um acht ab")).correct).toBe(false);
  });

  it("range accepts numbers with units stripped", async () => {
    expect((await scoreTask(task({ type: "range", min: -5, max: 42 }), "FINAL ANSWER: 27°C")).correct).toBe(true);
    expect((await scoreTask(task({ type: "range", min: -5, max: 42 }), "FINAL ANSWER: warm")).correct).toBe(false);
  });

  it("url_content fetches and checks the sentinel", async () => {
    const fetchImpl = (async () => new Response("hello opencrowd-sentinel", { status: 200 })) as unknown as typeof fetch;
    const result = await scoreTask(task({ type: "url_content", contains: "opencrowd-sentinel" }), "FINAL ANSWER: https://files.example/x.txt", { fetchImpl });
    expect(result.correct).toBe(true);
  });

  it("assistantbench partial credit: lists, numbers, strings", () => {
    expect(scoreAssistantBench("CrossFit East River; Avea Pilates", "CrossFit East River\nAvea Pilates")).toBe(1);
    expect(scoreAssistantBench("CrossFit East River", "CrossFit East River\nAvea Pilates")).toBeCloseTo(0.667, 2);
    expect(scoreAssistantBench("14.2", "14.2")).toBe(1);
    expect(scoreAssistantBench("15", "14.2")).toBeCloseTo(1 - 0.8 / 14.2, 3);
    expect(scoreAssistantBench("Glass Onion", "Glass Onion: A Knives Out Mystery")).toBeGreaterThan(0.4);
    expect(scoreAssistantBench(undefined, "x")).toBe(0);
  });
});
