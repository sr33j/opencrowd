#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  addAllowedService,
  blockService,
  budgetStatus,
  appendConversationMessage,
  compactConversationIfNeeded,
  createOpenCrowdSession,
  fallbackContextWindowTokens,
  listLlmModels,
  listAllowedServices,
  loadConfig,
  loadSession,
  readLedger,
  readConversationMessages,
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
  walletStatus,
  type ConversationMessage,
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
  runAgentTask,
  type LlmMessage,
  type ToolExecutor
} from "@opencrowd/agent-runtime";
import { startMcpServer } from "@opencrowd/mcp";
import { startLocalApi } from "@opencrowd/local-api";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command) {
    await repl();
    return;
  }
  if (command === "--test-mode") {
    const extraArgs = rest.filter((arg, index) => !isConsumedOption(rest, index, ["--test-seed"]));
    if (extraArgs.length > 0) {
      throw new Error("top-level --test-mode launches the REPL; use `opencrowd run --test-mode \"task\"` for one-shot tasks");
    }
    await repl({
      testMode: true,
      testSeed: readOption(rest, "--test-seed")
    });
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
      await walletCommand(rest);
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
  const session = await createOpenCrowdSession({
    workspaceRoot: process.cwd(),
    surface: "cli",
    useWalletBalanceBudget: !initialTestMode
  });
  const rl = createInterface({ input, output });
  const state: ReplState = {
    testMode: initialTestMode,
    testSeed: options.testSeed ?? process.env.OPENCROWD_TEST_SEED
  };
  if (state.testMode) {
    ensureMockRuntime(state);
  }
  console.log(`OpenCrowd session ${session.sessionId}${state.testMode ? " (test mode)" : ""}`);
  printReplHelp();
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
      console.log(await buildSessionSummary(session, "Interactive session ended.", { compact: state.testMode }));
      return true;
    }
    if (line.startsWith(":budget")) {
      await setSessionBudget(session, parseUsd(line.split(/\s+/)[1] ?? "0"));
      console.log(JSON.stringify(budgetStatus(session), null, 2));
      return false;
    }
    if (line === ":summary") {
      console.log(await buildSessionSummary(session, "Interactive summary.", { compact: state.testMode }));
      return false;
    }
    console.log(await runPersistentAgentTask(session, line, {
      model: state.model,
      testMode: state.testMode,
      testSeed: state.testSeed,
      mockProvider: state.mockProvider,
      mockToolExecutor: state.mockToolExecutor,
      onProgress: progressLogger(state.testMode)
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  return false;
}

interface ReplState {
  model?: string;
  testMode: boolean;
  testSeed?: string;
  mockProvider?: MockLlmProvider;
  mockToolExecutor?: ToolExecutor;
}

async function replCommand(session: SessionState, state: ReplState, inputLine: string): Promise<boolean> {
  const args = splitArgs(inputLine);
  const [command, ...rest] = args;
  switch (command) {
    case "":
    case "help":
    case "?":
      printReplHelp();
      return false;
    case "quit":
    case "exit":
      console.log(await buildSessionSummary(session, "Interactive session ended.", { compact: state.testMode }));
      return true;
    case "budget":
      await setSessionBudget(session, parseUsd(rest[0] ?? "0"));
      console.log(JSON.stringify(budgetStatus(session), null, 2));
      return false;
    case "summary":
      console.log(await buildSessionSummary(session, "Interactive summary.", { compact: state.testMode }));
      return false;
    case "model":
      if (!rest[0]) {
        console.log(JSON.stringify({ model: state.model ?? (await loadConfig()).x402LlmModel }, null, 2));
        return false;
      }
      state.model = rest[0];
      console.log(JSON.stringify({ model: state.model }, null, 2));
      return false;
    case "test-mode":
      if (!rest[0]) {
        console.log(JSON.stringify({ test_mode: state.testMode, test_seed: state.testSeed }, null, 2));
        return false;
      }
      if (!["on", "off"].includes(rest[0])) {
        throw new Error("/test-mode supports on or off");
      }
      state.testMode = rest[0] === "on";
      if (state.testMode) {
        ensureMockRuntime(state);
      }
      console.log(JSON.stringify({ test_mode: state.testMode, test_seed: state.testSeed }, null, 2));
      return false;
    case "test-seed":
      if (!rest[0]) {
        console.log(JSON.stringify({ test_seed: state.testSeed }, null, 2));
        return false;
      }
      state.testSeed = rest[0];
      if (state.testMode) {
        state.mockProvider = new MockLlmProvider({ seed: state.testSeed });
        state.mockToolExecutor ??= createMockToolExecutor();
      }
      console.log(JSON.stringify({ test_seed: state.testSeed }, null, 2));
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
      await walletCommand(rest);
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
    onProgress: progressLogger(testMode)
  }));
}

