#!/usr/bin/env node
import { appendFile, copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  addAllowedService,
  appendLedgerEntry,
  configDir,
  blockService,
  budgetStatus,
  clearConversation,
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
  setSessionBudget,
  walletAddress,
  sendUsdc,
  walletBalance,
  walletInit,
  walletList,
  walletStatus,
  type LedgerStatus,
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
import { closeSharedConnectorManager } from "@opencrowd/connectors";
import { ensureMockRuntime, runPersistentAgentTask, runPersistentAgentTaskDetailed, type ReplState } from "./agent-task.js";
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
    case "evals":
      await evalsCommand(rest);
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
    case "clear": {
      const cleared = await clearConversation(session);
      console.log(cleared.cleared
        ? `context cleared — ${cleared.messagesCleared} prior messages archived to ${cleared.archivePath}`
        : "context is already empty");
      return false;
    }
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
        : "/wallet new|list|status|address|balance|use|send|export",
      "/models list|set <model>",
      "/model <model>",
      "/test-mode on|off",
      "/test-seed <seed>",
      "/run [--budget <usd>] [--model <model>] \"<task>\"",
      "/search \"<query>\"",
      "/permissions list|allow|remove|block",
      "/ledger show [--session <id>]",
      "/summary [verbose]",
      "/clear",
      "/quit"
    ])
  ].join("\n");
}

