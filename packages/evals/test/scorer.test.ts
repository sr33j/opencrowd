import { describe, expect, it } from "vitest";
import { extractFinalAnswer, normalizeStr, scoreGaiaAnswer } from "../src/scorer.js";

describe("GAIA scorer", () => {
  it("compares numeric ground truths as floats", () => {
    expect(scoreGaiaAnswer("100", "100")).toBe(true);
    expect(scoreGaiaAnswer("$100,000", "100000")).toBe(true);
    expect(scoreGaiaAnswer("17%", "17")).toBe(true);
    expect(scoreGaiaAnswer("100.0", "100")).toBe(true);
    expect(scoreGaiaAnswer("99", "100")).toBe(false);
    expect(scoreGaiaAnswer("not a number", "100")).toBe(false);
  });

  it("compares strings without case, whitespace, or punctuation", () => {
    expect(scoreGaiaAnswer("Right Whale", "right whale")).toBe(true);
    expect(scoreGaiaAnswer("St. Petersburg", "Saint Petersburg")).toBe(false);
    expect(scoreGaiaAnswer("time-parking 2: parallel universe", "Time-Parking 2: Parallel Universe")).toBe(true);
  });

  it("compares comma lists element-wise", () => {
    expect(scoreGaiaAnswer("b, e", "b, e")).toBe(true);
    expect(scoreGaiaAnswer("b,e", "b, e")).toBe(true);
    expect(scoreGaiaAnswer("e, b", "b, e")).toBe(false);
    expect(scoreGaiaAnswer("120, 5", "120,5")).toBe(true);
    expect(scoreGaiaAnswer("120", "120,5")).toBe(false);
  });

  it("preserves punctuation inside list elements (official behavior)", () => {
    expect(normalizeStr("a.b", false)).toBe("a.b");
    expect(scoreGaiaAnswer("3.5, x!", "3.5, x!")).toBe(true);
  });

  it("extracts the last FINAL ANSWER line", () => {
    expect(extractFinalAnswer("thinking...\nFINAL ANSWER: 42")).toBe("42");
    expect(extractFinalAnswer("FINAL ANSWER: draft\nmore work\nfinal answer: right whale")).toBe("right whale");
    expect(extractFinalAnswer("no answer line")).toBeUndefined();
    expect(extractFinalAnswer(undefined)).toBeUndefined();
  });
});
