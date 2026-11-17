import type { EconomyGateway } from "@opencrowd/economy";
import type { CompletionSignals, DynamicToolsOption } from "./index.js";

export interface EconomyTools extends DynamicToolsOption {
  completionGate(alreadyNudged?: boolean, run?: CompletionSignals): Promise<string | undefined>;
}

/** A run at least this long earned a reflection on what would have helped. */
export const REFLECTION_MIN_TURNS = 8;

/**
 * An answer that hands a step back to the owner: the run ended waiting on
 * them. Narrow on purpose; a false positive costs one extra model turn.
 */
const OWNER_STEP = /\b(you(?:'ll| will)? need to|you have to|please (?:sign|log) in|please (?:upload|provide|send|share|confirm|approve|fund|add|connect|authori[sz]e)|(?:do|finish|complete) (?:this|that|it) (?:manually|by hand)|manually (?:book|call|file|submit|upload|enter|complete)|waiting (?:for|on) your|requires? your (?:approval|login|confirmation))\b/i;

/** Why this run qualifies for the reflection, or undefined when it does not. */
export function reflectionTrigger(run: CompletionSignals | undefined): string | undefined {
  if (!run) return "unknown run";
  if (run.paidCalls > 0) return "bought a service";
  if (run.failedTools > 0) return "a tool failed";
  if (run.turns >= REFLECTION_MIN_TURNS) return "many turns";
  if (run.finalMessage && OWNER_STEP.test(run.finalMessage)) return "ended waiting on the owner";
  return undefined;
}

export const REFLECTION_NUDGE = "Before this run ends, reflect once: what concrete paid service would have fixed an observed failure, a poor result or excessive cost in this task? For each worthwhile one, call request_service with input, output, problem, builds_on (what it could be built from today: an official API, a licensed dataset, existing paid services, a human-ops team), frequency (one_off, per_task_like_this or recurring) and price_per_call (an estimate, not a budget). Describe a reusable service, never this task's answer restated. A prior purchase or spending permission is not required. If nothing qualifies, submit nothing. Then call complete_session again to finish.";

/**
 * The paid tools, and the one thing they ask of a run before it completes:
 * an optional reflection on which services would have helped. No review is
 * ever owed: CrowdCode's gateway judges every settled hosted purchase by
 * itself (SRI-115), so a purchase never holds the run open.
 *
 * The reflection costs a model turn, so it is asked only of runs that earned
 * it (C6): one that bought something, had a failed tool, used at least
 * REFLECTION_MIN_TURNS turns, or ended waiting on the owner.
 */
export function economyTools(economy: Pick<EconomyGateway, "definitions" | "execute">, options: { hidden?: ReadonlySet<string>; resuming?: boolean } = {}): EconomyTools {
  let reflected = false;
  const supportsReflection = economy.definitions().some(tool => tool.name === "request_service");
  return {
    definitions: economy.definitions().filter(tool => !options.hidden?.has(tool.name)),
    execute: async (name, args, operationId) => {
      if (options.resuming && name === "call_paid_service") await economy.execute("inspect_paid_service", { url: args.url, method: args.method, sample_body: args.body });
      const result = await economy.execute(name, args, operationId);
      if (name === "request_service" && result.ok) reflected = true;
      return result;
    },
    completionGate: async (alreadyNudged = false, run?: CompletionSignals) => {
      if (reflected || alreadyNudged || !supportsReflection) return undefined;
      if (!reflectionTrigger(run)) return undefined;
      reflected = true;
      const status = await economy.execute("crowdcode_status", {});
      if (!status.ok || !(status.data as { enabled?: boolean })?.enabled) return undefined;
      return REFLECTION_NUDGE;
    }
  };
}
