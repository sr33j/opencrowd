import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentedHeader, findFollowUpTokens, matchesTemplate } from "../src/follow-ups.js";

// Drip's own operation, trimmed from https://dripstack.com/openapi.json (2026-11-04).
const DRIP = JSON.parse(readFileSync(join(__dirname, "fixtures", "drip-openapi.json"), "utf8"));
const POST = "https://dripstack.com/api/v2/x402/sources/quoththeraven.substack.com/a-potentially-mispriced-microcap";

describe("follow-up credentials (SRI-88)", () => {
  it("finds the token Drip nests in paymentInfo, which the agent could not find", () => {
    const body = { title: "A Potentially Mispriced Microcap", synthesizedSummary: "…", transcript: null,
      paymentInfo: { amountUsd: "0.7", protocol: "x402", settledAt: "2026-11-04T18:12:43.180Z", unlockToken: "eyJ0.abc" } };
    expect(findFollowUpTokens(body)).toEqual([{ field: "paymentInfo.unlockToken", value: "eyJ0.abc" }]);
    expect(findFollowUpTokens({ access_token: "t", nested: { deeper: { reread_token: "r" } } }).map((t) => t.field))
      .toEqual(["access_token", "nested.deeper.reread_token"]);
    expect(findFollowUpTokens({ token: "not named for a follow-up", unlockToken: 5 })).toEqual([]);
  });

  it("takes the header name from the seller's OpenAPI for that operation", () => {
    expect(matchesTemplate("/api/v2/x402/sources/{sourceSlug}/{postSlug}", new URL(POST).pathname)).toBe(true);
    expect(matchesTemplate("/api/v2/x402/sources/{sourceSlug}/{postSlug}", "/api/v2/x402/sources/a")).toBe(false);
    expect(documentedHeader(DRIP, POST, "GET", "paymentInfo.unlockToken")).toBe("X-Drip-Unlock");
    // Another operation documents no such header, and payment headers are never reused.
    expect(documentedHeader(DRIP, "https://dripstack.com/api/v2/x402/search?q=ai", "GET", "unlockToken")).toBeUndefined();
    const paying = { paths: { "/x": { get: { parameters: [{ name: "PAYMENT-SIGNATURE", in: "header", description: "unlockToken goes here" }] } } } };
    expect(documentedHeader(paying, "https://a.test/x", "GET", "unlockToken")).toBeUndefined();
  });
});
