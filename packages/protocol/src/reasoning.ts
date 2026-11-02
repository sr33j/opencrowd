/**
 * A model's answer without the reasoning some models leave in it.
 *
 * Qwen- and DeepSeek-style models think inside `<think>…</think>`, and when a
 * seller's chat template opens that block for them the reply carries only the
 * closing tag: everything before an unpaired `</think>` is the model thinking
 * aloud. An owner read a bare `</think>` at the end of an answer on
 * 2026-11-02 (SRI-66). Only a leading block or an unpaired closing tag is
 * removed, so an answer that talks *about* the tag mid-sentence keeps it.
 */
export function stripReasoning(text: string): string {
  let rest = text;
  for (;;) {
    const lead = /^\s*<think>[\s\S]*?<\/think>/.exec(rest);
    if (!lead) break;
    rest = rest.slice(lead[0].length);
  }
  const close = rest.indexOf("</think>");
  if (close !== -1 && !rest.slice(0, close).includes("<think>")) rest = rest.slice(close + "</think>".length);
  return rest === text ? text : rest.trim();
}
