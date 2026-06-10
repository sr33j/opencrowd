import {
  addAllowedService,
  blockService,
  budgetStatus,
  createTestWallet,
  ensureDefaultTestWallet,
  fundActiveTestWallet,
  listAllowedServices,
  listLlmModels,
  loadConfig,
  readLedger,
  removeAllowedService,
  setActivePaymentWallet,
  setPermissionMode,
  setPreferredLlmModel,
  setSessionBudget,
  walletAddress,
  walletBalance,
  walletInit,
  walletList,
  walletStatus,
  type PermissionMode,
  type SessionState
} from "@opencrowd/core";
import {
  asRecord,
  formatCents,
  formatServiceCandidate,
  optionCents,
  parseUsd,
  readOption,
  renderKeyValues,
  renderTable,
  shortUrl,
  splitArgs
} from "../shared.js";
import { searchServices } from "@opencrowd/core";
import { ensureMockRuntime, type ReplState } from "../agent-task.js";

export type CommandResult =
  | { kind: "text"; label?: string; body: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "run-task"; task: string; overrides: { budgetCents?: number; model?: string; testMode?: boolean; testSeed?: string } }
  | { kind: "wallet-new"; label?: string }
  | { kind: "wallet-export"; target: string }
  | { kind: "help" };

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "help", usage: "/help", summary: "Show commands and session info" },
  { name: "clear", usage: "/clear", summary: "Clear all previous conversation context" },
  { name: "budget", usage: "/budget <usd>", summary: "Set the local session spend cap" },
  { name: "mode", usage: "/mode ask_first|yolo|blocked", summary: "Set the permission mode (shift+tab toggles)" },
  { name: "wallet", usage: "/wallet new|list|status|address|balance|use|fund|export", summary: "Manage payment wallets" },
  { name: "models", usage: "/models list|set <model>", summary: "List or set the x402 LLM model" },
  { name: "model", usage: "/model <model>", summary: "Set the model for this session only" },
  { name: "run", usage: "/run [--budget <usd>] [--model <m>] \"<task>\"", summary: "Run a task with one-off overrides" },
  { name: "search", usage: "/search \"<query>\"", summary: "Search the x402 service bazaar" },
  { name: "permissions", usage: "/permissions list|allow|remove|block <url>", summary: "Manage allowed and blocked services" },
  { name: "ledger", usage: "/ledger show", summary: "Show this session's spend ledger" },
  { name: "summary", usage: "/summary [verbose]", summary: "Summarize spend and artifacts so far" },
  { name: "test-mode", usage: "/test-mode on|off", summary: "Toggle mock wallets, services, and LLM" },
  { name: "test-seed", usage: "/test-seed <seed>", summary: "Seed the mock runtime" },
  { name: "quit", usage: "/quit", summary: "End the session and show the final summary" }
];

export function matchCommands(prefix: string): CommandSpec[] {
  const needle = prefix.toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(needle));
}

