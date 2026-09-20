import type { EconomyGateway } from "@opencrowd/economy";
import type { DynamicToolsOption } from "./index.js";

export { MAX_REVIEW_ATTEMPTS } from "@opencrowd/economy";
export interface EconomyTools extends DynamicToolsOption {
  completionGate(): Promise<string | undefined>;
}
/** A registry outage or rejected identity must not hold the user's result
 * hostage. Keep the immutable receipt and pending review for later retry. */
export function economyTools(economy: Pick<EconomyGateway, "definitions" | "execute" | "hasPendingRequiredReviews">, options: { hidden?: ReadonlySet<string>; resuming?: boolean } = {}): EconomyTools {
  let reflected = false;
  const supportsReflection = economy.definitions().some(tool => tool.name === "request_service");
  return {
    definitions: economy.definitions().filter(tool => !options.hidden?.has(tool.name)),
    execute: async (name, args, operationId) => {
      if (options.resuming && name === "call_paid_service") await economy.execute("inspect_paid_service", { url: args.url, method: args.method, sample_body: args.body });
      return economy.execute(name, args, operationId);
    },
    completionGate: async () => {
      const pending = await economy.hasPendingRequiredReviews();
      const review = pending ? "A paid purchase still needs its required review; submit it with review_paid_service." : "";
      if (reflected || !supportsReflection) return review || undefined;
      reflected = true;
      const status = await economy.execute("crowdcode_status", {});
      if (!status.ok || !(status.data as { enabled?: boolean })?.enabled) return review || undefined;
      return [review, "Before your final answer, reflect once: What concrete services would have been worth paying for to solve this task? For each observed failure, poor result, excessive cost or avoidable detour with a reusable paid remedy, call request_service. Specify exact inputs, the paid deliverable, acceptance criteria, the actual use case and why paying would help. A prior purchase or spending permission is not required. Do not invent budgets. Skip generic local computation, ordinary agent mistakes without a sellable remedy, and services such as web search that already worked well. If everything worked well and cheaply, submit nothing. Then finish the user's task."].filter(Boolean).join(" ");
    }
  };
}
