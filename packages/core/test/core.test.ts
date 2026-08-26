import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearConversation,
  compactConversationIfNeeded,
  appendConversationMessage,
  readConversationMessages,
  createOpenCrowdSession,
  createSession,
  DEFAULT_CONFIG,
  listArtifacts,
  loadConfig,
  openCrowdToolDefinition,
  readAgentCashWallet,
  requireAgentCashWallet,
  reserveBudget,
  finalizeReservation,
  saveArtifact,
  updateConfig,
  runShell
} from "../src/index.js";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencrowd-test-"));
  tmpRoots.push(root);
  return root;
}

// Keep the developer's real shared AgentCash wallet out of test runs.
process.env.AGENTCASH_WALLET_PATH = "/nonexistent/agentcash-wallet.json";

afterEach(async () => {
  delete process.env.OPENCROWD_CONFIG_DIR;
  process.env.AGENTCASH_WALLET_PATH = "/nonexistent/agentcash-wallet.json";
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("budget accounting", () => {
  it("reserves and finalizes spend without overspending", async () => {
    const session = await createSession({ workspaceRoot: await tempRoot(), budgetCents: 100 });
    const reservation = await reserveBudget(session, 40);
    expect(session.reservedCents).toBe(40);
    await finalizeReservation(session, reservation, 25);
    expect(session.reservedCents).toBe(0);
    expect(session.spentCents).toBe(25);
    await expect(reserveBudget(session, 80)).rejects.toThrow("budget exceeded");
  });

  it("accepts fractional charged cents — most single LLM calls cost under a cent", async () => {
    const session = await createSession({ workspaceRoot: await tempRoot(), budgetCents: 100 });
    await finalizeReservation(session, await reserveBudget(session, 10), 0.217);
    await finalizeReservation(session, await reserveBudget(session, 10), 0.033);
    expect(session.spentCents).toBeCloseTo(0.25, 4);
    expect(session.reservedCents).toBe(0);
  });
});

describe("OpenCrowd session defaults", () => {
  it("uses BlockRun as the primary provider with matching proxy rescue models", () => {
    expect(DEFAULT_CONFIG.provider).toBe("blockrun");
    expect(DEFAULT_CONFIG.blockrun).toEqual(DEFAULT_CONFIG["openrouter-x402-proxy"]);
  });

  it("migrates the former x402 default to BlockRun while preserving its proxy settings", async () => {
    const root = await tempRoot();
    const configDir = join(root, "config");
    process.env.OPENCROWD_CONFIG_DIR = configDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify({
      provider: "x402",
      x402: { model: "openai/legacy-main", submodel: "openai/legacy-sub" },
      x402ProxyUrl: "https://legacy-proxy.test/v1"
    }));

    const config = await loadConfig();
    expect(config.provider).toBe("blockrun");
    expect(config["openrouter-x402-proxy"]).toEqual({ model: "openai/legacy-main", submodel: "openai/legacy-sub" });
    expect(config.openrouterX402ProxyUrl).toBe("https://legacy-proxy.test/v1");
  });

  it("normalizes an explicitly selected legacy x402 alias to the canonical proxy name", async () => {
    const root = await tempRoot();
    const configDir = join(root, "config");
    process.env.OPENCROWD_CONFIG_DIR = configDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify({
      provider: "x402",
      blockrun: DEFAULT_CONFIG.blockrun,
      x402: DEFAULT_CONFIG["openrouter-x402-proxy"]
    }));

    expect((await loadConfig()).provider).toBe("openrouter-x402-proxy");
  });

  it("defaults to ask mode, shell access, and the configured budget cap without any network lookup", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");

    const session = await createOpenCrowdSession({ workspaceRoot: root });

    expect(session.approvalMode).toBe("ask");
    expect(session.shellEnabled).toBe(true);
    expect(session.budgetCents).toBe(2000);
  });

  it("uses the configured default budget cap", async () => {
    const root = await tempRoot();
    process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
    await updateConfig({ defaultBudgetCents: 750 });

    const session = await createOpenCrowdSession({ workspaceRoot: root });

    expect(session.budgetCents).toBe(750);
  });
});

