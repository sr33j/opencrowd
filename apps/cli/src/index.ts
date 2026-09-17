#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createOpenCrowdSession, approvePendingSpending, SpendingDeclined, type SpendingHandler,
  loadConfig,
  loadSession,
  readAgentCashWallet,
  readLedger,
  saveSession,
  setApprovalMode,
  updateConfig,
  type ApprovalMode,
  type OpenCrowdConfig,
  type ProgressEvent
} from "@opencrowd/core";
import { closeSharedEconomyRuntime, isApprovalMode } from "@opencrowd/economy";
import {
  normalizeProviderId,
  renderProgress,
  sharedTypedProvider,
  type RenderProgressOptions
} from "@opencrowd/agent-runtime";
import {
  asRecord,
  envFlag,
  isConsumedOption,
  latestSessionId,
  parseUsd,
  readOption,
  renderKeyValues,
  renderTable,
  shouldUseColor,
  terminalWidth
} from "./shared.js";
import { runPersistentAgentTask, runPersistentAgentTaskDetailed, warmStartEconomy } from "./agent-task.js";
import { renderCommandHelp } from "./registry.js";
import { walletSummary } from "./wallet.js";
import { startTui } from "./tui/app.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command) {
    if (input.isTTY) {
      await startTui();
      return;
    }
    throw new Error("the interactive UI needs a terminal; use `opencrowd run --headless --prompt \"...\"` for scripts");
  }
  if (command === "--test-mode" || command === "--demo" || command === "demo") {
    const extraArgs = rest.filter((_arg, index) => !isConsumedOption(rest, index, ["--test-seed"]));
    if (extraArgs.length > 0) {
      throw new Error("top-level --demo launches the interactive demo; use `opencrowd run --test-mode \"task\"` for one-shot demo tasks");
    }
    if (input.isTTY) {
      await startTui({ testMode: true, testSeed: readOption(rest, "--test-seed") });
      return;
    }
    // Non-interactive demo (smoke tests): run one scripted demo task.
    await runCommand(["--test-mode", "demo: find a paid service, pay it with mock money, and review it"]);
    return;
  }
  switch (command) {
    case "worker": {
      const { workerCommand } = await import("./worker.js");
      await workerCommand(rest);
      return;
    }
    case "resume":
      await resumeCommand(rest);
      return;
    case "run":
      await runCommand(rest);
      return;
    case "config":
      await configCommand(rest);
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
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      const healthy = await runDoctor((line) => console.log(line));
      if (!healthy) {
        process.exitCode = 1;
      }
      return;
    }
    case "evals":
      await evalsCommand(rest);
      return;
    case "--version":
    case "-v":
    case "version": {
      // Works from both layouts: dist/index.js and bundle/opencrowd.js sit
      // one level below the package root.
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      console.log(pkg.version);
      return;
    }
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function progressLogger(options: RenderProgressOptions): (event: ProgressEvent) => void {
  return (event) => {
    const message = renderProgress(event, options);
    if (message) {
      console.log(message);
    }
  };
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
  const approval = readOption(args, "--approval");
  if (approval !== undefined && !isApprovalMode(approval)) {
    throw new Error("--approval must be ask, auto, or off");
  }
  const shellEnabled = args.includes("--enable-shell") ? true : args.includes("--disable-shell") ? false : undefined;
  const sessionId = readOption(args, "--session");
  const task = args.filter((arg, index) => !isConsumedOption(args, index, ["--budget", "--approval", "--model", "--session", "--test-seed"])
    && arg !== "--enable-shell"
    && arg !== "--disable-shell"
    && arg !== "--test-mode"
    && arg !== "--verbose").join(" ");
  if (!task) {
    throw new Error("run requires a task string");
  }
  if (!testMode) {
    await warmStartEconomy();
  }
  const session = sessionId
    ? await loadSession(process.cwd(), sessionId)
    : await createOpenCrowdSession({
      workspaceRoot: process.cwd(),
      budgetCents: budgetArg === undefined ? undefined : parseUsd(budgetArg),
      approvalMode: approval as ApprovalMode | undefined,
      shellEnabled
    });
  if (sessionId) {
    if (budgetArg !== undefined) {
      session.budgetCents = parseUsd(budgetArg);
      await saveSession(session);
    }
    if (approval !== undefined) {
      await setApprovalMode(session, approval as ApprovalMode);
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
    spendingHandler: input.isTTY ? terminalSpendingHandler : undefined,
    onProgress: progressLogger({ style: output.isTTY ? "pretty" : "compact", color: shouldUseColor(), width: terminalWidth() })
  });
  console.log(outputText);
}

