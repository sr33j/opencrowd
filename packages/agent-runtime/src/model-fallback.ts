import type { ModelFallback } from "./index.js";

/**
 * A model's name as an owner says it: "Claude Opus 5.5", "GPT-5.6 Sol". The
 * catalog id otherwise (SRI-166).
 */
export function modelLabel(id: string): string {
  const last = id.split("/").pop() ?? id;
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)[-.](\d+)/i.exec(last);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  const gpt = /^(?:openai-)?gpt-(\d)\.?(\d)-(luna|terra|sol|astra)(-pro)?/i.exec(last);
  if (gpt) return `GPT-${gpt[1]}.${gpt[2]} ${gpt[3][0].toUpperCase()}${gpt[3].slice(1)}${gpt[4] ? " Pro" : ""}`;
  return id;
}

/** The one line the owner reads when another model answered some of a run's steps. */
export function fallbackNote(fallbacks: ModelFallback[]): string {
  const pairs = new Map<string, number>();
  for (const f of fallbacks) pairs.set(`${f.from}\u0000${f.to}`, (pairs.get(`${f.from}\u0000${f.to}`) ?? 0) + 1);
  return [...pairs].map(([key, count]) => {
    const [from, to] = key.split("\u0000");
    return `${modelLabel(from)} was unavailable, so ${count === 1 ? "one step" : `${count} steps`} used ${modelLabel(to)} instead.`;
  }).join(" ");
}
