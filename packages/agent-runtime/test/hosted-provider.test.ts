import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it, expect } from 'vitest';
import { createHostedProvider, postHostedTool } from '../src/hosted-provider.js';
import { HOSTED_CONTROL_TOOL_TIMEOUT_MS, HOSTED_TOOL_BRIDGE_TIMEOUT_MS, SERVICE_BRIDGE_TIMEOUT_MS } from '@opencrowd/protocol';

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
    // The resumed call is the same operation; a two-turn run that bought nothing
    // and failed nothing ends there, with no reflection turn (SRI-115 C6).
    expect(operations).toEqual(['kill-run:llm:0','kill-run:llm:1','kill-run:llm:1']);
    expect(await readFile(join(home,'data/workspace/sessions/kill-session/artifacts/result.md'),'utf8')).toBe(before);
    // The finished run's checkpoint is compacted away (worker.ts compactWorkerState);
    // the session log is the durable conversation, and it holds the prompt once.
    const log=(await readFile(join(home,'data/workspace/sessions/kill-session/messages.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l).message);
    expect(log.filter((m:{role:string;content:string})=>m.role==='user' && !m.content.includes('reflect once'))).toHaveLength(1);
  } finally {
    child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(home,{recursive:true,force:true});
  }
},15000);

it('gives up on a hosted tool whose reply trickles forever, and sizes unpaid waits below the paid one', async () => {
  // `setTimeout` on a request is an idle timer, so a supervisor that keeps the
  // socket warm without finishing never trips it. The total deadline does.
  const home = await mkdtemp(join(tmpdir(), 'oc-trickle-')), socketPath = join(home, 'bridge.sock');
  const drips: NodeJS.Timeout[] = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":tr');
    drips.push(setInterval(() => res.write(' '), 20));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    await expect(postHostedTool({ socketPath, runId: 'run-1', sessionId: 'session-1' }, 'economy.balance', {}, { timeoutMs: 400 }))
      .rejects.toMatchObject({ name: 'HostedToolTimeout', code: 'hosted_tool_timeout' });
  } finally {
    for (const drip of drips) clearInterval(drip);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

it('waits thirteen minutes only on calls that can already have moved money', () => {
  // A wallet read used to inherit the payment ceiling. Nothing that cannot be
  // charged deserves to hold a run for that long.
  expect(HOSTED_TOOL_BRIDGE_TIMEOUT_MS).toBeLessThan(SERVICE_BRIDGE_TIMEOUT_MS);
  expect(HOSTED_TOOL_BRIDGE_TIMEOUT_MS).toBeGreaterThan(60_000); // The supervisor's own cap on these.
  expect(HOSTED_CONTROL_TOOL_TIMEOUT_MS).toBeGreaterThan(170_000); // Control's own cap on a deploy.
  expect(HOSTED_CONTROL_TOOL_TIMEOUT_MS).toBeLessThan(SERVICE_BRIDGE_TIMEOUT_MS);
});

it('streams the reply text from an NDJSON bridge and returns the final answer (FAST_START)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oc-stream-')), socketPath = join(home, 'bridge.sock');
  let asked: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    asked = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Split mid-line, as a socket does.
    res.write('{"type":"delta","text":"Bitcoin "}\n{"type":"del');
    res.write('ta","text":"is $97,000."}\n');
    res.end(JSON.stringify({ type: 'final', httpStatus: 200, status: 'complete', response: { content: 'Bitcoin is $97,000.', toolCalls: [] } }) + '\n');
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const seen: string[] = [];
    const response = await createHostedProvider({ socketPath, runId: 'run-1', sessionId: 'session-1' })
      .complete([{ role: 'user', content: 'price?' }], { operationId: 'run-1:llm:0', onTextDelta: text => seen.push(text) });
    expect(asked.stream).toBe(true);
    expect(seen).toEqual(['Bitcoin ', 'is $97,000.']);
    expect(response.content).toBe('Bitcoin is $97,000.');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});

it('reads a refusal that arrives after the text started streaming as the refusal it is', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oc-stream-')), socketPath = join(home, 'bridge.sock');
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"delta","text":"Bit"}\n');
    res.end(JSON.stringify({ type: 'final', httpStatus: 502, error: 'model_failed', paid: true, message: 'The paid model returned an error; its receipt is saved' }) + '\n');
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    await expect(createHostedProvider({ socketPath, runId: 'run-1', sessionId: 'session-1' })
      .complete([{ role: 'user', content: 'price?' }], { operationId: 'run-1:llm:0', onTextDelta: () => undefined }))
      .rejects.toMatchObject({ name: 'HostedRequestError', code: 'model_failed' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});

it('takes a plain JSON answer from a bridge that does not stream', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oc-stream-')), socketPath = join(home, 'bridge.sock');
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.end(JSON.stringify({ status: 'complete', response: { content: 'hi', toolCalls: [] } }));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const seen: string[] = [];
    const response = await createHostedProvider({ socketPath, runId: 'run-1', sessionId: 'session-1' })
      .complete([{ role: 'user', content: 'hi' }], { operationId: 'run-1:llm:0', onTextDelta: text => seen.push(text) });
    expect(response.content).toBe('hi');
    expect(seen).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
