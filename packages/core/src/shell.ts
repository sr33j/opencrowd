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
  signal?: AbortSignal;
  maxTimeoutMs?: number;
  outputCapBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** Long enough for a video render or a large download. */
export const DEFAULT_MAX_SHELL_TIMEOUT_MS = 300_000;
/** No single command may hold the agent loop longer than this, whatever the host asks for. */
export const SHELL_TIMEOUT_CEILING_MS = 2_700_000;

/**
 * The longest a single shell command may run. Heavy toolchains (a Lean +
 * Mathlib build, a large compile) need far more than five minutes, and the
 * host that provisioned the machine knows how much time its CPU and memory
 * justify, so it raises this with OPENCROWD_MAX_SHELL_TIMEOUT_MS. The runtime
 * keeps heartbeating while a command runs; the ceiling keeps a hung command
 * from owning the run.
 */
export function maxShellTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(env.OPENCROWD_MAX_SHELL_TIMEOUT_MS);
  if (!Number.isInteger(requested) || requested <= DEFAULT_MAX_SHELL_TIMEOUT_MS) {
    return DEFAULT_MAX_SHELL_TIMEOUT_MS;
  }
  return Math.min(SHELL_TIMEOUT_CEILING_MS, requested);
}

export async function runShell(
  state: SessionState,
  command: string,
  cwd = state.sessionDir,
  timeoutMs = 10_000,
  options: ShellOptions = {}
): Promise<ShellResult> {
  if (!state.shellEnabled) {
    throw new Error("shell tool is disabled for this session");
  }
  options.signal?.throwIfAborted();
  const maxTimeout = options.maxTimeoutMs ?? maxShellTimeoutMs();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout) {
    throw new Error(`timeout_ms must be between 1 and ${maxTimeout}`);
  }
  const resolvedCwd = resolveShellCwd(state, cwd);
  const root = resolve(state.workspaceRoot);
  if (resolvedCwd !== root && !resolvedCwd.startsWith(`${root}/`)) {
    throw new Error("shell cwd must stay inside the workspace");
  }
  const result = await execute(command, resolvedCwd, timeoutMs, options.outputCapBytes ?? 64_000, options.env, options.signal);
  await appendLedgerEntry(state.ledgerPath, {
    session_id: state.sessionId,
    type: "shell",
    status: result.exit_code === 0 ? "ok" : "failed",
    approval_mode: state.approvalMode,
    notes: JSON.stringify({ command, cwd: resolvedCwd, exit_code: result.exit_code, timed_out: result.timed_out })
  });
  return result;
}

function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputCapBytes: number,
  env: NodeJS.ProcessEnv = minimalEnv(),
  signal?: AbortSignal
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
      signal?.removeEventListener("abort", abort);
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
    const abort = () => {
      signalProcessGroup(child, detached, "SIGKILL");
      settle({ command, cwd, exit_code: null, timed_out: false, stdout, stderr });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
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

/**
 * A relative cwd resolves inside the session directory, so `artifacts/<name>`
 * means the same file to the shell as it does to save_file, read_file and
 * list_files. Resolving it against the workspace root instead created a decoy
 * `<workspace>/artifacts` that no publisher ever looked at, and everything an
 * agent wrote there was lost without an error.
 */
function resolveShellCwd(state: SessionState, cwd: string): string {
  return isAbsolute(cwd) ? resolve(cwd) : resolve(join(state.sessionDir, cwd));
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
