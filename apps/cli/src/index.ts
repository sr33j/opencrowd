#!/usr/bin/env node
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  addAllowedService,
  blockService,
  budgetStatus,
  confirmWalletDraft,
  createTestWallet,
  createWalletDraft,
  createOpenCrowdSession,
  ensureDefaultTestWallet,
  exportWalletSecret,
  fundActiveTestWallet,
  listLlmModels,
  listAllowedServices,
  loadConfig,
  loadSession,
  readLedger,
  removeAllowedService,
  saveSession,
  searchServices,
  setActivePaymentWallet,
  setPermissionMode,
  setPreferredLlmModel,
  setWalletAccount,
  setSessionBudget,
  walletAddress,
  walletBalance,
  walletInit,
  walletList,
  walletStatus,
  type PermissionMode,
  type ProgressEvent,
  type ServiceCandidate,
  type SessionState
} from "@opencrowd/core";
import {
  buildSessionSummary,
  createMockToolExecutor,
  MockLlmProvider,
  renderProgress,
  type RenderProgressOptions
} from "@opencrowd/agent-runtime";
import { startMcpServer } from "@opencrowd/mcp";
import { startLocalApi } from "@opencrowd/local-api";
import {
  asRecord,
  envFlag,
  formatCents,
  formatServiceCandidate,
  isConsumedOption,
  latestSessionId,
  optionCents,
  parseUsd,
  readOption,
  renderColumns,
  renderInlinePairs,
  renderKeyValues,
  renderTable,
  shortUrl,
  shouldUseColor,
  splitArgs,
  style,
  terminalWidth
} from "./shared.js";
import { ensureMockRuntime, runPersistentAgentTask, type ReplState } from "./agent-task.js";
import { startTui } from "./tui/app.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command) {
    if (input.isTTY) {
      await startTui();
    } else {
      await repl();
    }
    return;
  }
  if (command === "--test-mode" || command === "--demo" || command === "demo") {
    const extraArgs = rest.filter((arg, index) => !isConsumedOption(rest, index, ["--test-seed"]));
    if (extraArgs.length > 0) {
      throw new Error("top-level --demo/--test-mode launches the interactive UI; use `opencrowd run --test-mode \"task\"` for one-shot tasks");
    }
    const options = { testMode: true, testSeed: readOption(rest, "--test-seed") };
    if (input.isTTY) {
      await startTui(options);
    } else {
      await repl(options);
    }
    return;
  }
  switch (command) {
    case "run":
      await runCommand(rest);
      return;
    case "search":
      await searchCommand(rest);
      return;
    case "permissions":
      await permissionsCommand(rest);
      return;
    case "ledger":
      await ledgerCommand(rest);
      return;
    case "wallet":
      await walletCommand(rest, { testMode: rest.includes("--test-mode") || envFlag("OPENCROWD_TEST_MODE") });
      return;
    case "models":
      await modelsCommand(rest);
      return;
    case "mcp":
      await startMcpServer({ workspaceRoot: process.cwd() });
      return;
    case "api":
      await apiCommand(rest);
      return;
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function repl(options: { testMode?: boolean; testSeed?: string } = {}): Promise<void> {
  const initialTestMode = options.testMode ?? envFlag("OPENCROWD_TEST_MODE");
  if (initialTestMode) {
    await ensureDefaultTestWallet();
  }
  const session = await createOpenCrowdSession({
    workspaceRoot: process.cwd(),
    surface: "cli",
    useWalletBalanceBudget: true
  });
  const rl = createInterface({ input, output });
  const state: ReplState = {
    testMode: initialTestMode,
    testSeed: options.testSeed ?? process.env.OPENCROWD_TEST_SEED
  };
  if (state.testMode) {
    ensureMockRuntime(state);
  }
  console.log(await renderReplIntro(session, state));
  try {
    if (!input.isTTY) {
      for await (const rawLine of rl) {
        const shouldExit = await handleReplLine(session, state, rawLine.trim());
        if (shouldExit) {
          return;
        }
      }
      return;
    }
    while (true) {
      let line: string;
      try {
        line = (await rl.question("opencrowd> ")).trim();
      } catch (error) {
        if ((error as Error).message === "readline was closed") {
          return;
        }
        throw error;
      }
      if (!line) {
        continue;
      }
      const shouldExit = await handleReplLine(session, state, line);
      if (shouldExit) {
        return;
      }
    }
  } finally {
    rl.close();
  }
}

async function handleReplLine(session: SessionState, state: ReplState, line: string): Promise<boolean> {
  if (!line) {
    return false;
  }
  try {
    if (line.startsWith("/")) {
      return await replCommand(session, state, line.slice(1));
    }
    if (line === ":quit" || line === ":exit") {
      console.log(await buildSessionSummary(session, "Interactive session ended.", { compact: true }));
      return true;
    }
    if (line.startsWith(":budget")) {
      await setSessionBudget(session, parseUsd(line.split(/\s+/)[1] ?? "0"));
      printValue("Budget", budgetStatus(session), { pretty: renderKeyValues(asRecord(budgetStatus(session))) });
      return false;
    }
    if (line === ":summary") {
      console.log(await buildSessionSummary(session, "Interactive summary.", { compact: true }));
      return false;
    }
    console.log(await runPersistentAgentTask(session, line, {
      model: state.model,
      testMode: state.testMode,
      testSeed: state.testSeed,
      mockProvider: state.mockProvider,
      mockToolExecutor: state.mockToolExecutor,
      compactOutput: true,
      onProgress: progressLogger({ style: output.isTTY ? "pretty" : "compact", color: shouldUseColor(), width: terminalWidth() })
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  return false;
}

async function replCommand(session: SessionState, state: ReplState, inputLine: string): Promise<boolean> {
  const args = splitArgs(inputLine);
  const [command, ...rest] = args;
  switch (command) {
    case "":
    case "help":
    case "?":
      console.log(await renderReplIntro(session, state));
      return false;
    case "quit":
    case "exit":
      console.log(await buildSessionSummary(session, "Interactive session ended.", { compact: true }));
      return true;
    case "budget":
      await setSessionBudget(session, parseUsd(rest[0] ?? "0"));
      printValue("Budget", budgetStatus(session), { pretty: renderKeyValues(asRecord(budgetStatus(session))) });
      return false;
    case "summary":
      console.log(await buildSessionSummary(session, "Interactive summary.", { compact: rest[0] !== "verbose" }));
      return false;
    case "model":
      if (!rest[0]) {
        printValue("Model", { model: state.model ?? (await loadConfig()).x402LlmModel }, { pretty: renderKeyValues({ model: state.model ?? (await loadConfig()).x402LlmModel }) });
        return false;
      }
      state.model = rest[0];
      printValue("Model", { model: state.model }, { pretty: renderKeyValues({ model: state.model }) });
      return false;
    case "test-mode":
      if (!rest[0]) {
        printValue("Test mode", { test_mode: state.testMode, test_seed: state.testSeed }, { pretty: renderKeyValues({ test_mode: state.testMode, test_seed: state.testSeed }) });
        return false;
      }
      if (!["on", "off"].includes(rest[0])) {
        throw new Error("/test-mode supports on or off");
      }
      state.testMode = rest[0] === "on";
      if (state.testMode) {
        await ensureDefaultTestWallet();
        ensureMockRuntime(state);
      }
      printValue("Test mode", { test_mode: state.testMode, test_seed: state.testSeed }, { pretty: renderKeyValues({ test_mode: state.testMode, test_seed: state.testSeed }) });
      return false;
    case "test-seed":
      if (!rest[0]) {
        printValue("Test seed", { test_seed: state.testSeed }, { pretty: renderKeyValues({ test_seed: state.testSeed }) });
        return false;
      }
      state.testSeed = rest[0];
      if (state.testMode) {
        state.mockProvider = new MockLlmProvider({ seed: state.testSeed });
        state.mockToolExecutor ??= createMockToolExecutor();
      }
      printValue("Test seed", { test_seed: state.testSeed }, { pretty: renderKeyValues({ test_seed: state.testSeed }) });
      return false;
    case "run":
      await replRunCommand(session, state, rest);
      return false;
    case "search":
      await searchCommand(rest);
      return false;
    case "permissions":
      await permissionsCommand(rest);
      return false;
    case "ledger":
      await ledgerCommand(rest, session);
      return false;
    case "wallet":
      await walletCommand(rest, { testMode: state.testMode, session });
      return false;
    case "models":
      await modelsCommand(rest);
      return false;
    case "api":
      await apiCommand(rest);
      return false;
    case "mcp":
      throw new Error("Run `opencrowd mcp` outside the interactive REPL because MCP uses stdio.");
    default:
      throw new Error(`unknown slash command: /${command}`);
  }
}

async function replRunCommand(session: SessionState, state: ReplState, args: string[]): Promise<void> {
  const budgetArg = readOption(args, "--budget");
  if (budgetArg !== undefined) {
    await setSessionBudget(session, parseUsd(budgetArg));
  }
  const model = readOption(args, "--model") ?? state.model;
  const testMode = args.includes("--test-mode") || state.testMode;
  const testSeed = readOption(args, "--test-seed") ?? state.testSeed;
  const task = args.filter((arg, index) => !isConsumedOption(args, index, ["--budget", "--model", "--test-seed"]) && arg !== "--test-mode").join(" ");
  if (!task) {
    throw new Error("/run requires a task string");
  }
  console.log(await runPersistentAgentTask(session, task, {
    model,
    testMode,
    testSeed,
    mockProvider: testMode ? ensureMockRuntime(state).mockProvider : undefined,
    mockToolExecutor: testMode ? ensureMockRuntime(state).mockToolExecutor : undefined,
    compactOutput: true,
    onProgress: progressLogger({ style: output.isTTY ? "pretty" : "compact", color: shouldUseColor(), width: terminalWidth() })
  }));
}

function progressLogger(options: RenderProgressOptions): (event: ProgressEvent) => void {
  return (event) => {
    const message = renderProgress(event, options);
    if (message) {
      console.log(message);
    }
  };
}

async function renderReplIntro(session: SessionState, state: ReplState): Promise<string> {
  const config = await loadConfig();
  const budget = budgetStatus(session);
  const rows: Array<[string, string]> = [
    ["session", `${session.sessionId.slice(0, 8)}...${session.sessionId.slice(-6)}`],
    ["mode", state.testMode ? "test" : session.permissionMode],
    ["model", state.model ?? config.x402LlmModel],
    ["budget", `${formatCents(Number(budget.spent_cents ?? 0))} spent / ${formatCents(Number(budget.remaining_cents ?? 0))} left`],
    ["workspace", process.cwd().split("/").filter(Boolean).at(-1) ?? process.cwd()]
  ];
  const header = `${style("OpenCrowd", "bold")} ${style("CLI", "muted")}`;
  return [
    header,
    renderInlinePairs(rows),
    "",
    style("Commands", "muted"),
    renderColumns([
      "/budget <usd>",
      state.testMode
        ? "/wallet new|list|status|address|balance|use|fund"
        : "/wallet new|list|status|address|balance|use|export",
      "/models list|set <model>",
      "/model <model>",
      "/test-mode on|off",
      "/test-seed <seed>",
      "/run [--budget <usd>] [--model <model>] \"<task>\"",
      "/search \"<query>\"",
      "/permissions list|allow|remove|block",
      "/ledger show [--session <id>]",
      "/summary [verbose]",
      "/quit"
    ])
  ].join("\n");
}

async function runCommand(args: string[]): Promise<void> {
  const budgetArg = readOption(args, "--budget");
  const model = readOption(args, "--model");
  const verbose = args.includes("--verbose");
  const testMode = args.includes("--test-mode") || envFlag("OPENCROWD_TEST_MODE");
  const testSeed = readOption(args, "--test-seed") ?? process.env.OPENCROWD_TEST_SEED;
  const mode = readOption(args, "--mode") as PermissionMode | undefined;
  if (mode !== undefined && !["ask_first", "yolo", "blocked"].includes(mode)) {
    throw new Error("mode must be ask_first, yolo, or blocked");
  }
  const shellEnabled = args.includes("--enable-shell") ? true : args.includes("--disable-shell") ? false : undefined;
  const sessionId = readOption(args, "--session");
  const task = args.filter((arg, index) => !isConsumedOption(args, index, ["--budget", "--mode", "--model", "--session", "--test-seed"])
    && arg !== "--enable-shell"
    && arg !== "--disable-shell"
    && arg !== "--test-mode"
    && arg !== "--verbose").join(" ");
  if (!task) {
    throw new Error("run requires a task string");
  }
  if (testMode) {
    await ensureDefaultTestWallet();
  }
  const session = sessionId
    ? await loadSession(process.cwd(), sessionId)
    : await createOpenCrowdSession({
      workspaceRoot: process.cwd(),
      budgetCents: budgetArg === undefined ? undefined : parseUsd(budgetArg),
      permissionMode: mode,
      shellEnabled,
      surface: "cli",
      useWalletBalanceBudget: true
    });
  if (sessionId) {
    if (budgetArg !== undefined) {
      await setSessionBudget(session, parseUsd(budgetArg));
    }
    if (mode !== undefined) {
      await setPermissionMode(session, mode);
    }
    if (shellEnabled !== undefined) {
      session.shellEnabled = shellEnabled;
      await saveSession(session);
    }
  }
  const outputText = await runPersistentAgentTask(session, task, {
    model,
    testMode,
    testSeed,
    compactOutput: !verbose,
    onProgress: progressLogger({ style: output.isTTY ? "pretty" : "compact", color: shouldUseColor(), width: terminalWidth() })
  });
  console.log(outputText);
}

async function searchCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const query = args.filter((arg) => arg !== "--json").join(" ");
  if (!query) {
    throw new Error("search requires a query");
  }
  const results = await searchServices(query);
  const rows = results.map(formatServiceCandidate);
  printValue("Search results", rows, {
    json,
    pretty: renderTable(rows, [
      ["title", "title"],
      ["price", "price"],
      ["methods", "methods"],
      ["url", "url"]
    ])
  });
}

async function permissionsCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  args = args.filter((arg) => arg !== "--json");
  const [action, resourceUrl] = args;
  switch (action) {
    case "list":
      {
        const permissions = await listAllowedServices();
        printValue("Permissions", permissions, {
          json,
          pretty: renderTable(permissions.map(asRecord), [
            ["resource_url", "service"],
            ["mode", "mode"],
            ["max_cost_cents", "max"],
            ["session_max_cents", "session max"]
          ])
        });
      }
      return;
    case "allow":
      if (!resourceUrl) {
        throw new Error("permissions allow requires a resource URL");
      }
      printValue("Permission", await addAllowedService(resourceUrl, {
        max_cost_cents: optionCents(args, "--max-cost"),
        session_max_cents: optionCents(args, "--session-max")
      }), { json, pretty: `allowed ${shortUrl(resourceUrl)}` });
      return;
    case "remove":
      if (!resourceUrl) {
        throw new Error("permissions remove requires a resource URL");
      }
      await removeAllowedService(resourceUrl);
      console.log("removed");
      return;
    case "block":
      if (!resourceUrl) {
        throw new Error("permissions block requires a resource URL");
      }
      printValue("Permission", await blockService(resourceUrl), { json, pretty: `blocked ${shortUrl(resourceUrl)}` });
      return;
    default:
      throw new Error("permissions supports list, allow, remove, block");
  }
}

async function ledgerCommand(args: string[], currentSession?: SessionState): Promise<void> {
  const json = args.includes("--json");
  args = args.filter((arg) => arg !== "--json");
  const [action] = args;
  if (action !== "show") {
    throw new Error("ledger supports show");
  }
  const explicitSessionId = readOption(args, "--session");
  const ledgerPath = explicitSessionId
    ? join(process.cwd(), "sessions", explicitSessionId, "ledger.csv")
    : currentSession?.ledgerPath;
  const fallbackSessionId = ledgerPath ? undefined : await latestSessionId(process.cwd());
  const resolvedLedgerPath = ledgerPath ?? (fallbackSessionId ? join(process.cwd(), "sessions", fallbackSessionId, "ledger.csv") : undefined);
  if (!resolvedLedgerPath) {
    throw new Error("no local sessions found");
  }
  const rows = await readLedger(resolvedLedgerPath);
  printValue("Ledger", rows, {
    json,
    pretty: renderTable(rows.map(asRecord), [
      ["type", "type"],
      ["status", "status"],
      ["charged_cost_cents", "cost"],
      ["model", "model"],
      ["resource_url", "service"],
      ["artifact_path", "artifact"]
    ])
  });
}

async function walletCommand(args: string[], options: { testMode?: boolean; session?: SessionState } = {}): Promise<void> {
  const json = args.includes("--json");
  const testMode = options.testMode || args.includes("--test-mode");
  args = args.filter((arg) => arg !== "--json" && arg !== "--test-mode");
  const [action, subaction] = args;
  if (action === "new") {
    const label = subaction;
    if (testMode) {
      const wallet = await createTestWallet(label);
      if (options.session) {
        await syncSessionBudgetToActiveWallet(options.session);
      }
      printValue("Wallet", wallet, { json, pretty: renderKeyValues(asRecord(wallet)) });
      return;
    }
    const draft = await createWalletDraft(label);
    if (json) {
      throw new Error("wallet new cannot use --json because seed phrase backup requires an interactive confirmation");
    }
    await confirmSeedPhraseBackup(draft.mnemonic);
    const wallet = await confirmWalletDraft(draft);
    printValue("Wallet", {
      label: wallet.label,
      address: wallet.address,
      network: wallet.network,
      asset: wallet.asset,
      active: true
    }, {
      pretty: renderKeyValues({
        label: wallet.label,
        address: wallet.address,
        network: wallet.network,
        asset: wallet.asset,
        active: true
      })
    });
    return;
  }
  if (action === "list") {
    const wallets = await walletList();
    const rows = wallets.map((wallet) => ({
      active: wallet.active ? "*" : "",
      label: wallet.active ? style(wallet.label, "bold") : wallet.label,
      kind: wallet.kind,
      balance: wallet.spendable_balance_cents,
      asset: wallet.asset,
      address: wallet.address
    }));
    printValue("Wallets", wallets, {
      json,
      pretty: renderTable(rows, [
        ["active", ""],
        ["label", "label"],
        ["kind", "kind"],
        ["balance", "balance"],
        ["asset", "asset"],
        ["address", "address"]
      ])
    });
    return;
  }
  if (action === "init") {
    const result = await walletInit();
    printValue("Wallet", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  if (action === "status") {
    const result = await walletStatus();
    printValue("Wallet", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  if (action === "address") {
    const result = await walletAddress();
    printValue("Wallet", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  if (action === "balance") {
    const result = await walletBalance();
    printValue("Wallet", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  if (action === "use" && subaction) {
    const result = await setActivePaymentWallet(subaction);
    if (testMode && options.session) {
      await syncSessionBudgetToActiveWallet(options.session);
    }
    printValue("Wallet", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  if (action === "fund" && subaction) {
    if (!testMode) {
      throw new Error("wallet fund is only available in --test-mode");
    }
    const amountCents = parseUsd(subaction);
    const result = await fundActiveTestWallet(amountCents);
    if (options.session) {
      await syncSessionBudgetToActiveWallet(options.session);
    }
    printValue("Wallet", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  if (action === "export" && subaction) {
    if (json) {
      throw new Error("wallet export cannot use --json because seed phrase export requires an interactive confirmation");
    }
    await confirmSeedPhraseExport();
    const result = await exportWalletSecret(subaction);
    printValue("Wallet seed phrase", {
      label: result.wallet.label,
      address: result.wallet.address,
      mnemonic: result.mnemonic
    }, {
      pretty: renderKeyValues({
        label: result.wallet.label,
        address: result.wallet.address,
        mnemonic: result.mnemonic
      })
    });
    return;
  }
  throw new Error(testMode
    ? "wallet supports new [label], list, status, address, balance, use <label|address>, fund <usd>"
    : "wallet supports new [label], list, status, address, balance, use <label|address>, export <label|address>");
}

async function syncSessionBudgetToActiveWallet(session: SessionState): Promise<void> {
  const balance = await walletBalance();
  const balanceCents = balance.spendable_balance_cents ?? Math.max(0, Math.floor(Number(balance.spendable_balance) * 100));
  await setSessionBudget(session, session.spentCents + session.reservedCents + (Number.isFinite(balanceCents) ? balanceCents : 0));
}

async function modelsCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  args = args.filter((arg) => arg !== "--json");
  const [action, value] = args;
  if (action === "list") {
    const models = await listLlmModels();
    const rows = models.map((model) => ({
      id: model.id,
      name: model.name,
      max_cost_cents: model.max_cost_cents
    }));
    printValue("Models", rows, {
      json,
      pretty: renderTable(rows, [
        ["id", "id"],
        ["name", "name"],
        ["max_cost_cents", "max"]
      ])
    });
    return;
  }
  if (action === "set" && value) {
    const result = await setPreferredLlmModel(value);
    printValue("Model", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  throw new Error("models supports list, set <model>");
}

async function confirmSeedPhraseBackup(mnemonic: string): Promise<void> {
  if (!input.isTTY) {
    throw new Error("wallet new requires an interactive terminal so you can back up the seed phrase");
  }
  const words = mnemonic.split(/\s+/);
  console.log([
    style("Back up this seed phrase now.", "bold"),
    "OpenCrowd cannot recover this wallet if you lose this computer and do not have the seed phrase.",
    "",
    mnemonic,
    ""
  ].join("\n"));
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Enter words 3, 8, and 12 separated by spaces to confirm backup: ")).trim().toLowerCase();
    const expected = [words[2], words[7], words[11]].join(" ").toLowerCase();
    if (answer !== expected) {
      throw new Error("seed phrase confirmation failed; wallet was not saved");
    }
  } finally {
    rl.close();
  }
}

async function confirmSeedPhraseExport(): Promise<void> {
  if (!input.isTTY) {
    throw new Error("wallet export requires an interactive terminal");
  }
  console.log("This will reveal the wallet seed phrase. Anyone with it can spend the wallet funds.");
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Type EXPORT to continue: ")).trim();
    if (answer !== "EXPORT") {
      throw new Error("wallet export cancelled");
    }
  } finally {
    rl.close();
  }
}

async function apiCommand(args: string[]): Promise<void> {
  const port = Number(readOption(args, "--port") ?? 8787);
  const server = await startLocalApi({ port, workspaceRoot: process.cwd() });
  console.log(`OpenCrowd local API listening on ${server.url}`);
}

function printHelp(): void {
  console.log(`Usage:
  opencrowd                       interactive agent UI (first run walks you through wallet setup)
  opencrowd --demo                try the full loop with a mock wallet, mock services, and no real money
  opencrowd [--test-mode [--test-seed <seed>]]
  opencrowd run [--session <id>] [--budget <usd>] [--model <model>] [--mode ask_first|yolo|blocked] [--test-mode] [--test-seed <seed>] [--disable-shell] [--verbose] "<task>"
  opencrowd search [--json] "<query>"
  opencrowd permissions [--json] list|allow|remove|block
  opencrowd ledger [--json] show [--session <id>]
  opencrowd wallet [--json] new [label]|list|status|address|balance|use <label|address>|export <label|address>
  opencrowd wallet --test-mode [--json] new [label]|list|status|address|balance|use <label|address>|fund <usd>
  opencrowd models [--json] list|set <model>
  opencrowd mcp
  opencrowd api --port <port>`);
}

function printValue(label: string, value: unknown, options: { pretty?: string; json?: boolean } = {}): void {
  if (options.json || !output.isTTY || !options.pretty) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(`${style(label, "muted")}\n${options.pretty}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
