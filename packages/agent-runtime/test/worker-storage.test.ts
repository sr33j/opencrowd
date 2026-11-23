import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Command, type Event } from "@opencrowd/protocol";

// The worker's durable writes, made to fail on demand the way a full volume does.
const disk = vi.hoisted(() => ({ full: false }));
vi.mock("@opencrowd/core", async (original) => {
  const core = await original<typeof import("@opencrowd/core")>();
  return {
    ...core,
    atomicWrite: async (...args: Parameters<typeof core.atomicWrite>) => {
      if (disk.full && String(args[0]).endsWith("worker.json"))
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      return core.atomicWrite(...args);
    },
  };
});
const { MachineWorker } = await import("../src/worker.js");

const roots: string[] = [];
afterEach(async () => { disk.full = false; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "worker storage ")); roots.push(dir); return dir; }
const start: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-11-23T04:00:00Z", type: "run.start",
  payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Install the CLI", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "ask" } };
const cancel: Command = { protocolVersion: 1, id: "cancel-1", runId: "run-1", seq: 2, emittedAt: "2026-11-23T13:24:00Z", type: "run.cancel",
  payload: { reason: "Stopped by user." } };

describe("a worker whose disk fills during a run (run 71ef514b, 2026-11-23)", () => {
  it("tells the host at once, and answers a later command once there is room again", async () => {
    const home = await root(), events: Event[] = [];
    const onFatal = vi.fn();
    // The model asks for one tool; the tool fills the disk, the way npm's
    // half-unpacked package did, so nothing about the call can be recorded.
    const provider = { complete: vi.fn(async () => ({ content: "", toolCalls: [{ id: "install", name: "list_files", arguments: { path: "." } }] })) };
    const toolExecutor = vi.fn(async () => { disk.full = true; return { ok: true, data: [] }; });
    const worker = new MachineWorker({ agentHome: home, provider: () => provider, toolExecutor, onFatal,
      output: (line: string) => { events.push(JSON.parse(line)); } });
    await worker.initialize();
    await worker.handleLine(JSON.stringify(start));
    await expect(worker.drain()).rejects.toMatchObject({ code: "ENOSPC" });

    // Before: the rejection was swallowed and the worker went on reading
    // commands with nothing recorded, so the run stayed "running" for ten hours.
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toMatchObject({ code: "ENOSPC" });
    expect(events.map((event) => event.type)).toContain("tool.started");
    expect(events.map((event) => event.type)).not.toContain("tool.finished");

    // Before: every later write chained on the failed one and failed with it,
    // so even the owner's cancel, after space was freed, died as "worker_failure".
    disk.full = false;
    await worker.handleLine(JSON.stringify(cancel));
    await worker.drain().catch(() => undefined);
    expect(events.filter((event) => event.type === "command.accepted").at(-1)).toMatchObject({ commandId: "cancel-1" });
    expect(events.filter((event) => event.type === "run.finished").at(-1)).toMatchObject({ payload: { outcome: "cancelled" } });
  });
});
