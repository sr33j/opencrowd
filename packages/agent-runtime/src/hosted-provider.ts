import { request } from "node:http";
import { isAbsolute } from "node:path";
import { OPEN_CROWD_TOOLS, readArtifact, type ToolResult } from "@opencrowd/core";
import type { LlmProvider, LlmResponse } from "./index.js";
import { RuntimePause, type HostedToolExecutor } from "./worker.js";

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

/** Upper bound on one supervisor-executed tool request, including inlined source. */
const HOSTED_TOOL_REQUEST_BYTES = 1024 * 1024;

/**
 * Supervisor-executed tools (currently deploy_service) travel over the same
 * credential-free socket. The worker inlines the entry artifact so the
 * supervisor never reads the workspace on the agent's behalf; the supervisor
 * owns every remote credential and returns a plain tool result.
 */
export function createHostedToolExecutor(options: { socketPath: string; runId: string; sessionId: string }): HostedToolExecutor {
  if (!isAbsolute(options.socketPath)) throw new Error("Hosted bridge socket must be absolute");
  return async (name, args, context) => {
    let source: string | undefined;
    if (name === "deploy_service") {
      if (typeof args.entry !== "string" || !args.entry) return { ok: false, error: "entry is required: the artifact path of the service module" };
      try { source = await readArtifact(context.session, args.entry); }
      catch (error) { return { ok: false, error: `entry could not be read: ${(error as Error).message}` }; }
    }
    const body = JSON.stringify({ runId: options.runId, sessionId: options.sessionId, name, arguments: { ...args, ...(source === undefined ? {} : { source }) } });
    if (Buffer.byteLength(body) > HOSTED_TOOL_REQUEST_BYTES) return { ok: false, error: "tool request exceeds 1 MiB; reduce the service source" };
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const req = request({ socketPath: options.socketPath, path: "/tool", method: "POST", signal: context.signal,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
          const chunks: Buffer[] = []; let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) res.destroy(new Error("Hosted tool response exceeds 1 MiB"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) throw new Error(`Hosted tool request failed (${res.statusCode})`);
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) { reject(error); }
          });
        });
        req.setTimeout(180000, () => req.destroy(new Error("Hosted tool timed out")));
        req.on("error", reject); req.end(body);
      });
      if (typeof result?.ok !== "boolean") throw new Error("Invalid hosted tool response");
      return (result.ok ? { ok: true, data: result.data } : { ok: false, error: String(result.error ?? "tool failed") }) as ToolResult;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      // Unlike model calls, a lost tool response never implies a payment; the
      // deploy is idempotent per slug, so the model may simply retry.
      return { ok: false, error: `hosted tool unavailable: ${(error as Error).message}` };
    }
  };
}