/**
 * Programmatic run contract: non-interactive, exits when the session
 * completes or blocks, and emits the structured completion object plus
 * spend split, turn count, and model policy. Approval never waits for UI
 * input: `ask` mode denies un-ruled purchases with a clear error instead.
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
  const approval = readOption(args, "--approval") ?? (await loadConfig()).approval;
  if (!isApprovalMode(approval)) {
    throw new Error("--approval must be ask, auto, or off");
  }
  const attach = readOption(args, "--attach");
  const verbose = args.includes("--verbose");
  const testMode = args.includes("--test-mode") || envFlag("OPENCROWD_TEST_MODE");
  const testSeed = readOption(args, "--test-seed") ?? process.env.OPENCROWD_TEST_SEED;
  const budgetArg = readOption(args, "--budget");
  const maxTurnsArg = readOption(args, "--max-turns");
  const workspaceRoot = readOption(args, "--workspace") ?? process.cwd();
  if (!testMode) {
    await warmStartEconomy();
  }
  const session = await createOpenCrowdSession({
    workspaceRoot,
    budgetCents: budgetArg === undefined ? undefined : parseUsd(budgetArg),
    approvalMode: approval,
    shellEnabled: !args.includes("--disable-shell")
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
    nonInteractive: true,
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
    model_policy: session.models ?? null,
    usdc_spent_cents: {
      llm: Number(budget.llm_spend_cents ?? 0),
      services: Number(budget.external_service_spend_cents ?? 0),
      wallet_top_ups: Number(budget.wallet_top_up_spend_cents ?? 0),
      total: Number(budget.total_spent_cents ?? budget.spent_cents ?? 0)
    },
    budget,
    approval: result.summary.approval ?? null,
    resume_command: result.outcome === "waiting_for_approval" ? `opencrowd resume ${session.sessionId} --approve-once --workspace ${workspaceRoot}` : undefined,
    artifacts: result.summary.artifacts ?? [],
    service_calls: result.summary.service_calls ?? []
  };
  if (outputFormat === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(String(result.summary.final_message ?? "Session complete."));
  }
}

/**
 * Persistent defaults with explicit future-session semantics: `config set`
 * never mutates an already running session.
 */
async function configCommand(args: string[]): Promise<void> {
  const [action, key, value] = args;
  if (action === "show" || action === undefined) {
    const config = await loadConfig();
    printValue("Config (future sessions)", config, { pretty: renderKeyValues(asRecord(config as unknown as Record<string, unknown>)) });
    return;
  }
  if (action !== "set" || !key || value === undefined) {
    throw new Error("config supports: show | set provider|model|submodel|budget|approval <value>");
  }
  const config = await loadConfig();
  let savedValue = value;
  switch (key) {
    case "provider": {
      const provider = normalizeProviderId(value);
      if (!provider) {
        throw new Error("provider must be blockrun, openrouter-x402-proxy, venice, or openrouter");
      }
      await updateConfig({ provider });
      savedValue = provider;
      break;
    }
    case "model": {
      await updateConfig({
        [config.provider]: { ...config[config.provider], model: value }
      } as Partial<OpenCrowdConfig>);
      break;
    }
    case "submodel": {
      await updateConfig({
        [config.provider]: { ...config[config.provider], submodel: value }
      } as Partial<OpenCrowdConfig>);
      break;
    }
    case "budget": {
      await updateConfig({ defaultBudgetCents: parseUsd(value) });
      break;
    }
    case "approval": {
      if (!isApprovalMode(value)) {
        throw new Error("approval must be ask, auto, or off");
      }
      await updateConfig({ approval: value });
      break;
    }
    default:
      throw new Error(`unknown config key: ${key} (supported: provider, model, submodel, budget, approval)`);
  }
  console.log(`set ${key} = ${savedValue} (applies to future sessions; running sessions are unchanged)`);
}

