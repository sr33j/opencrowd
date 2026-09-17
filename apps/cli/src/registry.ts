import {
  budgetStatus,
  loadConfig,
  readAgentCashWallet,
  readLedger,
  setApprovalMode,
  setSessionBudget,
  saveSession,
  type SessionState
} from "@opencrowd/core";
import {
  approvalRulesPath,
  isApprovalMode,
  loadApprovalRules,
  pendingRequiredReviews,
  removeApprovalRule,
  upsertApprovalRule
} from "@opencrowd/economy";
import {
  buildSessionSummary,
  normalizeProviderId,
  resolveSessionModels,
  rescueProviderId,
  sharedTypedProvider,
  type ProviderId
} from "@opencrowd/agent-runtime";
import { walletSummary } from "./wallet.js";
import { metamaskDeepLink, SUGGESTED_FUND_CENTS, usdcTransferUri } from "./tui/funding.js";
import { asRecord, formatCents, parseUsd, renderKeyValues, renderTable } from "./shared.js";

/**
 * The one interactive command registry. Parsing, execution, autocomplete,
 * `/help`, `opencrowd --help`, and generated documentation all derive from
 * this table. Interactive commands mutate or inspect the CURRENT session;
 * persistent defaults change only through `opencrowd config`.
 */

export type CommandResult =
  | { kind: "text"; label?: string; body: string }
  | { kind: "wallet" }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "new-session" }
  | { kind: "help" };

export interface UiState {
  testMode: boolean;
  testSeed?: string;
}

export interface CommandContext {
  session: SessionState;
  state: UiState;
}

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  execute(rest: string[], context: CommandContext): Promise<CommandResult>;
}

