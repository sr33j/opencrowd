import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineWorker, RuntimePause, createWorkerDemoProvider } from "../src/worker.js";
import { type Command, type Event } from "@opencrowd/protocol";
import { createSession, readArtifact } from "@opencrowd/core";
import { runAgentTaskDetailed, type LoopCheckpoint } from "../src/index.js";
import { toolDeadlineError, toolDeadlineMs } from "../src/tool-deadlines.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "worker test ")); roots.push(dir); return dir; }
const start = (id = "command-1", runId = "run-1"): Command => ({ protocolVersion:1, id, runId, seq:1,
  emittedAt: "2026-09-05T00:00:00Z", type:"run.start", payload:{session:{kind:"create",sessionId:"session-1"},
    prompt:"Write a report", modelPolicy:{}, budget:{limit:"1000000"}, approvalMode:"ask"} });

describe("durable JSONL worker", () => {
  it("writes a real artifact and re-acknowledges a delivered command after restart without another provider call", async () => {
    const home = await root(); const events: Event[] = [];
    const options = {agentHome: home, provider: vi.fn(() => createWorkerDemoProvider()), output: (line:string) => {events.push(JSON.parse(line));}};
    const worker = new MachineWorker(options); await worker.initialize();
    await worker.handleLine(JSON.stringify(start())); await worker.drain();
    expect(events.filter(e=>e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
    const artifact = await readFile(join(home,"workspace/sessions/session-1/artifacts/result.md"),"utf8");
    expect(artifact).toContain("Write a report");
    const restarted = new MachineWorker(options); await restarted.initialize();
    await restarted.handleLine(JSON.stringify(start())); await restarted.drain();
    expect(options.provider).toHaveBeenCalledTimes(1);
    expect(events.every((event,i)=>i===0 || event.seq > events[i-1].seq)).toBe(true);
    const messages = await readFile(join(home,"workspace/sessions/session-1/messages.jsonl"),"utf8");
    expect(messages.match(/Write a report/g)).toHaveLength(2); // user prompt plus artifact tool content
    expect(messages.split('\n').filter(Boolean).map(l=>JSON.parse(l).message).filter(m=>m.role==='user')).toHaveLength(1);
  });

  it("repairs a durable state that already holds an oversized tool result, instead of dying on it", async () => {
    // Agent f047e0ef kept 21 MB of base64 audio in worker.json after the run
    // that fetched it was OOM-killed, and every boot afterwards was OOM-killed
    // 17 seconds in re-serializing it. The state has to be able to recover.
    const home = await root(); const events: Event[] = [];
    const options = { agentHome: home, provider: vi.fn(() => createWorkerDemoProvider()), output: (line: string) => { events.push(JSON.parse(line)); } };
    await new MachineWorker(options).initialize();
    const statePath = join(home, "metadata/worker.json");
    const poisoned = JSON.parse(await readFile(statePath, "utf8"));
    poisoned.runs = { "run-0": { start: start("command-0", "run-0"), sessionId: "session-1", commandId: "command-0", tools: {
      "0:call-1": { digest: "d", result: { ok: true, data: { audio_base64: "A".repeat(3_000_000) } } } } } };
    await writeFile(statePath, JSON.stringify(poisoned));
    expect((await readFile(statePath, "utf8")).length).toBeGreaterThan(3_000_000);

    const recovered = new MachineWorker(options);
    await recovered.initialize();

    const repaired = await readFile(statePath, "utf8");
    expect(repaired.length).toBeLessThan(400_000);
    expect(JSON.parse(repaired).runs["run-0"].tools["0:call-1"].result.data.audio_base64).toContain("[truncated ");
    // Still a working worker, not just a smaller file.
    await recovered.handleLine(JSON.stringify(start())); await recovered.drain();
    expect(events.filter(e => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
  });

  it("pauses and resumes a pending model operation using the same ID without appending the prompt", async () => {
    const home = await root(); const events: Event[] = []; const operations: string[] = []; let funded = false;
    const provider = {complete: vi.fn(async (_messages, context) => {
      operations.push(context.operationId);
      if (!funded) throw new RuntimePause("waiting_for_funds", context.operationId, "Test balance is empty");
      return {content:"Funded and complete",toolCalls:[]};
    })};
    const options = {agentHome:home, provider:()=>provider, output:(line:string)=>{events.push(JSON.parse(line));}};
    const worker = new MachineWorker(options); await worker.initialize(); await worker.handleLine(JSON.stringify(start())); await worker.drain();
    const waiting = events.filter(e=>e.type==='run.finished').at(-1)!;
    expect(waiting.payload.outcome).toBe('waiting_for_funds');
    funded = true;
    const restarted = new MachineWorker(options); await restarted.initialize();
    await restarted.handleLine(JSON.stringify({protocolVersion:1,id:'resume-1',runId:'run-1',seq:2,
      emittedAt:'2026-09-05T00:01:00Z',type:'run.resume',payload:{sessionId:'session-1',cause:'funds_available',operationId:waiting.payload.pendingOperationId}}));
    await restarted.drain();
    expect(operations).toEqual(['run-1:llm:0','run-1:llm:0']);
    expect(events.filter(e=>e.type==='run.finished').at(-1)?.payload.outcome).toBe('completed');
    const saved = JSON.parse(await readFile(join(home,'metadata/worker.json'),'utf8'));
    expect(saved.runs['run-1'].checkpoint.messages.filter(m=>m.role==='user')).toHaveLength(1);
  });

  it("reads cancellation while a model request is active and emits one terminal outcome", async () => {
    const home = await root(); const events: Event[] = [];
    let began!:()=>void; const ready = new Promise<void>(resolve=>{began=resolve;});
    const worker = new MachineWorker({agentHome:home, output:line=>{events.push(JSON.parse(line));},provider:()=>({
      complete:(_messages,context)=>new Promise((_resolve,reject)=>{
        began(); context!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
      })
    })});
    await worker.initialize(); await worker.handleLine(JSON.stringify(start())); await ready;
    await worker.handleLine(JSON.stringify({protocolVersion:1,id:'cancel-1',seq:2,emittedAt:'2026-09-05T00:01:00Z',type:'run.cancel',runId:'run-1',payload:{reason:'stop'}}));
    await worker.drain();
    expect(events.filter(e=>e.type==='run.finished').map(e=>e.payload.outcome)).toEqual(['cancelled']);
    expect(events.findIndex(e=>e.type==='checkpoint.completed')).toBeLessThan(events.findIndex(e=>e.type==='run.finished'));
  });

  it("recovers an accepted resume interrupted inside a shell without rerunning it", async () => {
    const home = await root(), events: Event[] = [];
    let funded = false, shellBegan!: () => void;
    const ready = new Promise<void>(resolve => { shellBegan = resolve; });
    const provider = { complete: vi.fn(async () => {
      if (!funded) throw new RuntimePause("waiting_for_funds", "run-1:llm:0", "Fund wallet");
      return { content: "Install package", toolCalls: [{ id: "install", name: "run_shell", arguments: { command: "pip install huge-package" } }] };
    }) };
    const options = { agentHome: home, provider: () => provider, output: (line: string) => { events.push(JSON.parse(line)); },
      toolExecutor: vi.fn(async () => { shellBegan(); return new Promise<never>(() => {}); }) };
    const worker = new MachineWorker(options);
    await worker.initialize(); await worker.handleLine(JSON.stringify(start())); await worker.drain();
    const resume: Command = { protocolVersion: 1, id: "resume-1", runId: "run-1", seq: 2,
      emittedAt: "2026-09-05T00:01:00Z", type: "run.resume", payload: { sessionId: "session-1", cause: "funds_available", operationId: "run-1:llm:0" } };
    funded = true;
    await worker.handleLine(JSON.stringify(resume)); await ready;
    // Simulate a killed process: only durable state is available to its replacement.
    const recovery = { complete: vi.fn(async messages => {
      expect(JSON.stringify(messages)).toContain("Shell command was interrupted");
      return { content: "Inspected partial files; choosing a lighter backend.", toolCalls: [] };
    }) };
    const restarted = new MachineWorker({ ...options, provider: () => recovery });
    await restarted.initialize();
    // A new command cannot bypass the waiting-state checks.
    await restarted.handleLine(JSON.stringify({ ...resume, id: "different-resume" }));
    expect(events.at(-1)).toMatchObject({ type: "command.rejected", payload: { reason: "run_not_resumable" } });
    await restarted.handleLine(JSON.stringify(resume)); await restarted.drain();
    expect(options.toolExecutor).toHaveBeenCalledTimes(1);
    expect(recovery.complete).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.type === "run.finished").at(-1)).toMatchObject({ payload: { outcome: "completed" } });
    expect(events.filter(e => e.type === "tool.finished").at(-1)).toMatchObject({ payload: { status: "error", toolCallId: "0:install" } });
  });

  it("honors cancellation of a restored unfinished run without another model call", async () => {
    const home = await root(), events: Event[] = [];
    let began!: () => void;
    const ready = new Promise<void>(resolve => { began = resolve; });
    const provider = { complete: vi.fn(async () => { began(); return new Promise<never>(() => {}); }) };
    const options = { agentHome: home, provider: () => provider, output: (line: string) => { events.push(JSON.parse(line)); } };
    const worker = new MachineWorker(options);
    await worker.initialize(); await worker.handleLine(JSON.stringify(start())); await ready;
    const restarted = new MachineWorker(options); await restarted.initialize();
    await restarted.handleLine(JSON.stringify({ protocolVersion: 1, id: "cancel-restored", runId: "run-1", seq: 2,
      emittedAt: "2026-09-05T00:01:00Z", type: "run.cancel", payload: { reason: "stop" } }));
    await restarted.drain();
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.type === "run.finished").at(-1)).toMatchObject({ payload: { outcome: "cancelled" } });
  });

  it("rejects conflicting command contents and invalid major versions", async () => {
    const home = await root(); const events: Event[] = [];
    const worker = new MachineWorker({agentHome:home,provider:()=>createWorkerDemoProvider(),output:line=>{events.push(JSON.parse(line));}});
    await worker.initialize(); await worker.handleLine(JSON.stringify(start())); await worker.drain();
    await worker.handleLine(JSON.stringify({...start(),seq:9}));
    await worker.handleLine(JSON.stringify({...start('other'),protocolVersion:2}));
    expect(events.filter(e=>e.type==='command.rejected').map(e=>e.payload.reason)).toEqual(['conflicting_duplicate','unsupported_version']);
  });

  it("restores a checkpoint after a tool result without executing the tool or buying a model response again", async () => {
    const workspace = await root(); const session = await createSession({workspaceRoot:workspace});
    let checkpoint: LoopCheckpoint | undefined;
    const provider = createWorkerDemoProvider();
    const spy = vi.spyOn(provider,'complete');
    await expect(runAgentTaskDetailed(session,'persist this', {provider, onCheckpoint:async next=>{
      checkpoint=next;
      if(next.completedTools['demo-save']) throw new Error('simulated process kill after durable checkpoint');
    }})).rejects.toThrow('simulated process kill');
    expect(await readArtifact(session,'result.md')).toContain('persist this');
    const result = await runAgentTaskDetailed(session,'persist this',{provider,resume:checkpoint});
    expect(result.outcome).toBe('completed');
    expect(spy).toHaveBeenCalledTimes(2); // original response plus next turn; no replay of original
  });
});

