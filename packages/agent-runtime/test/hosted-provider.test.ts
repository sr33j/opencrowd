import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it, expect } from 'vitest';
import { createHostedProvider } from '../src/hosted-provider.js';

it('uses a credential-free socket and preserves approval operation identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oc-bridge-')), socketPath = join(home, 'bridge.sock');
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    expect(req.headers.authorization).toBeUndefined();
    expect(input.tools.some((tool: {name:string}) => tool.name === 'save_file')).toBe(true);
    expect(input.tools.some((tool: {name:string}) => tool.name === 'spawn_subagent')).toBe(false);
    res.end(JSON.stringify({status:'paused',outcome:'waiting_for_approval',operationId:input.operationId,message:'Approve model call'}));
  });
  await new Promise<void>(resolve => server.listen(socketPath,resolve));
  try {
    await expect(createHostedProvider({socketPath,runId:'run-1',sessionId:'session-1'}).complete(
      [{role:'user',content:'hello'}],{operationId:'run-1:llm:0'}
    )).rejects.toMatchObject({name:'RuntimePause',outcome:'waiting_for_approval',operationId:'run-1:llm:0'});
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); await rm(home,{recursive:true,force:true}); }
});

it('survives SIGKILL after a completed tool and resumes the same model operation without duplicating the prompt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oc-kill-')), socketPath = join(home,'bridge.sock');
  let wake!:()=>void; const reachedSecond = new Promise<void>(resolve => {wake=resolve;});
  const operations: string[] = []; let restarting = false;
  const server = createServer(async (req,res) => {
    const chunks:Buffer[]=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/tool') { res.end(JSON.stringify({ok:false,error:'Financial read unavailable in restart fixture'})); return; }
    operations.push(input.operationId);
    if(input.operationId.endsWith(':0')) res.end(JSON.stringify({status:'complete',response:{content:'Saving',toolCalls:[{id:'save',name:'save_file',arguments:{path:'result.md',content:'durable artifact'}}]}}));
    else if(!restarting) wake();
    else res.end(JSON.stringify({status:'complete',response:{content:'Restored successfully',toolCalls:[]}}));
  });
  await new Promise<void>(resolve => server.listen(socketPath,resolve));
  const command = {protocolVersion:1,id:'start',seq:1,emittedAt:'2026-09-05T00:00:00Z',type:'run.start',runId:'kill-run',payload:{session:{kind:'create',sessionId:'kill-session'},prompt:'Write once',modelPolicy:{},budget:{limit:'1000000'},approvalMode:'ask'}};
  const start = () => spawn(process.execPath,[resolve('apps/cli/dist/index.js'),'worker','--protocol','jsonl','--agent-home',join(home,'data'),'--bridge-socket',socketPath],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:home}});
  let child = start();
  try {
    child.stdout.resume(); child.stdin.write(JSON.stringify(command)+'\n');
    await reachedSecond;
    const before = await readFile(join(home,'data/workspace/sessions/kill-session/artifacts/result.md'),'utf8');
    const exited=once(child,'exit'); child.kill('SIGKILL'); await exited;
    restarting=true; child=start();
    const lines:string[]=[]; child.stdout.on('data',b=>lines.push(b.toString()));
    child.stdin.end(JSON.stringify(command)+'\n');
    const [code]=await once(child,'exit'); expect(code).toBe(0);
    const events=lines.join('').trim().split('\n').map(line=>JSON.parse(line));
    expect(events.filter(e=>e.type==='run.finished').at(-1).payload.outcome).toBe('completed');
    expect(events.filter(e=>e.type==='tool.started')).toHaveLength(0);
    expect(operations).toEqual(['kill-run:llm:0','kill-run:llm:1','kill-run:llm:1','kill-run:llm:2']);
    expect(await readFile(join(home,'data/workspace/sessions/kill-session/artifacts/result.md'),'utf8')).toBe(before);
    const state=JSON.parse(await readFile(join(home,'data/metadata/worker.json'),'utf8'));
    expect(state.runs['kill-run'].checkpoint.messages.filter((m:{role:string;content:string})=>m.role==='user' && !m.content.includes('Before your final answer'))).toHaveLength(1);
  } finally {
    child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(home,{recursive:true,force:true});
  }
},15000);