async function runCommand(args: string[]): Promise<void> {
  if (args.includes("--headless")) {
    await headlessRunCommand(args);
    return;
  }
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

/**
 * Programmatic run contract: non-interactive, exits when the session
 * completes or blocks, and emits the structured completion object plus
 * spend split, turn count, and model policy. The eval runner and any
 * external wrapper share this same interface.
 */
async function headlessRunCommand(args: string[]): Promise<void> {
  const prompt = readOption(args, "--prompt");
  if (!prompt) {
    throw new Error("run --headless requires --prompt <text>");
  }
  const outputFormat = readOption(args, "--output") ?? "json";
  if (!["json", "text"].includes(outputFormat)) {
    throw new Error("--output must be json or text");
  }
  const attach = readOption(args, "--attach");
  const verbose = args.includes("--verbose");
  const testMode = args.includes("--test-mode") || envFlag("OPENCROWD_TEST_MODE");
  const testSeed = readOption(args, "--test-seed") ?? process.env.OPENCROWD_TEST_SEED;
  const budgetArg = readOption(args, "--budget");
  const maxTurnsArg = readOption(args, "--max-turns");
  const workspaceRoot = readOption(args, "--workspace") ?? process.cwd();
  if (testMode) {
    await ensureDefaultTestWallet();
  }
  const session = await createOpenCrowdSession({
    workspaceRoot,
    budgetCents: budgetArg === undefined ? undefined : parseUsd(budgetArg),
    permissionMode: "yolo",
    shellEnabled: !args.includes("--disable-shell"),
    surface: "cli",
    useWalletBalanceBudget: true
  });
  let task = prompt;
  if (attach) {
    const attachmentName = basename(attach);
    await mkdir(session.artifactsDir, { recursive: true });
    await copyFile(attach, join(session.artifactsDir, attachmentName));
    task = `${prompt}\n\nAn input file is available at the session artifact path \`${attachmentName}\` (use read_file, or run_shell against ${join(session.artifactsDir, attachmentName)}).`;
  }
  const result = await runPersistentAgentTaskDetailed(session, task, {
    model: readOption(args, "--model"),
    subagentModel: readOption(args, "--subagent-model"),
    forceAutoPolicy: args.includes("--auto"),
    testMode,
    testSeed,
    maxTurns: maxTurnsArg === undefined ? undefined : Number(maxTurnsArg),
    compactOutput: true,
    onProgress: verbose
      ? (event) => {
        const message = renderProgress(event, { style: "compact" });
        if (message) {
          console.error(message);
        }
      }
      : undefined
  });
  const budget = asRecord(result.summary.budget);
  const payload = {
    outcome: result.outcome,
    final_message: result.summary.final_message ?? null,
    session_id: session.sessionId,
    session_dir: session.sessionDir,
    trajectory_path: join(session.sessionDir, "messages.jsonl"),
    turns: result.turns,
    model_policy: session.modelPolicy ?? null,
    usdc_spent_cents: {
      llm: Number(budget.llm_spend_cents ?? 0),
      services: Number(budget.external_service_spend_cents ?? 0),
      wallet_top_ups: Number(budget.wallet_top_up_spend_cents ?? 0),
      total: Number(budget.total_spent_cents ?? budget.spent_cents ?? 0)
    },
    budget,
    artifacts: result.summary.artifacts ?? [],
    service_calls: result.summary.service_calls ?? []
  };
  if (outputFormat === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(String(result.summary.final_message ?? "Session complete."));
  }
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
    console.log(style("Note: OpenCrowd now uses the shared AgentCash wallet by default (one wallet for LLM spend, paid services, and reviews).", "muted"));
    console.log(style("Creating a separate legacy wallet is deprecated; switch back anytime with `opencrowd wallet use agentcash`.", "muted"));
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
  if (action === "send") {
    await walletSendCommand(args.slice(1), { testMode, session: options.session });
    return;
  }
  throw new Error(testMode
    ? "wallet supports new [label], list, status, address, balance, use <label|address>, fund <usd>"
    : "wallet supports new [label], list, status, address, balance, use <label|address>, send <address> <usd> [--network base|tempo], export <label|address>");
}

/**
 * Send USDC to any address by signing a plain ERC-20 transfer with the
 * shared wallet key. This is a financial action, not a paid service: no
 * CrowdCode check, no receipt, no review, and never an automatic replay.
 * The model has no send tool; sends are human-initiated and human-confirmed.
 */
async function walletSendCommand(args: string[], options: { testMode?: boolean; session?: SessionState }): Promise<void> {
  if (options.testMode) {
    throw new Error("wallet send moves real USDC and is not available in --test-mode");
  }
  const network = readOption(args, "--network") ?? "base";
  if (network !== "base") {
    throw new Error("wallet send currently supports base only");
  }
  const positional = args.filter((arg, index) => !isConsumedOption(args, index, ["--network"]));
  const [to, amountArg] = positional;
  if (!to || !amountArg) {
    throw new Error("wallet send requires an address and a USD amount: opencrowd wallet send <address> <usd>");
  }
  const amountCents = parseUsd(amountArg);
  if (amountCents <= 0) {
    throw new Error("amount must be greater than zero");
  }
  if (!input.isTTY) {
    throw new Error("wallet send requires an interactive terminal to confirm the transfer");
  }
  const amountUsdc = amountCents / 100;
  const balance = await walletBalance().catch(() => undefined);
  console.log([
    style("Confirm USDC transfer", "bold"),
    renderKeyValues({
      from: balance?.address,
      to,
      amount: `$${amountUsdc.toFixed(2)} USDC`,
      network,
      current_balance: balance?.spendable_balance ?? "unavailable"
    }),
    "This signs an on-chain transfer with your wallet key. It cannot be reversed."
  ].join("\n"));
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Type SEND to confirm: ")).trim();
    if (answer !== "SEND") {
      throw new Error("transfer cancelled");
    }
  } finally {
    rl.close();
  }
  try {
    const result = await sendUsdc(to, amountUsdc);
    await recordTransfer({ to, amountCents, network, txHash: result.tx_hash, status: "charged", session: options.session });
    printValue("Transfer", result, {
      pretty: renderKeyValues({
        from: result.from,
        to: result.to,
        amount: `$${result.amount_usdc.toFixed(2)} USDC`,
        network: result.network,
        tx_hash: result.tx_hash
      })
    });
  } catch (error) {
    const message = (error as Error).message;
    // A thrown wait-for-receipt is ambiguous; everything else failed before broadcast.
    const ambiguous = /waitForTransactionReceipt|timed out/i.test(message);
    await recordTransfer({
      to,
      amountCents,
      network,
      status: ambiguous ? "unknown" : "failed",
      notes: message,
      session: options.session
    });
    throw ambiguous
      ? new Error(`transfer outcome is unknown: ${message}. Verify on-chain activity before retrying; transfers are never replayed automatically.`)
      : error;
  }
}

