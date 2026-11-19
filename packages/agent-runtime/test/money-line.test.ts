import { expect, it } from "vitest";
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
