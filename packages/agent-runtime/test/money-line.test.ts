import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { FinancialStateSchema, type FinancialState } from "@opencrowd/protocol";
import { moneyLine, newMoneyTrack, tierOf, trackModelCall, usd } from "../src/money-line.js";

const state = (runway?: object): FinancialState => FinancialStateSchema.parse({
  status: "available", run_id: randomUUID(), currency: "USDC", observed_at: new Date().toISOString(),
  wallet: { balance_status: "available", balance_usdc: "0.840000", reserved_usdc: "0.000000", available_usdc: "0.840000",
    networks: [{ network: "base", balance_status: "available", balance_usdc: "0.500000", available_usdc: "0.500000" },
      { network: "solana", balance_status: "available", balance_usdc: "0.340000", available_usdc: "0.340000" },
      { network: "tempo", balance_status: "available", balance_usdc: "0.000000", available_usdc: "0.000000" }] },
  current_run: { inference_spent_usdc: "0.142000", service_spent_usdc: "0.000000", total_spent_usdc: "0.142000", reserved_usdc: "0.000000",
    budget_limit_usdc: "0.982000", remaining_budget_usdc: "0.840000", per_call_approval_threshold_usdc: "0.100000", approval_mode: "auto" },
  ...(runway ? { runway } : {}),
});

it("leads with calls left and the tier, and names the next call's cost, not a per-call cost", () => {
  const track = newMoneyTrack();
  for (let i = 0; i < 9; i++) trackModelCall(track, 0, 0.0158);
  expect(moneyLine(state({ model: "openai/gpt-5.6-luna", next_call_usdc: "0.016000", per_call_usdc: "0.015800", calls_left: 52, low: false, tier: "HIGH" }), track))
    .toBe("Money: ≈52 calls left (HIGH) · wallet $0.8400 free (base $0.5000, solana $0.3400) · this run spent $0.1420 over 9 model calls · next call ≈$0.0160 on openai/gpt-5.6-luna · paid calls above $0.1000 need approval.");
});

it("gives the one action at LOW and CRITICAL", () => {
  const line = moneyLine(state({ model: "m", next_call_usdc: "0.016000", per_call_usdc: "0.015800", calls_left: 3, low: true, tier: "CRITICAL", action: "wrap up" }));
  expect(line!.startsWith("Money: ≈3 calls left (CRITICAL: wrap up) · ")).toBe(true);
  expect(line).not.toContain("per call");
  expect(tierOf(60)).toEqual({ tier: "HIGH" });
  expect(tierOf(20)).toEqual({ tier: "MEDIUM" });
  expect(tierOf(8)).toEqual({ tier: "LOW", action: "verify before branching" });
  expect(tierOf(4)).toEqual({ tier: "CRITICAL", action: "wrap up" });
});

it("counts calls left at the newest call's cost when control sends no runway", () => {
  const track = newMoneyTrack();
  trackModelCall(track, 0.1, 0.11);
  trackModelCall(track, 0.11, 0.13);
  expect(moneyLine(state(), track)).toContain("Money: ≈42 calls left (HIGH) · ");
  expect(moneyLine(state(), track)).toContain("last call $0.0200");
});

it("shows nothing at all when the operator turned the line off", () => {
  expect(moneyLine(state({ model: "m", next_call_usdc: "0.001000", per_call_usdc: "0.001000", calls_left: 5, low: false, money_line: false }))).toBeUndefined();
});

it("never turns an unknown balance into zero", () => {
  expect(moneyLine({ status: "unavailable", reason: "control offline" })).toBe("Money: unknown right now (control offline). Don't assume a balance of zero.");
});

it("ignores a runway an older control never sent, and one a newer control adds fields to", () => {
  expect(FinancialStateSchema.safeParse({ ...state(), runway: { model: "m", next_call_usdc: "0.001000", per_call_usdc: "0.001000", calls_left: 5, low: false, future: 1 } }).success).toBe(true);
});

it("reads small amounts in enough places to mean something", () => {
  expect(usd(0.00014)).toBe("$0.000140");
  expect(usd(0.0158)).toBe("$0.0158");
  expect(usd(12.5)).toBe("$12.50");
});

// Properties (SRI-175). The examples above are the regression seeds.

/** A 6-decimal USDC string, as control sends amounts ("0.840000"). */
const decimal = (atomic: bigint) => `${atomic / 1_000_000n}.${String(atomic % 1_000_000n).padStart(6, "0")}`;
/** What usd() displays, in atomic units, and how many decimals it showed. */
function shown(text: string): { atomic: bigint; places: number } {
  const match = /^\$(-?)(\d+)\.(\d+)$/.exec(text);
  expect(match, text).not.toBeNull();
  const [, sign, whole, fraction] = match!;
  const atomic = BigInt(whole + fraction) * 10n ** BigInt(6 - fraction.length);
  return { atomic: sign ? -atomic : atomic, places: fraction.length };
}
const MAX_ATOMIC = 2n ** 256n - 1n;
const atomic = (max: bigint) => fc.oneof(
  fc.constantFrom(0n, 1n, 9n, 999n, 1_000n, 1_001n, 49n, 50n, 99_999n, 9_999_999n, 10_000_000n, 2n ** 53n - 1n, 2n ** 53n, MAX_ATOMIC).filter(n => n <= max),
  fc.bigInt({ min: 0n, max: 10_000n }), fc.bigInt({ min: 0n, max: 100_000_000n }), fc.bigInt({ min: 0n, max })
);

