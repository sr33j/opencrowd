import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BudgetStatus, PermissionMode, SessionOptions, SessionState } from "./types.js";
import { ensureLedger } from "./ledger.js";

const STATE_FILE = "session.json";

export async function createSession(options: SessionOptions = {}): Promise<SessionState> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const sessionId = options.sessionId ?? new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const sessionDir = join(workspaceRoot, "sessions", sessionId);
  const artifactsDir = join(sessionDir, "artifacts");
  const ledgerPath = join(sessionDir, "ledger.csv");
  const now = new Date().toISOString();
  const state: SessionState = {
    sessionId,
    workspaceRoot,
    sessionDir,
    artifactsDir,
    ledgerPath,
    budgetCents: options.budgetCents ?? 0,
    reservedCents: 0,
    spentCents: 0,
    permissionMode: options.permissionMode ?? "ask_first",
    shellEnabled: options.shellEnabled ?? false,
    createdAt: now,
    updatedAt: now
  };

  await mkdir(artifactsDir, { recursive: true });
  await ensureLedger(ledgerPath);
  await saveSession(state);
  return state;
}

export async function loadSession(workspaceRoot: string, sessionId: string): Promise<SessionState> {
  const sessionDir = join(resolve(workspaceRoot), "sessions", sessionId);
  const text = await readFile(join(sessionDir, STATE_FILE), "utf8");
  return JSON.parse(text) as SessionState;
}

export async function saveSession(state: SessionState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await mkdir(state.sessionDir, { recursive: true });
  await writeFile(join(state.sessionDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function budgetStatus(state: SessionState): BudgetStatus {
  return {
    session_id: state.sessionId,
    budget_cents: state.budgetCents,
    spent_cents: state.spentCents,
    reserved_cents: state.reservedCents,
    remaining_cents: Math.max(0, state.budgetCents - state.spentCents - state.reservedCents),
    permission_mode: state.permissionMode
  };
}

export async function setSessionBudget(state: SessionState, budgetCents: number): Promise<SessionState> {
  if (!Number.isInteger(budgetCents) || budgetCents < 0) {
    throw new Error("budget must be a non-negative integer number of cents");
  }
  state.budgetCents = budgetCents;
  await saveSession(state);
  return state;
}

export async function setPermissionMode(state: SessionState, mode: PermissionMode): Promise<SessionState> {
  state.permissionMode = mode;
  await saveSession(state);
  return state;
}
