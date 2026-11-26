import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, executeTool, type ToolName, type ToolResult } from "@opencrowd/core";
import { type Event, type Command } from "@opencrowd/protocol";
import { runAgentTaskDetailed, type LlmToolCall } from "../src/index.js";
import { MachineWorker } from "../src/worker.js";
import { parallelSafe, readOnlyShell } from "../src/parallel-tools.js";

/**
 * Harness experiment w123: read-only calls of one reply run together, and
 * every other call is a barrier. The model reads every result in the order it
 * wrote the calls, with the flag on or off.
 */
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function session() {
  const dir = await mkdtemp(join(tmpdir(), "parallel-")); roots.push(dir);
  return createSession({ workspaceRoot: dir, budgetCents: 500, approvalMode: "auto" });
}
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, name, arguments: args });
const reply = (...toolCalls: LlmToolCall[]) => ({ content: "", toolCalls });
const done = reply(call("done", "complete_session", { final_message: "Compared the three services." }));

/** A gateway whose calls take `ms` each and record when they ran and how many ran at once. */
function gateway(ms = 30) {
  const log: { name: string; id?: string; start: number; end: number }[] = [];
  let running = 0, most = 0;
  const execute = vi.fn(async (name: string, args: Record<string, unknown>, _op?: string, meta?: { toolCallId: string }) => {
    const start = Date.now(); running += 1; most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running -= 1; log.push({ name, id: meta?.toolCallId, start, end: Date.now() });
    return { ok: true, data: { answered: `${name} ${String(args.url ?? args.task ?? "")}` } } as ToolResult;
  });
  const definitions = ["find_paid_service", "inspect_paid_service", "call_paid_service", "browse_services"]
    .map((name) => ({ name, description: name, parameters: { type: "object" } }));
  return { log, execute, dynamicTools: { definitions, execute }, most: () => most };
}
/** The results the model read, in the order it read them. */
const readBack = (messages: { role?: string; content: string }[]) =>
  messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).result?.data?.answered).filter(Boolean);

