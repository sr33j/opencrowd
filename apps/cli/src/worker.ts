import { createInterface } from "node:readline";
import { MachineWorker, createWorkerDemoProvider, createHostedEconomy, createHostedProvider, createHostedToolExecutor, moneyReadsFromEnv, readHostedFinancialState } from "@opencrowd/agent-runtime";
import { readOption } from "./shared.js";

export async function workerCommand(args: string[]): Promise<void> {
  const home = readOption(args, "--agent-home");
  if (!home || readOption(args, "--protocol") !== "jsonl") throw new Error("worker requires --protocol jsonl --agent-home <path>");
  const socketPath = readOption(args, "--bridge-socket");
  if (args.includes("--demo") === !!socketPath) throw new Error("worker requires exactly one of --demo or --bridge-socket <path>");
  const worker = new MachineWorker({ agentHome: home, provider: (run, session, extraTools) => socketPath
    ? createHostedProvider({ socketPath, runId: run.runId, sessionId: session.sessionId, extraTools,
      chatOnly: run.payload.modelPolicy.chatOnly === true }) : createWorkerDemoProvider(),
    hostedTools: socketPath ? (run, session) => createHostedToolExecutor({ socketPath, runId: run.runId, sessionId: session.sessionId }) : undefined,
    economy: socketPath ? (run, session) => createHostedEconomy({ socketPath, runId: run.runId, sessionId: session.sessionId, session }) : undefined,
    financialState: socketPath ? (run, session) => readHostedFinancialState({ socketPath, runId: run.runId, sessionId: session.sessionId }) : undefined,
    // The money-reads flag (money-reads.ts), set by the supervisor from its environment.
    ...(moneyReadsFromEnv() ? { moneyReads: moneyReadsFromEnv() } : {}),
    output: line => { process.stdout.write(line); }, onFatal: workerFatal });
  try {
    await worker.initialize();
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) await worker.handleLine(line);
    await worker.drain();
  } catch (error) {
    workerFatal(error);
  }
}

/** Error codes that mean the agent's disk cannot take another write. */
const STORAGE_FULL = new Set(["ENOSPC", "EDQUOT"]);

/**
 * A worker that cannot record its work ends, at once, with one line saying
 * why. It used to log "worker_failure" and stay alive with stdin still open,
 * so its supervisor never noticed, and the run stayed "running" for ten hours
 * with the owner's cancel unanswered. Its exit is what the supervisor reports.
 */
export function workerFatal(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const storageFull = typeof code === "string" && STORAGE_FULL.has(code);
  process.stderr.write(JSON.stringify(storageFull
    ? { level: "error", code: "storage_full", message: "The agent's disk is full, so its progress could not be saved" }
    : { level: "error", code: "worker_failure", message: "Worker protocol or configuration failed" }) + "\n");
  process.exit(1);
}
