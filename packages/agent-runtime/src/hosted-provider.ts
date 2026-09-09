import { request } from "node:http";
import { isAbsolute } from "node:path";
import { OPEN_CROWD_TOOLS } from "@opencrowd/core";
import type { LlmProvider, LlmResponse } from "./index.js";
import { RuntimePause } from "./worker.js";

/** Narrow local transport. The supervisor owns remote authorization; neither
 * model code nor the agent subprocess receives wallet or gateway credentials. */
export function createHostedProvider(options: { socketPath: string; runId: string; sessionId: string }): LlmProvider {
  if (!isAbsolute(options.socketPath)) throw new Error("Hosted bridge socket must be absolute");
  return {
    async complete(messages, context) {
      const operationId = context?.operationId;
      if (!operationId?.startsWith(`${options.runId}:llm:`)) throw new Error("Hosted model operation scope is missing");
      const body = JSON.stringify({ runId: options.runId, sessionId: options.sessionId, operationId, messages,
        tools: OPEN_CROWD_TOOLS.filter(tool => !["spawn_subagent", "check_subagents"].includes(tool.name)) });
      if (Buffer.byteLength(body) > 64000) throw new Error("Hosted model context exceeds 64 KiB");
      const result = await new Promise<any>((resolve, reject) => {
        const req = request({ socketPath: options.socketPath, path: "/model", method: "POST", signal: context?.signal,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
          const chunks: Buffer[] = []; let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) res.destroy(new Error("Hosted response exceeds 1 MiB"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) throw new Error("Hosted bridge request failed");
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) { reject(error); }
          });
        });
        req.setTimeout(90000, () => req.destroy(new Error("Hosted bridge timed out")));
        req.on("error", reject); req.end(body);
      }).catch(error => {
        if (context?.signal?.aborted) throw error;
        // An interrupted bridge may have submitted payment. Pause this exact
        // operation; never switch providers or create a fresh purchase.
        throw new RuntimePause("payment_unknown", operationId, "Model request interrupted; payment status needs reconciliation.");
      });
      if (result.status === "paused") {
        if (!["waiting_for_approval", "waiting_for_funds", "waiting_for_delegation", "payment_unknown"].includes(result.outcome)
          || result.operationId !== operationId) throw new Error("Invalid hosted pause response");
        throw new RuntimePause(result.outcome, operationId, String(result.message ?? "Run paused"));
      }
      if (result.status !== "complete" || typeof result.response?.content !== "string" || !Array.isArray(result.response.toolCalls))
        throw new Error("Invalid hosted model response");
      for (const call of result.response.toolCalls) {
        if (typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.arguments
          || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error("Invalid hosted tool call");
      }
      return result.response as LlmResponse;
    }
  };
}