export const COMMAND_REGISTRY: CommandSpec[] = [
  {
    name: "status",
    usage: "/status",
    summary: "Session, provider, models, wallet/credit, budget, and approval mode",
    execute: async (_rest, { session, state }) => {
      const budget = budgetStatus(session);
      const config = await loadConfig();
      const providerId = activeProviderId(session, config.provider);
      const rows: Record<string, unknown> = {
        session: session.sessionId,
        workspace: session.workspaceRoot,
        provider: providerId,
        model: session.models?.main ?? `${config[config.provider].model} (unresolved)`,
        submodel: session.models?.subagent ?? (session.models ? "off" : `${config[config.provider].submodel} (unresolved)`),
        budget: `${formatCents(budget.spent_cents)} spent / ${formatCents(budget.remaining_cents)} left of ${formatCents(budget.budget_cents)}`,
        approval: session.approvalMode,
        shell: session.shellEnabled ? "enabled" : "disabled"
      };
      if (state.testMode) {
        rows.wallet = "demo (mock; no real money)";
      } else {
        const wallet = await walletSummary();
        rows.wallet = wallet.address ?? "no AgentCash wallet found";
        rows.wallet_balance = wallet.totalCents !== undefined
          ? formatCents(wallet.totalCents)
          : wallet.error ? `unavailable (${wallet.error})` : "unknown";
      }
      return { kind: "text", label: "Status", body: renderKeyValues(rows) };
    }
  },
  {
    name: "provider",
    usage: "/provider [help|blockrun|openrouter-x402-proxy|venice|openrouter]",
    summary: "Show or select this session's LLM provider (validated immediately)",
    execute: async (rest, { session, state }) => {
      const config = await loadConfig();
      if (!rest[0]) {
        const current = activeProviderId(session, config.provider);
        return {
          kind: "text",
          label: "Provider",
          body: renderKeyValues({
            provider: current,
            description: PROVIDER_DESCRIPTIONS[current],
            model: session.models?.main ?? `${config[current].model} (unresolved)`,
            fallback: rescueProviderId(current)
          })
        };
      }
      if (rest[0] === "help") {
        return {
          kind: "text",
          label: "Providers",
          body: renderTable(PROVIDER_HELP, [["provider", "provider"], ["auth", "auth/payment"], ["description", "route"]])
        };
      }
      if (state.testMode) {
        throw new Error("provider selection is unavailable in demo mode");
      }
      const normalized = normalizeProviderId(rest[0]);
      if (!normalized) {
        throw new Error("/provider supports blockrun, openrouter-x402-proxy, venice, or openrouter (try /provider help)");
      }
      const providerId: ProviderId = normalized;
      // Validate configuration immediately: this connects/authenticates and
      // fetches the catalog, then re-resolves this session's models.
      const provider = sharedTypedProvider(providerId, { timeoutMs: config.llmTimeoutMs, x402ProxyUrl: config.openrouterX402ProxyUrl });
      const catalog = await provider.listModels();
      const defaults = config[providerId];
      session.models = resolveSessionModels(providerId, catalog, {
        main: defaults.model,
        subagent: defaults.submodel
      });
      await saveSession(session);
      return {
        kind: "text",
        label: "Provider",
        body: renderKeyValues({
          provider: providerId,
          model: session.models.main,
          submodel: session.models.subagent ?? "off"
        })
      };
    }
  },
  {
    name: "models",
    usage: "/models [refresh]",
    summary: "List models for the active provider (cached; `refresh` refetches)",
    execute: async (rest, { session, state }) => {
      if (state.testMode) {
        return { kind: "text", label: "Models", body: "  demo mode uses a scripted mock model" };
      }
      const config = await loadConfig();
      const providerId = activeProviderId(session, config.provider);
      const provider = sharedTypedProvider(providerId, { timeoutMs: config.llmTimeoutMs, x402ProxyUrl: config.openrouterX402ProxyUrl });
      const models = await provider.listModels({ refresh: rest[0] === "refresh" });
      const rows = models.map((model) => ({
        id: model.id,
        name: model.name,
        context: model.contextWindowTokens,
        output_cost_cents_per_1k: model.outputCostCentsPer1k
      }));
      return {
        kind: "text",
        label: `Models (${providerId})`,
        body: renderTable(rows, [["id", "id"], ["name", "name"], ["context", "context"], ["output_cost_cents_per_1k", "out/1k"]])
      };
    }
  },
  {
    name: "model",
    usage: "/model [id|auto]",
    summary: "Show or set this session's main model",
    execute: async (rest, { session, state }) => {
      if (!rest[0]) {
        return {
          kind: "text",
          label: "Model",
          body: renderKeyValues({ model: session.models?.main ?? "unresolved (set with /model <id|auto>)" })
        };
      }
      if (state.testMode) {
        throw new Error("model selection is unavailable in demo mode");
      }
      await updateSessionModels(session, { main: rest[0] });
      return { kind: "text", label: "Model", body: renderKeyValues({ model: session.models?.main }) };
    }
  },
  {
    name: "submodel",
    usage: "/submodel [id|auto|off]",
    summary: "Show, set, auto-select, or disable this session's subagent model",
    execute: async (rest, { session, state }) => {
      if (!rest[0]) {
        return {
          kind: "text",
          label: "Submodel",
          body: renderKeyValues({ submodel: session.models ? session.models.subagent ?? "off" : "unresolved" })
        };
      }
      if (state.testMode) {
        throw new Error("model selection is unavailable in demo mode");
      }
      await updateSessionModels(session, { subagent: rest[0] });
      return { kind: "text", label: "Submodel", body: renderKeyValues({ submodel: session.models?.subagent ?? "off" }) };
    }
  },
  {
    name: "budget",
    usage: "/budget <usd>",
    summary: "Change the current query budget (saved defaults stay the same)",
    execute: async (rest, { session }) => {
      if (!rest[0]) {
        return { kind: "text", label: "Budget", body: renderKeyValues(asRecord(budgetStatus(session))) };
      }
      await setSessionBudget(session, parseUsd(rest[0]));
      return { kind: "text", label: "Budget", body: renderKeyValues(asRecord(budgetStatus(session))) };
    }
  },
  {
    name: "approval",
    usage: "/approval ask|auto|off",
    summary: "Control external-service purchase approval for this session",
    execute: async (rest, { session }) => {
      if (!rest[0]) {
        return { kind: "text", label: "Approval", body: renderKeyValues({ approval: session.approvalMode }) };
      }
      if (!isApprovalMode(rest[0])) {
        throw new Error("/approval supports ask, auto, or off");
      }
      await setApprovalMode(session, rest[0]);
      return { kind: "text", label: "Approval", body: renderKeyValues({ approval: session.approvalMode }) };
    }
  },
  {
    name: "approvals",
    usage: "/approvals [allow <service> [--max-cost <usd>] [--session-max <usd>] | remove <service> | block <service>]",
    summary: "List/manage stored service allow/block rules and caps",
    execute: async (rest) => {
      const [action, service] = rest;
      if (!action || action === "list") {
        const rules = await loadApprovalRules();
        const rows = rules.map((rule) => ({
          service: rule.service,
          decision: rule.decision,
          max_cost_cents: rule.caps.maxCostCents,
          session_max_cents: rule.caps.sessionMaxCents
        }));
        return {
          kind: "text",
          label: "Approval rules",
          body: rows.length === 0
            ? `  none (stored at ${approvalRulesPath()})`
            : renderTable(rows, [["service", "service"], ["decision", "decision"], ["max_cost_cents", "max"], ["session_max_cents", "session max"]])
        };
      }
      if (!service) {
        throw new Error("/approvals allow|remove|block requires a service URL or origin");
      }
      if (action === "allow") {
        const rule = await upsertApprovalRule(service, "allow", {
          maxCostCents: optionUsdCents(rest, "--max-cost"),
          sessionMaxCents: optionUsdCents(rest, "--session-max")
        });
        return { kind: "text", label: "Approval rules", body: `  allowed ${rule.service}` };
      }
      if (action === "block") {
        const rule = await upsertApprovalRule(service, "block", {});
        return { kind: "text", label: "Approval rules", body: `  blocked ${rule.service}` };
      }
      if (action === "remove") {
        await removeApprovalRule(service);
        return { kind: "text", label: "Approval rules", body: `  removed ${service}` };
      }
      throw new Error("/approvals supports list, allow, remove, block");
    }
  },
  {
    name: "wallet",
    usage: "/wallet",
    summary: "Open Wallet: balance and editable spending limits",
    execute: async () => ({ kind: "wallet" })
  },
  {
    name: "fund",
    usage: "/fund",
    summary: "Show funding instructions and links for the shared wallet",
    execute: async (_rest, { state }) => {
      if (state.testMode) {
        return { kind: "text", label: "Fund", body: "  demo mode uses mock funds; nothing to deposit" };
      }
      const wallet = await readAgentCashWallet();
      if (!wallet) {
        throw new Error("No AgentCash wallet found. Install agentcash (its wallet is created automatically) and retry.");
      }
      const transferUri = usdcTransferUri(wallet.address, SUGGESTED_FUND_CENTS);
      const metamask = metamaskDeepLink(wallet.address, SUGGESTED_FUND_CENTS);
      return {
        kind: "text",
        label: "Fund the wallet",
        // Funding URIs must remain complete and copyable; the generic
        // key/value renderer intentionally shortens URLs for status output.
        body: [
          `  address          ${wallet.address}`,
          `  send             USDC on Base (suggested ${formatCents(SUGGESTED_FUND_CENTS)})`,
          `  transfer_uri     ${transferUri}`,
          `  metamask         ${metamask}`
        ].join("\n")
      };
    }
  },
  {
    name: "ledger",
    usage: "/ledger",
    summary: "Show normalized LLM usage, purchases, top-ups, and totals (no secrets)",
    execute: async (_rest, { session }) => {
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
  },
  {
    name: "summary",
    usage: "/summary [verbose]",
    summary: "Summarize work, artifacts, service calls, and spending so far",
    execute: async (rest, { session }) => {
      const body = await buildSessionSummary(session, "Interactive summary.", { compact: rest[0] !== "verbose" });
      return { kind: "text", label: "Summary", body: indent(body) };
    }
  },
  {
    name: "clear",
    usage: "/clear",
    summary: "Archive and clear conversation context; keep session, spend, models, policy",
    execute: async () => ({ kind: "clear" })
  },
  {
    name: "new",
    usage: "/new",
    summary: "Start a new session with configured defaults",
    execute: async () => ({ kind: "new-session" })
  },
  {
    name: "help",
    usage: "/help",
    summary: "Show the command registry",
    execute: async () => ({ kind: "help" })
  },
  {
    name: "quit",
    usage: "/quit",
    summary: "Finalize and exit (after required reviews are resolved)",
    execute: async () => ({ kind: "exit" })
  }
];

export function matchCommands(prefix: string): CommandSpec[] {
  const needle = prefix.toLowerCase();
  return COMMAND_REGISTRY.filter((command) => command.name.startsWith(needle));
}

export async function runSlashCommand(context: CommandContext, inputLine: string): Promise<CommandResult> {
  const [name, ...rest] = inputLine.split(/\s+/).filter(Boolean);
  if (!name || name === "?") {
    return { kind: "help" };
  }
  const command = COMMAND_REGISTRY.find((candidate) => candidate.name === name);
  if (!command) {
    throw new Error(`unknown command: /${name} (try /help)`);
  }
  return command.execute(rest, context);
}

/** Canonical help text, shared by /help, `opencrowd --help`, and the docs. */
export function renderCommandHelp(): string {
  return COMMAND_REGISTRY
    .map((command) => `  ${command.usage.padEnd(52)} ${command.summary}`)
    .join("\n");
}

/** Markdown table for generated documentation; CI fails if docs diverge. */
export function renderCommandHelpMarkdown(): string {
  return [
    "| Command | What it does |",
    "| --- | --- |",
    ...COMMAND_REGISTRY.map((command) => `| \`${command.usage.replace(/\|/g, "\\|")}\` | ${command.summary} |`)
  ].join("\n");
}

/** True while a confirmed paid purchase still needs its required review. */
export async function sessionHasPendingReviews(session: SessionState): Promise<boolean> {
  return (await pendingRequiredReviews(session)).length > 0;
}

function activeProviderId(session: SessionState, fallback: ProviderId): ProviderId {
  const recorded = session.models?.provider;
  return normalizeProviderId(recorded) ?? fallback;
}

const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  blockrun: "BlockRun gateway; AgentCash wallet pays x402 USDC",
  "openrouter-x402-proxy": "legacy x402-paid proxy fronting OpenRouter-grade serving",
  venice: "direct Venice integration using wallet-funded Venice credit",
  openrouter: "direct OpenRouter API using OPENROUTER_API_KEY and account credit"
};