async function runPersistentAgentTask(
  session: SessionState,
  task: string,
  options: {
    model?: string;
    testMode?: boolean;
    testSeed?: string;
    mockProvider?: MockLlmProvider;
    mockToolExecutor?: ToolExecutor;
    onProgress?: (event: ProgressEvent) => void;
  } = {}
): Promise<string> {
  const contextWindowTokens = options.testMode
    ? fallbackContextWindowTokens("mock-test-mode")
    : await resolveContextWindowTokens(options.model);
  const compaction = await compactConversationIfNeeded(session, { contextWindowTokens });
  if (compaction.compacted) {
    options.onProgress?.({
      type: "complete",
      message: `Compacted prior conversation into ${compaction.archivePath}`,
      data: { archive_path: compaction.archivePath, tokens_before: compaction.tokensBefore }
    });
  }
  const history = (compaction.compacted ? compaction.messages : await readConversationMessages(session)) as ConversationMessage[];
  return runAgentTask(session, task, {
    model: options.model,
    onProgress: options.onProgress,
    provider: options.testMode ? options.mockProvider ?? new MockLlmProvider({ seed: options.testSeed }) : undefined,
    toolExecutor: options.testMode ? options.mockToolExecutor ?? createMockToolExecutor() : undefined,
    compactOutput: options.testMode,
    history: history as LlmMessage[],
    onMessage: (message) => appendConversationMessage(session, message as ConversationMessage)
  });
}

async function resolveContextWindowTokens(model: string | undefined): Promise<number> {
  const config = await loadConfig();
  const modelId = model ?? config.x402LlmModel;
  try {
    const models = await listLlmModels();
    const resolved = models.find((candidate) => candidate.id === modelId);
    return resolved?.context_window_tokens ?? fallbackContextWindowTokens(modelId);
  } catch {
    return fallbackContextWindowTokens(modelId);
  }
}

function ensureMockRuntime(state: ReplState): ReplState {
  state.mockProvider ??= new MockLlmProvider({ seed: state.testSeed });
  state.mockToolExecutor ??= createMockToolExecutor();
  return state;
}

function progressLogger(compact: boolean): (event: ProgressEvent) => void {
  return (event) => {
    const message = renderProgress(event, { compact });
    if (message) {
      console.log(message);
    }
  };
}

function printReplHelp(): void {
  console.log(`Type a task, or use slash commands:
  /budget <usd>
  /wallet init|status|address|balance
  /wallet use auto|local-evm|agentic-wallet
  /models list|set <model>
  /model <model>
  /test-mode on|off
  /test-seed <seed>
  /run [--budget <usd>] [--model <model>] [--test-mode] [--test-seed <seed>] "<task>"
  /search "<query>"
  /permissions list|allow|remove|block
  /ledger show [--session <id>]
  /summary
  /quit`);
}

async function runCommand(args: string[]): Promise<void> {
  const budgetArg = readOption(args, "--budget");
  const model = readOption(args, "--model");
  const testMode = args.includes("--test-mode") || envFlag("OPENCROWD_TEST_MODE");
  const testSeed = readOption(args, "--test-seed") ?? process.env.OPENCROWD_TEST_SEED;
  const mode = (readOption(args, "--mode") ?? "yolo") as PermissionMode;
  if (!["ask_first", "yolo", "blocked"].includes(mode)) {
    throw new Error("mode must be ask_first, yolo, or blocked");
  }
  const shellEnabled = args.includes("--enable-shell") ? true : args.includes("--disable-shell") ? false : undefined;
  const sessionId = readOption(args, "--session");
  const task = args.filter((arg, index) => !isConsumedOption(args, index, ["--budget", "--mode", "--model", "--session", "--test-seed"])
    && arg !== "--enable-shell"
    && arg !== "--disable-shell"
    && arg !== "--test-mode").join(" ");
  if (!task) {
    throw new Error("run requires a task string");
  }
  const session = sessionId
    ? await loadSession(process.cwd(), sessionId)
    : await createOpenCrowdSession({
      workspaceRoot: process.cwd(),
      budgetCents: budgetArg === undefined ? (testMode ? 0 : undefined) : parseUsd(budgetArg),
      permissionMode: mode,
      shellEnabled,
      surface: "cli",
      useWalletBalanceBudget: !testMode
    });
  if (sessionId) {
    if (budgetArg !== undefined) {
      await setSessionBudget(session, parseUsd(budgetArg));
    }
    await setPermissionMode(session, mode);
    if (shellEnabled !== undefined) {
      session.shellEnabled = shellEnabled;
      await saveSession(session);
    }
  }
  const outputText = await runPersistentAgentTask(session, task, {
    model,
    testMode,
    testSeed,
    onProgress: progressLogger(testMode)
  });
  console.log(outputText);
}

