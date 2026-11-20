import { describe, expect, it } from "vitest";
import { routeTemplate } from "../src/route.js";

/**
 * The exact collect URLs of the six BlockRun clips in SRI-135 (job ids cut to
 * their first 60 characters; the rule reads the segment's shape, and the
 * real ids are 1,580 characters of the same alphabet).
 */
const BLOCKRUN_COLLECTS = [
  "https://blockrun.ai/api/v1/videos/generations/v1_iKAoQPb2qLgY324q5iQGvatY6grOPvcyPgNiDe9pMj9C0q5B0RUP7H_G4jIhr",
  "https://blockrun.ai/api/v1/videos/generations/v1_0-M8TPPXjxbpzKxNL_8CoNJIo4d42XeRfYPySzbHYrY6V-nf5I5M2fHo_6Nlh",
  "https://blockrun.ai/api/v1/videos/generations/v1_MJL_ZSrADfAwmMyFvKHyUevcFy2-uOAdVmkIs2XjTpy3FU-mwY-Z0vHPgB4fN",
  "https://blockrun.ai/api/v1/videos/generations/v1_CI42ApEHJrtQuF3UBbfN79qmZlqLHPA4kWFq9Rm5nTTrQ5TXx0-k5z-UfH-OC",
  "https://blockrun.ai/api/v1/videos/generations/v1_qbK0IS_hRaF5-EJr8aXtvPF_RSuaPih0BIR5JhPIulvdPrAYwohyioQD6rPG2",
  "https://blockrun.ai/api/v1/videos/generations/v1_KH2IOHaD9jVQD5uVhJGa8Y6sPNCnPQIFFZiNqi0T8qe9j131PkZVXAEzW5cEr"
];

describe("route templates (SRI-135)", () => {
  it("files every BlockRun clip's collect URL under one route", () => {
    expect(new Set(BLOCKRUN_COLLECTS.map(routeTemplate))).toEqual(new Set(["https://blockrun.ai/api/v1/videos/generations/{id}"]));
    expect(routeTemplate(`${BLOCKRUN_COLLECTS[0]}?model=xai%2Fgrok-imagine-video&sig=abc`)).toBe("https://blockrun.ai/api/v1/videos/generations/{id}");
    expect(routeTemplate("https://blockrun.ai/api/v1/videos/generations")).toBe("https://blockrun.ai/api/v1/videos/generations");
  });

  it("templates ids, addresses and timestamps, never route words or a marketplace's service slugs", () => {
    expect(routeTemplate("https://a.example/jobs/0b7e3f0c-5a8d-4c1e-9f2b-7d6a5c4b3a21/result")).toBe("https://a.example/jobs/{id}/result");
    expect(routeTemplate("https://api.onesource.io/api/chain/contract/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606EB48")).toBe("https://api.onesource.io/api/chain/contract/{id}");
    expect(routeTemplate("https://astro.dutchdata.io/api/full_chart/dt/1779285600000")).toBe("https://astro.dutchdata.io/api/full_chart/dt/{id}");
    for (const kept of [
      "https://payanagent.com/x402/kh71792ee7x7w59dtrgbq7zz898an9cn",
      "https://api.useatelier.ai/api/x402/pay/svc_1780812536114_y6pg8e7aw",
      "https://x402helper.xyz/c8239c/api/v1/x402/x402-payment-header-shape",
      "https://api.example/v1/models/claude-3-5-sonnet-20241022",
      "https://api.twitter.com/2/tweets",
      "https://stationfx.com/economic-data/interest-rates/market-yield-on-u-s-treasury-securities-at-10-year-constant-maturity-quoted-on-an-investment-basis",
      "https://api.example/getTokenPriceByAddressV2"
    ]) expect(routeTemplate(kept)).toBe(kept);
  });
});
