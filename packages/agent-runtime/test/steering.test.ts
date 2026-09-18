import { it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineWorker } from "../src/worker.js";
import { FileSteeringInbox } from "../src/inbox.js";
import { createSession } from "@opencrowd/core";
import { runAgentTaskDetailed, type LlmMessage, type LoopCheckpoint } from "../src/index.js";

it("delivers steering after an entire tool batch and survives restart without replaying it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "steering-"));
  try {
    const session = await createSession({ workspaceRoot: dir });
    const inbox = new FileSteeringInbox(join(session.sessionDir, "inbox.json"));
    let saved: LoopCheckpoint | undefined, calls = 0;
    const provider = { complete: async () => (++calls === 1
      ? { content: "", toolCalls: [{ id: "a", name: "read_file", arguments: {} }, { id: "b", name: "read_file", arguments: {} }] }
      : { content: "done", toolCalls: [] }) };
    let tools = 0;
    await expect(runAgentTaskDetailed(session, "start", { inbox, provider, toolExecutor: async () => {
      if (++tools === 1) await inbox.push({ id: "steer-1", prompt: "make it a cartoon" });
      return { ok: true, data: "result" };
    }, onCheckpoint: async cp => {
      saved = cp;
      if (cp.deliveredMessageIds?.length) throw new Error("crash after checkpoint before acknowledgement");
    } })).rejects.toThrow("crash after checkpoint");
    expect(tools).toBe(2);
    expect(saved!.messages.slice(-3).map(m => m.role)).toEqual(["tool", "tool", "user"]);
    const restarted = new FileSteeringInbox(join(session.sessionDir, "inbox.json"));
    const result = await runAgentTaskDetailed(session, "start", { inbox: restarted, resume: saved, provider: {
      complete: async messages => { expect(messages.filter(m => m.content === "make it a cartoon")).toHaveLength(1); return { content: "done", toolCalls: [] }; }
    } });
    expect(result.outcome).toBe("completed"); expect(await restarted.pending()).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("accepts a protocol message while the model is running and does not finish before consuming it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-steering-"));
  const events: any[] = [], requests: LlmMessage[][] = [];
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(r => { began = r; });
  const waiting = new Promise<void>(r => { release = r; });
  const worker = new MachineWorker({ agentHome: dir, output: line => { events.push(JSON.parse(line)); }, provider: () => ({
    complete: async messages => { requests.push(structuredClone(messages)); if (requests.length === 1) { began(); await waiting; } return { content: "done", toolCalls: [] }; }
  }) });
  const base = { protocolVersion: 1, runId: "run-1", emittedAt: new Date().toISOString() };
  try {
    await worker.initialize();
    await worker.handleLine(JSON.stringify({ ...base, id: "start", seq: 1, type: "run.start", payload: { session: { kind: "create", sessionId: "session" }, prompt: "start", modelPolicy: {}, budget: { limit: "0" }, approvalMode: "off" } }));
    await started;
    const message = { ...base, id: "steer", seq: 2, type: "run.message", payload: { prompt: "change direction" } };
    await worker.handleLine(JSON.stringify(message)); await worker.handleLine(JSON.stringify(message)); release(); await worker.drain();
    expect(requests).toHaveLength(2); expect(requests[1].filter(m => m.content === "change direction")).toHaveLength(1);
    expect(events.filter(e => e.type === "user.message")).toHaveLength(1);
    expect(events.filter(e => e.type === "run.finished")).toHaveLength(1);
    const state = JSON.parse(await readFile(join(dir, "metadata/worker.json"), "utf8"));
    expect(state.runs["run-1"].checkpoint.deliveredMessageIds).toEqual(["steer"]);
  } finally { release?.(); await worker.drain(); await rm(dir, { recursive: true, force: true }); }
});

it("consumes a queued message even when completion appears before another tool in the batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "complete-steering-"));
  try {
    const session = await createSession({ workspaceRoot: dir });
    const inbox = new FileSteeringInbox(join(session.sessionDir, "inbox.json"));
    let calls = 0, executed = 0;
    const result = await runAgentTaskDetailed(session, "start", { inbox, provider: { complete: async messages => {
      if (++calls === 1) return { content: "", toolCalls: [{ id: "done", name: "complete_session", arguments: {} }, { id: "read", name: "read_file", arguments: {} }] };
      expect(messages.slice(-3).map(m => m.role)).toEqual(["tool", "tool", "user"]);
      return { content: "follow-up complete", toolCalls: [] };
    } }, toolExecutor: async () => { if (++executed === 2) await inbox.push({ id: "late", prompt: "one more thing" }); return { ok: true, data: {} }; } });
    expect(executed).toBe(2); expect(calls).toBe(2); expect(result.outcome).toBe("completed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