export async function runSlashCommand(
  session: SessionState,
  state: ReplState,
  inputLine: string
): Promise<CommandResult> {
  const args = splitArgs(inputLine);
  const [command, ...rest] = args;
  switch (command) {
    case "":
    case "help":
    case "?":
      return { kind: "help" };
    case "quit":
    case "exit":
      return { kind: "exit" };
    case "clear":
      return { kind: "clear" };
    case "budget": {
      await setSessionBudget(session, parseUsd(rest[0] ?? "0"));
      return { kind: "text", label: "Budget", body: renderKeyValues(asRecord(budgetStatus(session))) };
    }
    case "mode": {
      const mode = rest[0] as PermissionMode | undefined;
      if (!mode || !["ask_first", "yolo", "blocked"].includes(mode)) {
        throw new Error("/mode supports ask_first, yolo, or blocked");
      }
      await setPermissionMode(session, mode);
      return { kind: "text", label: "Mode", body: renderKeyValues({ permission_mode: mode }) };
    }
    case "summary":
      return { kind: "text", label: "Summary", body: "__summary__" + (rest[0] === "verbose" ? "verbose" : "") };
    case "model": {
      if (!rest[0]) {
        const config = await loadConfig();
        return { kind: "text", label: "Model", body: renderKeyValues({ model: state.model ?? config.x402LlmModel }) };
      }
      state.model = rest[0];
      return { kind: "text", label: "Model", body: renderKeyValues({ model: state.model }) };
    }
    case "models": {
      const [action, value] = rest;
      if (action === "list" || action === undefined) {
        const models = await listLlmModels();
        const rows = models.map((model) => ({ id: model.id, name: model.name, max_cost_cents: model.max_cost_cents }));
        return {
          kind: "text",
          label: "Models",
          body: renderTable(rows, [["id", "id"], ["name", "name"], ["max_cost_cents", "max"]])
        };
      }
      if (action === "set" && value) {
        const result = await setPreferredLlmModel(value);
        return { kind: "text", label: "Model", body: renderKeyValues(asRecord(result)) };
      }
      throw new Error("/models supports list, set <model>");
    }
    case "test-mode": {
      if (!rest[0]) {
        return { kind: "text", label: "Test mode", body: renderKeyValues({ test_mode: state.testMode, test_seed: state.testSeed }) };
      }
      if (!["on", "off"].includes(rest[0])) {
        throw new Error("/test-mode supports on or off");
      }
      state.testMode = rest[0] === "on";
      if (state.testMode) {
        await ensureDefaultTestWallet();
        ensureMockRuntime(state);
      }
      return { kind: "text", label: "Test mode", body: renderKeyValues({ test_mode: state.testMode, test_seed: state.testSeed }) };
    }
    case "test-seed": {
      if (!rest[0]) {
        return { kind: "text", label: "Test seed", body: renderKeyValues({ test_seed: state.testSeed }) };
      }
      state.testSeed = rest[0];
      if (state.testMode) {
        state.mockProvider = undefined;
        state.mockToolExecutor = undefined;
        ensureMockRuntime(state);
      }
      return { kind: "text", label: "Test seed", body: renderKeyValues({ test_seed: state.testSeed }) };
    }
    case "run": {
      const budgetArg = readOption(rest, "--budget");
      const model = readOption(rest, "--model") ?? state.model;
      const testMode = rest.includes("--test-mode") || state.testMode;
      const testSeed = readOption(rest, "--test-seed") ?? state.testSeed;
      const task = rest
        .filter((arg, index) => !isConsumed(rest, index, ["--budget", "--model", "--test-seed"]) && arg !== "--test-mode")
        .join(" ");
      if (!task) {
        throw new Error("/run requires a task string");
      }
      return {
        kind: "run-task",
        task,
        overrides: {
          budgetCents: budgetArg === undefined ? undefined : parseUsd(budgetArg),
          model,
          testMode,
          testSeed
        }
      };
    }
    case "search": {
      const query = rest.join(" ");
      if (!query) {
        throw new Error("/search requires a query");
      }
      const results = await searchServices(query);
      const rows = results.map(formatServiceCandidate);
      return {
        kind: "text",
        label: "Search results",
        body: renderTable(rows, [["title", "title"], ["price", "price"], ["methods", "methods"], ["url", "url"]])
      };
    }
    case "permissions": {
      const [action, resourceUrl] = rest;
      if (action === "list" || action === undefined) {
        const permissions = await listAllowedServices();
        return {
          kind: "text",
          label: "Permissions",
          body: renderTable(permissions.map(asRecord), [
            ["resource_url", "service"],
            ["mode", "mode"],
            ["max_cost_cents", "max"],
            ["session_max_cents", "session max"]
          ])
        };
      }
      if (action === "allow" && resourceUrl) {
        await addAllowedService(resourceUrl, {
          max_cost_cents: optionCents(rest, "--max-cost"),
          session_max_cents: optionCents(rest, "--session-max")
        });
        return { kind: "text", label: "Permissions", body: `  allowed ${shortUrl(resourceUrl)}` };
      }
      if (action === "remove" && resourceUrl) {
        await removeAllowedService(resourceUrl);
        return { kind: "text", label: "Permissions", body: `  removed ${shortUrl(resourceUrl)}` };
      }
      if (action === "block" && resourceUrl) {
        await blockService(resourceUrl);
        return { kind: "text", label: "Permissions", body: `  blocked ${shortUrl(resourceUrl)}` };
      }
      throw new Error("/permissions supports list, allow, remove, block");
    }
    case "ledger": {
      const rows = await readLedger(session.ledgerPath);
      return {
        kind: "text",
        label: "Ledger",
        body: renderTable(rows.map(asRecord), [
          ["type", "type"],
          ["status", "status"],
          ["charged_cost_cents", "cost"],
          ["model", "model"],
          ["resource_url", "service"],
          ["artifact_path", "artifact"]
        ])
      };
    }
    case "wallet":
      return walletSlashCommand(session, state, rest);
    case "mcp":
      throw new Error("Run `opencrowd mcp` outside the interactive UI because MCP uses stdio.");
    default:
      throw new Error(`unknown slash command: /${command} (try /help)`);
  }
}