async function searchCommand(args: string[]): Promise<void> {
  const query = args.join(" ");
  if (!query) {
    throw new Error("search requires a query");
  }
  const results = await searchServices(query);
  console.log(JSON.stringify(results.map(formatServiceCandidate), null, 2));
}

async function permissionsCommand(args: string[]): Promise<void> {
  const [action, resourceUrl] = args;
  switch (action) {
    case "list":
      console.log(JSON.stringify(await listAllowedServices(), null, 2));
      return;
    case "allow":
      if (!resourceUrl) {
        throw new Error("permissions allow requires a resource URL");
      }
      console.log(JSON.stringify(await addAllowedService(resourceUrl, {
        max_cost_cents: optionCents(args, "--max-cost"),
        session_max_cents: optionCents(args, "--session-max")
      }), null, 2));
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
      console.log(JSON.stringify(await blockService(resourceUrl), null, 2));
      return;
    default:
      throw new Error("permissions supports list, allow, remove, block");
  }
}

async function ledgerCommand(args: string[], currentSession?: SessionState): Promise<void> {
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
  console.log(JSON.stringify(rows, null, 2));
}

async function walletCommand(args: string[]): Promise<void> {
  const [action, subaction, value] = args;
  if (action === "init") {
    console.log(JSON.stringify(await walletInit(), null, 2));
    return;
  }
  if (action === "status") {
    console.log(JSON.stringify(await walletStatus(), null, 2));
    return;
  }
  if (action === "address") {
    console.log(JSON.stringify(await walletAddress(), null, 2));
    return;
  }
  if (action === "balance") {
    console.log(JSON.stringify(await walletBalance(), null, 2));
    return;
  }
  if (action === "use" && subaction) {
    if (!["auto", "local-evm", "agentic-wallet"].includes(subaction)) {
      throw new Error("wallet use supports auto, local-evm, agentic-wallet");
    }
    console.log(JSON.stringify(await setActivePaymentWallet(subaction as "auto" | "local-evm" | "agentic-wallet"), null, 2));
    return;
  }
  if (action === "account" && subaction === "set" && value) {
    console.log(JSON.stringify(await setWalletAccount(value), null, 2));
    return;
  }
  throw new Error("wallet supports init, status, address, balance, use <auto|local-evm|agentic-wallet>");
}

async function modelsCommand(args: string[]): Promise<void> {
  const [action, value] = args;
  if (action === "list") {
    const models = await listLlmModels();
    console.log(JSON.stringify(models.map((model) => ({
      id: model.id,
      name: model.name,
      max_cost_cents: model.max_cost_cents
    })), null, 2));
    return;
  }
  if (action === "set" && value) {
    console.log(JSON.stringify(await setPreferredLlmModel(value), null, 2));
    return;
  }
  throw new Error("models supports list, set <model>");
}

async function apiCommand(args: string[]): Promise<void> {
  const port = Number(readOption(args, "--port") ?? 8787);
  const server = await startLocalApi({ port, workspaceRoot: process.cwd() });
  console.log(`OpenCrowd local API listening on ${server.url}`);
}

function printHelp(): void {
  console.log(`Usage:
  opencrowd [--test-mode [--test-seed <seed>]]
  opencrowd run [--session <id>] [--budget <usd>] [--model <model>] [--mode ask_first|yolo|blocked] [--test-mode] [--test-seed <seed>] [--disable-shell] "<task>"
  opencrowd search "<query>"
  opencrowd permissions list|allow|remove|block
  opencrowd ledger show [--session <id>]
  opencrowd wallet init|status|address|balance|use <auto|local-evm|agentic-wallet>
  opencrowd models list|set <model>
  opencrowd mcp
  opencrowd api --port <port>`);
}

function formatServiceCandidate(candidate: ServiceCandidate): Record<string, unknown> {
  return pruneUndefined({
    title: candidate.title,
    url: candidate.resource_url,
    methods: candidate.methods,
    price: candidate.price_display ?? (candidate.price_cents === undefined ? undefined : `$${(candidate.price_cents / 100).toFixed(2)}`),
    currency: candidate.currency,
    tags: candidate.tags,
    score: Number(candidate.score.toFixed(4))
  });
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function parseUsd(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid USD amount: ${value}`);
  }
  return Math.round(parsed * 100);
}

function readOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function splitArgs(inputLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (const char of inputLine) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (quote) {
    throw new Error("unterminated quote in slash command");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function optionCents(args: string[], option: string): number | undefined {
  const value = readOption(args, option);
  return value === undefined ? undefined : parseUsd(value);
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function isConsumedOption(args: string[], index: number, options: string[]): boolean {
  return options.includes(args[index]) || (index > 0 && options.includes(args[index - 1]));
}

async function latestSessionId(workspaceRoot: string): Promise<string | undefined> {
  const sessionsDir = join(resolve(workspaceRoot), "sessions");
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
