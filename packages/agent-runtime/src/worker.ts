import { beginQuery, SpendingDeclined } from "@opencrowd/core";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  atomicWrite, containedPath, createSession, executeTool, loadSession, resolveAgentPaths, summarizeToolInput, HOSTED_ONLY_TOOL_NAMES,
  type AgentPaths, type SessionState, type ToolContext, type ToolName, type ToolResult
} from "@opencrowd/core";
import {
  encodeEvent, parseCommandLine, RUN_FAILURE_MESSAGE, type CommandOf, type Event, type EventType,
  type EventPayload, type RunOutcome
} from "@opencrowd/protocol";
import type { EconomyGateway } from "@opencrowd/economy";
import { runAgentTaskDetailed, type DynamicToolDefinition, type LlmProvider, type LoopCheckpoint, type ToolExecutor } from "./index.js";
import { hostedDynamicTools } from "./hosted-economy.js";
import { loadKnowledgeTree } from "./knowledge.js";

export class RuntimePause extends Error {
  constructor(readonly outcome: RunOutcome, readonly operationId: string, message: string) {
    super(message);
    this.name = "RuntimePause";
  }
}

interface DurableRun {
  inbox?: Array<{ id: string; prompt: string }>;
  start: CommandOf<"run.start">;
  sessionId: string;
  commandId: string;
  outcome?: RunOutcome;
  checkpoint?: LoopCheckpoint;
  checkpointId: string;
  pendingOperationId?: string;
  summary?: string;
  tools: Record<string, { digest: string; result?: ToolResult; approvalPending?: boolean }>;
}
interface WorkerState {
  version: 1;
  seq: number;
  commands: Record<string, string>;
  runs: Record<string, DurableRun>;
  activeRunId?: string;
}
/** Executes supervisor-owned tools (HOSTED_ONLY_TOOL_NAMES) outside the agent process. */
export type HostedToolExecutor = (name: ToolName, args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

export interface WorkerOptions {
  agentHome: string;
  /** Inject a remote-only provider or demo. No local provider selection occurs. `extraTools` are the run's economy tool definitions. */
  provider: (run: CommandOf<"run.start">, session: SessionState, extraTools: DynamicToolDefinition[]) => LlmProvider;
  output: (line: string) => void | Promise<void>;
  toolExecutor?: ToolExecutor;
  /** Supervisor-executed tools; absent means hosted-only tools report themselves unavailable. */
  hostedTools?: (run: CommandOf<"run.start">, session: SessionState) => HostedToolExecutor;
  /** Paid-capability gateway (hosted adapters); absent means paid services are unavailable to the model. */
  economy?: (run: CommandOf<"run.start">, session: SessionState) => EconomyGateway;
  now?: () => Date;
  id?: () => string;
}

/** Durable single-agent process boundary. stdout is exclusively validated protocol. */
export class MachineWorker {
  readonly paths: AgentPaths;
  private state: WorkerState = { version: 1, seq: 0, commands: Object.create(null), runs: Object.create(null) };
  private writes: Promise<void> = Promise.resolve();
  private running?: Promise<void>;
  private controller?: AbortController;
  private shuttingDown = false;
  private readonly statePath: string;

  constructor(private readonly options: WorkerOptions) {
    this.paths = resolveAgentPaths({ agentHome: options.agentHome });
    this.statePath = join(this.paths.metadata, "worker.json");
  }

  async initialize(): Promise<void> {
    await containedPath(this.paths.home!, "metadata/worker.json");
    await mkdir(this.paths.metadata, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8")) as WorkerState;
      if (this.state.version !== 1 || !Number.isSafeInteger(this.state.seq) || !this.state.commands || !this.state.runs) {
        throw new Error("worker checkpoint version or shape is invalid");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.state.commands = Object.assign(Object.create(null), this.state.commands);
    this.state.runs = Object.assign(Object.create(null), this.state.runs);
    for (const run of Object.values(this.state.runs)) run.tools = Object.assign(Object.create(null), run.tools);
    await this.emit("worker.ready", { protocolVersion: 1, runtimeVersion: "0.3.2-worker.1", restoredRunId: this.state.activeRunId });
  }

  private mutate(fn: () => void): Promise<void> {
    const write = this.writes.then(async () => { fn(); await atomicWrite(this.statePath, JSON.stringify(this.state)); });
    this.writes = write;
    return write;
  }

  private async emit<T extends EventType>(type: T, payload: EventPayload<T>, runId?: string, commandId?: string): Promise<void> {
    let line = "";
    await this.mutate(() => {
      line = encodeEvent({ protocolVersion: 1, id: this.options.id?.() ?? randomUUID(),
        seq: ++this.state.seq, emittedAt: (this.options.now?.() ?? new Date()).toISOString(),
        type, payload, ...(runId ? { runId } : {}), ...(commandId ? { commandId } : {}) } as Event);
    });
    await this.options.output(line);
  }

  async handleLine(line: string): Promise<void> {
    if (Buffer.byteLength(line) > 1_048_576) throw new Error("command exceeds 1 MiB");
    const parsed = parseCommandLine(line);
    if (!parsed.ok) {
      await this.emit("command.rejected", {
        reason: parsed.error.kind === "unsupported_version" ? "unsupported_version" : "invalid_command",
        message: "Command did not pass protocol validation"
      });
      return;
    }
    const command = parsed.value;
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const previous = this.state.commands[command.id];
    const runId = "runId" in command ? command.runId as string : undefined;
    const reject = (reason: EventPayload<"command.rejected">["reason"], message: string) =>
      this.emit("command.rejected", { commandType: command.type, reason, message }, runId, command.id);
    if (previous && previous !== digest) return reject("conflicting_duplicate", "Command ID was already used with different content");
    if (this.shuttingDown) return reject("shutting_down", "Worker is shutting down");
    if (command.type === "worker.shutdown") {
      this.shuttingDown = true;
      this.controller?.abort();
      await this.running;
      await this.mutate(() => { this.state.commands[command.id] = digest; });
      await this.emit("command.accepted", { commandType: command.type, duplicate: !!previous }, undefined, command.id);
      return;
    }
    if (command.type === "run.cancel") {
      const run = this.state.runs[command.runId];
      if (!run) return reject("unknown_run", "Run does not exist");
      await this.mutate(() => { this.state.commands[command.id] = digest; });
      await this.emit("command.accepted", { commandType: command.type, duplicate: !!previous }, command.runId, command.id);
      if (this.state.activeRunId === command.runId && this.controller) this.controller.abort();
      else if (!run.outcome || isWaiting(run.outcome)) await this.finish(command.runId, run, "cancelled", command.payload.reason);
      return;
    }
    if (command.type === "run.message") {
      const run = this.state.runs[command.runId];
      if (!run || (run.outcome && !isWaiting(run.outcome))) return reject("run_not_resumable", "Message arrived after the run ended; queue it as a new turn");
      await this.mutate(() => {
        this.state.commands[command.id] = digest;
        run.inbox ??= [];
        if (!run.inbox.some(m => m.id === command.id)) run.inbox.push({ id: command.id, prompt: command.payload.prompt });
      });
      await this.emit("command.accepted", { commandType: command.type, duplicate: !!previous }, command.runId, command.id);
      return;
    }
    if (this.running) {
      if (previous) {
        await this.emit("command.accepted", { commandType: command.type, duplicate: true }, command.runId, command.id);
        return;
      }
      return reject("run_active", "Only one run may execute per agent");
    }
    let run = this.state.runs[command.runId];
    if (previous && run?.outcome) {
      await this.emit("command.accepted", { commandType: command.type, duplicate: true }, command.runId, command.id);
      for (const message of run.inbox ?? []) if (run.checkpoint?.deliveredMessageIds?.includes(message.id))
        await this.emit("user.message", { messageId: message.id, content: message.prompt }, command.runId, message.id);
      await this.emit("run.finished", { sessionId: run.sessionId, outcome: run.outcome, checkpointId: run.checkpointId,
        summary: run.summary, pendingOperationId: run.pendingOperationId }, command.runId, command.id);
      return;
    }
    if (command.type === "run.resume") {
      if (!run) return reject("unknown_run", "Run does not exist");
      if (!run.outcome || !isWaiting(run.outcome) || command.payload.sessionId !== run.sessionId
        || (command.payload.checkpointId && command.payload.checkpointId !== run.checkpointId)
        || (run.pendingOperationId && command.payload.operationId !== run.pendingOperationId)) {
        return reject("run_not_resumable", "Resume does not match the waiting operation and checkpoint");
      }
      const causes: Partial<Record<RunOutcome, string>> = {
        waiting_for_approval: "approval_granted", waiting_for_funds: "funds_available",
        waiting_for_delegation: "delegation_renewed", payment_unknown: "payment_reconciled"
      };
      if (causes[run.outcome] !== command.payload.cause) return reject("run_not_resumable", "Resume cause does not resolve this wait");
    } else if (run && !previous) {
      return reject("conflicting_duplicate", "Run ID already exists");
    } else if (!run) {
      run = { start: command, sessionId: command.payload.session.sessionId ?? randomUUID(), commandId: command.id,
        checkpointId: randomUUID(), tools: Object.create(null) };
    }
    if (this.state.activeRunId && this.state.activeRunId !== command.runId) return reject("run_active", "An unfinished run must be resolved first");
    const current = run;
    await this.mutate(() => {
      this.state.commands[command.id] = digest;
      current.commandId = command.id;
      current.outcome = undefined;
      this.state.runs[command.runId] = current;
      this.state.activeRunId = command.runId;
    });
    await this.emit("command.accepted", { commandType: command.type, duplicate: !!previous }, command.runId, command.id);
    this.controller = new AbortController();
    this.running = this.execute(command.runId, current, this.controller.signal).finally(() => {
      this.running = undefined; this.controller = undefined;
    });
    // Keep the rejection observed while controls continue to be read; drain rethrows it.
    void this.running.catch(() => undefined);
  }

  private async execute(runId: string, run: DurableRun, signal: AbortSignal): Promise<void> {
    try {
      let session: SessionState;
      try { session = await loadSession(this.paths.workspace, run.sessionId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || run.start.payload.session.kind === "existing") throw error;
        const cents = BigInt(run.start.payload.budget.limit) / 10_000n;
        if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("budget exceeds local accounting range");
        session = await createSession({ workspaceRoot: this.paths.workspace, sessionId: run.sessionId,
          budgetCents: Number(cents), approvalMode: run.start.payload.approvalMode, shellEnabled: true });
      }
      await beginQuery(session, runId);
      await this.emit("run.state", { sessionId: session.sessionId, state: "running" }, runId, run.commandId);
      const local = this.options.toolExecutor ?? executeTool;
      const hosted = this.options.hostedTools?.(run.start, session);
      const economy = this.options.economy?.(run.start, session);
      const dynamicTools = economy ? hostedDynamicTools(economy) : undefined;
      // Every tool call, built-in or economy, is recorded once per checkpoint turn and replayed from its stored result.
      const record = async (name: string, args: Record<string, unknown>, invoke: () => Promise<ToolResult>): Promise<ToolResult> => {
        const call = run.checkpoint?.response?.toolCalls.find(c => c.name === name && !run.checkpoint?.completedTools[c.id]);
        // Providers may reuse tool IDs on later turns. Results are scoped to
        // their checkpoint turn so a later call cannot replay an old result.
        const id = `${run.checkpoint?.turn ?? 0}:${call?.id ?? randomUUID()}`;
        const digest = createHash("sha256").update(JSON.stringify({ name, args })).digest("hex");
        const saved = run.tools[id];
        if (saved && saved.digest !== digest) throw new Error("tool request digest mismatch");
        if (saved?.result) return saved.result;
        if (saved && name === "run_shell") throw new Error("shell result was lost; execution requires manual reconciliation");
        if (saved && !saved.approvalPending && name === "call_paid_service") throw new Error("paid call result was lost; the payment requires manual reconciliation");
        await this.mutate(() => { run.tools[id] = { digest }; });
        await this.emit("tool.started", { toolCallId: id, toolName: name, input: summarizeToolInput(name, args) }, runId, run.commandId);
        let output: ToolResult;
        try {
          if (saved?.approvalPending && name === "call_paid_service" && economy)
            await economy.execute("inspect_paid_service", { url: args.url, method: args.method, sample_body: args.body });
          output = await invoke();
        } catch (error) {
          if (error instanceof RuntimePause && error.outcome === "waiting_for_approval")
            await this.mutate(() => { run.tools[id].approvalPending = true; });
          throw error;
        }
        await this.mutate(() => { run.tools[id].result = output; });
        await this.emit("tool.finished", { toolCallId: id, toolName: name, status: output.ok ? "ok" : "error",
          error: output.error }, runId, run.commandId);
        if (name === "save_file" && output.ok) await this.emit("artifact.created", {
          artifactId: id, name: String(args.path), path: String(args.path).replace(/^artifacts\//, "")
        }, runId, run.commandId);
        return output;
      };
      const acknowledgedMessages = new Set<string>();
      const result = await runAgentTaskDetailed(session, run.start.payload.prompt, {
        inbox: {
          pending: async () => { await this.writes; return (run.inbox ?? []).filter(m => !acknowledgedMessages.has(m.id)); },
          delivered: async ids => {
            for (const message of run.inbox ?? []) if (ids.includes(message.id))
              await this.emit("user.message", { messageId: message.id, content: message.prompt }, runId, message.id);
            for (const id of ids) acknowledgedMessages.add(id);
          }
        },
        hosted: true, runId, signal, resume: run.checkpoint, maxTurns: run.start.payload.maxTurns,
        contextWindowTokens: run.start.payload.modelPolicy.contextWindowTokens,
        maxOutputTokens: run.start.payload.modelPolicy.maxOutputTokens,
        provider: this.options.provider(run.start, session, dynamicTools?.definitions ?? []),
        history: run.checkpoint ? undefined : await this.history(session),
        ...(dynamicTools ? {
          dynamicTools: { definitions: dynamicTools.definitions, execute: (name, args) => record(name, args, () => dynamicTools.execute(name, args, `${run.checkpoint?.turn ?? 0}:${run.checkpoint?.response?.toolCalls.find(c => c.name === name && !run.checkpoint?.completedTools[c.id])?.id}`)) },
          completionGate: () => dynamicTools!.completionGate(),
          knowledge: await this.knowledgeOption(session)
        } : {}),
        onCheckpoint: async (checkpoint) => {
          await this.mutate(() => { run.checkpoint = checkpoint; run.checkpointId = randomUUID(); });
          // Human-readable mirror; worker.json is authoritative after an interrupted write.
          await atomicWrite(join(session.sessionDir, "messages.jsonl"), checkpoint.messages.filter(m => m.role !== "system")
            .map(message => JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message }) + "\n").join(""));
        },
        onMessage: async message => {
          if (message.role === "assistant" && message.content) await this.emit("assistant.message", {
            messageId: randomUUID(), content: message.content
          }, runId, run.commandId);
        },
        toolExecutor: (name, args, context) => record(name, args, () =>
          hosted && HOSTED_ONLY_TOOL_NAMES.includes(name) ? hosted(name, args, context) : local(name, args, context))
      });
      await this.finish(runId, run, result.outcome === "stopped" ? "user_stopped" : result.outcome,
        String(result.summary.final_message ?? ""));
    } catch (error) {
      if (signal.aborted) await this.finish(runId, run, "cancelled", "Run cancelled");
      else if (error instanceof RuntimePause) {
        await this.mutate(() => { run.pendingOperationId = error.operationId; });
        // Payment uncertainty belongs to the ledger, not the conversation.
        // End this task so a new user request can proceed while it reconciles.
        await this.finish(runId, run, error.outcome === "payment_unknown" ? "failed" : error.outcome,
          error.outcome === "payment_unknown" ? RUN_FAILURE_MESSAGE : error.message);
      } else if (error instanceof SpendingDeclined) await this.finish(runId, run, "user_stopped", error.message);
      else await this.finish(runId, run, "failed", RUN_FAILURE_MESSAGE);
    }
  }

  /** Keep the bundled knowledge tree when it loads; a broken snapshot must never fail a hosted run. */
  private async knowledgeOption(session: SessionState): Promise<false | undefined> {
    try { await loadKnowledgeTree(session, {}); return undefined; }
    catch { return false; }
  }

  private async history(session: SessionState): Promise<LoopCheckpoint["messages"]> {
    try {
      return (await readFile(join(session.sessionDir, "messages.jsonl"), "utf8")).split("\n").filter(Boolean)
        .map(line => JSON.parse(line).message).filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async finish(runId: string, run: DurableRun, outcome: RunOutcome, summary: string): Promise<void> {
    await this.mutate(() => {
      run.outcome = outcome; run.summary = summary; run.checkpointId = randomUUID();
      if (!isWaiting(outcome) && this.state.activeRunId === runId) this.state.activeRunId = undefined;
    });
    await this.emit("checkpoint.completed", { checkpointId: run.checkpointId, sessionId: run.sessionId,
      reason: outcome === "cancelled" ? "cancel" : isWaiting(outcome) ? "waiting" : "terminal",
      pendingOperationIds: run.pendingOperationId ? [run.pendingOperationId] : [] }, runId, run.commandId);
    await this.emit("run.finished", { sessionId: run.sessionId, outcome, summary,
      checkpointId: run.checkpointId, pendingOperationId: run.pendingOperationId }, runId, run.commandId);
  }

  async drain(): Promise<void> { await this.running; await this.writes; }
}

function isWaiting(outcome: RunOutcome): boolean {
  return ["waiting_for_approval", "waiting_for_funds", "waiting_for_delegation", "payment_unknown"].includes(outcome);
}

/** Scripted model with real filesystem tools, exclusively for fake-money staging. */
export function createWorkerDemoProvider(): LlmProvider {
  return {
    async complete(messages) {
      const lastUser = messages.map(message => message.role).lastIndexOf("user");
      const done = messages.slice(lastUser + 1).some(message => message.role === "tool");
      const prompt = messages[lastUser]?.content ?? "";
      return done ? { content: "Demo run complete. Your output is saved in result.md.", toolCalls: [] }
        : { content: "I’m saving a demonstration artifact to this session.", toolCalls: [{
          id: "demo-save", name: "save_file", arguments: { path: "result.md", content: `# OpenCrowd demo\n\n${prompt}\n\nThis artifact was created by the real worker using a scripted model. No USDC was spent.\n` }
        }] };
    }
  };
}
