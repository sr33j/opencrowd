import { checkAction, newPolicyState } from "./action-policy.js";
import { capStrings, captureDetail, DeadlineExceeded, InputTrail, MAX_EXTERNAL_STRING_CHARS, scrubText, stripReasoning, withDeadline } from "@opencrowd/protocol";
import { beginQuery, SpendingDeclined } from "@opencrowd/core";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  atomicWrite, containedPath, createSession, executeTool, loadSession, resolveAgentPaths, summarizeToolInput, HOSTED_ONLY_TOOL_NAMES, TOOL_NAMES,
  type AgentPaths, type SessionState, type ToolContext, type ToolName, type ToolResult
} from "@opencrowd/core";
import {
  encodeEvent, parseCommandLine, RUN_FAILURE_MESSAGE, PAYMENT_RECONCILING_MESSAGE, upstreamRefusalSummary, type CommandOf, type Event, type EventType, type RunKnowledge,
  type EventPayload, type RunOutcome
} from "@opencrowd/protocol";
import type { EconomyGateway } from "@opencrowd/economy";
import { repairToolPairs } from "./tool-pairs.js";
import { capToolResult, runAgentTaskDetailed, type DynamicToolDefinition, type LlmProvider, type LoopCheckpoint, type ToolCallContext, type ToolExecutor } from "./index.js";
import { hostedDynamicTools } from "./hosted-economy.js";
import { toolDeadlineError, toolDeadlineMs } from "./tool-deadlines.js";
import { loadKnowledgeTree, renderCapabilityIndex, type KnowledgeOptions, type LiveTreeOptions } from "./knowledge.js";

/** Above this the durable state is repaired on load rather than carried. Large
 * enough that an ordinary run of capped tool results never triggers it. */
const MAX_WORKER_STATE_CHARS = 2 * 1024 * 1024;

/** Finished runs whose replay record is kept; older ones are forgotten. */
export const KEEP_FINISHED_RUNS = 20;
/** Command ids remembered for duplicate detection, newest kept. */
export const KEEP_COMMANDS = 1000;

/**
 * Keep the durable state proportional to what can still happen, not to the
 * agent's whole history.
 *
 * Every `mutate()` re-serializes this file, so whatever it holds is paid for in
 * CPU on every event of every run. It used to keep every run the agent ever
 * finished, each with its whole conversation (`checkpoint.messages`) and every
 * tool result. The canary agent reached 7.5 MB after ~140 runs; on a shared
 * CPU that exhausted Fly's burst balance (558 s → 0.5 s in half an hour on
 * 2026-11-17) and from then on the worker could not even report ready inside
 * the supervisor's 30 s start budget, which failed every deploy's canary.
 *
 * A finished run is only ever *replayed* (its outcome, summary, ids, inbox and
 * which messages were delivered), never resumed, so that is all it keeps; the
 * newest KEEP_FINISHED_RUNS are kept and older ones dropped. Active and waiting
 * runs are never touched: they may still resume from their checkpoint.
 * Returns true when anything changed.
 */
export function compactWorkerState(state: WorkerState): boolean {
  let changed = false;
  const finished: string[] = [];
  for (const [id, run] of Object.entries(state.runs)) {
    if (id === state.activeRunId || !run.outcome || isWaiting(run.outcome)) continue;
    finished.push(id);
    if (Object.keys(run.tools ?? {}).length) { run.tools = Object.create(null); changed = true; }
    const checkpoint = run.checkpoint as Partial<LoopCheckpoint> | undefined;
    if (checkpoint && Object.keys(checkpoint).some(key => key !== "deliveredMessageIds")) {
      run.checkpoint = (checkpoint.deliveredMessageIds?.length
        ? { deliveredMessageIds: checkpoint.deliveredMessageIds } : undefined) as LoopCheckpoint | undefined;
      if (!run.checkpoint) delete run.checkpoint;
      changed = true;
    }
  }
  // Object key order is insertion order: the oldest finished runs come first.
  for (const id of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_RUNS))) {
    delete state.runs[id];
    changed = true;
  }
  const keep = new Set(Object.values(state.runs).map(run => run.commandId));
  const commands = Object.keys(state.commands);
  if (commands.length > KEEP_COMMANDS) {
    const recent = new Set(commands.slice(-KEEP_COMMANDS));
    for (const id of commands) if (!recent.has(id) && !keep.has(id)) { delete state.commands[id]; changed = true; }
  }
  return changed;
}

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
  /** The knowledge tree the run's prompt was built from, reported on run.finished (C7). */
  knowledge?: RunKnowledge;
  tools: Record<string, { digest: string; result?: ToolResult; approvalPending?: boolean }>;
}
/** How often streamed text is sent on: often enough to read as live, rarely enough to stay a handful of events. */
const DELTA_FLUSH_MS = 300;