async function recordTransfer(entry: {
  to: string;
  amountCents: number;
  network: string;
  txHash?: string;
  status: LedgerStatus;
  notes?: string;
  session?: SessionState;
}): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    type: "transfer",
    to: entry.to,
    amount_cents: entry.amountCents,
    network: entry.network,
    tx_hash: entry.txHash,
    status: entry.status,
    notes: entry.notes
  };
  await mkdir(configDir(), { recursive: true });
  await appendFile(join(configDir(), "transfers.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  if (entry.session) {
    await appendLedgerEntry(entry.session.ledgerPath, {
      session_id: entry.session.sessionId,
      type: "transfer",
      method: entry.network,
      quoted_cost_cents: entry.amountCents,
      charged_cost_cents: entry.status === "charged" ? entry.amountCents : 0,
      status: entry.status,
      permission_mode: entry.session.permissionMode,
      tx_hash: entry.txHash,
      notes: entry.notes ?? `USDC transfer to ${entry.to}`
    });
  }
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

async function evalsCommand(args: string[]): Promise<void> {
  const [dataset, ...rest] = args;
  if (dataset !== "gaia") {
    throw new Error("evals supports: gaia [--tier smoke|level1|full] [--harness opencrowd,claude,codex] [--hf-token <token>] [--auto] [--model <model>] [--yes]");
  }
  const { runGaiaBenchmark, renderGaiaReport, GAIA_TIERS } = await import("@opencrowd/evals");
  const tier = readOption(rest, "--tier") ?? "smoke";
  if (!(tier in GAIA_TIERS)) {
    throw new Error(`--tier must be one of: ${Object.keys(GAIA_TIERS).join(", ")}`);
  }
  const harnesses = (readOption(rest, "--harness") ?? "opencrowd").split(",").map((name) => name.trim()).filter(Boolean);
  const yes = rest.includes("--yes");
  const report = await runGaiaBenchmark({
    tier: tier as keyof typeof GAIA_TIERS,
    harnesses,
    hfToken: readOption(rest, "--hf-token") ?? process.env.HF_TOKEN,
    workspaceRoot: process.cwd(),
    model: readOption(rest, "--model"),
    auto: rest.includes("--auto"),
    limit: readOption(rest, "--limit") === undefined ? undefined : Number(readOption(rest, "--limit")),
    testMode: rest.includes("--test-mode"),
    log: (message) => console.error(message),
    confirm: async (message) => {
      if (yes) {
        return true;
      }
      if (!input.isTTY) {
        throw new Error(`${message}\nRe-run with --yes to accept the estimated cost ceiling in a non-interactive shell.`);
      }
      console.log(message);
      const rl = createInterface({ input, output });
      try {
        return (await rl.question("Proceed? (yes/no): ")).trim().toLowerCase() === "yes";
      } finally {
        rl.close();
      }
    }
  });
  console.log(renderGaiaReport(report));
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
  opencrowd run --headless --prompt "<text>" [--attach <file>] [--output json|text] [--auto] [--model <model>] [--subagent-model <model>] [--budget <usd>] [--max-turns <n>] [--workspace <dir>] [--verbose]
  opencrowd search [--json] "<query>"
  opencrowd permissions [--json] list|allow|remove|block
  opencrowd ledger [--json] show [--session <id>]
  opencrowd wallet [--json] list|status|address|balance|use <label|agentcash>|send <address> <usd>|export <label|address>
  opencrowd wallet --test-mode [--json] new [label]|list|status|address|balance|use <label|address>|fund <usd>
  opencrowd models [--json] list|set <model>
  opencrowd evals gaia [--tier smoke|level1|full] [--harness opencrowd,claude,codex] [--hf-token <token>] [--auto] [--yes]
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

main(process.argv.slice(2))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeSharedConnectorManager().catch(() => undefined));
