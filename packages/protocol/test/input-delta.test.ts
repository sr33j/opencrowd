import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyInputDelta, diffInput, InputTrail, KEYFRAME_EVERY, type InputDelta, type RecordedInput } from "../src/input-delta.js";

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

// Properties (SRI-175). The examples above are the regression seeds.
describe("properties: model input deltas", () => {
  // A small pool makes messages repeat, move and come back, as they do across
  // compactions; fresh messages make the rest of each input new.
  const pool = [msg("system", "You are an agent."), msg("user", "a"), msg("assistant", "b"), msg("tool", "{}"), msg("user", "a"), msg("user", "Summary: a, b")];
  const message = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...pool) },
    { weight: 1, arbitrary: fc.record({ role: fc.constantFrom("user", "assistant", "tool"), content: fc.string({ unit: "binary", maxLength: 8 }) }) },
    // Messages arrive as JSON, which has no -0 (JSON.stringify would key -0 and 0 alike).
    { weight: 1, arbitrary: fc.dictionary(fc.string({ maxLength: 4 }), fc.jsonValue({ maxDepth: 2 }), { minKeys: 1, maxKeys: 3 }).map(m => JSON.parse(JSON.stringify(m)) as unknown) }
  );
  const input = fc.array(message, { maxLength: 30 });

  it("rebuilds any input exactly from any earlier input and the parts between them", () => {
    fc.assert(fc.property(input, input, (before, after) => {
      const parts = diffInput(keys(before), keys(after), after);
      expect(applyInputDelta(before, { base: { runId: "r", callId: "c" }, total: after.length, parts })).toEqual({ messages: after, missing: 0 });
      // References point inside the base; nothing is referenced that is not there.
      for (const part of parts) if ("from" in part) expect(part.from + part.count).toBeLessThanOrEqual(before.length);
    }), { numRuns: 300 });
  });

  it("rebuilds every call of a conversation exactly by walking its chain back to a keyframe", () => {
    // Each call's input grows from the one before: appended turns, a compacted middle, an edited last message.
    const step = fc.oneof(
      fc.record({ kind: fc.constant("append" as const), messages: fc.array(message, { minLength: 1, maxLength: 3 }) }),
      fc.record({ kind: fc.constant("compact" as const), at: fc.nat(), length: fc.nat({ max: 6 }), summary: message }),
      fc.record({ kind: fc.constant("note" as const), note: fc.string({ maxLength: 6 }) }),
      fc.record({ kind: fc.constant("unrelated" as const), messages: fc.array(message, { maxLength: 4 }) })
    );
    fc.assert(fc.property(input, fc.array(step, { minLength: 1, maxLength: KEYFRAME_EVERY + 6 }), fc.array(fc.boolean(), { maxLength: 40 }), (first, steps, newRun) => {
      const trail = new InputTrail();
      const recorded = new Map<string, RecordedInput>();
      const rebuild = (callId: string): unknown[] => {
        const entry = recorded.get(callId)!;
        if ("input" in entry) return entry.input;
        // The base is named by the run that recorded it, not the run asking.
        expect(entry.inputDelta.base.runId).toBe(histories[Number(entry.inputDelta.base.callId.slice(1))][1]);
        const { messages, missing } = applyInputDelta(rebuild(entry.inputDelta.base.callId), entry.inputDelta);
        expect(missing).toBe(0);
        expect(messages).toHaveLength(entry.inputDelta.total);
        return messages;
      };
      let history: unknown[] = first, runId = "run-0";
      const histories: [unknown[], string][] = [[history, runId]];
      for (const [index, change] of steps.entries()) {
        if (change.kind === "append") history = [...history, ...change.messages];
        else if (change.kind === "compact") { const at = history.length ? change.at % history.length : 0; history = [...history.slice(0, at), change.summary, ...history.slice(at + change.length)]; }
        else if (change.kind === "note") history = history.length ? [...history.slice(0, -1), { note: change.note, of: history.at(-1) }] : history;
        else history = change.messages;
        // The same conversation may continue in a later run.
        if (newRun[index]) runId = `run-${index + 1}`;
        histories.push([history, runId]);
      }
      histories.forEach(([messages, run], index) => recorded.set(`c${index}`, trail.record({ sessionId: "s", runId: run, callId: `c${index}` }, messages)));
      histories.forEach(([messages], index) => expect(rebuild(`c${index}`)).toEqual(messages));
      // A long conversation is never more than KEYFRAME_EVERY calls from a keyframe (when keyframes fit, as these do).
      let sinceKeyframe = 0;
      for (const index of histories.keys()) {
        sinceKeyframe = "input" in recorded.get(`c${index}`)! ? 0 : sinceKeyframe + 1;
        expect(sinceKeyframe).toBeLessThan(KEYFRAME_EVERY);
      }
    }), { numRuns: 200 });
  });
});
