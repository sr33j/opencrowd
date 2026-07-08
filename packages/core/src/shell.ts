import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { appendLedgerEntry } from "./ledger.js";
import type { SessionState } from "./types.js";

export interface ShellResult {
  command: string;
  cwd: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

export interface ShellOptions {
  maxTimeoutMs?: number;
  outputCapBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runShell(
  state: SessionState,
  command: string,
  cwd = state.workspaceRoot,
  timeoutMs = 10_000,
  options: ShellOptions = {}
): Promise<ShellResult> {
  if (!state.shellEnabled) {
    throw new Error("shell tool is disabled for this session");
  }
  const maxTimeout = options.maxTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout) {
    throw new Error(`timeout_ms must be between 1 and ${maxTimeout}`);
  }
  const resolvedCwd = resolveShellCwd(state, cwd);
  const root = resolve(state.workspaceRoot);
  if (resolvedCwd !== root && !resolvedCwd.startsWith(`${root}/`)) {
    throw new Error("shell cwd must stay inside the workspace");
  }
  const result = await execute(command, resolvedCwd, timeoutMs, options.outputCapBytes ?? 64_000, options.env);
  await appendLedgerEntry(state.ledgerPath, {
    session_id: state.sessionId,
    type: "shell",
    status: result.exit_code === 0 ? "ok" : "failed",
    permission_mode: state.permissionMode,
    notes: JSON.stringify({ command, cwd: resolvedCwd, exit_code: result.exit_code, timed_out: result.timed_out })
  });
  return result;
}

function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputCapBytes: number,
  env: NodeJS.ProcessEnv = minimalEnv()
): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let closeGraceTimer: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    const detached = process.platform !== "win32";
    const settle = (result: ShellResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
      }
      cleanupProcessGroup(child, detached);
      resolvePromise(result);
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      env,
      detached,
      stdio: ["ignore", "pipe", "pipe"]
    });
    timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, detached, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalProcessGroup(child, detached, "SIGKILL");
        settle({ command, cwd, exit_code: exitCode, timed_out: timedOut, stdout, stderr });
      }, 1_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = capOutput(stdout + String(chunk), outputCapBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capOutput(stderr + String(chunk), outputCapBytes);
    });
    child.on("error", (error) => {
      settle({ command, cwd, exit_code: null, timed_out: timedOut, stdout, stderr: capOutput(`${stderr}${error.message}`, outputCapBytes) });
    });
    child.on("exit", (code) => {
      exitCode = code;
      closeGraceTimer = setTimeout(() => {
        settle({ command, cwd, exit_code: code, timed_out: timedOut, stdout, stderr });
      }, 250);
    });
    child.on("close", (code) => {
      settle({ command, cwd, exit_code: code, timed_out: timedOut, stdout, stderr });
    });
  });
}

function signalProcessGroup(child: ReturnType<typeof spawn>, detached: boolean, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    if (detached) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may already be gone by the time cleanup runs.
  }
}

function cleanupProcessGroup(child: ReturnType<typeof spawn>, detached: boolean): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  signalProcessGroup(child, detached, "SIGTERM");
}

function resolveShellCwd(state: SessionState, cwd: string): string {
  if (isAbsolute(cwd)) {
    return resolve(cwd);
  }
  if (cwd === "artifacts" || cwd.startsWith("artifacts/")) {
    return resolve(join(state.sessionDir, cwd));
  }
  return resolve(state.workspaceRoot, cwd);
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR
  };
}

function capOutput(output: string, maxBytes: number): string {
  if (Buffer.byteLength(output) <= maxBytes) {
    return output;
  }
  return output.slice(0, maxBytes) + "\n[output truncated]\n";
}
