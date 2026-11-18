import type { LlmMessage } from "./index.js";

/**
 * Every tool call in a conversation's history answered, and every tool result
 * attached to a call, before the history goes back to a model.
 *
 * A run can end between a model's tool calls and their results: the loop
 * guard stops a run in the middle of a batch ("failed repeatedly"), and a
 * worker can be stopped mid-turn. The calls stay in `messages.jsonl` with no
 * result, and every model provider refuses the next request in that
 * conversation ("No tool output found for function call …"). The
 * conversation was lost for good: on 2026-11-18 a chief of staff's only
 * conversation failed every run after one such stop.
 *
 * A missing result is filled with a short note that the call did not run;
 * a result whose call is gone is dropped. Nothing else changes.
 */
export const NOT_RUN = JSON.stringify({ ok: false, error: "This call was not run: the run stopped before it." });

export function repairToolPairs(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  let open: { ids: string[]; answered: Set<string> } | undefined;
  const close = () => {
    if (!open) return;
    for (const id of open.ids) if (!open.answered.has(id)) out.push({ role: "tool", toolCallId: id, content: NOT_RUN });
    open = undefined;
  };
  for (const message of messages) {
    if (message.role === "tool") {
      if (open && message.toolCallId && open.ids.includes(message.toolCallId) && !open.answered.has(message.toolCallId)) {
        open.answered.add(message.toolCallId);
        out.push(message);
      }
      // A result with no call before it is dropped.
      continue;
    }
    close();
    out.push(message);
    if (message.role === "assistant" && message.toolCalls?.length) open = { ids: message.toolCalls.map((call) => call.id), answered: new Set() };
  }
  close();
  return out;
}
