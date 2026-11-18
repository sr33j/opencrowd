import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenCrowdSession, type SessionState } from "@opencrowd/core";
import { clearTreeCache, EconomyGateway, MockAgentCashAdapter, MockCrowdCodeAdapter } from "@opencrowd/economy";
import { RunStartCommandSchema, type Command, type Event } from "@opencrowd/protocol";
import { MachineWorker } from "../src/worker.js";
import {
  bundledKnowledgeDir,
  loadKnowledgeTree,
  renderCapabilityIndex,
  resolveKnowledgeDir,
  runAgentTaskDetailed,
  type LlmMessage,
  type LlmProvider
} from "../src/index.js";

let home: string;
let session: SessionState;
const savedEnv = process.env.OPENCROWD_KNOWLEDGE_DIR;

beforeEach(async () => {
  clearTreeCache();
  home = await mkdtemp(join(tmpdir(), "oc-knowledge-"));
  session = await createOpenCrowdSession({ workspaceRoot: home, approvalMode: "auto", shellEnabled: false });
  delete process.env.OPENCROWD_KNOWLEDGE_DIR;
});

afterEach(async () => {
  if (savedEnv === undefined) {
    delete process.env.OPENCROWD_KNOWLEDGE_DIR;
  } else {
    process.env.OPENCROWD_KNOWLEDGE_DIR = savedEnv;
  }
  await rm(home, { recursive: true, force: true });
});

describe("bundled knowledge tree", () => {
  it("ships L0, INDEX, and category pages with metadata", async () => {
    const dir = bundledKnowledgeDir();
    await access(join(dir, "L0.md"));
    await access(join(dir, "INDEX.md"));
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as { content_hash: string; validation: { ok: boolean } };
    expect(meta.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.validation.ok).toBe(true);
    expect(await resolveKnowledgeDir()).toBe(dir);
  });

  it("loads into the session artifacts and records the version", async () => {
    const loaded = await loadKnowledgeTree(session);
    expect(loaded).toBeDefined();
    expect(loaded!.l0.length).toBeGreaterThan(200);
    await access(join(session.artifactsDir, "knowledge", "INDEX.md"));
    await access(join(session.artifactsDir, "knowledge", "categories"));
    expect(session.knowledge?.version).toBe(loaded!.version);
    const persisted = JSON.parse(await readFile(join(session.sessionDir, "session.json"), "utf8")) as SessionState;
    expect(persisted.knowledge?.version).toBe(loaded!.version);
  });
});

describe("knowledge resolution", () => {
  it("is disabled by OPENCROWD_KNOWLEDGE_DIR=none", async () => {
    process.env.OPENCROWD_KNOWLEDGE_DIR = "none";
    expect(await resolveKnowledgeDir()).toBeUndefined();
    expect(await loadKnowledgeTree(session)).toBeUndefined();
  });

  it("prefers an explicit directory and versions by L0 content when metadata is absent", async () => {
    const custom = join(home, "tree");
    await mkdir(join(custom, "categories"), { recursive: true });
    await writeFile(join(custom, "L0.md"), "- Web search -> https://example.dev/search -> $0.01\n");
    await writeFile(join(custom, "INDEX.md"), "- search -> categories/search.md\n");
    await writeFile(join(custom, "categories", "search.md"), "# search\n");
    const loaded = await loadKnowledgeTree(session, { dir: custom });
    expect(loaded?.version).toMatch(/^l0-[0-9a-f]{16}$/);
    expect(loaded?.source).toBe(custom);
    expect(await readFile(join(session.artifactsDir, "knowledge", "categories", "search.md"), "utf8")).toBe("# search\n");
  });
});