export interface WorkerState {
  version: 1;
  seq: number;
  commands: Record<string, string>;
  runs: Record<string, DurableRun>;
  activeRunId?: string;
}
/** Executes supervisor-owned tools (HOSTED_ONLY_TOOL_NAMES, and control-declared `control.<name>` tools) outside the agent process. */
export type HostedToolExecutor = (name: ToolName | `control.${string}`, args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

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
  financialState?: (run: CommandOf<"run.start">, session: SessionState) => Promise<import("@opencrowd/protocol").FinancialState>;
  now?: () => Date;
  id?: () => string;
  /** Test hook: the backstop deadline for one tool call, in milliseconds. */
  toolDeadlineMs?: (name: string) => number;
  /** CrowdCode's live capability tree (default: read it); false keeps the bundled snapshot. */
  liveTree?: false | LiveTreeOptions;
  /**
   * The worker can no longer record what it does: a run's own error handling
   * failed, which only happens when its state or an event could not be
   * written (a full disk). The host should end the process, so its supervisor
   * reports the run instead of leaving it "running" with nothing behind it.
   */
  onFatal?: (error: unknown) => void;
}

/** Durable single-agent process boundary. stdout is exclusively validated protocol. */
export class MachineWorker {
  readonly paths: AgentPaths;
  private state: WorkerState = { version: 1, seq: 0, commands: Object.create(null), runs: Object.create(null) };
  private writes: Promise<void> = Promise.resolve();
  /** Each model call's input is recorded as a change from the last (SRI-127). */
  private readonly inputs = new InputTrail();
  private running?: Promise<void>;
  /** This process's financial reads per run, reported on run.finished (w124). */
  private readonly moneyReadStats = new Map<string, { reads: number; ms: number; maxMs: number }>();
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
      const raw = await readFile(this.statePath, "utf8");
      this.state = JSON.parse(raw) as WorkerState;
      if (this.state.version !== 1 || !Number.isSafeInteger(this.state.seq) || !this.state.commands || !this.state.runs) {
        throw new Error("worker checkpoint version or shape is invalid");
      }
      // Every mutate() re-serializes the whole of this file, so one oversized
      // tool result in it costs memory on every write for the rest of the
      // agent's life. Agent f047e0ef kept 21 MB of base64 audio here after the
      // run that fetched it was OOM-killed, and was then OOM-killed 17 seconds
      // into every boot that followed. Results are capped before they are
      // stored now; repair a file written before they were, so an agent that
      // was already poisoned starts instead of dying on its own state.
      if (raw.length > MAX_WORKER_STATE_CHARS) {
        this.state = capStrings(this.state, MAX_EXTERNAL_STRING_CHARS) as WorkerState;
        await atomicWrite(this.statePath, JSON.stringify(this.state));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.state.commands = Object.assign(Object.create(null), this.state.commands);
    this.state.runs = Object.assign(Object.create(null), this.state.runs);
    for (const run of Object.values(this.state.runs)) run.tools = Object.assign(Object.create(null), run.tools);
    // A state written before compaction existed carries every run the agent
    // ever finished; shed it once here, before anything else rewrites it.
    if (compactWorkerState(this.state)) await atomicWrite(this.statePath, JSON.stringify(this.state));
    await this.emit("worker.ready", { protocolVersion: 1, runtimeVersion: "0.3.2-worker.1", restoredRunId: this.state.activeRunId });
  }

