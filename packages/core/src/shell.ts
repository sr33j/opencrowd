import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { appendLedgerEntry } from "./ledger.js";
import { localSandboxSettings, sandboxCommand, sandboxUnavailable, type SandboxedCommand } from "./local-sandbox.js";
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
  // The local CLI's sandbox (local-sandbox.ts). A hosted executor's own
  // sandbox program takes precedence: it already confines.
  let confined: SandboxedCommand | undefined, sandboxNote: string;
  if (shellSandbox()) sandboxNote = "host";
  else {
    const settings = localSandboxSettings();
    const unavailable = await sandboxUnavailable(settings);
    if (unavailable && settings.network.mode !== "open")
      throw new Error(`The shell network is restricted (OPENCROWD_SHELL_NETWORK) but the sandbox that enforces it cannot run: ${unavailable}. The command was not run.`);
    if (unavailable) sandboxNote = `unavailable: ${unavailable}`;
    else {
      confined = await sandboxCommand({ command, cwd: resolvedCwd, workspaceRoot: root, env: options.env ?? minimalEnv(), settings,
        readOnly: [...SESSION_BOOKS.map((name) => join(state.sessionDir, name)), ...GIT_EXECUTABLES.map((name) => join(root, ".git", name))] });
      sandboxNote = `${confined.program === "bwrap" ? "bubblewrap" : "sandbox-exec"}, network ${settings.network.mode}`;
    }
  }
  let result: ShellResult;
  try {
    result = await execute(command, resolvedCwd, timeoutMs, options.outputCapBytes ?? 64_000, options.env, options.signal, confined);
  } finally {
    await confined?.close();
  }
  await appendLedgerEntry(state.ledgerPath, {
    session_id: state.sessionId,
    type: "shell",
    status: result.exit_code === 0 ? "ok" : "failed",
    approval_mode: state.approvalMode,
    notes: JSON.stringify({ command, cwd: resolvedCwd, exit_code: result.exit_code, timed_out: result.timed_out, sandbox: sandboxNote })
  });
  return result;
}

/** What a sandboxed command may read but not change: its session's budget, ledger and conversation. */
const SESSION_BOOKS = ["session.json", "ledger.csv", "messages.jsonl", "query-checkpoint.json"];
/**
 * What git runs later, outside any sandbox: hooks, and a config that can name
 * a program (`core.fsmonitor`, `core.hooksPath`, an alias). A command may
 * commit and branch; it may not plant something the owner's next `git status` runs.
 */
const GIT_EXECUTABLES = ["hooks", "config"];

function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputCapBytes: number,
  env: NodeJS.ProcessEnv = minimalEnv(),
  signal?: AbortSignal,
  confined?: SandboxedCommand
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
    const sandbox = shellSandbox();
    // A host that runs the model's commands as another user names the program
    // that switches to it. It receives an absolute program and its arguments,
    // never a shell string, and the environment travels as `env -i` arguments
    // because a setuid program's loader drops some variables (TMPDIR among
    // them) on the way in.
    const child = confined
      ? spawn(confined.program, confined.args, { cwd, env: confined.env, detached, stdio: ["ignore", "pipe", "pipe"] })
      : sandbox
      ? spawn(sandbox, ["/usr/bin/env", "-i", ...environmentArguments(env), "/bin/sh", "-c", command], {
        cwd,
        env: {},
        detached,
        stdio: ["ignore", "pipe", "pipe"]
      })
      : spawn(command, {
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

/**
 * The program a host runs every shell command through, when it has one.
 *
 * A hosted CrowdCode executor sets this to a setuid helper that runs the
 * command as a separate, unprivileged user in its own PID namespace, so a
 * command the model wrote cannot reach the supervisor's tokens, its Unix
 * socket or the worker's state, all of which belong to the user this process
 * runs as. Nothing else changes: the command, its working directory, its
 * timeout and its output are the same. It is read from this process's own
 * environment and never passed on to the command.
 */
export function shellSandbox(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const program = env.OPENCROWD_SHELL_SANDBOX;
  if (!program) return undefined;
  if (!isAbsolute(program)) throw new Error("OPENCROWD_SHELL_SANDBOX must be an absolute path");
  return program;
}

function environmentArguments(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]))
    .map(([key, value]) => `${key}=${value}`);
}

/**
 * The shell gets a deliberately small environment, so nothing the host holds
 * leaks into a command the model wrote. `OPENCROWD_SCRATCH_DIR` is here
 * because the hosted heavy tier puts `$HOME` and `$TMPDIR` on a temporary
 * disk, and an agent has to be able to tell whether it has one: its absence is
 * the difference between a 1 GB volume and room for a toolchain.
 */
function minimalEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    ...(process.env.OPENCROWD_SCRATCH_DIR
      ? { OPENCROWD_SCRATCH_DIR: process.env.OPENCROWD_SCRATCH_DIR }
      : {}),
    ...packageManagerEnv()
  };
}

/**
 * Where package managers install and cache, when the host says. These are
 * paths, never credentials. A hosted agent's volume is 1 GB: on 2026-11-23 an
 * agent's `npm install -g` of a 600 MB package, with npm's cache on the same
 * volume beside the copy it was replacing, filled it, and the run hung for ten
 * hours. The host now puts the global prefix where its `bin` is on PATH and
 * the caches off the volume.
 */
export const PACKAGE_MANAGER_ENV = ["NPM_CONFIG_PREFIX", "NPM_CONFIG_CACHE", "PIP_CACHE_DIR"] as const;
function packageManagerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(PACKAGE_MANAGER_ENV.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function capOutput(output: string, maxBytes: number): string {
  if (Buffer.byteLength(output) <= maxBytes) {
    return output;
  }
  return output.slice(0, maxBytes) + "\n[output truncated]\n";
}
