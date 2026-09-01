import { describe, expect, it } from "vitest";
import { insertInputText } from "../src/tui/input.js";

describe("insertInputText", () => {
  it("preserves every line in pasted text without submitting it", () => {
    expect(insertInputText("", 0, "first line\nsecond line\nthird line")).toEqual({
      value: "first line\nsecond line\nthird line",
      cursor: 33
    });
  });

  it("inserts a multiline paste at the cursor", () => {
    expect(insertInputText("beforeafter", 6, " one\n two ")).toEqual({
      value: "before one\n two after",
      cursor: 16
    });
  });

  it("normalizes carriage returns from terminal paste data", () => {
    expect(insertInputText("", 0, "one\r\ntwo\rthree")).toEqual({
      value: "one\ntwo\nthree",
      cursor: 13
    });
  });
});
