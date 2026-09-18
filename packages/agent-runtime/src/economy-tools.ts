import type { EconomyGateway } from "@opencrowd/economy";
import type { DynamicToolsOption } from "./index.js";

export const MAX_REVIEW_ATTEMPTS = 2;
export interface EconomyTools extends DynamicToolsOption {
  completionGate(): Promise<string | undefined>;
}
/** A registry outage or rejected identity must not hold the user's result
 * hostage. Keep the immutable receipt and pending review for later retry. */
export function economyTools(economy: Pick<EconomyGateway, "definitions" | "execute" | "hasPendingRequiredReviews">, options: { hidden?: ReadonlySet<string>; resuming?: boolean } = {}): EconomyTools {
  let failedReviews = 0;
  return {
    definitions: economy.definitions().filter(tool => !options.hidden?.has(tool.name)),
    execute: async (name, args, operationId) => {
      if (options.resuming && name === "call_paid_service") await economy.execute("inspect_paid_service", { url: args.url, method: args.method, sample_body: args.body });
      const result = await economy.execute(name, args, operationId);
      if (name === "review_paid_service" && !result.ok) failedReviews++;
      return result;
    },
    completionGate: async () => failedReviews >= MAX_REVIEW_ATTEMPTS || !(await economy.hasPendingRequiredReviews())
      ? undefined : "a paid purchase still needs its required review; submit it with review_paid_service"
  };
}
