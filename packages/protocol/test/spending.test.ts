import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_PER_CALL_ATOMIC, DEFAULT_PER_QUERY_ATOMIC, spendingDecision } from "../src/index.js";

/**
 * spendingDecision is the per-call and per-query check that the hosted gateway
 * and the local wallet runtime share. Amounts are USDC atomic units (6
 * decimals) as integer strings, so it must be exact over the whole range.
 */
const MAX = 2n ** 256n - 1n;
const atomic = fc.oneof(
  fc.constantFrom(0n, 1n, 999_999n, 1_000_000n, 1_000_001n, 10_000_000n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, MAX),
  fc.bigInt({ min: 0n, max: 20_000_000n }),
  fc.bigInt({ min: 0n, max: MAX })
);
const decide = (amount: bigint, perCall: bigint, queryLimit: bigint, queryCommitted: bigint) =>
  spendingDecision({ amount: String(amount), perCall: String(perCall), queryLimit: String(queryLimit), queryCommitted: String(queryCommitted) });

describe("examples (regression seeds)", () => {
  it("allows a call at exactly the per-call and per-query limits, and asks one atomic unit above", () => {
    expect(decide(1_000_000n, 1_000_000n, 10_000_000n, 9_000_000n)).toEqual({ approvalRequired: false, reasons: [], projected: "10000000" });
    expect(decide(1_000_001n, 1_000_000n, 10_000_000n, 0n).reasons).toEqual(["per_call"]);
    expect(decide(1n, 1_000_000n, 10_000_000n, 10_000_000n).reasons).toEqual(["per_query"]);
    expect(decide(2_000_000n, 1_000_000n, 1_000_000n, 0n).reasons).toEqual(["per_call", "per_query"]);
  });

  it("defaults to $1 a call and $10 a query", () => {
    expect([DEFAULT_PER_CALL_ATOMIC, DEFAULT_PER_QUERY_ATOMIC]).toEqual(["1000000", "10000000"]);
  });
});

describe("properties", () => {
  it("asks exactly when a call is over the per-call limit or would take the query over its limit, at any size", () => {
    // Limits are often exactly at, one under or one over the call, where off-by-one bugs live.
    const near = (target: bigint) => fc.oneof(atomic, fc.constantFrom(-1n, 0n, 1n).map(d => target + d).filter(n => n >= 0n));
    const cases = fc.tuple(atomic, atomic).chain(([amount, committed]) =>
      fc.tuple(fc.constant(amount), near(amount), near(committed + amount), fc.constant(committed)));
    fc.assert(fc.property(cases, ([amount, perCall, limit, committed]) => {
      const decision = decide(amount, perCall, limit, committed);
      const reasons = [...(amount > perCall ? ["per_call"] : []), ...(committed + amount > limit ? ["per_query"] : [])];
      expect(decision.reasons).toEqual(reasons);
      expect(decision.approvalRequired).toBe(reasons.length > 0);
      // No float anywhere: the projection is exact past 2^53 and past 2^256.
      expect(BigInt(decision.projected)).toBe(committed + amount);
    }), { numRuns: 300 });
  });

  it("never lets a query's cumulative spend pass its limit, or one call pass the per-call limit, for any sequence of calls", () => {
    fc.assert(fc.property(atomic, atomic, fc.array(atomic, { maxLength: 40 }), (perCall, limit, calls) => {
      let committed = 0n;
      for (const amount of calls) {
        const decision = decide(amount, perCall, limit, committed);
        if (decision.approvalRequired) continue; // stopped for the owner, nothing spent
        expect(amount <= perCall).toBe(true);
        committed = BigInt(decision.projected);
        expect(committed <= limit).toBe(true);
      }
    }), { numRuns: 300 });
  });

  it("refuses a negative amount, limit or commitment, and anything that is not an integer", () => {
    const negative = fc.bigInt({ min: -MAX, max: -1n });
    fc.assert(fc.property(fc.nat({ max: 3 }), negative, atomic, (slot, bad, good) => {
      const args = [good, good, good, good];
      args[slot] = bad;
      expect(() => decide(args[0], args[1], args[2], args[3])).toThrow();
    }));
    const notInteger = fc.oneof(fc.constantFrom("1.5", "0.000001", "1e6", "abc", "1_000", "Infinity"), fc.double({ noInteger: true }).map(String));
    fc.assert(fc.property(notInteger, amount => {
      expect(() => spendingDecision({ amount, perCall: "1000000", queryLimit: "10000000", queryCommitted: "0" })).toThrow();
    }));
  });
});