it("captures every model/tool input and exact failure output while redacting credentials", async () => {
  const home = await root(), events: Event[] = [];
  let turn = 0;
  const provider = { complete: async () => ++turn === 1
    ? {content:"Running a diagnostic command",toolCalls:[{id:"shell-1",name:"run_shell",arguments:{command:"printf diagnostic",api_key:"private-test-secret"}}]}
    : {content:"The command failed with exit code 17.",toolCalls:[]} };
  const worker=new MachineWorker({agentHome:home,provider:()=>provider,
    toolExecutor:async()=>({ok:false,error:"Command exited with code 17",data:{stdout:"exact stdout\n",stderr:"exact stderr\n",exit_code:17}}),
    output:line=>events.push(JSON.parse(line))});
  await worker.initialize();await worker.handleLine(JSON.stringify(start()));await worker.drain();
  expect(events.filter(e=>e.type==='model.started')).toHaveLength(2);
  expect(events.filter(e=>e.type==='model.finished')).toHaveLength(2);
  const calls=events.filter(e=>e.type==='tool.started'), results=events.filter(e=>e.type==='tool.finished');
  expect(calls).toHaveLength(1);expect(results).toHaveLength(1);
  expect(JSON.stringify(calls[0])).not.toContain('private-test-secret');
  expect(results[0].payload).toMatchObject({toolCallId:calls[0].payload.toolCallId,status:'error',details:{value:{output:{data:{stdout:'exact stdout\n',stderr:'exact stderr\n',exit_code:17}}}}});
});

