import { FinancialStateSchema, type FinancialState, ContextWindowExceeded, isContextWindowError, MODEL_REQUEST_MAX_BYTES, MODEL_BRIDGE_TIMEOUT_MS, SERVICE_BRIDGE_TIMEOUT_MS, SERVICE_RESPONSE_MAX_BYTES } from "@opencrowd/protocol";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { OPEN_CROWD_TOOLS, readArtifact, type ToolResult } from "@opencrowd/core";
import type { DynamicToolDefinition, LlmProvider, LlmResponse } from "./index.js";
import { RuntimePause, type HostedToolExecutor } from "./worker.js";

/** A definitive request failure with resolved payment state; fail with the
 * gateway's message instead of pausing for reconciliation. */
export class HostedRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "HostedRequestError";
  }
}

/** Narrow local transport. The supervisor owns remote authorization; neither
 * model code nor the agent subprocess receives wallet or gateway credentials.
 * `extraTools` are the run's dynamic (economy gateway) definitions, advertised
 * to the hosted model alongside the built-in tools. */
export function createHostedProvider(options: { socketPath: string; runId: string; sessionId: string; extraTools?: DynamicToolDefinition[] }): LlmProvider {
  if (!isAbsolute(options.socketPath)) throw new Error("Hosted bridge socket must be absolute");
  const tools = [...OPEN_CROWD_TOOLS.filter(tool => !["spawn_subagent", "check_subagents"].includes(tool.name)).map(tool => tool.name === "get_budget_status"
    ? { ...tool, description: "Read authoritative hosted finances: live USDC wallet balance, settled inference and service spending, pending holds, and remaining authorized budget for this run." } : tool), ...(options.extraTools ?? [])];
  return {
    async complete(messages, context) {
      const operationId = context?.operationId;
      if (!operationId?.startsWith(`${options.runId}:llm:`)) throw new Error("Hosted model operation scope is missing");
      const body = JSON.stringify({ runId: options.runId, sessionId: options.sessionId, operationId, messages: messages.map(({ contextArchive: _archive, ...message }) => message), tools });
      if (Buffer.byteLength(body) > MODEL_REQUEST_MAX_BYTES) throw new Error("Hosted request exceeds the transport byte limit");
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
        req.setTimeout(MODEL_BRIDGE_TIMEOUT_MS, () => req.destroy(new Error("Hosted bridge timed out")));
        req.on("error", reject); req.end(body);
      }).catch(error => {
        if (context?.signal?.aborted || error instanceof HostedRequestError || error instanceof ContextWindowExceeded) throw error;
        // An interrupted bridge may have submitted payment. Pause this exact
        // operation; never switch providers or create a fresh purchase.
        throw new RuntimePause("payment_unknown", operationId, "Model request interrupted; payment status needs reconciliation.");
      });
      if (result.status === "context_exceeded" && result.operationId === operationId && ["settled", "unpaid"].includes(result.payment))
        throw new ContextWindowExceeded("Provider context window exceeded");
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

/** Unpaid rejections and saved, settled model failures need no reconciliation. */
function rejectedRequest(status: number, text: string): Error | undefined {
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object") return undefined;
    if (body.paid === true && body.error === "model_failed")
      return new HostedRequestError("model_failed", status, String(body.message ?? "The model response failed after payment settled. Its receipt is saved."));
    if (body.paid !== false) return undefined;
    if (isContextWindowError({ code: body.error, message: body.message })) return new ContextWindowExceeded(String(body.message ?? "Provider context window exceeded"));
    const code = typeof body.error === "string" && body.error ? body.error : `http_${status}`;
    return new HostedRequestError(code, status, typeof body.message === "string" && body.message ? body.message : `The model request was rejected (${code})`);
  } catch { return undefined; }
}

/** Upper bound on one supervisor-executed tool request, including inlined source. */
const HOSTED_TOOL_REQUEST_BYTES = 1024 * 1024;

export interface HostedBridgeOptions { socketPath: string; runId: string; sessionId: string }

