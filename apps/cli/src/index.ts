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
import { buildSessionSummary, renderLedgerSummary, renderProgress, runAgentTask, type LlmMessage } from "@opencrowd/agent-runtime";
import { startMcpServer } from "@opencrowd/mcp";
import { startLocalApi } from "@opencrowd/local-api";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command) {
    await repl();
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

async function repl(): Promise<void> {
  const session = await createOpenCrowdSession({ workspaceRoot: process.cwd(), surface: "cli" });
  const rl = createInterface({ input, output });
  const state: { model?: string } = {};
  console.log(`OpenCrowd ${session.sessionId}`);
  console.log(formatBudgetStatus(budgetStatus(session)));
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

async function handleReplLine(session: SessionState, state: { model?: string }, line: string): Promise<boolean> {
  if (!line) {
    return false;
  }
  try {
    if (line.startsWith("/")) {
      return await replCommand(session, state, line.slice(1));
    }
    if (line === ":quit" || line === ":exit") {
      console.log(await buildSessionSummary(session, "Interactive session ended."));
      return true;
    }
    if (line.startsWith(":budget")) {
      await setSessionBudget(session, parseUsd(line.split(/\s+/)[1] ?? "0"));
      console.log(formatBudgetStatus(budgetStatus(session)));
      return false;
    }
    if (line === ":summary") {
      console.log(await buildSessionSummary(session, "Interactive summary."));
      return false;
    }
    console.log(await runPersistentAgentTask(session, line, {
      model: state.model,
      onProgress: (event) => console.log(renderProgress(event))
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  return false;
}

async function replCommand(session: SessionState, state: { model?: string }, inputLine: string): Promise<boolean> {
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
      console.log(await buildSessionSummary(session, "Interactive session ended."));
      return true;
    case "budget":
      await setSessionBudget(session, parseUsd(rest[0] ?? "0"));
      console.log(formatBudgetStatus(budgetStatus(session)));
      return false;
    case "summary":
      console.log(await buildSessionSummary(session, "Interactive summary."));
      return false;
    case "model":
      if (!rest[0]) {
        console.log(`Model ${state.model ?? (await loadConfig()).x402LlmModel}`);
        return false;
      }
      state.model = rest[0];
      console.log(`Model ${state.model}`);
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

async function replRunCommand(session: SessionState, state: { model?: string }, args: string[]): Promise<void> {
  const budgetArg = readOption(args, "--budget");
  if (budgetArg !== undefined) {
    await setSessionBudget(session, parseUsd(budgetArg));
  }
  const model = readOption(args, "--model") ?? state.model;
  const task = args.filter((arg, index) => !isConsumedOption(args, index, ["--budget", "--model"])).join(" ");
  if (!task) {
    throw new Error("/run requires a task string");
  }
  console.log(await runPersistentAgentTask(session, task, {
    model,
    onProgress: (event) => console.log(renderProgress(event))
  }));
}

async function runPersistentAgentTask(
  session: SessionState,
  task: string,
  options: { model?: string; onProgress?: (event: ProgressEvent) => void } = {}
): Promise<string> {
  const contextWindowTokens = await resolveContextWindowTokens(options.model);
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
    ...options,
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

function printReplHelp(): void {
  console.log(`Type a task, or use slash commands:
  /budget <usd>
  /wallet init|status|address|balance
  /wallet use auto|local-evm|agentic-wallet
  /models list|set <model>
  /model <model>
  /run [--budget <usd>] [--model <model>] "<task>"
  /search "<query>"
  /permissions list|allow|remove|block
  /ledger show [--session <id>]
  /summary
  /quit`);
}

async function runCommand(args: string[]): Promise<void> {
  const budgetArg = readOption(args, "--budget");
  const model = readOption(args, "--model");
  const mode = (readOption(args, "--mode") ?? "yolo") as PermissionMode;
  if (!["ask_first", "yolo", "blocked"].includes(mode)) {
    throw new Error("mode must be ask_first, yolo, or blocked");
  }
  const shellEnabled = args.includes("--enable-shell") ? true : args.includes("--disable-shell") ? false : undefined;
  const sessionId = readOption(args, "--session");
  const task = args.filter((arg, index) => !isConsumedOption(args, index, ["--budget", "--mode", "--model", "--session"]) && arg !== "--enable-shell" && arg !== "--disable-shell").join(" ");
  if (!task) {
    throw new Error("run requires a task string");
  }
  const session = sessionId
    ? await loadSession(process.cwd(), sessionId)
    : await createOpenCrowdSession({
      workspaceRoot: process.cwd(),
      budgetCents: budgetArg === undefined ? undefined : parseUsd(budgetArg),
      permissionMode: mode,
      shellEnabled,
      surface: "cli"
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
    onProgress: (event) => console.log(renderProgress(event))
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
  if (currentSession && resolvedLedgerPath === currentSession.ledgerPath) {
    console.log(await renderLedgerSummary(currentSession));
    return;
  }
  const sessionId = explicitSessionId ?? fallbackSessionId;
  if (sessionId) {
    console.log(await renderLedgerSummary(await loadSession(process.cwd(), sessionId)));
    return;
  }
  console.log(formatLedgerRows(rows));
}

async function walletCommand(args: string[]): Promise<void> {
  const [action, subaction, value] = args;
  if (action === "init") {
    console.log(formatWalletInit(await walletInit()));
    return;
  }
  if (action === "status") {
    console.log(formatWalletStatus(await walletStatus()));
    return;
  }
  if (action === "address") {
    console.log(formatWalletAddress(await walletAddress()));
    return;
  }
  if (action === "balance") {
    console.log(formatWalletBalance(await walletBalance()));
    return;
  }
  if (action === "use" && subaction) {
    if (!["auto", "local-evm", "agentic-wallet"].includes(subaction)) {
      throw new Error("wallet use supports auto, local-evm, agentic-wallet");
    }
    const updated = await setActivePaymentWallet(subaction as "auto" | "local-evm" | "agentic-wallet");
    console.log(`Wallet ${updated.wallet}`);
    return;
  }
  if (action === "account" && subaction === "set" && value) {
    const updated = await setWalletAccount(value);
    console.log(`Wallet account ${updated.account}`);
    return;
  }
  throw new Error("wallet supports init, status, address, balance, use <auto|local-evm|agentic-wallet>");
}

async function modelsCommand(args: string[]): Promise<void> {
  const [action, value] = args;
  if (action === "list") {
    const models = await listLlmModels();
    console.log(formatModels(models.map((model) => ({
      id: model.id,
      name: model.name,
      max_cost_cents: model.max_cost_cents
    }))));
    return;
  }
  if (action === "set" && value) {
    const updated = await setPreferredLlmModel(value);
    console.log(`Model ${updated.model}`);
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
  opencrowd
  opencrowd run [--session <id>] [--budget <usd>] [--model <model>] [--mode ask_first|yolo|blocked] [--disable-shell] "<task>"
  opencrowd search "<query>"
  opencrowd permissions list|allow|remove|block
  opencrowd ledger show [--session <id>]
  opencrowd wallet init|status|address|balance|use <auto|local-evm|agentic-wallet>
  opencrowd models list|set <model>
  opencrowd mcp
  opencrowd api --port <port>`);
}

function formatBudgetStatus(value: unknown): string {
  const status = objectValue(value) ?? {};
  return [
    `Budget ${formatCents(Number(status.budget_cents ?? 0))} | remaining ${formatCents(Number(status.remaining_cents ?? 0))} | spent ${formatCents(Number(status.spent_cents ?? 0))}`,
    `Mode ${String(status.permission_mode ?? "unknown")}`
  ].join("\n");
}

function formatWalletInit(result: Record<string, unknown>): string {
  const wallet = objectValue(result.active_wallet);
  const address = objectValue(wallet?.address);
  const funding = Array.isArray(result.funding_instructions) ? result.funding_instructions.map(String) : [];
  const next = Array.isArray(result.next_steps) ? result.next_steps.map(String) : [];
  const lines = [
    "Wallet ready",
    `Selected ${String(result.selected_wallet ?? "agentic-wallet")}`,
    address?.address ? `Address ${String(address.address)}` : "Address pending",
    `Network ${String(address?.network ?? result.network ?? "base")} | asset ${String(address?.asset ?? result.asset ?? "USDC")}`
  ];
  if (funding.length > 0) {
    lines.push("", "Fund this wallet:", ...funding.map((item) => `- ${item}`));
  }
  if (next.length > 0) {
    lines.push("", "Next:", ...next.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

function formatWalletStatus(status: Record<string, unknown>): string {
  const active = objectValue(status.active_wallet);
  const address = objectValue(active?.address);
  const balance = objectValue(active?.balance);
  const lines = [
    status.configured ? "Wallet configured" : "Wallet needs setup",
    `Selected ${String(status.selected_wallet ?? "auto")}`
  ];
  if (address?.address) {
    lines.push(`Address ${String(address.address)}`);
    lines.push(`Network ${String(address.network ?? "base")} | asset ${String(address.asset ?? "USDC")}`);
  }
  if (balance?.spendable_balance !== undefined) {
    lines.push(`Spendable ${String(balance.spendable_balance)} ${String(balance.asset ?? "USDC")}`);
  }
  const warning = String(status.local_private_key_warning ?? "");
  if (warning) {
    lines.push("", warning);
  }
  return lines.join("\n");
}

function formatWalletAddress(value: unknown): string {
  const address = objectValue(value) ?? {};
  return [
    `Address ${String(address.address ?? "unknown")}`,
    `Network ${String(address.network ?? "base")} | asset ${String(address.asset ?? "USDC")} | wallet ${String(address.account ?? "unknown")}`
  ].join("\n");
}

function formatWalletBalance(value: unknown): string {
  const balance = objectValue(value) ?? {};
  const lines = [
    `Spendable ${String(balance.spendable_balance ?? "0")} ${String(balance.asset ?? "USDC")}`,
    `Wallet ${String(balance.account ?? "unknown")} | network ${String(balance.network ?? "base")}`
  ];
  if (balance.address) {
    lines.push(`Address ${String(balance.address)}`);
  }
  if (balance.onchain_balance !== undefined) {
    lines.push(`On-chain ${String(balance.onchain_balance)} ${String(balance.asset ?? "USDC")}`);
  }
  if (balance.x402_credit_balance !== undefined) {
    lines.push(`x402 credit ${String(balance.x402_credit_balance)} USD`);
  }
  return lines.join("\n");
}

function formatLedgerRows(rows: Record<string, string>[]): string {
  if (rows.length === 0) {
    return "Ledger is empty.";
  }
  const table = rows.slice(-12).map((row) => [
    shortTime(row.timestamp),
    truncate(`${row.type}${row.status ? `/${row.status}` : ""}`, 18),
    truncate(row.model || row.resource_url || row.endpoint || row.artifact_path || row.notes || "-", 48),
    formatCents(Number(row.charged_cost_cents || 0))
  ]);
  return `Recent ledger:\n${formatTable(["time", "kind", "subject", "cost"], table)}`;
}

function formatModels(models: Array<{ id: string; name?: string; max_cost_cents?: number }>): string {
  if (models.length === 0) {
    return "No models returned.";
  }
  return formatTable(["model", "name", "max"], models.map((model) => [
    truncate(model.id, 36),
    truncate(model.name ?? "-", 32),
    model.max_cost_cents === undefined ? "-" : formatCents(model.max_cost_cents)
  ]));
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const rowText = (row: string[]): string => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  return [rowText(headers), rowText(widths.map((width) => "-".repeat(width))), ...rows.map(rowText)].join("\n");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function shortTime(value: string | undefined): string {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(11, 19) : "--:--:--";
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
