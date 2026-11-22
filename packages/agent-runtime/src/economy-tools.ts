import type { EconomyGateway } from "@opencrowd/economy";
import type { CompletionGateResult, CompletionSignals, DynamicToolsOption } from "./index.js";
import { countShortfall } from "./service-strategy.js";

export interface EconomyTools extends DynamicToolsOption {
  completionGate(alreadyNudged?: boolean, run?: CompletionSignals): Promise<CompletionGateResult>;
}

/** A run at least this long earned a reflection on what would have helped. */
export const REFLECTION_MIN_TURNS = 8;

/**
 * An answer that hands a step back to the owner: the run ended waiting on
 * them. Narrow on purpose; a false positive costs one extra model turn.
 */
const OWNER_STEP = /\b(you(?:'ll| will)? need to|you have to|please (?:sign|log) in|please (?:upload|provide|send|share|confirm|approve|fund|add|connect|authori[sz]e)|(?:do|finish|complete) (?:this|that|it) (?:manually|by hand)|manually (?:book|call|file|submit|upload|enter|complete)|waiting (?:for|on) your|requires? your (?:approval|login|confirmation))\b/i;

/**
 * An answer that says, in the run's own words, that it did not get the task
 * done: it could not, it is partial, it needed a workaround, or no service did
 * the job. First person or explicit only, so "you cannot deduct this" in an
 * ordinary answer does not count.
 */
const SHORT_ANSWER = new RegExp([
  String.raw`\b(?:I|we)(?:['’](?:m|ve|d|re))?(?:\s+[\w'’]+){0,3}?\s+(?:unable to|couldn[’']?t|could not|can[’']?t|cannot|(?:was|were|am|are) unable to|(?:was|were|am|are)(?: not|n[’']?t) able to|did(?: not|n[’']?t) (?:manage|get|find|finish|complete)|failed to|ran out of|gave up)\b`,
  String.raw`\bpartial (?:result|answer|list|data|report|delivery)\b`,
  String.raw`\b(?:this|the) (?:task|request|result|answer|list|report) is (?:incomplete|partial|unfinished)\b`,
  String.raw`\bwork(?:ed)? ?around\b`,
  String.raw`\bno (?:paid |available |suitable )?(?:service|api|provider|endpoint)s? (?:could|can|was able|were able|offers?|returned|provides?|is available|was available|exists?)\b`,
].join("|"), "i");

/** The run, by its own answer or its task's explicit count, stopped short of its task (SRI-122). */
export function endedShort(run: CompletionSignals | undefined): boolean {
  if (!run?.finalMessage) return false;
  return SHORT_ANSWER.test(run.finalMessage) || (!!run.task && !!countShortfall(run.task, run.finalMessage));
}

/** Why this run qualifies for the reflection, or undefined when it does not. */
export function reflectionTrigger(run: CompletionSignals | undefined): string | undefined {
  if (!run) return "unknown run";
  if (endedShort(run)) return "ended short of its task";
  if (run.paidCalls > 0) return "bought a service";
  if (run.failedTools > 0) return "a tool failed";
  if (run.turns >= REFLECTION_MIN_TURNS) return "many turns";
  if (run.finalMessage && OWNER_STEP.test(run.finalMessage)) return "ended waiting on the owner";
  return undefined;
}

/**
 * What was missing decides where it goes (SRI-159): a gap in CrowdCode's own
 * tools, data or notices is harness feedback; only a service an outside
 * provider could build and sell is a service request. A chief of staff that
 * could not break revenue down by service filed "a per-service revenue
 * breakdown" as a marketplace request (#245) because this said only
 * request_service.
 */
const ROUTE_GAP = "First decide what was missing. If it was CrowdCode's own data or tools (an internal API or report, an action a CrowdCode tool lacks, a notice that left something out, a limit or a confusing error), call submit_harness_feedback once with what was missing and the change you would make, and do not file it with request_service. request_service is only for a paid external service that someone outside could build and sell to any agent.";
/**
 * An answer that says a capability is unavailable: no access, no browser, "I
 * can't open / fill in / call / order". Paired with a run that never searched
 * the directory, it is the refusal SRI-159 caught on production: a real owner
 * asked why the agent couldn't use a browser, and it said it had no
 * browser-control access without looking; Browser Use, Browserbase and
 * StableBrowser were all listed. A false positive costs one search turn.
 */
const UNAVAILABLE = new RegExp([
  String.raw`\b(?:I|we|this (?:chat )?agent|the agent)\b(?:['’]m| am| are| is)?\s+(?:[\w’'-]+\s+){0,3}?(?:do(?:es)?(?: not|n['’]?t) have|lacks?|has no|have no)\s+(?:[\w’'-]+\s+){0,3}?(?:access|tools?|abilit(?:y|ies)|capabilit(?:y|ies)|means|way|browser|integration)\b`,
  String.raw`\b(?:I|we)\b(?:\s+[\w’'-]+){0,2}?\s+(?:can['’]?t|cannot|can not|am unable to|are unable to|am not able to|are not able to)\s+(?:[\w’'-]+\s+){0,2}?(?:browse|use (?:a |the )?(?:browser|website|computer)|open|click|fill|control|operate|access|log ?in|sign ?in|navigate|interact|call|phone|text|send|post|book|place|order|buy|purchase|pay|check ?out)\b`,
  String.raw`\b(?:not|isn['’]?t|aren['’]?t) (?:available|supported|possible) (?:to me|for me|here|in this (?:chat|environment|run|conversation))\b`,
  String.raw`\b(?:beyond|outside(?: of)?) (?:my|this agent['’]s) (?:capabilities|abilities|tools)\b`,
  String.raw`\bno (?:browser|tool|way|means|ability|access) to\b`,
].join("|"), "i");

/** The answer says something can't be done for lack of a capability (SRI-159). */
export function claimsUnavailable(finalMessage: string | undefined): boolean {
  return !!finalMessage && UNAVAILABLE.test(finalMessage);
}

/** Asked, once, of a run that says a capability is unavailable without having searched for it. */
export const CAPABILITY_CHECK_NUDGE = "Before you tell the owner this can't be done: your answer says a capability is unavailable, but this run has not searched CrowdCode's directory for it. Paid services cover much of what you lack, for example a remote browser that opens pages, clicks and fills in forms (browser automation, computer use), phone calls and SMS, email, posting and booking. Call find_paid_service (or browse_services) for the capability now. If a fitting service exists, offer it to the owner by its name and host, with the price its search result lists and whether it is verified; an unverified one can still be used, and the spending guard asks the owner before paying. Say plainly only the limits that remain: you pay in USDC, not by card, so a browser service can fill in a retailer's checkout but you can't pay a normal retailer. Then call complete_session again.";

export const REFLECTION_NUDGE = `Before this run ends, reflect once. ${ROUTE_GAP} For each worthwhile external service that would have fixed an observed failure, a poor result or excessive cost in this task, call request_service with input, output, problem, builds_on (what it could be built from today: an official API, a licensed dataset, existing paid services, a human-ops team), frequency (one_off, per_task_like_this or recurring) and price_per_call (an estimate, not a budget). Describe a reusable service, never this task's answer restated. A prior purchase or spending permission is not required. If nothing qualifies, submit nothing. Then call complete_session again to finish.`;

/**
 * Asked instead when the run ends short of its task (SRI-122): one request for
 * the service that would have let it finish, and one review of an endpoint
 * that worked but fell short of the task, if the run has not written it
 * (SRI-135). CrowdCode's gateway judges every settled purchase anyway. It
 * comes after SRI-119's early-stop question, never instead of it, and like it
 * is asked once.
 */
export const SHORT_RUN_NUDGE = `This run is ending short of its task: it could not finish, delivered a partial result or needed a costly workaround. ${ROUTE_GAP} If an external service would have let you finish, call request_service once for it: input, output, problem, builds_on (what it could be built from today: an official API, a licensed dataset, existing paid services, a human-ops team), frequency (one_off, per_task_like_this or recurring) and price_per_call (an estimate, not a budget). Describe a reusable service, never this task's answer restated. A prior purchase or spending permission is not required. If a paid call worked but fell short of the task (a cap, partial coverage, a workaround) and you have not reviewed that endpoint in this run, also call review_paid_service once for it, stating the limit against the task; CrowdCode already judges every other paid call you made. Skip both if the task did in fact finish without a workaround. Then call complete_session again to finish.`;

/**
 * The paid tools, and the one thing they ask of a run before it completes:
 * an optional reflection on which services would have helped. No review is
 * ever owed: CrowdCode's gateway judges every settled hosted purchase by
 * itself (SRI-115), so a purchase never holds the run open.
 *
 * The reflection costs a model turn, so it is asked only of runs that earned
 * it (C6): one that ended short of its task (asked for one request, SRI-122),
 * bought something, had a failed tool, used at least REFLECTION_MIN_TURNS
 * turns, or ended waiting on the owner.
 */
export function economyTools(economy: Pick<EconomyGateway, "definitions" | "execute">, options: { hidden?: ReadonlySet<string>; resuming?: boolean } = {}): EconomyTools {
  let reflected = false;
  const supportsReflection = economy.definitions().some(tool => tool.name === "request_service");
  const supportsDiscovery = economy.definitions().some(tool => tool.name === "find_paid_service");
  return {
    definitions: economy.definitions().filter(tool => !options.hidden?.has(tool.name)),
    execute: async (name, args, operationId) => {
      if (options.resuming && name === "call_paid_service") await economy.execute("inspect_paid_service", { url: args.url, method: args.method, sample_body: args.body });
      const result = await economy.execute(name, args, operationId);
      if (name === "request_service" && result.ok) reflected = true;
      return result;
    },
    completionGate: async (alreadyNudged = false, run?: CompletionSignals) => {
      // Searching comes before saying no, and before any reflection (SRI-159).
      if (!alreadyNudged && supportsDiscovery && run && !run.discoveryCalls && claimsUnavailable(run.finalMessage)) return { nudge: CAPABILITY_CHECK_NUDGE, revise: true };
      if (reflected || alreadyNudged || !supportsReflection) return undefined;
      const trigger = reflectionTrigger(run);
      if (!trigger) return undefined;
      reflected = true;
      const status = await economy.execute("crowdcode_status", {});
      if (!status.ok || !(status.data as { enabled?: boolean })?.enabled) return undefined;
      return endedShort(run) ? SHORT_RUN_NUDGE : REFLECTION_NUDGE;
    }
  };
}