async function walletSlashCommand(session: SessionState, state: ReplState, args: string[]): Promise<CommandResult> {
  const [action, subaction] = args;
  if (action === "new") {
    if (state.testMode) {
      const wallet = await createTestWallet(subaction);
      await syncSessionBudgetToActiveWallet(session);
      return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(wallet)) };
    }
    return { kind: "wallet-new", label: subaction };
  }
  if (action === "list" || action === undefined) {
    const wallets = await walletList();
    const rows = wallets.map((wallet) => ({
      active: wallet.active ? "*" : "",
      label: wallet.label,
      kind: wallet.kind,
      balance: wallet.spendable_balance_cents,
      asset: wallet.asset,
      address: wallet.address
    }));
    return {
      kind: "text",
      label: "Wallets",
      body: renderTable(rows, [
        ["active", ""],
        ["label", "label"],
        ["kind", "kind"],
        ["balance", "balance"],
        ["asset", "asset"],
        ["address", "address"]
      ])
    };
  }
  if (action === "init") {
    return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(await walletInit())) };
  }
  if (action === "status") {
    return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(await walletStatus())) };
  }
  if (action === "address") {
    return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(await walletAddress())) };
  }
  if (action === "balance") {
    return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(await walletBalance())) };
  }
  if (action === "use" && subaction) {
    const result = await setActivePaymentWallet(subaction);
    if (state.testMode) {
      await syncSessionBudgetToActiveWallet(session);
    }
    return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(result)) };
  }
  if (action === "fund" && subaction) {
    if (!state.testMode) {
      throw new Error("/wallet fund is only available in test mode");
    }
    const result = await fundActiveTestWallet(parseUsd(subaction));
    await syncSessionBudgetToActiveWallet(session);
    return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(result)) };
  }
  if (action === "export" && subaction) {
    return { kind: "wallet-export", target: subaction };
  }
  throw new Error(state.testMode
    ? "/wallet supports new [label], list, status, address, balance, use <label|address>, fund <usd>"
    : "/wallet supports new [label], list, status, address, balance, use <label|address>, export <label|address>");
}

async function syncSessionBudgetToActiveWallet(session: SessionState): Promise<void> {
  const balance = await walletBalance();
  const balanceCents = balance.spendable_balance_cents ?? Math.max(0, Math.floor(Number(balance.spendable_balance) * 100));
  await setSessionBudget(session, session.spentCents + session.reservedCents + (Number.isFinite(balanceCents) ? balanceCents : 0));
}

function isConsumed(args: string[], index: number, options: string[]): boolean {
  return options.includes(args[index]) || (index > 0 && options.includes(args[index - 1]));
}
