import {
  budgetStatus,
  loadConfig,
  readAgentCashWallet,
  readLedger,
  setPermissionMode,
  setSessionBudget,
  updateConfig,
  type OpenCrowdConfig,
  type PermissionMode,
  type SessionState
} from "@opencrowd/core";
import { sharedTypedProvider } from "@opencrowd/agent-runtime";
import { walletSummary } from "../wallet.js";
import {
  asRecord,
  parseUsd,
  readOption,
  renderKeyValues,
  renderTable,
  splitArgs
} from "../shared.js";
import { ensureMockRuntime, type ReplState } from "../agent-task.js";

export type CommandResult =
  | { kind: "text"; label?: string; body: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "run-task"; task: string; overrides: { budgetCents?: number; model?: string; testMode?: boolean; testSeed?: string } }
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
  { name: "wallet", usage: "/wallet address|balance", summary: "Inspect the shared AgentCash wallet" },
  { name: "models", usage: "/models list|set <model>", summary: "List or set the x402 LLM model" },
  { name: "model", usage: "/model <model>", summary: "Set the model for this session only" },
  { name: "run", usage: "/run [--budget <usd>] [--model <m>] \"<task>\"", summary: "Run a task with one-off overrides" },
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
        const label = state.model ?? `${config.provider}/${config[config.provider].model}`;
        return { kind: "text", label: "Model", body: renderKeyValues({ model: label }) };
      }
      state.model = rest[0];
      return { kind: "text", label: "Model", body: renderKeyValues({ model: state.model }) };
    }
    case "models": {
      const [action, value] = rest;
      const config = await loadConfig();
      if (action === "list" || action === undefined) {
        const provider = sharedTypedProvider(config.provider, { timeoutMs: config.llmTimeoutMs });
        const models = await provider.listModels();
        const rows = models.map((model) => ({
          id: model.id,
          name: model.name,
          context: model.contextWindowTokens,
          output_cost_cents_per_1k: model.outputCostCentsPer1k
        }));
        return {
          kind: "text",
          label: `Models (${config.provider})`,
          body: renderTable(rows, [["id", "id"], ["name", "name"], ["context", "context"], ["output_cost_cents_per_1k", "out/1k"]])
        };
      }
      if (action === "set" && value) {
        await updateConfig({
          [config.provider]: { ...config[config.provider], model: value }
        } as Partial<OpenCrowdConfig>);
        return { kind: "text", label: "Model", body: renderKeyValues({ provider: config.provider, model: value }) };
      }
      throw new Error("/models supports list, set <model|auto>");
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
      return walletSlashCommand(rest);
    default:
      throw new Error(`unknown slash command: /${command} (try /help)`);
  }
}

/** Public wallet info only: the shared AgentCash wallet's address and balances. */
async function walletSlashCommand(args: string[]): Promise<CommandResult> {
  const [action] = args;
  if (action === "address" || action === undefined) {
    const wallet = await readAgentCashWallet();
    if (!wallet) {
      throw new Error("No AgentCash wallet found. Install agentcash (its wallet is created automatically) and retry.");
    }
    return { kind: "text", label: "Wallet", body: renderKeyValues({ address: wallet.address, networks: "base, tempo, solana", asset: "USDC" }) };
  }
  if (action === "balance") {
    const summary = await walletSummary();
    if (summary.error) {
      throw new Error(`wallet balance unavailable: ${summary.error}`);
    }
    return { kind: "text", label: "Wallet", body: renderKeyValues(asRecord(summary.raw ?? summary)) };
  }
  throw new Error("/wallet supports address, balance");
}

function isConsumed(args: string[], index: number, options: string[]): boolean {
  return options.includes(args[index]) || (index > 0 && options.includes(args[index - 1]));
}