describe("properties: usd()", () => {
  // T5 found: usd() goes through a float, so past about $10^10 it cannot hold all six decimals and
  // can round the wrong way at a half-cent boundary (counterexample 4511256557316994629n atomic shown
  // as "$4511256557317.00", seed -2033646949; 50684516164607930368n, seed 505737973), and from $10^21
  // it prints "$1e+21" (999999999999999934464000000n, seed -1934213392). Kept to $10^9 (10^15
  // atomic): no wallet holds more, and USDC's whole supply is under 2^57 atomic units.
  const realistic = atomic(10n ** 15n);

  it("shows any amount to within half of its last shown place, from the number or the 6-decimal string", () => {
    fc.assert(fc.property(realistic, fc.boolean(), (value, negative) => {
      const signed = negative ? -value : value;
      const text = usd(Number(signed) / 1e6);
      expect(usd(`${negative ? "-" : ""}${decimal(value)}`)).toBe(text);
      const { atomic: displayed, places } = shown(text);
      const unit = 10n ** BigInt(6 - places);
      const error = displayed > signed ? displayed - signed : signed - displayed;
      expect(error * 2n <= unit, `${decimal(value)} shown as ${text}`).toBe(true);
    }), { numRuns: 300 });
  });

  it("never shows a nonzero amount as zero, or with the wrong sign", () => {
    fc.assert(fc.property(realistic.filter(n => n > 0n), fc.boolean(), (value, negative) => {
      const { atomic: displayed } = shown(usd(`${negative ? "-" : ""}${decimal(value)}`));
      expect(displayed).not.toBe(0n);
      expect(displayed < 0n).toBe(negative);
    }), { numRuns: 300 });
  });

  it("round-trips every amount under a tenth of a cent exactly, at USDC's 6 decimals", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 999n }), value => {
      expect(shown(usd(decimal(value))).atomic).toBe(value);
      expect(shown(usd(Number(value) / 1e6)).atomic).toBe(value);
    }));
  });

  it("says $? for anything that is not a number, never $0", () => {
    fc.assert(fc.property(fc.oneof(fc.constantFrom("abc", "0x", "1,5", "NaN", "Infinity", "-Infinity", "$1", "1.2.3"), fc.string().filter(t => !Number.isFinite(Number(t)))), text => {
      expect(usd(text)).toBe("$?");
    }));
  });
});

describe("properties: the money line", () => {
  const amount = atomic(10n ** 12n).map(decimal);
  const network = fc.record({ network: fc.constantFrom("base", "solana", "tempo"), balance_status: fc.constant("available" as const), balance_usdc: amount, available_usdc: amount });
  const financial = fc.record({
    available: fc.option(amount, { nil: null }), walletReserved: amount, runReserved: amount, spent: amount,
    networks: fc.array(network, { maxLength: 3 }), approval: fc.constantFrom("auto", "ask", "off"), threshold: amount,
  }).map(f => FinancialStateSchema.parse({
    status: "available", run_id: randomUUID(), currency: "USDC", observed_at: new Date().toISOString(),
    wallet: { balance_status: "available", balance_usdc: f.available, reserved_usdc: f.walletReserved, available_usdc: f.available, networks: f.networks },
    current_run: { inference_spent_usdc: f.spent, service_spent_usdc: "0.000000", total_spent_usdc: f.spent, reserved_usdc: f.runReserved,
      budget_limit_usdc: "1.000000", remaining_budget_usdc: "1.000000", per_call_approval_threshold_usdc: f.threshold, approval_mode: f.approval },
  }));

  it("states the wallet, the run's spend and any money held exactly as usd() shows them, and never drops a nonzero one", () => {
    fc.assert(fc.property(financial, state => {
      if (state.status !== "available") return;
      const line = moneyLine(state)!;
      if (state.wallet.available_usdc === null) expect(line).toContain("wallet balance unavailable");
      else expect(line).toContain(`wallet ${usd(state.wallet.available_usdc)} free`);
      expect(line).toContain(`this run spent ${usd(state.current_run.total_spent_usdc)}`);
      // Money held for a payment in flight, by the run or anywhere in the wallet, is never left out (SRI-96).
      const held = [state.current_run.reserved_usdc, state.wallet.reserved_usdc].map(v => BigInt(v.replace(".", ""))).reduce((a, b) => (a > b ? a : b));
      if (held > 0n) expect(line).toContain(`${usd(decimal(held))} held for payments in flight`);
      else expect(line).not.toContain("held");
    }), { numRuns: 200 });
  });

  it("never counts more calls left than the wallet covers at the newest call's price", () => {
    fc.assert(fc.property(financial, fc.array(fc.tuple(atomic(10n ** 9n), atomic(10n ** 8n)), { minLength: 1, maxLength: 8 }), (state, calls) => {
      if (state.status !== "available") return;
      const track = newMoneyTrack();
      for (const [before, cost] of calls) trackModelCall(track, Number(before) / 1e6, Number(before + cost) / 1e6);
      expect(track.calls).toBe(calls.length);
      const last = track.recent.at(-1)!;
      const match = /≈(\d+)(\+?) calls left/.exec(moneyLine(state, track)!);
      if (!last || state.wallet.available_usdc === null) { expect(match).toBeNull(); return; }
      const left = Number(match![1]), wallet = Number(state.wallet.available_usdc);
      // Within the 1e-6 the code allows for float noise in the division.
      expect(left * last).toBeLessThanOrEqual(wallet + last * 1e-6 + 1e-9);
      if (left < 999) expect((left + 1) * last).toBeGreaterThan(wallet);
      else expect(match![2]).toBe("+");
      expect(moneyLine(state, track)).toContain(`(${tierOf(left).tier}`);
    }), { numRuns: 200 });
  });
});
