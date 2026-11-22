import { describe, expect, it } from "vitest";
import { quotedPrices } from "../src/offers.js";


describe("what an owner is told a service costs (SRI-163)", () => {
  it("is the cheapest payable offer, and the most one can charge when that is more", () => {
    expect(quotedPrices([{ price_usd: 1, payable: true }, { price_usd: 5, payable: true }, { price_usd: 100, payable: true }])).toEqual({ from_usd: 1, max_usd: 100 });
    expect(quotedPrices([{ price_usd: 0.1, payable: true }])).toEqual({ from_usd: 0.1 });
    // An offer this payer cannot use is not a price it can quote.
    expect(quotedPrices([{ price_usd: 0.01, payable: false }, { price_usd: 0.2, payable: true }])).toEqual({ from_usd: 0.2 });
    expect(quotedPrices([])).toEqual({});
  });
});
