import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenCrowdSession, type SessionState } from "@opencrowd/core";
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
