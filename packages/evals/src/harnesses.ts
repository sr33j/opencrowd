import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  appendConversationMessage,
  createOpenCrowdSession,
  listLlmModels,
  loadConfig,
  resolveModelPolicy,
  saveSession,
  type ConversationMessage,
  type LlmModel,
  type ResolvedModelPolicy
} from "@opencrowd/core";
import {
  createMockToolExecutor,
  MockLlmProvider,
  runAgentTaskDetailed,
  type SubagentOptions
} from "@opencrowd/agent-runtime";
import { buildEconomyContext, sharedConnectorManager, type EconomyContext } from "@opencrowd/connectors";
import { gradeTrajectoryFile, type ComplianceReport } from "./grader.js";
import type { GaiaQuestion } from "./gaia.js";

const execFileAsync = promisify(execFile);
const COMPARATOR_TIMEOUT_MS = 15 * 60 * 1000;

export interface HarnessContext {
  /** Fresh per-question directory; each harness treats it as its workspace. */
  runDir: string;
  prompt: string;
  attachmentPath?: string;
  testMode?: boolean;
  testSeed?: string;
  model?: string;
  auto?: boolean;
  log: (message: string) => void;
}

export interface HarnessRun {
  final_message?: string;
  turns?: number;
  /** Measured on-chain USDC spend (OpenCrowd only). */
  cost_cents?: number;
  llm_cost_cents?: number;
  service_cost_cents?: number;
  /** List-price estimate for API-billed comparators; not on-chain spend. */
  estimated_cost_usd?: number;
  tokens?: { input?: number; output?: number };
  trajectory_path?: string;
  model_policy?: ResolvedModelPolicy;
  compliance?: ComplianceReport;
  error?: string;
}

export interface GaiaHarness {
  name: string;
  /** True when cost figures are measured on-chain rather than estimated. */
  onChainCost: boolean;
  run(question: GaiaQuestion, context: HarnessContext): Promise<HarnessRun>;
}

export function resolveHarness(name: string): GaiaHarness {
  switch (name) {
    case "opencrowd":
      return openCrowdHarness;
    case "claude":
      return claudeHarness;
    case "codex":
      return codexHarness;
    default:
      throw new Error(`unknown harness: ${name} (supported: opencrowd, claude, codex)`);
  }
}

/** Shared prompt template so all harnesses answer under identical instructions. */
export function gaiaPrompt(question: GaiaQuestion, attachmentNote?: string): string {
  return [
    "You are being evaluated on a benchmark question.",
    "Answer the question below using whatever tools you have.",
    "Finish your reply with a line of exactly this form: FINAL ANSWER: [YOUR FINAL ANSWER]",
    "YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers and/or strings.",
    "If you are asked for a number, don't use commas or units such as $ or % unless specified otherwise.",
    "If you are asked for a string, don't use articles or abbreviations (e.g. for cities), and write digits in plain text unless specified otherwise.",
    "If you are asked for a comma separated list, apply the above rules to each element.",
    "",
    `Question: ${question.question}`,
    attachmentNote ?? ""
  ].filter(Boolean).join("\n");
}

const openCrowdHarness: GaiaHarness = {
  name: "opencrowd",
  onChainCost: true,
  async run(question, context) {
    const session = await createOpenCrowdSession({
      workspaceRoot: context.runDir,
      permissionMode: "yolo",
      shellEnabled: true,
      surface: "cli",
      useWalletBalanceBudget: !context.testMode
    });
    let prompt = context.prompt;
    if (context.attachmentPath) {
      const name = basename(context.attachmentPath);
      await mkdir(session.artifactsDir, { recursive: true });
      await copyFile(context.attachmentPath, join(session.artifactsDir, name));
      prompt = `${prompt}\n\nAn input file is available at the session artifact path \`${name}\` (use read_file, or run_shell against ${join(session.artifactsDir, name)}).`;
    }
    const models = context.testMode ? [] : await tryListModels();
    const policy = context.testMode ? undefined : await resolvePolicy(models, context);
    if (policy) {
      session.modelPolicy = policy;
      await saveSession(session);
    }
    const economy = context.testMode ? undefined : await tryEconomyContext(context.log);
    const mainModelId = policy?.main ?? context.model;
    const result = await runAgentTaskDetailed(session, prompt, {
      model: mainModelId,
      subagent: policy ? subagentOptions(models, policy) : undefined,
      maxTurns: 40,
      contextWindowTokens: models.find((candidate) => candidate.id === mainModelId)?.context_window_tokens,
      provider: context.testMode ? new MockLlmProvider({ seed: context.testSeed ?? question.task_id }) : undefined,
      toolExecutor: context.testMode ? createMockToolExecutor() : undefined,
      dynamicTools: economy?.dynamicTools,
      promptSections: economy?.promptSections,
      onMessage: (message) => appendConversationMessage(session, message as ConversationMessage)
    });
    const budget = asRecord(result.summary.budget);
    const trajectoryPath = join(session.sessionDir, "messages.jsonl");
    return {
      final_message: String(result.summary.final_message ?? ""),
      turns: result.turns,
      cost_cents: Number(budget.total_spent_cents ?? budget.spent_cents ?? 0),
      llm_cost_cents: Number(budget.llm_spend_cents ?? 0),
      service_cost_cents: Number(budget.external_service_spend_cents ?? 0),
      trajectory_path: trajectoryPath,
      model_policy: session.modelPolicy,
      compliance: await gradeTrajectoryFile(trajectoryPath).catch(() => undefined)
    };
  }
};

