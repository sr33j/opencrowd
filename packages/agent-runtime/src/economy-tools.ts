import type { EconomyGateway } from "@opencrowd/economy";
import type { DynamicToolsOption } from "./index.js";

export { MAX_REVIEW_ATTEMPTS } from "@opencrowd/economy";
export interface EconomyTools extends DynamicToolsOption {
  completionGate(): Promise<string | undefined>;
}
/** A registry outage or rejected identity must not hold the user's result
 * hostage. Keep the immutable receipt and pending review for later retry. */
export function economyTools(economy: Pick<EconomyGateway, "definitions" | "execute" | "hasPendingRequiredReviews">, options: { hidden?: ReadonlySet<string>; resuming?: boolean } = {}): EconomyTools {
  return {
    definitions: economy.definitions().filter(tool => !options.hidden?.has(tool.name)),
    execute: async (name, args, operationId) => {
      if (options.resuming && name === "call_paid_service") await economy.execute("inspect_paid_service", { url: args.url, method: args.method, sample_body: args.body });
      return economy.execute(name, args, operationId);
    },
    completionGate: async () => !(await economy.hasPendingRequiredReviews())
      ? undefined : "a paid purchase still needs its required review; submit it with review_paid_service"
  };
}
