import { createInterface } from "node:readline";
import { MachineWorker, createWorkerDemoProvider } from "@opencrowd/agent-runtime";
import { readOption } from "./shared.js";

export async function workerCommand(args: string[]): Promise<void> {
  const home = readOption(args, "--agent-home");
  if (!home || readOption(args, "--protocol") !== "jsonl") throw new Error("worker requires --protocol jsonl --agent-home <path>");
  if (!args.includes("--demo")) throw new Error("worker currently requires --demo; paid execution is disabled until gateway verification");
  const worker = new MachineWorker({ agentHome: home, provider: () => createWorkerDemoProvider(),
    output: line => { process.stdout.write(line); } });
  await worker.initialize();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) await worker.handleLine(line);
  await worker.drain();
}
