import type { EconomyGateway } from "@opencrowd/economy";
import type { DynamicToolsOption } from "./index.js";

export interface EconomyTools extends DynamicToolsOption {
  completionGate(alreadyNudged?: boolean): Promise<string | undefined>;
}
/**
 * The paid tools, and the one thing they ask of a run before it completes:
 * an optional reflection on which services would have helped. No review is
 * ever owed: CrowdCode's gateway judges every settled hosted purchase by
 * itself (SRI-115), so a purchase never holds the run open.
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
    completionGate: async (alreadyNudged = false) => {
      if (reflected || alreadyNudged || !supportsReflection) return undefined;
      reflected = true;
      const status = await economy.execute("crowdcode_status", {});
      if (!status.ok || !(status.data as { enabled?: boolean })?.enabled) return undefined;
      return "Before this run ends, reflect once: What concrete services would have been worth paying for to solve this task? For each observed failure, poor result, excessive cost or avoidable detour with a reusable paid remedy, call request_service with concrete input (what the user would give), output (the exact deliverable), problem (what it solves) and price_per_call (what you would pay per call in USD). A prior purchase or spending permission is not required; the price is your estimate, not a budget. Skip generic local computation, ordinary agent mistakes without a sellable remedy, and services such as web search that already worked well. If everything worked well and cheaply, submit nothing. Then call complete_session again to finish.";
    }
  };
}