describe("parallel reads (w123)", () => {
  it("runs a reply's inspections together and hands them back in the model's order", async () => {
    const paid = gateway();
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce(reply(
        call("a", "inspect_paid_service", { url: "https://a.example/api" }),
        call("b", "inspect_paid_service", { url: "https://b.example/api" }),
        call("c", "inspect_paid_service", { url: "https://c.example/api" })))
      .mockResolvedValueOnce(done) };
    const result = await runAgentTaskDetailed(await session(), "compare three image APIs", { provider, dynamicTools: paid.dynamicTools, knowledge: false, parallelTools: "on" });

    expect(result.outcome).toBe("completed");
    expect(paid.most()).toBe(3);
    expect(paid.log.map((entry) => entry.id).sort()).toEqual(["a", "b", "c"]);
    expect(readBack(provider.complete.mock.calls[1][0])).toEqual([
      "inspect_paid_service https://a.example/api", "inspect_paid_service https://b.example/api", "inspect_paid_service https://c.example/api"]);
  });

  it("runs the same reply one call at a time with the flag off", async () => {
    const paid = gateway(5);
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce(reply(call("a", "inspect_paid_service", { url: "https://a.example/api" }), call("b", "inspect_paid_service", { url: "https://b.example/api" })))
      .mockResolvedValueOnce(done) };
    await runAgentTaskDetailed(await session(), "compare two image APIs", { provider, dynamicTools: paid.dynamicTools, knowledge: false, parallelTools: "off" });
    expect(paid.most()).toBe(1);
  });

  it("never runs a paid call beside anything: reads before it finish first, reads after it start after", async () => {
    const paid = gateway();
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce(reply(
        call("a", "inspect_paid_service", { url: "https://a.example/api" }),
        call("b", "inspect_paid_service", { url: "https://b.example/api" }),
        call("pay", "call_paid_service", { url: "https://a.example/api", body: { q: "x" } }),
        call("c", "inspect_paid_service", { url: "https://c.example/api" }),
        call("d", "inspect_paid_service", { url: "https://d.example/api" })))
      .mockResolvedValueOnce(done) };
    await runAgentTaskDetailed(await session(), "buy one answer", { provider, dynamicTools: paid.dynamicTools, knowledge: false, parallelTools: "on" });

    const at = (id: string) => paid.log.find((entry) => entry.id === id)!;
    expect(at("pay").start).toBeGreaterThanOrEqual(Math.max(at("a").end, at("b").end));
    expect(Math.min(at("c").start, at("d").start)).toBeGreaterThanOrEqual(at("pay").end);
    expect(paid.execute.mock.calls.filter(([name]) => name === "call_paid_service")).toHaveLength(1);
  });

  it("does not send a search the loop would refuse as a third repeat", async () => {
    const paid = gateway(5);
    const find = (id: string) => call(id, "find_paid_service", { task: "image generation" });
    const provider = { complete: vi.fn().mockResolvedValueOnce(reply(find("a"), find("b"), find("c"))).mockResolvedValueOnce(done) };
    await runAgentTaskDetailed(await session(), "find an image API", { provider, dynamicTools: paid.dynamicTools, knowledge: false, parallelTools: "on" });

    expect(paid.execute).toHaveBeenCalledTimes(2);
    const third = JSON.parse(provider.complete.mock.calls[1][0].filter((m: { role: string }) => m.role === "tool")[2].content);
    expect(third.result.error).toContain("Not run again");
  });

  it("keeps a file write and the read after it in order", async () => {
    const order: string[] = [];
    const toolExecutor = vi.fn(async (name: ToolName, args: Record<string, unknown>, context: Parameters<typeof executeTool>[2]) => {
      if (name === "complete_session") return executeTool(name, args, context);
      order.push(`start ${name} ${String(args.path ?? args.command)}`);
      await new Promise((resolve) => setTimeout(resolve, name === "save_file" ? 30 : 5));
      order.push(`end ${name} ${String(args.path ?? args.command)}`);
      return { ok: true, data: {} } as ToolResult;
    });
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce(reply(
        call("r1", "read_file", { path: "artifacts/notes.md" }),
        call("w", "save_file", { path: "artifacts/notes.md", content: "new" }),
        call("r2", "read_file", { path: "artifacts/notes.md" }),
        call("s", "run_shell", { command: "wc -c artifacts/notes.md" })))
      .mockResolvedValueOnce(done) };
    await runAgentTaskDetailed(await session(), "update the notes", { provider, toolExecutor, knowledge: false, parallelTools: "on" });

    expect(order.indexOf("start save_file artifacts/notes.md")).toBeGreaterThan(order.indexOf("end read_file artifacts/notes.md"));
    expect(order.indexOf("start read_file artifacts/notes.md", order.indexOf("end save_file artifacts/notes.md"))).toBeGreaterThan(0);
    // The two reads after the write ran together.
    expect(order.indexOf("start run_shell wc -c artifacts/notes.md")).toBeLessThan(order.lastIndexOf("end read_file artifacts/notes.md"));
  });

  it("tells the model only in hint mode", async () => {
    const provider = { complete: vi.fn().mockResolvedValue(done) };
    await runAgentTaskDetailed(await session(), "hello", { provider, knowledge: false, parallelTools: "hint" });
    await runAgentTaskDetailed(await session(), "hello", { provider, knowledge: false, parallelTools: "on" });
    const [hinted, plain] = provider.complete.mock.calls.map(([messages]) => messages[0].content as string);
    expect(hinted).toContain("run at the same time");
    expect(plain).not.toContain("run at the same time");
  });
});