/** Diagnostic reads must never turn an already-paid answer into a retry. */
export async function readHostedFinancialState(options: HostedBridgeOptions): Promise<FinancialState> {
  try {
    const reply = await postHostedTool(options, "economy.balance", {}, { timeoutMs: 10000 });
    const parsed = FinancialStateSchema.safeParse((reply.data as { financial_state?: unknown } | undefined)?.financial_state);
    if (reply.ok && parsed.success && parsed.data.status === "available" && parsed.data.run_id === options.runId)
      return parsed.data;
  } catch { /* unavailable is explicit; never fall back to local accounting */ }
  return { status: "unavailable", reason: "Hosted financial state could not be read. Do not infer balance or spending from the local session budget." };
}

/** The supervisor's reply to `POST /tool`: a tool result, optionally with a machine-readable failure code. */
export interface HostedToolReply { ok: boolean; data?: unknown; error?: string; code?: string }

/**
 * One bounded `POST /tool` on the credential-free supervisor socket. Rejects
 * on oversize, transport failure, a non-200 status, or a malformed reply;
 * callers decide whether a lost reply is harmless (deploys) or ambiguous
 * (payments).
 */
/** The runtime gave up waiting on the supervisor socket; the request may still be executing behind it. */
export class HostedToolTimeout extends Error {
  readonly code = "hosted_tool_timeout";
  constructor(name: string, readonly timeoutMs: number) {
    super(`Hosted tool ${name} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "HostedToolTimeout";
  }
}

export async function postHostedTool(options: HostedBridgeOptions, name: string, args: Record<string, unknown>,
  settings: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HostedToolReply> {
  if (!isAbsolute(options.socketPath)) throw new Error("Hosted bridge socket must be absolute");
  const body = JSON.stringify({ runId: options.runId, sessionId: options.sessionId, name, arguments: args });
  if (Buffer.byteLength(body) > HOSTED_TOOL_REQUEST_BYTES) throw new Error("tool request exceeds 1 MiB");
  const result = await new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: options.socketPath, path: "/tool", method: "POST", signal: settings.signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > SERVICE_RESPONSE_MAX_BYTES) res.destroy(new Error("Hosted tool response exceeds media limit"));
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
    const timeoutMs = settings.timeoutMs ?? SERVICE_BRIDGE_TIMEOUT_MS;
    req.setTimeout(timeoutMs, () => req.destroy(new HostedToolTimeout(name, timeoutMs)));
    req.on("error", reject); req.end(body);
  });
  if (typeof result?.ok !== "boolean") throw new Error("Invalid hosted tool response");
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: String(result.error ?? "tool failed"), ...(typeof result.code === "string" ? { code: result.code } : {}) };
}

/**
 * Supervisor-executed tools (deploy_service, request_secret) travel over the
 * same credential-free socket. For deploy_service the worker inlines the entry
 * artifact so the supervisor never reads the workspace on the agent's behalf;
 * request_secret forwards its arguments untouched. The supervisor owns every
 * remote credential and secret value and returns a plain tool result.
 */
export function createHostedToolExecutor(options: HostedBridgeOptions): HostedToolExecutor {
  if (!isAbsolute(options.socketPath)) throw new Error("Hosted bridge socket must be absolute");
  return async (name, args, context) => {
    let source: string | undefined;
    if (name === "deploy_service") {
      if (typeof args.entry !== "string" || !args.entry) return { ok: false, error: "entry is required: the artifact path of the service module" };
      try { source = await readArtifact(context.session, args.entry); }
      catch (error) { return { ok: false, error: `entry could not be read: ${(error as Error).message}` }; }
    }
    try {
      const result = await postHostedTool(options, name, { ...args, ...(source === undefined ? {} : { source }) }, { signal: context.signal });
      return (result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error ?? "tool failed" }) as ToolResult;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      if ((error as Error).message === "tool request exceeds 1 MiB") return { ok: false, error: "tool request exceeds 1 MiB; reduce the service source" };
      // Unlike model calls, a lost tool response never implies a payment; the
      // deploy is idempotent per slug, so the model may simply retry.
      return { ok: false, error: `hosted tool unavailable: ${(error as Error).message}` };
    }
  };
}
