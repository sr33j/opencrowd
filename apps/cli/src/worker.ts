import { createInterface } from "node:readline";
import { MachineWorker, createWorkerDemoProvider, createHostedProvider } from "@opencrowd/agent-runtime";
import { readOption } from "./shared.js";

export async function workerCommand(args: string[]): Promise<void> {
  const home = readOption(args, "--agent-home");
  if (!home || readOption(args, "--protocol") !== "jsonl") throw new Error("worker requires --protocol jsonl --agent-home <path>");
  const socketPath = readOption(args, "--bridge-socket");
  if (args.includes("--demo") === !!socketPath) throw new Error("worker requires exactly one of --demo or --bridge-socket <path>");
  const worker = new MachineWorker({ agentHome: home, provider: (run, session) => socketPath
    ? createHostedProvider({ socketPath, runId: run.runId, sessionId: session.sessionId }) : createWorkerDemoProvider(),
    output: line => { process.stdout.write(line); } });
  await worker.initialize();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) await worker.handleLine(line);
  await worker.drain();
}