describe("AgentCash wallet contract", () => {
  it("reads the shared AgentCash wallet file when present", async () => {
    const root = await tempRoot();
    const walletPath = join(root, "wallet.json");
    await writeFile(walletPath, JSON.stringify({
      address: "0x1111111111111111111111111111111111111111",
      privateKey: "0x59c6995e998f97a5a0044966f094538f89d8f907357e22278c4cfeabf7c5d1c6"
    }));
    process.env.AGENTCASH_WALLET_PATH = walletPath;

    await expect(readAgentCashWallet()).resolves.toMatchObject({
      address: "0x1111111111111111111111111111111111111111"
    });
    await expect(requireAgentCashWallet()).resolves.toMatchObject({
      address: "0x1111111111111111111111111111111111111111"
    });
  });

  it("fails with an installation hint when no AgentCash wallet exists", async () => {
    process.env.AGENTCASH_WALLET_PATH = "/nonexistent/agentcash-wallet.json";

    await expect(readAgentCashWallet()).resolves.toBeUndefined();
    await expect(requireAgentCashWallet()).rejects.toThrow("No AgentCash wallet found");
  });
});

describe("conversation clearing", () => {
  it("archives prior messages and starts the context fresh", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, budgetCents: 100 });
    await appendConversationMessage(session, { role: "user", content: "first task" });
    await appendConversationMessage(session, { role: "assistant", content: "done" });

    const result = await clearConversation(session);

    expect(result.cleared).toBe(true);
    expect(result.messagesCleared).toBe(2);
    expect(result.archivePath).toMatch(/^context\/cleared-/);
    await expect(readConversationMessages(session)).resolves.toEqual([]);
    const archived = await readFile(join(session.sessionDir, result.archivePath ?? ""), "utf8");
    expect(archived).toContain("first task");

    await expect(clearConversation(session)).resolves.toMatchObject({ cleared: false, messagesCleared: 0 });
  });
});

describe("conversation compaction", () => {
  it("archives older messages and keeps a compacted continuation", async () => {
    const session = await createSession({ workspaceRoot: await tempRoot() });
    for (let index = 0; index < 10; index += 1) {
      await appendConversationMessage(session, { role: "user", content: `message ${index} ${"x".repeat(200)}` });
    }

    const result = await compactConversationIfNeeded(session, {
      contextWindowTokens: 1_000,
      thresholdRatio: 0.2,
      keepRecentTokens: 120
    });

    expect(result.compacted).toBe(true);
    expect(result.archivePath).toMatch(/^context\//);
    expect(result.messages[0]?.content).toContain("Original transcript archive:");
  });
});

describe("artifacts", () => {
  it("stores artifacts inside the session and rejects traversal", async () => {
    const session = await createSession({ workspaceRoot: await tempRoot() });
    const artifact = await saveArtifact(session, "reports/out.txt", "hello");
    expect(artifact.path).toBe("artifacts/reports/out.txt");
    await expect(readFile(join(session.sessionDir, artifact.path), "utf8")).resolves.toBe("hello");
    await expect(saveArtifact(session, "../outside.txt", "no")).rejects.toThrow("artifact path");
    await expect(listArtifacts(session)).resolves.toEqual(["reports/out.txt"]);
  });
});

describe("shell policy", () => {
  it("rejects disabled shell, unsafe cwd, and excessive timeout", async () => {
    const root = await tempRoot();
    const disabled = await createSession({ workspaceRoot: root, shellEnabled: false });
    await expect(runShell(disabled, "echo hi")).rejects.toThrow("disabled");

    const enabled = await createSession({ workspaceRoot: root, shellEnabled: true });
    await expect(runShell(enabled, "echo hi", "/", 1000)).rejects.toThrow("workspace");
    await expect(runShell(enabled, "echo hi", root, 60_000)).rejects.toThrow("timeout_ms");
  });

  it("resolves artifact cwd and returns spawn failures as tool results", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, shellEnabled: true });

    await expect(runShell(session, "pwd", "artifacts", 1000)).resolves.toMatchObject({
      cwd: session.artifactsDir,
      exit_code: 0
    });
    await expect(runShell(session, "pwd", "missing-dir", 1000)).resolves.toMatchObject({
      cwd: join(root, "missing-dir"),
      exit_code: null
    });
  });

  it("returns when a background child keeps stdio open after the shell exits", async () => {
    const root = await tempRoot();
    const session = await createSession({ workspaceRoot: root, shellEnabled: true });
    await writeFile(
      join(root, "background-child.js"),
      "setInterval(() => process.stdout.write('still-running\\n'), 1000);\n"
    );

    const startedAt = Date.now();
    const result = await runShell(session, `"${process.execPath}" background-child.js & echo done`, root, 5_000);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({
      exit_code: 0,
      timed_out: false
    });
    expect(result.stdout).toContain("done");
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function addressPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address is not available");
  }
  return address.port;
}