async function ledgerCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  args = args.filter((arg) => arg !== "--json");
  const [action] = args;
  if (action !== "show") {
    throw new Error("ledger supports show");
  }
  const explicitSessionId = readOption(args, "--session");
  const sessionId = explicitSessionId ?? await latestSessionId(process.cwd());
  if (!sessionId) {
    throw new Error("no local sessions found");
  }
  const rows = await readLedger(join(process.cwd(), "sessions", sessionId, "ledger.csv"));
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

const terminalSpendingHandler: SpendingHandler = async request => {
  const rl = createInterface({ input, output });
  try {
    console.log(`Spending approval required: ${request.description}\nThis call: $${request.amountCents / 100}; query after call: $${request.projectedCents / 100} / $${request.queryLimitCents / 100}.`);
    const answer = (await rl.question("[y] approve this call, [i] increase query budget, [n] decline: ")).trim().toLowerCase();
    if (answer === "i") return { decision: "approve", queryBudgetCents: parseUsd(await rl.question("New budget for this query (USD): ")) };
    return { decision: answer === "y" ? "approve" : "decline" };
  } finally { rl.close(); }
};

async function resumeCommand(args: string[]) {
  const id = args[0];
  if (!id) throw new Error("resume requires a session ID");
  const session = await loadSession(readOption(args, "--workspace") ?? process.cwd(), id);
  const pending = session.query?.pending;
  if (pending) {
    if (args.includes("--decline")) {
      try { await approvePendingSpending(session, { decision: "decline" }); } catch (e) { if (!(e instanceof SpendingDeclined)) throw e; }
      await rm(join(session.sessionDir, "query-checkpoint.json"), { force: true });
      console.log("Query declined. Nothing was paid for the pending call."); return;
    }
    const budget = readOption(args, "--query-budget");
    if (args.includes("--approve-once") || budget !== undefined)
      await approvePendingSpending(session, { decision: "approve", ...(budget === undefined ? {} : { queryBudgetCents: parseUsd(budget) }) });
    else if (input.isTTY) await approvePendingSpending(session, await terminalSpendingHandler(pending));
    else { console.log(JSON.stringify({ outcome: "waiting_for_approval", approval: pending }, null, 2)); return; }
  }
  const result = await runPersistentAgentTaskDetailed(session, "", { nonInteractive: !input.isTTY, spendingHandler: input.isTTY ? terminalSpendingHandler : undefined,
    testMode: args.includes("--test-mode") });
  console.log(JSON.stringify(result, null, 2));
}

async function walletCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  args = args.filter((arg) => arg !== "--json");
  const [action] = args;
  if (action === "limits") {
    const call = readOption(args, "--per-call"), query = readOption(args, "--per-query");
    const config = call !== undefined || query !== undefined ? await updateConfig({
      ...(call === undefined ? {} : { llmMaxCostCentsPerCall: parseUsd(call) }),
      ...(query === undefined ? {} : { defaultBudgetCents: parseUsd(query) })
    }) : await loadConfig();
    printValue("Spending limits", { per_call_usd: config.llmMaxCostCentsPerCall / 100, per_query_usd: config.defaultBudgetCents / 100 }, { json }); return;
  }
  if (action === "address" || action === undefined) {
    const wallet = await readAgentCashWallet();
    if (!wallet) {
      throw new Error("No AgentCash wallet found. Install agentcash (its wallet is created automatically on first use) and retry.");
    }
    const result = { address: wallet.address, networks: "base, tempo, solana", asset: "USDC" };
    printValue("Wallet", result, { json, pretty: renderKeyValues(asRecord(result)) });
    return;
  }
  if (action === "balance") {
    const summary = await walletSummary();
    if (summary.error) {
      throw new Error(`wallet balance unavailable: ${summary.error}`);
    }
    printValue("Wallet", summary.raw ?? summary, { json, pretty: renderKeyValues(asRecord(summary.raw ?? summary)) });
    return;
  }
  throw new Error("wallet supports address, balance, limits [--per-call USD] [--per-query USD]");
}

