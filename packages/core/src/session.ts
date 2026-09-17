import { DEFAULT_PER_CALL_ATOMIC, DEFAULT_PER_QUERY_ATOMIC } from "@opencrowd/protocol";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BudgetStatus, ApprovalMode, SessionOptions, SessionState } from "./types.js";
import { ensureLedger } from "./ledger.js";
import { assertPathId, atomicWrite, containedPath } from "./paths.js";

const STATE_FILE = "session.json";

export async function createSession(options: SessionOptions = {}): Promise<SessionState> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const sessionId = options.sessionId ?? new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  assertPathId(sessionId);
  const sessionDir = await containedPath(workspaceRoot, join("sessions", sessionId));
  const artifactsDir = join(sessionDir, "artifacts");
  const ledgerPath = join(sessionDir, "ledger.csv");
  const now = new Date().toISOString();
  const state: SessionState = {
    sessionId,
    workspaceRoot,
    sessionDir,
    artifactsDir,
    ledgerPath,
    budgetCents: options.budgetCents ?? Number(DEFAULT_PER_QUERY_ATOMIC) / 10000,
    perCallCents: options.perCallCents ?? Number(DEFAULT_PER_CALL_ATOMIC) / 10000,
    reservedCents: 0,
    spentCents: 0,
    approvalMode: options.approvalMode ?? "auto",
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
  assertPathId(sessionId);
  const sessionDir = await containedPath(workspaceRoot, join("sessions", sessionId));
  const text = await readFile(join(sessionDir, STATE_FILE), "utf8");
  const state = JSON.parse(text) as SessionState;
  if (state.sessionId !== sessionId) throw new Error("session identity mismatch");
  // Sessions from the former cumulative-budget framework receive the new defaults.
  if (state.perCallCents === undefined) {
    state.perCallCents = Number(DEFAULT_PER_CALL_ATOMIC) / 10000;
    state.budgetCents = Number(DEFAULT_PER_QUERY_ATOMIC) / 10000;
    if (state.approvalMode === "ask") state.approvalMode = "auto";
  }
  // A restored backup can live on a different mount; never trust saved absolute paths.
  return { ...state, workspaceRoot: resolve(workspaceRoot), sessionDir,
    artifactsDir: await containedPath(sessionDir, "artifacts"), ledgerPath: join(sessionDir, "ledger.csv") };
}

export async function saveSession(state: SessionState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await mkdir(state.sessionDir, { recursive: true });
  await atomicWrite(join(state.sessionDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export function budgetStatus(state: SessionState): BudgetStatus {
  return {
    session_id: state.sessionId,
    budget_cents: state.query?.limitCents ?? state.budgetCents,
    spent_cents: state.spentCents - (state.query?.startSpentCents ?? 0),
    reserved_cents: state.reservedCents,
    remaining_cents: Math.max(0, (state.query?.limitCents ?? state.budgetCents) - (state.spentCents - (state.query?.startSpentCents ?? 0)) - state.reservedCents),
    approval_mode: state.approvalMode
  };
}

export async function setSessionBudget(state: SessionState, budgetCents: number): Promise<SessionState> {
  if (!Number.isInteger(budgetCents) || budgetCents < 0) {
    throw new Error("budget must be a non-negative integer number of cents");
  }
  // The budget is a cumulative cap on value already consumed; it can never
  // drop below what the session has finalized as spent.
  if (budgetCents < state.spentCents - (state.query?.startSpentCents ?? 0) + state.reservedCents) {
    throw new Error(`budget cannot be set below already-spent ${state.spentCents} cents`);
  }
  if (state.query) state.query.limitCents = budgetCents;
  else state.budgetCents = budgetCents;
  await saveSession(state);
  return state;
}

export async function setApprovalMode(state: SessionState, mode: ApprovalMode): Promise<SessionState> {
  state.approvalMode = mode;
  await saveSession(state);
  return state;
}