describe("prompt injection", () => {
  function capturingProvider(seen: LlmMessage[][]): LlmProvider {
    return {
      async complete(messages) {
        seen.push(messages);
        throw new Error("captured");
      }
    };
  }

  const dynamicTools = {
    definitions: [{ name: "find_paid_service", description: "x", parameters: { type: "object", properties: {} } }],
    execute: async () => ({ ok: true, data: {} })
  };

  it("renders L0 into the system prompt when paid tools are present", async () => {
    const seen: LlmMessage[][] = [];
    await expect(runAgentTaskDetailed(session, "task", { provider: capturingProvider(seen), dynamicTools })).rejects.toThrow("captured");
    const system = seen[0][0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("Service knowledge base (derived from CrowdCode reviews");
    expect(system.content).toContain("knowledge/INDEX.md");
    expect(system.content).not.toContain("Paid capability index — fast paths");
  });

  it("keeps the static capability line when knowledge is false or paid tools are absent", async () => {
    const seen: LlmMessage[][] = [];
    await expect(runAgentTaskDetailed(session, "task", { provider: capturingProvider(seen), dynamicTools, knowledge: false })).rejects.toThrow("captured");
    expect(seen[0][0].content).toContain("Paid capability index — fast paths");
    await expect(runAgentTaskDetailed(session, "task", { provider: capturingProvider(seen) })).rejects.toThrow("captured");
    expect(seen[1][0].content).not.toContain("Service knowledge base");
  });

  it("renderCapabilityIndex wraps L0 with the pointer to on-demand pages", () => {
    const text = renderCapabilityIndex("- x\n");
    expect(text.split("\n")[1]).toBe("- x");
    expect(text).toContain("knowledge/categories/<name>.md");
  });
});

describe("CrowdCode's live capability tree (C7)", () => {
  const BASE = "https://crowdcode.test";
  const L0 = "CrowdCode capability tree v4 (2026-11-17).\nFree first: use local files, shell, Python and free public APIs; once they answer, stop.\n- search: Finding pages you have no URL for. → nothing reliable yet";
  const treeFetcher = (urls: string[] = []) => (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true, version: 4, built_at: "2026-11-17T02:23:01Z", published: true, nodes: [], l0: L0 }), { status: 200 });
  }) as typeof fetch;
  const dynamicTools = {
    definitions: [{ name: "browse_services", description: "x", parameters: { type: "object", properties: {} } }],
    execute: async () => ({ ok: true, data: {} })
  };
  const capture = (seen: LlmMessage[][]): LlmProvider => ({ async complete(messages) { seen.push(messages); throw new Error("captured"); } });

  it("puts the live L0 in the system prompt in place of the bundled one, and records the version", async () => {
    const seen: LlmMessage[][] = [];
    const urls: string[] = [];
    await expect(runAgentTaskDetailed(session, "task", { provider: capture(seen), dynamicTools,
      knowledge: { live: { base: BASE, fetcher: treeFetcher(urls), version: "candidate" } } })).rejects.toThrow("captured");
    const system = seen[0][0].content;
    expect(system).toContain(L0);
    expect(system).toContain("browse_services(<node>)");
    expect(system).not.toContain("knowledge/INDEX.md");
    expect(system).not.toContain("Service knowledge base (derived from CrowdCode reviews");
    expect(urls).toEqual([`${BASE}/api/tree?version=candidate`]);
    expect(session.knowledge).toMatchObject({ version: "capability-tree-v4", tree: 4, source: `${BASE}/api/tree` });
    const persisted = JSON.parse(await readFile(join(session.sessionDir, "session.json"), "utf8")) as SessionState;
    expect(persisted.knowledge?.tree).toBe(4);
  });

  it("falls back to the bundled snapshot when the backend is unreachable, and says why on the session", async () => {
    const seen: LlmMessage[][] = [];
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(runAgentTaskDetailed(session, "task", { provider: capture(seen), dynamicTools,
      knowledge: { live: { base: BASE, fetcher: down } } })).rejects.toThrow("captured");
    expect(seen[0][0].content).toContain("Service knowledge base (derived from CrowdCode reviews");
    expect(seen[0][0].content).not.toContain("CrowdCode capability tree v4");
    expect(session.knowledge?.tree).toBeUndefined();
    expect(session.knowledge?.fallback).toContain("fetch failed");
  });

  it("an explicit directory still wins over the live tree", async () => {
    const custom = join(home, "tree");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, "L0.md"), "- custom\n");
    const urls: string[] = [];
    expect((await loadKnowledgeTree(session, { dir: custom, live: { base: BASE, fetcher: treeFetcher(urls) } }))?.l0).toBe("- custom");
    expect(urls).toEqual([]);
  });

  describe("on a hosted worker", () => {
    const start = (treeVersion?: string): Command => ({ protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-11-17T00:00:00Z",
      type: "run.start", payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "What is 2 + 2?", modelPolicy: {},
        budget: { limit: "1000000" }, approvalMode: "auto", ...(treeVersion ? { treeVersion } : {}) } });

    async function run(fetcher: typeof fetch, treeVersion?: string) {
      const agentHome = await mkdtemp(join(tmpdir(), "oc-live-tree-"));
      const events: Event[] = [];
      let system = "";
      const provider: LlmProvider = { async complete(messages) {
        system = messages.find((m) => m.role === "system")?.content ?? "";
        return { content: "4", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "4" } }] };
      } };
      const worker = new MachineWorker({ agentHome, output: (line) => { events.push(JSON.parse(line)); }, provider: () => provider,
        liveTree: { base: BASE, fetcher },
        economy: (_run, current) => new EconomyGateway({ session: current, agentcash: new MockAgentCashAdapter(), crowdcode: new MockCrowdCodeAdapter(),
          approvalMode: "auto", approvalRulesPath: join(agentHome, "rules.json") }) });
      await worker.initialize(); await worker.handleLine(JSON.stringify(start(treeVersion))); await worker.drain();
      const recorded = JSON.parse(await readFile(join(agentHome, "workspace/sessions/session-1/session.json"), "utf8")) as SessionState;
      await rm(agentHome, { recursive: true, force: true });
      const finished = events.filter((e) => e.type === "run.finished").at(-1) as Extract<Event, { type: "run.finished" }> | undefined;
      return { system, outcome: finished?.payload.outcome, knowledge: recorded.knowledge, reported: finished?.payload.knowledge };
    }

    it("reads the tree a run.start pins and records its version on the session", async () => {
      const urls: string[] = [];
      const result = await run(treeFetcher(urls), "candidate");
      expect(result.outcome).toBe("completed");
      expect(result.system).toContain(L0);
      expect(result.knowledge).toMatchObject({ version: "capability-tree-v4", tree: 4 });
      // run.finished reports the tree this run read, for the tree gate (W8).
      expect(result.reported).toEqual({ version: "capability-tree-v4", tree: 4 });
      // The worker's load and the loop's load share one fetch.
      expect(urls).toEqual([`${BASE}/api/tree?version=candidate`]);
    });

    it("reads a pinned version afresh on every run, while unpinned runs share the hour's copy", async () => {
      const urls: string[] = [];
      const fetcher = treeFetcher(urls);
      await run(fetcher, "12");
      await run(fetcher, "12");
      expect(urls).toEqual([`${BASE}/api/tree?version=12`, `${BASE}/api/tree?version=12`]);
      urls.length = 0;
      await run(fetcher);
      await run(fetcher);
      expect(urls).toEqual([`${BASE}/api/tree`]);
    });

    it("reports no tree for a run that read none", async () => {
      const agentHome = await mkdtemp(join(tmpdir(), "oc-live-tree-"));
      const events: Event[] = [];
      const provider: LlmProvider = { async complete() { return { content: "4", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "4" } }] }; } };
      const worker = new MachineWorker({ agentHome, output: (line) => { events.push(JSON.parse(line)); }, provider: () => provider, liveTree: false });
      await worker.initialize(); await worker.handleLine(JSON.stringify(start())); await worker.drain();
      await rm(agentHome, { recursive: true, force: true });
      const finished = events.filter((e) => e.type === "run.finished").at(-1) as Extract<Event, { type: "run.finished" }>;
      expect(finished.payload.outcome).toBe("completed");
      expect(finished.payload.knowledge).toBeUndefined();
    });

    it("rejects a malformed pin at the protocol boundary", () => {
      expect(RunStartCommandSchema.safeParse(start("candidate")).success).toBe(true);
      expect(RunStartCommandSchema.safeParse(start("7")).success).toBe(true);
      expect(RunStartCommandSchema.safeParse(start("latest")).success).toBe(false);
    });

    it("gives a run the last tree served, not the September snapshot, when the backend is slow", async () => {
      // Two wakes of one agent: the first reads v4; by the second the backend is warming up past the deadline.
      const agentHome = await mkdtemp(join(tmpdir(), "oc-live-tree-"));
      const slow = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
      })) as unknown as typeof fetch;
      const wake = async (fetcher: typeof fetch) => {
        clearTreeCache();
        const events: Event[] = [];
        let system = "";
        const provider: LlmProvider = { async complete(messages) {
          system = messages.find((m) => m.role === "system")?.content ?? "";
          return { content: "4", toolCalls: [{ id: "c", name: "complete_session", arguments: { final_message: "4" } }] };
        } };
        const worker = new MachineWorker({ agentHome, output: (line) => { events.push(JSON.parse(line)); }, provider: () => provider,
          liveTree: { base: BASE, fetcher, timeoutMs: 200, retryDelayMs: 1, now: () => Date.now() + (fetcher === slow ? 2 * 60 * 60_000 : 0) },
          economy: (_run, current) => new EconomyGateway({ session: current, agentcash: new MockAgentCashAdapter(), crowdcode: new MockCrowdCodeAdapter(),
            approvalMode: "auto", approvalRulesPath: join(agentHome, "rules.json") }) });
        await worker.initialize();
        const command = { ...start(), id: `command-${events.length}${fetcher === slow ? "b" : "a"}`, runId: fetcher === slow ? "run-2" : "run-1" };
        await worker.handleLine(JSON.stringify(command)); await worker.drain();
        const finished = events.filter((e) => e.type === "run.finished").at(-1) as Extract<Event, { type: "run.finished" }>;
        return { system, finished: finished.payload };
      };
      try {
        expect((await wake(treeFetcher())).finished.knowledge).toEqual({ version: "capability-tree-v4", tree: 4 });
        const second = await wake(slow);
        expect(second.finished.outcome).toBe("completed");
        expect(second.system).toContain(L0);
        expect(second.system).not.toContain("Service knowledge base (derived from CrowdCode reviews");
        expect(second.finished.knowledge).toMatchObject({ version: "capability-tree-v4", tree: 4 });
        expect(second.finished.knowledge?.fallback).toMatch(/unavailable after 2 attempts.*using the last tree served, v4, fetched 20/);
      } finally {
        await rm(agentHome, { recursive: true, force: true });
      }
    });

    it("completes on the bundled snapshot when CrowdCode is unreachable", async () => {
      const hanging = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
      const started = Date.now();
      const result = await run(hanging);
      expect(result.outcome).toBe("completed");
      // Two attempts of 4 s and the pause between them: never much more than 8.3 s.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.system).toContain("Service knowledge base (derived from CrowdCode reviews");
      expect(result.knowledge?.fallback).toMatch(/capability tree unavailable/);
      expect(result.reported?.version).toBe(result.knowledge?.version);
      expect(result.reported?.tree).toBeUndefined();
      expect(result.reported?.fallback).toMatch(/capability tree unavailable/);
    }, 15_000);
  });
});
