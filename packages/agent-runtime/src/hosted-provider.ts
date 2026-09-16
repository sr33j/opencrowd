import { request } from "node:http";
import { isAbsolute } from "node:path";
import { OPEN_CROWD_TOOLS, readArtifact, type ToolResult } from "@opencrowd/core";
import type { LlmMessage, LlmProvider, LlmResponse } from "./index.js";
import { RuntimePause, type HostedToolExecutor } from "./worker.js";

/** The bridge refused the request before any payment was made (`paid: false`);
 * the run fails with this message instead of pausing for reconciliation. */
export class HostedRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "HostedRequestError";
  }
}

const TRUNCATED_TOOL_OUTPUT = JSON.stringify({ truncated: true, note: "older tool output removed to fit the model context; re-run the tool if you need it" });
const TRIMMED_PREFIX = "[…trimmed…]";
const TRIMMED_TAIL_CHARS = 6000;

/**
 * Fit a replayed conversation under the bridge's request budget without
 * touching the system prompt, the original task, or the last four messages.
 * Older tool outputs are blanked first, then whole older turns are dropped
 * (an assistant message always takes its tool results with it so no orphan
 * result remains), and only then is a single oversized message cut down.
 * Pure and deterministic: the input array and its messages are never mutated.
 */
export function trimHostedMessages(messages: LlmMessage[], budgetBytes = 48_000): LlmMessage[] {
  const size = (list: LlmMessage[]) => Buffer.byteLength(JSON.stringify(list));
  if (size(messages) <= budgetBytes) return messages;
  let list = messages.slice();
  const firstUser = list.findIndex(m => m.role === "user");
  const eligible = (i: number) => i > firstUser && i < list.length - 4 && list[i].role !== "system";
  for (let i = 0; i < list.length && size(list) > budgetBytes; i++) {
    if (eligible(i) && list[i].role === "tool" && list[i].content.length > 300) list[i] = { ...list[i], content: TRUNCATED_TOOL_OUTPUT };
  }
  while (size(list) > budgetBytes) {
    let drop: number[] | undefined;
    for (let i = 0; i < list.length && !drop; i++) {
      if (!eligible(i)) continue;
      const m = list[i];
      if (m.role === "tool" && list.some(a => a.role === "assistant" && a.toolCalls?.some(c => c.id === m.toolCallId))) continue;
      const ids = new Set((m.toolCalls ?? []).map(c => c.id));
      const results = ids.size ? list.flatMap((r, j) => r.role === "tool" && r.toolCallId !== undefined && ids.has(r.toolCallId) ? [j] : []) : [];
      if (results.every(eligible)) drop = [i, ...results];
    }
    if (!drop) break;
    list = list.filter((_, i) => !drop!.includes(i));
  }
  const lastUser = list.map(m => m.role).lastIndexOf("user");
  while (size(list) > budgetBytes) {
    let largest = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].role === "system" || i === lastUser || list[i].content.length <= TRIMMED_PREFIX.length + TRIMMED_TAIL_CHARS) continue;
      if (largest < 0 || list[i].content.length > list[largest].content.length) largest = i;
    }
    if (largest < 0) break;
    list[largest] = { ...list[largest], content: TRIMMED_PREFIX + list[largest].content.slice(-TRIMMED_TAIL_CHARS) };
  }
  return list;
}

/** Narrow local transport. The supervisor owns remote authorization; neither
 * model code nor the agent subprocess receives wallet or gateway credentials. */
export function createHostedProvider(options: { socketPath: string; runId: string; sessionId: string }): LlmProvider {
  if (!isAbsolute(options.socketPath)) throw new Error("Hosted bridge socket must be absolute");
  return {
    async complete(messages, context) {
      const operationId = context?.operationId;
      if (!operationId?.startsWith(`${options.runId}:llm:`)) throw new Error("Hosted model operation scope is missing");
      const body = JSON.stringify({ runId: options.runId, sessionId: options.sessionId, operationId, messages: trimHostedMessages(messages),
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
              const text = Buffer.concat(chunks).toString("utf8");
              if (res.statusCode !== 200) throw rejectedRequest(res.statusCode ?? 0, text) ?? new Error("Hosted bridge request failed");
              resolve(JSON.parse(text));
            } catch (error) { reject(error); }
          });
        });
        req.setTimeout(90000, () => req.destroy(new Error("Hosted bridge timed out")));
        req.on("error", reject); req.end(body);
      }).catch(error => {
        if (context?.signal?.aborted || error instanceof HostedRequestError) throw error;
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

/** Only an explicit `paid: false` proves no charge happened; anything else stays ambiguous. */
function rejectedRequest(status: number, text: string): HostedRequestError | undefined {
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || body.paid !== false) return undefined;
    const code = typeof body.error === "string" && body.error ? body.error : `http_${status}`;
    return new HostedRequestError(code, status, typeof body.message === "string" && body.message ? body.message : `The model request was rejected (${code})`);
  } catch { return undefined; }
}

/** Upper bound on one supervisor-executed tool request, including inlined source. */
const HOSTED_TOOL_REQUEST_BYTES = 1024 * 1024;

/**
 * Supervisor-executed tools (deploy_service, request_secret) travel over the
 * same credential-free socket. For deploy_service the worker inlines the entry
 * artifact so the supervisor never reads the workspace on the agent's behalf;
 * request_secret forwards its arguments untouched. The supervisor owns every
 * remote credential and secret value and returns a plain tool result.
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