const claudeHarness: GaiaHarness = {
  name: "claude",
  onChainCost: false,
  async run(question, context) {
    const prompt = await comparatorPrompt(context);
    const { stdout } = await execFileAsync("claude", [
      "-p", prompt,
      "--output-format", "json",
      "--dangerously-skip-permissions"
    ], { cwd: context.runDir, timeout: COMPARATOR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const parsed = parseJson(stdout);
    const record = asRecord(parsed);
    return {
      final_message: typeof record.result === "string" ? record.result : stdout.trim(),
      turns: numberOrUndefined(record.num_turns),
      estimated_cost_usd: numberOrUndefined(record.total_cost_usd),
      tokens: {
        input: numberOrUndefined(asRecord(record.usage).input_tokens),
        output: numberOrUndefined(asRecord(record.usage).output_tokens)
      }
    };
  }
};

const codexHarness: GaiaHarness = {
  name: "codex",
  onChainCost: false,
  async run(question, context) {
    const prompt = await comparatorPrompt(context);
    // danger-full-access mirrors claude's --dangerously-skip-permissions so
    // both comparators get network and tool parity; each question runs in an
    // isolated scratch directory.
    const pending = execFileAsync("codex", [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox", "danger-full-access",
      prompt
    ], { cwd: context.runDir, timeout: COMPARATOR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    // codex exec reads extra prompt input from a piped stdin until EOF and
    // hangs if the pipe stays open — close it immediately.
    pending.child.stdin?.end();
    const { stdout } = await pending;
    let finalMessage: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    for (const line of stdout.split(/\r?\n/)) {
      const event = asRecord(parseJson(line));
      const item = asRecord(event.item);
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalMessage = item.text;
      }
      const usage = asRecord(event.usage);
      if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
        sawUsage = true;
        inputTokens += numberOrUndefined(usage.input_tokens) ?? 0;
        outputTokens += numberOrUndefined(usage.output_tokens) ?? 0;
      }
    }
    return {
      final_message: finalMessage ?? stdout.trim(),
      tokens: sawUsage ? { input: inputTokens, output: outputTokens } : undefined
    };
  }
};

async function comparatorPrompt(context: HarnessContext): Promise<string> {
  if (!context.attachmentPath) {
    return context.prompt;
  }
  const name = basename(context.attachmentPath);
  await copyFile(context.attachmentPath, join(context.runDir, name));
  return `${context.prompt}\n\nAn input file is available in the working directory at ./${name}`;
}

async function resolvePolicy(models: LlmModel[], context: HarnessContext): Promise<ResolvedModelPolicy | undefined> {
  const config = await loadConfig();
  try {
    return resolveModelPolicy(models, {
      mode: context.auto ? "auto" : "manual",
      main: context.model ?? (context.auto ? "auto" : config.x402LlmModel),
      subagent: config.modelPolicy.subagent
    });
  } catch (error) {
    if (context.auto) {
      throw error;
    }
    return undefined;
  }
}

function subagentOptions(models: LlmModel[], policy: ResolvedModelPolicy): SubagentOptions {
  const model = models.find((candidate) => candidate.id === policy.subagent);
  return {
    model: policy.subagent,
    costHint: model?.output_cost_cents_per_1k !== undefined
      ? `~${model.output_cost_cents_per_1k}¢ per 1k output tokens`
      : undefined
  };
}

async function tryListModels(): Promise<LlmModel[]> {
  try {
    return await listLlmModels();
  } catch {
    return [];
  }
}

async function tryEconomyContext(log: (message: string) => void): Promise<EconomyContext | undefined> {
  if (process.env.OPENCROWD_DISABLE_CONNECTORS === "1" || process.env.OPENCROWD_DISABLE_CONNECTORS === "true") {
    return undefined;
  }
  try {
    return await buildEconomyContext(await sharedConnectorManager());
  } catch (error) {
    log(`connector MCP servers unavailable (${(error as Error).message}); using the legacy service path`);
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
