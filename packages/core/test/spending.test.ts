import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, loadSession, beginQuery, reserveBudget, finalizeReservation, releaseReservation,
  setSpendingHandler, approvePendingSpending, SpendingApprovalRequired, SpendingDeclined, remainingBudgetCents, BudgetExhaustedError,
  type SessionState } from "../src/index.js";
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

// Properties (SRI-175). The examples above are the regression seeds.
//
// Amounts: reservations are whole cents (config ceilings); charges are real
// spend in USDC atomic units (1 cent = 10,000 atomic), so a charge here is
// generated as an integer number of atomic units and passed as cents.
describe("properties: the session budget", () => {
  const ATOMIC_PER_CENT = 10_000;
  // Every budget change is saved with fsync; memory-backed /dev/shm (Linux, CI) keeps 100s of them fast.
  const scratch = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const toAtomic = (cents: number) => Math.round(cents * ATOMIC_PER_CENT);
  /** A charge in atomic units: often sub-cent, as a cheap model call is. */
  const chargeAtomic = fc.oneof(fc.constantFrom(0, 1, 9_999, 10_000, 10_001, 1_000, 3_000), fc.nat({ max: 20_000 }), fc.nat({ max: 5_000_000 }));
  /** One step: reserve some cents, then charge (at most the hold, or any amount for upto billing) or release. */
  const step = fc.record({
    cents: fc.oneof(fc.constantFrom(0, 1, 50, 100, 101), fc.nat({ max: 600 })),
    settle: fc.oneof(fc.record({ kind: fc.constant("charge" as const), atomic: chargeAtomic }), fc.constant({ kind: "release" as const })),
    parallel: fc.boolean(),
  });

  it("records spend as the exact sum of the charges, for any sequence of sub-cent charges", async () => {
    const root = await mkdtemp(join(scratch, "spending-sum-")); roots.push(root);
    await fc.assert(fc.asyncProperty(fc.array(chargeAtomic, { minLength: 1, maxLength: 10 }), async charges => {
      const s = await createSession({ workspaceRoot: root, budgetCents: 1e9 });
      let total = 0;
      for (const charge of charges) {
        const r = await reserveBudget(s, 1, action);
        await finalizeReservation(s, r, charge / ATOMIC_PER_CENT);
        total += charge;
        // Spend is held at atomic precision: no float drift, however many charges.
        expect(toAtomic(s.spentCents)).toBe(total);
        expect(s.spentCents).toBe(total / ATOMIC_PER_CENT);
      }
      expect(s.reservedCents).toBe(0);
      expect((await loadSession(root, s.sessionId)).spentCents).toBe(total / ATOMIC_PER_CENT);
    }), { numRuns: 25 });
  });

  it("never lets spend plus holds exceed the session budget when charges stay within their holds, and refuses only what does not fit", async () => {
    const root = await mkdtemp(join(scratch, "spending-cap-")); roots.push(root);
    await fc.assert(fc.asyncProperty(fc.nat({ max: 2_000 }), fc.array(step, { minLength: 1, maxLength: 8 }), async (budget, steps) => {
      const s = await createSession({ workspaceRoot: root, budgetCents: budget });
      const within = (state: SessionState) => toAtomic(state.spentCents) + toAtomic(state.reservedCents) <= toAtomic(state.budgetCents);
      for (let i = 0; i < steps.length; i++) {
        // Two calls at once (parallel subagents) go through the same lock.
        const batch = steps[i].parallel && steps[i + 1] ? [steps[i], steps[++i]] : [steps[i]];
        const remaining = remainingBudgetCents(s);
        const held = await Promise.allSettled(batch.map(b => reserveBudget(s, b.cents, action)));
        expect(within(s)).toBe(true);
        held.forEach((result, k) => {
          if (result.status === "rejected") {
            expect(result.reason).toBeInstanceOf(BudgetExhaustedError);
            // Refused only when it did not fit: alone, or after the other call in the batch.
            expect(batch[k].cents > remaining - (k === 1 && held[0].status === "fulfilled" ? batch[0].cents : 0)).toBe(true);
          }
        });
        for (const [k, result] of held.entries()) {
          if (result.status !== "fulfilled") continue;
          const settle = batch[k].settle;
          if (settle.kind === "release") await releaseReservation(s, result.value);
          else await finalizeReservation(s, result.value, Math.min(settle.atomic, result.value.amountCents * ATOMIC_PER_CENT) / ATOMIC_PER_CENT);
          expect(within(s)).toBe(true);
        }
      }
      expect(s.reservedCents).toBe(0);
    }), { numRuns: 25 });
  });

  it("never lets a query pass its limit, or one call pass the per-call limit, without the owner's approval", async () => {
    const root = await mkdtemp(join(scratch, "spending-query-")); roots.push(root);
    await fc.assert(fc.asyncProperty(fc.nat({ max: 300 }), fc.nat({ max: 2_000 }), fc.array(step, { minLength: 1, maxLength: 8 }), async (perCall, limit, steps) => {
      const s = await createSession({ workspaceRoot: root, budgetCents: limit, perCallCents: perCall });
      await beginQuery(s, "q");
      const querySpent = () => toAtomic(s.spentCents - s.query!.startSpentCents);
      for (const [i, { cents, settle }] of steps.entries()) {
        const committed = querySpent() + toAtomic(s.reservedCents);
        let reservation;
        try {
          reservation = await reserveBudget(s, cents, { ...action, identity: `call-${i}` });
        } catch (error) {
          expect(error).toBeInstanceOf(SpendingApprovalRequired);
          // It asks exactly when the call is over the per-call limit or would take the query over.
          expect(cents > perCall || committed + toAtomic(cents) > toAtomic(limit)).toBe(true);
          await expect(approvePendingSpending(s, { decision: "decline" })).rejects.toBeInstanceOf(SpendingDeclined);
          continue;
        }
        expect(cents <= perCall && committed + toAtomic(cents) <= toAtomic(limit)).toBe(true);
        if (settle.kind === "release") await releaseReservation(s, reservation);
        else await finalizeReservation(s, reservation, Math.min(settle.atomic, cents * ATOMIC_PER_CENT) / ATOMIC_PER_CENT);
        expect(querySpent() + toAtomic(s.reservedCents)).toBeLessThanOrEqual(toAtomic(limit));
      }
      expect(s.query?.pending).toBeUndefined();
    }), { numRuns: 25 });
  });
});