  private mutate(fn: () => void): Promise<void> {
    const write = this.writes.then(async () => { fn(); await atomicWrite(this.statePath, JSON.stringify(this.state)); });
    // The caller sees this write's failure; the next write must not. Chaining
    // on a rejected write rejected every later one too, so one ENOSPC left the
    // worker unable to emit anything, a cancel included, even after the disk
    // had room again (run 71ef514b, 2026-11-23: ten hours "running").
    this.writes = write.catch(() => undefined);
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
        summary: run.summary, pendingOperationId: run.pendingOperationId, ...(run.knowledge ? { knowledge: run.knowledge } : {}) }, command.runId, command.id);
      return;
    }
    // A previously accepted resume may have been interrupted after clearing
    // the wait. Replay that exact command from its checkpoint; new resume
    // commands must still prove they resolve the original waiting operation.
    if (command.type === "run.resume") {
      if (!run) return reject("unknown_run", "Run does not exist");
      if (!previous) {
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
      }
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
    // `execute` handles its own failures and ends the run. It rejects only
    // when that handling failed too, so nothing was recorded: say so to the
    // host rather than keep reading commands as if the run were alive.
    // drain() still rethrows it.
    void this.running.catch((error) => this.options.onFatal?.(error));
  }

  private async execute(runId: string, run: DurableRun, signal: AbortSignal): Promise<void> {
    let closeStreamOf: (() => Promise<{ id: string } | undefined>) | undefined;
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
      // A chat-only model is given no tools of any kind (`chat-only.ts`), so
      // none of the hosted tool surfaces is even built for its run.
      const chatOnly = run.start.payload.modelPolicy.chatOnly === true;
      const hosted = chatOnly ? undefined : this.options.hostedTools?.(run.start, session);
      const economy = chatOnly ? undefined : this.options.economy?.(run.start, session);
      const dynamicTools = economy ? hostedDynamicTools(economy) : undefined;
      // Control-declared tools (C2) are answered by control through the hosted
      // executor, so a worker without one advertises none of them.
      const declared = hosted ? declaredToolDefinitions(run.start, dynamicTools?.definitions ?? []) : [];
      let latestFinancialState: import("@opencrowd/protocol").FinancialState = { status: "unavailable", reason: "Hosted financial state has not been read." };
      const readStats = this.moneyReadStats.get(runId) ?? { reads: 0, ms: 0, maxMs: 0 };
      this.moneyReadStats.set(runId, readStats);
      const financialState = this.options.financialState && !chatOnly ? async () => {
        const started = Date.now();
        try { latestFinancialState = await this.options.financialState!(run.start, session); }
        catch { latestFinancialState = { status: "unavailable", reason: "Hosted financial state could not be read; do not use local budget figures." }; }
        const ms = Date.now() - started;
        readStats.reads += 1; readStats.ms += ms; readStats.maxMs = Math.max(readStats.maxMs, ms);
        return latestFinancialState;
      } : undefined;
      // Every tool call, built-in or economy, is recorded once per checkpoint turn and replayed from its stored result.
      // `wireName` is what the trace and the backstop know a declared tool by (`control.<name>`).
      // The owner's standing no-action rules (SRI-166), from run.start, which the
      // checkpoint keeps: a resumed run is held to them too. Checked here, where
      // every hosted tool passes (subagents' included), so a refusal is traced.
      const actionPolicy = run.start.payload.actionPolicy;
      const policyState = newPolicyState();
      // The runtime names the call (ToolCallContext); a subagent's calls are not in the checkpoint and get an id of their own.
      // Parallel reads (parallel-tools.ts) need the name: several calls of one tool are unfinished at once.
      const callOf = (name: string, meta?: ToolCallContext) => meta?.toolCallId ? { id: meta.toolCallId }
        : run.checkpoint?.response?.toolCalls.find(c => c.name === name && !run.checkpoint?.completedTools[c.id]);
      const record = async (name: string, args: Record<string, unknown>, invoke: () => Promise<ToolResult>, wireName = name, meta?: ToolCallContext): Promise<ToolResult> => {
        const call = callOf(name, meta);
        // Providers may reuse tool IDs on later turns. Results are scoped to
        // their checkpoint turn so a later call cannot replay an old result.
        const id = `${run.checkpoint?.turn ?? 0}:${call?.id ?? randomUUID()}`;
        const digest = createHash("sha256").update(JSON.stringify({ name, args })).digest("hex");
        const saved = run.tools[id];
        if (saved && saved.digest !== digest) throw new Error("tool request digest mismatch");
        if (saved?.result) return saved.result;
        if (saved && name === "run_shell") {
          // The shell may have partially changed files before the worker died.
          // Give the model a failed result so it can inspect and recover, but
          // never execute that command again implicitly.
          const output: ToolResult = { ok: false, error: "Shell command was interrupted and its result was lost. It was not rerun. Inspect existing files and installed packages before choosing a different approach; do not assume the command succeeded or repeat side effects blindly." };
          await this.mutate(() => { run.tools[id].result = output; });
          await this.emit("tool.finished", { toolCallId: id, toolName: name, status: "error", durationMs: 0,
            turn: run.checkpoint?.turn ?? 0, error: output.error, details: captureDetail({ output }) }, runId, run.commandId);
          return output;
        }
        if (saved && !saved.approvalPending && name === "call_paid_service") throw new Error("paid call result was lost; the payment requires manual reconciliation");
        await this.mutate(() => { run.tools[id] = { digest }; });
        await this.emit("tool.started", { toolCallId: id, toolName: wireName, input: summarizeToolInput(wireName, args), details: captureDetail({ input: args }), turn: run.checkpoint?.turn ?? 0,
          ...(meta?.parallel ? { parallel: { group: `${run.checkpoint?.turn ?? 0}:${meta.parallel.group}`, index: meta.parallel.index, size: meta.parallel.size } } : {}) }, runId, run.commandId);
        const started = Date.now();
        let output: ToolResult;
        try {
          if (saved?.approvalPending && name === "call_paid_service" && economy)
            await economy.execute("inspect_paid_service", { url: args.url, method: args.method, sample_body: args.body });
          const refused = checkAction(actionPolicy, policyState, name, args);
          output = refused ? { ok: false, error: refused } : capToolResult(await this.withinDeadline(wireName, invoke));
          // Keep durable tool diagnostics consistent with what the model sees.
          if (financialState && name === "get_budget_status") output = { ok: true, data: latestFinancialState };
          if (financialState && name === "complete_session" && output.ok && output.data && typeof output.data === "object")
            output = { ...output, data: { ...output.data, budget: latestFinancialState } };
        } catch (error) {
          if (error instanceof RuntimePause && error.outcome === "waiting_for_approval")
            await this.mutate(() => { run.tools[id].approvalPending = true; });
          await this.emit("tool.finished", { toolCallId: id, toolName: wireName,
            status: error instanceof RuntimePause ? "blocked" : signal.aborted ? "cancelled" : "error",
            durationMs: Date.now() - started, turn: run.checkpoint?.turn ?? 0,
            error: scrubText(error instanceof Error ? error.message : String(error)),
            details: captureDetail({ error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) })
          }, runId, run.commandId);
          throw error;
        }
        await this.mutate(() => { run.tools[id].result = output; });
        await this.emit("tool.finished", { toolCallId: id, toolName: wireName, status: output.ok ? "ok" : "error",
          error: output.error ? scrubText(output.error) : undefined, durationMs: Date.now() - started,
          turn: run.checkpoint?.turn ?? 0, details: captureDetail({ output }) }, runId, run.commandId);
        if (name === "save_file" && output.ok) await this.emit("artifact.created", {
          artifactId: id, name: String(args.path), path: String(args.path).replace(/^artifacts\//, "")
        }, runId, run.commandId);
        return output;
      };
      const baseProvider = this.options.provider(run.start, session, [...dynamicTools?.definitions ?? [], ...declared]);
      // The reply's text reaches the owner while the model is still writing it
      // (FAST_START.md), a few words at a time, under the id the turn's
      // assistant.message will carry so the conversation replaces the one with
      // the other. A call that fails part-way closes its text with an empty
      // message, which the conversation drops, so a retry starts clean.
      let streamed: { id: string; turn: number; buffer: string; timer?: ReturnType<typeof setTimeout> } | undefined;
      const flushDeltas = async () => {
        const open = streamed;
        if (!open?.buffer) return;
        const delta = open.buffer;
        open.buffer = "";
        clearTimeout(open.timer); open.timer = undefined;
        await this.emit("assistant.delta", { messageId: open.id, delta, turn: open.turn }, runId, run.commandId);
      };
      const onTurnTextDelta = (delta: string, { turn }: { turn: number }) => {
        if (!delta) return;
        streamed ??= { id: randomUUID(), turn, buffer: "" };
        streamed.buffer += delta;
        streamed.timer ??= setTimeout(() => void flushDeltas().catch(() => undefined), DELTA_FLUSH_MS);
      };
      const closeStream = async () => {
        await flushDeltas();
        const open = streamed;
        streamed = undefined;
        return open;
      };
      closeStreamOf = closeStream;
      const provider: LlmProvider = {
        complete: async (messages, context) => {
          const abandoned = await closeStream();
          if (abandoned) await this.emit("assistant.message", { messageId: abandoned.id, content: "" }, runId, run.commandId);
          const callId = randomUUID(), started = Date.now(), turn = run.checkpoint?.turn ?? 0;
          await this.emit("model.started", { callId, model: run.start.payload.modelPolicy.model ?? "demo", turn,
            details: captureDetail(this.inputs.record({ sessionId: session.sessionId, runId, callId }, messages)) }, runId, run.commandId);
          try {
            const result = await baseProvider.complete(messages, context);
            await flushDeltas();
            await this.emit("model.finished", { callId, model: run.start.payload.modelPolicy.model ?? "demo", turn, status: "ok",
              durationMs: Date.now() - started, usage: result.usage,
              details: captureDetail({ output: result }) }, runId, run.commandId);
            return result;
          } catch (error) {
            await this.emit("model.finished", { callId, model: run.start.payload.modelPolicy.model ?? "demo", turn,
              status: error instanceof RuntimePause ? "blocked" : signal.aborted ? "cancelled" : "error",
              durationMs: Date.now() - started, error: scrubText(error instanceof Error ? error.message : String(error)),
              details: captureDetail({ error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) })
            }, runId, run.commandId);
            throw error;
          }
        }
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
        ...(chatOnly ? { chatOnly: true } : {}),
        ...(declared.length ? { declaredTools: { definitions: declared,
          execute: (name, args, _operationId, meta) => record(name, args, () => hosted!(`control.${name}`, args, { session, signal }), `control.${name}`, meta) } } : {}),
        ...(!chatOnly && run.start.payload.instructions?.length ? { instructions: run.start.payload.instructions } : {}),
        contextWindowTokens: run.start.payload.modelPolicy.contextWindowTokens,
        maxOutputTokens: run.start.payload.modelPolicy.maxOutputTokens,
        prices: {
          inputPriceUsdPerMillion: run.start.payload.modelPolicy.inputPriceUsdPerMillion,
          cachedInputPriceUsdPerMillion: run.start.payload.modelPolicy.cachedInputPriceUsdPerMillion,
        },
        provider,
        financialState,
        history: run.checkpoint ? undefined : await this.history(session),
        ...(dynamicTools ? {
          dynamicTools: { definitions: dynamicTools.definitions, execute: (name, args, _operationId, meta) => record(name, args, () => dynamicTools.execute(name, args, `${run.checkpoint?.turn ?? 0}:${callOf(name, meta)?.id}`), name, meta) },
          completionGate: (alreadyNudged, signals) => dynamicTools!.completionGate(alreadyNudged, signals),
          ...await this.capabilityIndex(session, run, !!run.checkpoint)
        } : {}),
        onCheckpoint: async (checkpoint) => {
          await this.mutate(() => { run.checkpoint = checkpoint; run.checkpointId = randomUUID(); });
          // Human-readable mirror; worker.json is authoritative after an interrupted write.
          await atomicWrite(join(session.sessionDir, "messages.jsonl"), checkpoint.messages.filter(m => m.role !== "system")
            .map(message => JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message }) + "\n").join(""));
        },
        onMessage: async message => {
          // Bookkeeping after the answer is not part of the owner's reply
          // (SRI-66); model.finished keeps it for whoever is debugging.
          const content = message.role === "assistant" && !message.housekeeping ? stripReasoning(message.content) : "";
          const open = await closeStream();
          // A streamed reply is always closed by its message, even an empty
          // one (all reasoning, or a bare tool call), so no half-shown text stays.
          if (content.trim() || open) await this.emit("assistant.message", {
            messageId: open?.id ?? randomUUID(), content: content.trim() ? content : ""
          }, runId, run.commandId);
        },
        onTurnTextDelta,
        toolExecutor: (name, args, context) => record(name, args, () =>
          // Harness feedback goes to CrowdCode, which attaches the run, model and image (SRI-113).
          hosted && (HOSTED_ONLY_TOOL_NAMES.includes(name) || name === "submit_harness_feedback") ? hosted(name, args, context) : local(name, args, context),
          name, context.toolCallId ? { toolCallId: context.toolCallId, parallel: context.parallel } : undefined)
      });
      // The runtime's "stopped" is CrowdCode ending the run, never the owner (adf318ab read "User stopped").
      await this.finish(runId, run, result.outcome,
        String(result.summary.final_message ?? ""));
    } catch (error) {
      // Text a failed, paused or cancelled call had already shown is closed, so
      // the conversation does not keep a reply that was never finished.
      const unfinished = await closeStreamOf?.().catch(() => undefined);
      if (unfinished) await this.emit("assistant.message", { messageId: unfinished.id, content: "" }, runId, run.commandId).catch(() => undefined);
      // The owner declining a spend is their decision, recorded as the run
      // ending `user_stopped` below, not a runtime error: as one it showed in
      // CrowdCode's error list and opened an incident (SRI-139).
      if (!(error instanceof RuntimePause) && !(error instanceof SpendingDeclined) && !signal.aborted) await this.emit("runtime.error", {
        code: "run_exception", message: scrubText(error instanceof Error ? error.message : String(error)), fatal: false,
        details: captureDetail({ error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) })
      }, runId, run.commandId);
      if (signal.aborted) await this.finish(runId, run, "cancelled", "Run cancelled");
      else if (error instanceof RuntimePause) {
        await this.mutate(() => { run.pendingOperationId = error.operationId; });
        // An interrupted paid call is a pause, never a failure: the gateway may
        // already hold the answer it paid for (on 2026-11-01 run bdf636cf's
        // did, and the run still ended "failed"). The hosted reconciler
        // settles or releases the payment and resumes this exact operation,
        // which replays a saved answer instead of buying it twice. A new
        // message from the owner still supersedes the pause: control cancels
        // a waiting run before it starts the next one.
        await this.finish(runId, run, error.outcome,
          error.outcome === "payment_unknown" ? PAYMENT_RECONCILING_MESSAGE : error.message);
      } else if (error instanceof SpendingDeclined) await this.finish(runId, run, "user_stopped", error.message);
      // A seller's refusal before payment is a fact the owner can act on, so
      // it is said in plain words instead of "something went wrong".
      else await this.finish(runId, run, "failed", upstreamRefusalSummary(error) ?? RUN_FAILURE_MESSAGE);
    }
  }

  /**
   * The backstop deadline around one tool call.
   *
   * A `RuntimePause` must still travel: an approval or a funding stop is the
   * tool reporting a decision, not failing to answer. Everything else becomes
   * an ordinary tool error, so the loop keeps the turn and the model chooses
   * what to do instead of the owner losing the run.
   */
  private async withinDeadline(name: string, invoke: () => Promise<ToolResult>): Promise<ToolResult> {
    const timeoutMs = (this.options.toolDeadlineMs ?? toolDeadlineMs)(name);
    try {
      return await withDeadline(invoke, timeoutMs, `tool ${name}`);
    } catch (error) {
      if (!(error instanceof DeadlineExceeded)) throw error;
      return { ok: false, error: toolDeadlineError(name, timeoutMs) };
    }
  }

  /**
   * CrowdCode's live capability tree, else the bundled snapshot; a tree that
   * cannot load must never fail a hosted run. Loaded once here and handed to
   * the loop as its rendered index, so a run makes one fetch at most.
   *
   * A run pinned by `run.start` `treeVersion` (W8's gate: `candidate` or a
   * version number) fetches `GET /api/tree?version=<value>` itself, past the
   * per-process cache. A resumed run keeps the prompt in its checkpoint, so
   * nothing is reloaded and the session keeps the version that prompt came from.
   */
  private async capabilityIndex(session: SessionState, run: DurableRun, resuming: boolean): Promise<{ capabilityIndex?: string; knowledge: false }> {
    if (resuming) return { knowledge: false };
    const treeVersion = run.start.payload.treeVersion;
    const live = this.options.liveTree;
    const options: KnowledgeOptions = live === false ? {} : { live: { persistPath: join(this.paths.metadata, "capability-tree.json"), ...live,
      ...(treeVersion ? { version: treeVersion, fresh: true } : {}) } };
    let loaded;
    try {
      loaded = await loadKnowledgeTree(session, options);
    } catch {
      return { knowledge: false };
    }
    if (!loaded) return { knowledge: false };
    const fallback = session.knowledge?.version === loaded.version ? session.knowledge.fallback : undefined;
    const knowledge: RunKnowledge = { version: loaded.version, ...(loaded.tree !== undefined ? { tree: loaded.tree } : {}),
      ...(fallback ? { fallback: scrubText(fallback).slice(0, 500) } : {}) };
    await this.mutate(() => { run.knowledge = knowledge; });
    return { capabilityIndex: renderCapabilityIndex(loaded.l0, loaded.tree !== undefined), knowledge: false };
  }

  private async history(session: SessionState): Promise<LoopCheckpoint["messages"]> {
    try {
      return repairToolPairs((await readFile(join(session.sessionDir, "messages.jsonl"), "utf8")).split("\n").filter(Boolean)
        .map(line => JSON.parse(line).message).filter(Boolean));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async finish(runId: string, run: DurableRun, outcome: RunOutcome, summary: string): Promise<void> {
    await this.mutate(() => {
      run.outcome = outcome; run.summary = summary; run.checkpointId = randomUUID();
      if (!isWaiting(outcome) && this.state.activeRunId === runId) this.state.activeRunId = undefined;
      compactWorkerState(this.state);
    });
    await this.emit("checkpoint.completed", { checkpointId: run.checkpointId, sessionId: run.sessionId,
      reason: outcome === "cancelled" ? "cancel" : isWaiting(outcome) ? "waiting" : "terminal",
      pendingOperationIds: run.pendingOperationId ? [run.pendingOperationId] : [] }, runId, run.commandId);
    // How often this process read the run's money and how long that took
    // (money-reads.ts). Diagnostic only; a resumed run counts from its resume.
    const reads = this.moneyReadStats.get(runId);
    this.moneyReadStats.delete(runId);
    await this.emit("run.finished", { sessionId: run.sessionId, outcome, summary,
      checkpointId: run.checkpointId, pendingOperationId: run.pendingOperationId, ...(run.knowledge ? { knowledge: run.knowledge } : {}),
      ...(reads?.reads ? { moneyReads: { reads: reads.reads, ms: reads.ms, maxMs: reads.maxMs } } : {}) }, runId, run.commandId);
  }

  async drain(): Promise<void> { await this.running; await this.writes; }
}

/**
 * The model-facing definitions of a run's control-declared tools: each name
 * without its `control.` prefix. A declared name that a built-in or dynamic
 * tool already uses is dropped, so control can never shadow a runtime tool.
 * The definitions come from `run.start`, which the worker checkpoint keeps,
 * so a resumed, unpaused or rebooted run is offered exactly the same tools.
 */
export function declaredToolDefinitions(start: CommandOf<"run.start">, taken: DynamicToolDefinition[] = []): DynamicToolDefinition[] {
  if (start.payload.modelPolicy.chatOnly === true) return [];
  const reserved = new Set<string>([...TOOL_NAMES, ...taken.map(tool => tool.name)]);
  return (start.payload.tools ?? []).flatMap(tool => {
    const name = tool.name.slice("control.".length);
    if (reserved.has(name)) return [];
    reserved.add(name);
    return [{ name, description: tool.description, parameters: tool.parameters }];
  });
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