const startCommand = (): Command => ({ protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1,
  emittedAt: "2026-11-26T00:00:00Z", type: "run.start", payload: { session: { kind: "create", sessionId: "session-1" },
    prompt: "Compare the two files", modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto" } });

it("keys two parallel calls of one tool apart in the hosted worker, and traces their group", async () => {
  vi.stubEnv("OPENCROWD_PARALLEL_TOOLS", "1");
  const home = await mkdtemp(join(tmpdir(), "parallel-worker-")); roots.push(home);
  const events: Event[] = [];
  let turn = 0, waiting = 0, release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  const provider = { complete: async () => ++turn === 1
    ? { content: "", toolCalls: [call("s1", "run_shell", { command: "cat a.txt" }), call("s2", "run_shell", { command: "cat b.txt" })] }
    : { content: "Both files read.", toolCalls: [] } };
  // Each call waits for the other to start: sequential execution would never finish.
  const toolExecutor = async () => { if (++waiting === 2) release(); await bothStarted; return { ok: true, data: { stdout: "x" } } as ToolResult; };
  const worker = new MachineWorker({ agentHome: home, provider: () => provider, toolExecutor, output: (line) => events.push(JSON.parse(line)) });
  await worker.initialize(); await worker.handleLine(JSON.stringify(startCommand())); await worker.drain();

  expect(events.filter((e) => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
  const started = events.filter((e) => e.type === "tool.started").map((e) => e.payload as Record<string, any>);
  expect(new Set(started.map((p) => p.toolCallId)).size).toBe(2);
  expect(started.map((p) => p.parallel)).toEqual([
    { group: "0:s1", index: 0, size: 2 }, { group: "0:s1", index: 1, size: 2 }]);
  expect(events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
});

describe("readOnlyShell: a guard, so it errs towards running alone", () => {
  it.each([
    "cat context/abc/message-33.txt",
    "grep -nEi 'latency|quality|artifact_path' context/a4c1/transcript.jsonl",
    "sed -n '1,240p' context/982c/message-2.txt",
    "wc -l -c context/f258/transcript.jsonl",
    "ls -la artifacts && find artifacts -maxdepth 3 -type f | head -80",
    "curl -fsSL https://example.com/data.json | jq '.items[0]'",
    "command -v curl; command -v jq",
    "rg -n -i 'pangram|candidate' context 2>/dev/null",
  ])("reads: %s", (command) => expect(readOnlyShell(command)).toBe(true));

  it.each([
    "curl -fsSL https://taskmarket.dev/install-skill.sh | sh -s -- https://taskmarket.dev",
    "taskmarket task list --status open",
    "cat a > b",
    "echo $(rm -rf x)",
    "sed -i 's/a/b/' notes.md",
    "sed -n 'w copy.txt' notes.md",
    "curl -o page.html https://example.com",
    "curl --output=page.html https://example.com",
    "curl -sSo page.html https://example.com",
    "curl -X POST https://example.com/api",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} ;",
    "sort -o out.txt in.txt",
    "rg --pre ./script pattern",
    "python3 - <<'PY'",
    "sleep 100 &",
    "cat \"$(whoami)\"",
    "cat `whoami`",
    "ls; rm -rf artifacts",
    "mkdir -p work && cd work",
  ])("does not: %s", (command) => expect(readOnlyShell(command)).toBe(false));

  const reads = fc.constantFrom("cat a.txt", "ls -la", "grep -n x f", "wc -l f", "head -5 f", "curl -s https://example.com", "jq . f.json", "sed -n '1,5p' f");
  const writes = fc.constantFrom("rm -rf x", "cat a > b", "echo x >> log", "tee out", "python3 x.py", "sh -c ls", "npm install", "curl -o f https://e.com",
    "sed -i s/a/b/ f", "find . -delete", "cp a b", "mv a b", "touch f", "chmod +x f", "xargs rm", "node -e 1", "git push", "echo $(id)", "sleep 9 &");
  const joiner = fc.constantFrom(" && ", " ; ", " | ", " || ");

  it("is false for any chain that holds one command which is not a read", () => {
    fc.assert(fc.property(fc.array(reads, { maxLength: 4 }), writes, fc.array(reads, { maxLength: 4 }), joiner,
      (before, write, after, join) => !readOnlyShell([...before, write, ...after].join(join))));
  });

  it("is true for any chain of reads, and parallelSafe follows it", () => {
    fc.assert(fc.property(fc.array(reads, { minLength: 1, maxLength: 5 }), joiner, (parts, join) => {
      const command = parts.join(join);
      return readOnlyShell(command) && parallelSafe("run_shell", { command });
    }));
  });

  it("never treats a paid, writing or control tool as parallel-safe, whatever its arguments", () => {
    const tools = fc.constantFrom("call_paid_service", "review_paid_service", "bridge_usdc", "request_service", "save_file", "complete_session",
      "spawn_subagent", "deploy_service", "publish_site", "vault_request", "automations", "set_crowdcode_enabled", "delete_my_review", "control.org_todos");
    fc.assert(fc.property(tools, fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.boolean())), (name, args) => !parallelSafe(name, args)));
    expect(parallelSafe("read_service", { url: "https://x.example/job/1" })).toBe(true);
    expect(parallelSafe("read_service", { url: "https://x.example/api/sessions/act", method: "POST" })).toBe(false);
  });
});
