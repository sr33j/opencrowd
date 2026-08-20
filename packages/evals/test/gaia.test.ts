import { describe, expect, it } from "vitest";
import { isUnsupportedModality, selectGaiaTier, type GaiaQuestion } from "../src/gaia.js";

const QUESTIONS: GaiaQuestion[] = Array.from({ length: 30 }, (_, index) => ({
  task_id: `task-${index}`,
  question: `question ${index}`,
  level: ((index % 3) + 1) as 1 | 2 | 3,
  final_answer: String(index),
  file_name: index % 10 === 0 ? "clip.mp3" : index % 7 === 0 ? "table.xlsx" : undefined
}));

describe("GAIA tiers and modality skips", () => {
  it("smoke takes the first 10 questions", () => {
    const selected = selectGaiaTier(QUESTIONS, "smoke");
    expect(selected).toHaveLength(10);
    expect(selected[0].task_id).toBe("task-0");
  });

  it("level1 filters to level 1 only", () => {
    const selected = selectGaiaTier(QUESTIONS, "level1");
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((question) => question.level === 1)).toBe(true);
  });

  it("full keeps everything", () => {
    expect(selectGaiaTier(QUESTIONS, "full")).toHaveLength(30);
  });

  it("flags audio/video/image attachments as unsupported, keeps documents", () => {
    expect(isUnsupportedModality("clip.mp3")).toBe(true);
    expect(isUnsupportedModality("chart.PNG")).toBe(true);
    expect(isUnsupportedModality("table.xlsx")).toBe(false);
    expect(isUnsupportedModality("data.csv")).toBe(false);
    expect(isUnsupportedModality(undefined)).toBe(false);
  });
});
