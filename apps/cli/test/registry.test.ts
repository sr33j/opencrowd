import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSession, loadSession, type SessionState } from "@opencrowd/core";
import {
  COMMAND_REGISTRY,
  matchCommands,
  renderCommandHelp,
  renderCommandHelpMarkdown,
  runSlashCommand,
  type CommandContext
} from "../src/registry.js";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencrowd-cli-test-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.OPENCROWD_CONFIG_DIR;
  delete process.env.AGENTCASH_WALLET_PATH;
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function context(overrides: Partial<SessionState> = {}): Promise<CommandContext> {
  const root = await tempRoot();
  process.env.OPENCROWD_CONFIG_DIR = join(root, "config");
  const session = await createSession({ workspaceRoot: root, budgetCents: 500 });
  Object.assign(session, overrides);
  return { session, state: { testMode: true } };
}

const FINAL_COMMANDS = [
  "status", "provider", "models", "model", "submodel", "budget", "approval",
  "approvals", "wallet", "fund", "ledger", "summary", "clear", "new", "help", "quit"
];

describe("command registry", () => {
  it("contains exactly the final command contract", () => {
    expect(COMMAND_REGISTRY.map((command) => command.name)).toEqual(FINAL_COMMANDS);
  });

  it("does not contain removed legacy commands", () => {
    const names = COMMAND_REGISTRY.map((command) => command.name);
    for (const removed of ["run", "search", "permissions", "mode", "test-mode", "test-seed", "mcp", "api"]) {
      expect(names).not.toContain(removed);
    }
    const helpText = renderCommandHelp();
    expect(helpText).not.toMatch(/ask_first|yolo|blocked/);
  });

  it("drives autocomplete and help from the same table", () => {
    expect(matchCommands("s").map((command) => command.name)).toEqual(["status", "submodel", "summary"]);
    const help = renderCommandHelp();
    const markdown = renderCommandHelpMarkdown();
    for (const command of COMMAND_REGISTRY) {
      expect(help).toContain(command.usage);
      expect(markdown).toContain(command.summary);
    }
  });

  it("rejects unknown commands with a /help hint", async () => {
    const ctx = await context();
    await expect(runSlashCommand(ctx, "definitely-not-a-command")).rejects.toThrow("/help");
  });
});

describe("session mutation commands", () => {
  it("/budget sets the session cap and persists it, never below finalized spend", async () => {
    const ctx = await context();
    await runSlashCommand(ctx, "budget 3.50");
    expect(ctx.session.budgetCents).toBe(350);
    const reloaded = await loadSession(ctx.session.workspaceRoot, ctx.session.sessionId);
    expect(reloaded.budgetCents).toBe(350);

    ctx.session.spentCents = 200;
    await expect(runSlashCommand(ctx, "budget 1.00")).rejects.toThrow("below already-spent");
  });

  it("/approval controls the session's external-purchase policy", async () => {
    const ctx = await context();
    expect(ctx.session.approvalMode).toBe("ask");
    await runSlashCommand(ctx, "approval auto");
    expect(ctx.session.approvalMode).toBe("auto");
    await runSlashCommand(ctx, "approval off");
    expect(ctx.session.approvalMode).toBe("off");
    await expect(runSlashCommand(ctx, "approval sometimes")).rejects.toThrow("ask, auto, or off");
  });

  it("/approvals manages stored allow/block rules with caps", async () => {
    const ctx = await context();
    await runSlashCommand(ctx, "approvals allow https://svc.example --max-cost 0.25");
    await runSlashCommand(ctx, "approvals block https://bad.example");
    const list = await runSlashCommand(ctx, "approvals");
    expect(list.kind).toBe("text");
    const body = (list as { body: string }).body;
    expect(body).toContain("svc.example");
    expect(body).toContain("bad.example");

    await runSlashCommand(ctx, "approvals remove https://bad.example");
    const after = await runSlashCommand(ctx, "approvals list");
    expect((after as { body: string }).body).not.toContain("bad.example");
  });

  it("session commands do not mutate persistent config defaults", async () => {
    const ctx = await context();
    const { loadConfig } = await import("@opencrowd/core");
    const before = await loadConfig();
    await runSlashCommand(ctx, "budget 9.99");
    await runSlashCommand(ctx, "approval auto");
    const after = await loadConfig();
    expect(after.defaultBudgetCents).toBe(before.defaultBudgetCents);
    expect(after.approval).toBe(before.approval);
  });
});

describe("inspection commands", () => {
  it("/provider shows the BlockRun default and /provider help explains every route", async () => {
    const ctx = await context();
    const current = await runSlashCommand(ctx, "provider") as { body: string };
    expect(current.body).toContain("blockrun");
    expect(current.body).toContain("openrouter-x402-proxy");

    const help = await runSlashCommand(ctx, "provider help") as { body: string };
    expect(help.body).toContain("BlockRun gateway");
    expect(help.body).toContain("OPENROUTER_API_KEY");
  });

  it("/provider renders legacy x402 sessions with the canonical proxy name", async () => {
    const ctx = await context({
      models: { provider: "x402", main: "model-a", resolvedAt: "2026-01-01" }
    });
    expect((await runSlashCommand(ctx, "provider") as { body: string }).body)
      .toContain("openrouter-x402-proxy");
  });

  it("/fund preserves complete copyable Base transfer links", async () => {
    const ctx = await context();
    ctx.state.testMode = false;
    const walletPath = join(await tempRoot(), "wallet.json");
    process.env.AGENTCASH_WALLET_PATH = walletPath;
    await writeFile(walletPath, JSON.stringify({
      address: "0xF5a65ae916474Da7fB0B47C6182E6c4Eb63A0C80",
      privateKey: `0x${"1".repeat(64)}`
    }));

    const result = await runSlashCommand(ctx, "fund") as { body: string };
    expect(result.body).toContain("uint256=20000000");
    expect(result.body).toContain("https://metamask.app.link/send/");
    expect(result.body).not.toContain("…");
  });

  it("/status reports session, models, budget, and approval without needing the network in demo mode", async () => {
    const ctx = await context({
      models: { provider: "venice", main: "model-a", subagent: "model-b", resolvedAt: "2026-01-01" }
    });
    const result = await runSlashCommand(ctx, "status");
    const body = (result as { body: string }).body;
    expect(body).toContain("venice");
    expect(body).toContain("model-a");
    expect(body).toContain("model-b");
    expect(body).toContain("ask");
  });

  it("/model and /submodel show the session's resolved models", async () => {
    const ctx = await context({
      models: { provider: "venice", main: "model-a", subagent: "model-b", resolvedAt: "2026-01-01" }
    });
    expect((await runSlashCommand(ctx, "model") as { body: string }).body).toContain("model-a");
    expect((await runSlashCommand(ctx, "submodel") as { body: string }).body).toContain("model-b");
    // Mutation needs a live catalog, which demo mode does not have.
    await expect(runSlashCommand(ctx, "model auto")).rejects.toThrow("demo");
  });

  it("/clear, /new, /help, and /quit return their structural results", async () => {
    const ctx = await context();
    expect((await runSlashCommand(ctx, "clear")).kind).toBe("clear");
    expect((await runSlashCommand(ctx, "new")).kind).toBe("new-session");
    expect((await runSlashCommand(ctx, "help")).kind).toBe("help");
    expect((await runSlashCommand(ctx, "quit")).kind).toBe("exit");
  });
});