const PROVIDER_HELP: Array<Record<string, unknown>> = [
  { provider: "blockrun (default)", auth: "AgentCash / x402", description: PROVIDER_DESCRIPTIONS.blockrun },
  { provider: "openrouter-x402-proxy", auth: "AgentCash / x402", description: PROVIDER_DESCRIPTIONS["openrouter-x402-proxy"] },
  { provider: "venice", auth: "AgentCash / SIWX", description: PROVIDER_DESCRIPTIONS.venice },
  { provider: "openrouter", auth: "OPENROUTER_API_KEY", description: PROVIDER_DESCRIPTIONS.openrouter }
];

/** Re-resolve this session's models with one preference changed; persist. */
async function updateSessionModels(
  session: SessionState,
  change: { main?: string; subagent?: string }
): Promise<void> {
  const config = await loadConfig();
  const providerId = activeProviderId(session, config.provider);
  const provider = sharedTypedProvider(providerId, { timeoutMs: config.llmTimeoutMs, x402ProxyUrl: config.openrouterX402ProxyUrl });
  const catalog = await provider.listModels();
  const defaults = config[providerId];
  const currentSubagent = session.models ? session.models.subagent ?? "off" : defaults.submodel;
  session.models = resolveSessionModels(providerId, catalog, {
    main: change.main ?? session.models?.main ?? defaults.model,
    subagent: change.subagent ?? currentSubagent
  });
  await saveSession(session);
}

function optionUsdCents(args: string[], option: string): number | undefined {
  const index = args.indexOf(option);
  if (index < 0 || !args[index + 1]) {
    return undefined;
  }
  return parseUsd(args[index + 1]);
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
