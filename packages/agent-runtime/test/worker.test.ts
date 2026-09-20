import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineWorker, RuntimePause, createWorkerDemoProvider } from "../src/worker.js";
import { type Command, type Event } from "@opencrowd/protocol";
import { createSession, readArtifact } from "@opencrowd/core";
import { runAgentTaskDetailed, type LoopCheckpoint } from "../src/index.js";

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