async function modelsCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  args = args.filter((arg) => arg !== "--json");
  const [action] = args;
  const config = await loadConfig();
  if (action === "list" || action === undefined) {
    const provider = sharedTypedProvider(config.provider, { timeoutMs: config.llmTimeoutMs, x402ProxyUrl: config.openrouterX402ProxyUrl });
    const models = await provider.listModels();
    const rows = models.map((model) => ({
      id: model.id,
      name: model.name,
      context: model.contextWindowTokens,
      output_cost_cents_per_1k: model.outputCostCentsPer1k
    }));
    printValue(`Models (${config.provider})`, rows, {
      json,
      pretty: renderTable(rows, [
        ["id", "id"],
        ["name", "name"],
        ["context", "context"],
        ["output_cost_cents_per_1k", "out/1k"]
      ])
    });
    return;
  }
  throw new Error("models supports list; set defaults with `opencrowd config set model <id|auto>`");
}

async function evalsCommand(args: string[]): Promise<void> {
  const [dataset, ...rest] = args;
  if (dataset === "suite") {
    await evalsSuiteCommand(rest);
    return;
  }
  if (dataset === "evolve") {
    await evalsEvolveCommand(rest);
    return;
  }
  if (dataset !== "gaia") {
    throw new Error("evals supports: gaia [--tier smoke|level1|full] [--harness opencrowd,claude,codex] [--hf-token <token>] [--auto] [--model <model>] [--subagent-model <model|off>] [--yes]");
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
    subagentModel: readOption(rest, "--subagent-model"),
    auto: rest.includes("--auto"),
    limit: readOption(rest, "--limit") === undefined ? undefined : Number(readOption(rest, "--limit")),
    parallel: readOption(rest, "--parallel") === undefined ? undefined : Number(readOption(rest, "--parallel")),
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

async function evalsSuiteCommand(rest: string[]): Promise<void> {
  const { runSuite, renderSuiteReport, TASK_SETS } = await import("@opencrowd/evals");
  const set = readOption(rest, "--set") ?? "heldin";
  if (!(set in TASK_SETS)) {
    throw new Error(`--set must be one of: ${Object.keys(TASK_SETS).join(", ")}`);
  }
  const report = await runSuite({
    set: set as keyof typeof TASK_SETS,
    harness: readOption(rest, "--harness") ?? "opencrowd",
    resultsRoot: readOption(rest, "--out") ?? join(process.cwd(), "evals", "suite"),
    tag: readOption(rest, "--tag"),
    knowledgeDir: readOption(rest, "--knowledge"),
    hfToken: readOption(rest, "--hf-token") ?? process.env.HF_TOKEN,
    model: readOption(rest, "--model"),
    subagentModel: readOption(rest, "--subagent-model"),
    auto: rest.includes("--auto"),
    maxTurns: readOption(rest, "--max-turns") === undefined ? undefined : Number(readOption(rest, "--max-turns")),
    parallel: readOption(rest, "--parallel") === undefined ? undefined : Number(readOption(rest, "--parallel")),
    limit: readOption(rest, "--limit") === undefined ? undefined : Number(readOption(rest, "--limit")),
    only: readOption(rest, "--only")?.split(",").map((id) => id.trim()).filter(Boolean),
    seed: readOption(rest, "--seed"),
    log: (message) => console.error(message)
  });
  console.log(renderSuiteReport(report));
}

async function evalsEvolveCommand(rest: string[]): Promise<void> {
  const { runEvolution, renderArchive } = await import("@opencrowd/evals");
  const { archive, best } = await runEvolution({
    resultsRoot: readOption(rest, "--out") ?? join(process.cwd(), "evals", "evolve"),
    evidencePath: readOption(rest, "--evidence"),
    refreshEvidence: rest.includes("--refresh-evidence"),
    generations: Number(readOption(rest, "--generations") ?? 2),
    candidatesPerGeneration: Number(readOption(rest, "--candidates") ?? 2),
    agentModel: readOption(rest, "--model") ?? "openai/gpt-5.6-luna",
    proposerModels: (readOption(rest, "--proposer") ?? "openai/gpt-5.6-sol,openai/gpt-5.6-luna").split(",").map((id) => id.trim()).filter(Boolean),
    seedTrees: readOption(rest, "--seed-trees")?.split(",").map((dir) => dir.trim()).filter(Boolean),
    baselineReport: readOption(rest, "--baseline-report"),
    parallel: readOption(rest, "--parallel") === undefined ? undefined : Number(readOption(rest, "--parallel")),
    maxTurns: readOption(rest, "--max-turns") === undefined ? undefined : Number(readOption(rest, "--max-turns")),
    hfToken: readOption(rest, "--hf-token") ?? process.env.HF_TOKEN,
    log: (message) => console.error(message)
  });
  console.log(renderArchive(archive));
  if (best?.dir) {
    console.log(`\nBEST=${best.dir}`);
  }
}

function printHelp(): void {
  console.log(`Usage:
  opencrowd                       interactive agent UI
  opencrowd --demo                try the full loop with mock money, mock services, and a scripted agent
  opencrowd run [--session <id>] [--budget <usd>] [--model <model>] [--approval ask|auto|off] [--test-mode] [--disable-shell] [--verbose] "<task>"
  opencrowd run --headless --prompt "<text>" [--attach <file>] [--output json|text] [--approval ask|auto|off] [--auto] [--model <model>] [--subagent-model <model>] [--budget <usd>] [--max-turns <n>] [--workspace <dir>] [--verbose]
  opencrowd config show
  opencrowd config set provider|model|submodel|budget|approval <value>
  opencrowd ledger [--json] show [--session <id>]
  opencrowd resume <session-id> [--approve-once | --query-budget <usd> | --decline] [--workspace <dir>]
  opencrowd wallet [--json] address|balance
  opencrowd wallet limits [--per-call <usd>] [--per-query <usd>]
  opencrowd models [--json] list
  opencrowd doctor
  opencrowd --version
  opencrowd evals gaia [--tier smoke|level1|full] [--harness opencrowd,claude,codex] [--parallel <n>] [--hf-token <token>] [--auto] [--model <model>] [--subagent-model <model|off>] [--yes]
  opencrowd evals evolve [--out <dir>] [--generations <n>] [--candidates <n>] [--model <agent model>] [--proposer <model,model>] [--seed-trees <dir,dir>] [--baseline-report <report.json>] [--parallel <n>]
  opencrowd evals suite [--set usage|gaia-hard|assistantbench|heldin|heldout|all] [--knowledge <dir>|none] [--tag <label>] [--out <dir>] [--only id,id] [--limit <n>] [--parallel <n>] [--model <model>] [--subagent-model <model|off>] [--max-turns <n>]

Interactive commands (also /help inside the UI):
${renderCommandHelp()}`);
}

function printValue(label: string, value: unknown, options: { pretty?: string; json?: boolean } = {}): void {
  if (options.json || !output.isTTY || !options.pretty) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(`${label}\n${options.pretty}`);
}

main(process.argv.slice(2))
  .catch((error) => {
    if (process.argv[2] === "worker") {
      console.error(JSON.stringify({ level: "error", code: "worker_failure", message: "Worker protocol or configuration failed" }));
    } else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeSharedEconomyRuntime().catch(() => undefined));
