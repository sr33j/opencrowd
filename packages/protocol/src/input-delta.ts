/**
 * A model call's input, recorded as what changed since the call before it
 * (SRI-127).
 *
 * Every call in a run resends the whole conversation: the system prompt, the
 * knowledge it was given, every earlier message. Captured whole, that is the
 * same tens of kilobytes again on every turn, and a long run's inputs cross
 * the 96 KB a diagnostic may hold, at which point all that survives is a short
 * preview and nobody can see what the model was actually shown. So a call
 * records only the messages that are new, and points at the earlier call for
 * the rest. Joined back up, the chain is the exact input, and the difference
 * between two calls is the thing worth reading anyway.
 *
 * A full copy (a keyframe) is still written for a session's first call, and
 * again every `KEYFRAME_EVERY` calls when it fits, so rebuilding an input
 * never has to walk the whole history of a long conversation.
 */

/** Messages taken from the base call, by position, or messages that are new. */
export type InputPart = { from: number; count: number } | { messages: unknown[] };

export interface InputDelta {
  /** The call these parts refer back to. */
  base: { runId: string; callId: string };
  /** How many messages the input has once rebuilt. */
  total: number;
  parts: InputPart[];
}

export type RecordedInput = { input: unknown[] } | { inputDelta: InputDelta };

export const KEYFRAME_EVERY = 24;
/** A keyframe larger than this would be cut down to a preview; send a delta instead. */
export const KEYFRAME_MAX_BYTES = 64 * 1024;

/** The parts that turn `previous` into `current`, matched message by message. */
export function diffInput(previous: string[], current: string[], messages: unknown[]): InputPart[] {
  const positions = new Map<string, number[]>();
  previous.forEach((key, index) => { const list = positions.get(key); if (list) list.push(index); else positions.set(key, [index]); });
  const parts: InputPart[] = [];
  let next = -1;
  current.forEach((key, index) => {
    const last = parts.at(-1);
    if (next >= 0 && previous[next] === key && last && "from" in last) { last.count++; next++; return; }
    const found = positions.get(key);
    const from = found?.find(position => position >= next) ?? found?.[0];
    if (from !== undefined) { parts.push({ from, count: 1 }); next = from + 1; return; }
    if (last && "messages" in last) last.messages.push(messages[index]);
    else parts.push({ messages: [messages[index]] });
  });
  return parts;
}

/**
 * Rebuilds an input from its delta and the base call's rebuilt input. A base
 * that could not be read (expired, or cut to a preview) leaves `null` where
 * its messages were, and says how many are missing.
 */
export function applyInputDelta(base: unknown[] | undefined, delta: InputDelta): { messages: unknown[]; missing: number } {
  const messages: unknown[] = [];
  let missing = 0;
  for (const part of delta.parts ?? []) {
    if ("messages" in part && Array.isArray(part.messages)) { messages.push(...part.messages); continue; }
    if (!("from" in part)) continue;
    for (let i = 0; i < part.count; i++) {
      const message = base?.[part.from + i];
      if (message === undefined || message === null) { missing++; messages.push(null); } else messages.push(message);
    }
  }
  return { messages, missing };
}

/**
 * The previous call a worker remembers, per session. Held in memory only: a
 * restarted worker writes a keyframe on its next call.
 */
export class InputTrail {
  private last?: { sessionId: string; runId: string; callId: string; keys: string[]; sinceKeyframe: number };

  record(scope: { sessionId: string; runId: string; callId: string }, messages: unknown[]): RecordedInput {
    const keys = messages.map(message => JSON.stringify(message) ?? "null");
    const previous = this.last?.sessionId === scope.sessionId ? this.last : undefined;
    const bytes = keys.reduce((sum, key) => sum + key.length, 0);
    const keyframe = !previous || (previous.sinceKeyframe + 1 >= KEYFRAME_EVERY && bytes <= KEYFRAME_MAX_BYTES);
    const parts = keyframe ? undefined : diffInput(previous!.keys, keys, messages);
    // A delta that reuses nothing is the whole input with extra words.
    const reused = parts?.some(part => "from" in part) ?? false;
    const full = keyframe || !reused;
    this.last = { ...scope, keys, sinceKeyframe: full ? 0 : previous!.sinceKeyframe + 1 };
    if (full) return { input: messages };
    return { inputDelta: { base: { runId: previous!.runId, callId: previous!.callId }, total: messages.length, parts: parts! } };
  }
}