it("abandons a tool that never returns and lets the model carry the turn on", async () => {
  // The backstop below every tool's own deadline. Without it one tool that
  // never answers is a run the owner never hears back from — run 47a629fc
  // spent nine minutes inside find_paid_service and then failed, having
  // already spent $0.57.
  const home = await root(), events: Event[] = [];
  let turn = 0;
  const provider = { complete: async () => ++turn === 1
    ? { content: "Reading the saved page", toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "page.html" } }] }
    : { content: "That tool stalled, so I used the shell instead.", toolCalls: [] } };
  const worker = new MachineWorker({ agentHome: home, provider: () => provider,
    toolExecutor: () => new Promise(() => undefined), toolDeadlineMs: () => 1_200,
    output: line => events.push(JSON.parse(line)) });
  await worker.initialize();
  await worker.handleLine(JSON.stringify(start()));
  await worker.drain();
  const finished = events.filter(event => event.type === "tool.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0].payload).toMatchObject({ toolName: "read_file", status: "error" });
  expect(finished[0].payload.error).toContain("did not finish within 1s");
  expect(finished[0].payload.error).toContain("Nothing was charged");
  // The run reaches its own end rather than dying with the tool.
  expect(events.filter(event => event.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
});

it("tells the model a timed-out paid call may have been charged, and not to retry it", () => {
  // Every other tool is safe to try again. A payment is not, so the backstop
  // uses the same words the gateway uses for its own unknown outcomes.
  expect(toolDeadlineError("call_paid_service", 480_000))
    .toContain("its payment state is unknown");
  expect(toolDeadlineError("call_paid_service", 480_000))
    .toContain("must not be retried automatically");
  expect(toolDeadlineError("find_paid_service", 180_000)).toContain("Nothing was charged");
  // A heavy toolchain's shell command must never trip the backstop; its own
  // ceiling is 45 minutes.
  expect(toolDeadlineMs("run_shell")).toBeGreaterThan(2_700_000);
});
