import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, loadSession, beginQuery, reserveBudget, finalizeReservation, releaseReservation,
  setSpendingHandler, approvePendingSpending, SpendingApprovalRequired, SpendingDeclined, remainingBudgetCents } from "../src/index.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function session() { const root = await mkdtemp(join(tmpdir(), "spending-")); roots.push(root); return createSession({ workspaceRoot: root }); }
const action = { description: "Test model quote", identity: "request:1" };

describe("per-call and per-query spending approvals", () => {
  it("uses $1/$10 defaults and gives every query a fresh allowance without resetting history", async () => {
    const s = await session(); await beginQuery(s, "first");
    expect(s.perCallCents).toBe(100); expect(s.query?.limitCents).toBe(1000);
    const r = await reserveBudget(s, 100, action); await finalizeReservation(s, r, 100);
    expect(remainingBudgetCents(s)).toBe(900);
    await beginQuery(s, "second"); expect(s.spentCents).toBe(100); expect(remainingBudgetCents(s)).toBe(1000);
  });
  it("persists a pending quote and consumes its approval once after restart", async () => {
    const s = await session(); await beginQuery(s, "first");
    await expect(reserveBudget(s, 150, action)).rejects.toBeInstanceOf(SpendingApprovalRequired);
    expect(s.reservedCents).toBe(0);
    const restored = await loadSession(s.workspaceRoot, s.sessionId);
    await approvePendingSpending(restored, { decision: "approve" });
    const r = await reserveBudget(restored, 150, action); await finalizeReservation(restored, r, 150);
    await expect(reserveBudget(restored, 150, action)).rejects.toBeInstanceOf(SpendingApprovalRequired);
  });
  it("preserves approval when an unrelated parallel call reserves first", async () => {
    const s = await session(); await beginQuery(s);
    await expect(reserveBudget(s, 150, action)).rejects.toBeInstanceOf(SpendingApprovalRequired);
    await approvePendingSpending(s, { decision: "approve" });
    const other = await reserveBudget(s, 1, { ...action, identity: "unrelated" });
    await finalizeReservation(s, other, 1);
    await expect(reserveBudget(s, 150, action)).resolves.toMatchObject({ amountCents: 150 });
  });
  it("requires a fresh approval for a higher quote", async () => {
    const s = await session(); await beginQuery(s);
    await expect(reserveBudget(s, 150, action)).rejects.toBeInstanceOf(SpendingApprovalRequired);
    await approvePendingSpending(s, { decision: "approve" });
    await expect(reserveBudget(s, 160, action)).rejects.toBeInstanceOf(SpendingApprovalRequired);
    expect(s.query?.pending?.amountCents).toBe(160);
  });
  it("counts concurrent holds and asks when they cross the query limit", async () => {
    const s = await session(); s.budgetCents = 100; await beginQuery(s);
    const results = await Promise.allSettled([reserveBudget(s, 60, action), reserveBudget(s, 60, { ...action, identity: "second" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(s.reservedCents).toBe(60); expect(s.query?.pending?.projectedCents).toBe(120);
  });
  it("raises only this query and still asks for individual calls above the call limit", async () => {
    const s = await session(); s.budgetCents = 100; await beginQuery(s);
    let prompts = 0;
    setSpendingHandler(s, async () => { prompts++; return { decision: "approve", queryBudgetCents: 500 }; });
    const first = await reserveBudget(s, 150, action); await finalizeReservation(s, first, 150);
    expect(s.budgetCents).toBe(100); expect(s.query?.limitCents).toBe(500);
    const second = await reserveBudget(s, 80, { ...action, identity: "2" }); await releaseReservation(s, second); expect(prompts).toBe(1);
    setSpendingHandler(s, undefined);
    await expect(reserveBudget(s, 101, { ...action, identity: "3" })).rejects.toBeInstanceOf(SpendingApprovalRequired);
  });
  it("declines before reserving and rejects a query increase that cannot cover the call", async () => {
    const s = await session(); await beginQuery(s);
    setSpendingHandler(s, async () => ({ decision: "decline" }));
    await expect(reserveBudget(s, 150, action)).rejects.toBeInstanceOf(SpendingDeclined);
    expect(s.spentCents).toBe(0); expect(s.reservedCents).toBe(0);
    setSpendingHandler(s, undefined);
    await expect(reserveBudget(s, 1500, action)).rejects.toBeInstanceOf(SpendingApprovalRequired);
    await expect(approvePendingSpending(s, { decision: "approve", queryBudgetCents: 1100 })).rejects.toThrow("cover");
  });
});
