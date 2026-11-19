import { describe, expect, it } from "vitest";
import { applyInputDelta, diffInput, InputTrail, KEYFRAME_EVERY, type InputDelta } from "../src/input-delta.js";

const msg = (role: string, content: string) => ({ role, content });
const keys = (messages: unknown[]) => messages.map(m => JSON.stringify(m));
const rebuild = (base: unknown[], current: unknown[]) =>
  applyInputDelta(base, { base: { runId: "r", callId: "c" }, total: current.length, parts: diffInput(keys(base), keys(current), current) });

describe("model input deltas (SRI-127)", () => {
  const system = msg("system", "You are an agent. ".repeat(500));
  const first = [system, msg("user", "find three venues")];
  const second = [...first, msg("assistant", "searching"), msg("tool", "{\"ok\":true}")];

  it("records an appended turn as a reference plus the new messages", () => {
    const parts = diffInput(keys(first), keys(second), second);
    expect(parts).toEqual([{ from: 0, count: 2 }, { messages: [second[2], second[3]] }]);
    expect(rebuild(first, second)).toEqual({ messages: second, missing: 0 });
  });

  it("rebuilds an input whose middle was compacted and whose last message gained a note", () => {
    const before = [system, msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d"), msg("user", "e")];
    const after = [system, msg("user", "Summary: a, b"), msg("user", "c"), msg("assistant", "d"), msg("user", "note\n\ne")];
    expect(rebuild(before, after)).toEqual({ messages: after, missing: 0 });
    expect(diffInput(keys(before), keys(after), after)).toEqual([
      { from: 0, count: 1 }, { messages: [after[1]] }, { from: 3, count: 2 }, { messages: [after[4]] }]);
  });

  it("marks messages it could not take from a base that was never captured", () => {
    const delta: InputDelta = { base: { runId: "r", callId: "c" }, total: 3, parts: [{ from: 0, count: 2 }, { messages: [msg("user", "x")] }] };
    expect(applyInputDelta(undefined, delta)).toEqual({ messages: [null, null, msg("user", "x")], missing: 2 });
  });

  it("writes a keyframe first, deltas after it, and a fresh keyframe on a schedule", () => {
    const trail = new InputTrail(), scope = (callId: string) => ({ sessionId: "s", runId: "run-1", callId });
    expect(trail.record(scope("c0"), first)).toEqual({ input: first });
    const recorded = trail.record(scope("c1"), second);
    expect(recorded).toEqual({ inputDelta: { base: { runId: "run-1", callId: "c0" }, total: 4, parts: [{ from: 0, count: 2 }, { messages: second.slice(2) }] } });
    let history = second;
    const kinds: string[] = [];
    for (let i = 2; i <= KEYFRAME_EVERY + 1; i++) {
      history = [...history, msg("assistant", `step ${i}`)];
      kinds.push("input" in trail.record(scope(`c${i}`), history) ? "keyframe" : "delta");
    }
    expect(kinds.filter(k => k === "keyframe")).toHaveLength(1);
    expect(kinds.indexOf("keyframe")).toBe(KEYFRAME_EVERY - 2);
  });

  it("starts over with a keyframe in another session, and never sends a delta that reuses nothing", () => {
    const trail = new InputTrail();
    trail.record({ sessionId: "s1", runId: "r", callId: "a" }, first);
    expect(trail.record({ sessionId: "s2", runId: "r2", callId: "b" }, second)).toEqual({ input: second });
    const unrelated = [msg("system", "other"), msg("user", "new")];
    expect(trail.record({ sessionId: "s2", runId: "r2", callId: "c" }, unrelated)).toEqual({ input: unrelated });
  });

  it("refers back across runs of the same conversation", () => {
    const trail = new InputTrail();
    trail.record({ sessionId: "s", runId: "run-1", callId: "a" }, second);
    const next = [...second, msg("user", "and a fourth?")];
    const recorded = trail.record({ sessionId: "s", runId: "run-2", callId: "b" }, next);
    expect(recorded).toMatchObject({ inputDelta: { base: { runId: "run-1", callId: "a" }, parts: [{ from: 0, count: 4 }, { messages: [next[4]] }] } });
  });
});
