import { describe, expect, it } from "vitest";
import { NOT_RUN, repairToolPairs } from "../src/tool-pairs.js";
import type { LlmMessage } from "../src/index.js";

const call = (id: string) => ({ id, name: "org_schedule", arguments: {} });
describe("repairToolPairs", () => {
  it("answers the calls a stopped run left without a result, in place", () => {
    const history: LlmMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [call("a"), call("b"), call("c")] },
      { role: "tool", toolCallId: "a", content: "{}" },
      { role: "user", content: "and now?" },
    ];
    const repaired = repairToolPairs(history);
    expect(repaired.map((m) => [m.role, m.toolCallId ?? ""])).toEqual([
      ["user", ""], ["assistant", ""], ["tool", "a"], ["tool", "b"], ["tool", "c"], ["user", ""],
    ]);
    expect(repaired[3].content).toBe(NOT_RUN);
  });
  it("drops a result whose call is gone, and a second result for one call", () => {
    const repaired = repairToolPairs([
      { role: "tool", toolCallId: "x", content: "{}" },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", content: "1" },
      { role: "tool", toolCallId: "a", content: "2" },
    ]);
    expect(repaired.map((m) => m.content)).toEqual(["", "1"]);
  });
  it("leaves a sound history exactly as it was", () => {
    const sound: LlmMessage[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", content: "{}" }, { role: "assistant", content: "done" }];
    expect(repairToolPairs(sound)).toEqual(sound);
  });
});
