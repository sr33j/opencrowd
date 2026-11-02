import { describe, expect, it } from "vitest";
import {
  MODEL_BRIDGE_TIMEOUT_MS, MODEL_GATEWAY_RETRY_BUDGET_MS, MODEL_GATEWAY_TIMEOUT_MS, MODEL_PROVIDER_MAX_TIMEOUT_MS,
  MODEL_PROVIDER_TIMEOUT_MS, MODEL_QUOTE_MAX_TIMEOUT_MS, MODEL_QUOTE_TIMEOUT_MS, MODEL_SELLER_REQUEST_MAX_BYTES,
  modelProviderTimeoutMs, modelQuoteTimeoutMs,
} from "../src/index.js";

describe("model call deadlines sized from the request (SRI-58)", () => {
  it("keeps the old floor for an ordinary turn", () => {
    expect(modelProviderTimeoutMs({ requestBytes: 40_000, maxOutputTokens: 1024 })).toBe(MODEL_PROVIDER_TIMEOUT_MS);
    expect(modelQuoteTimeoutMs(40_000)).toBe(MODEL_QUOTE_TIMEOUT_MS + 381);
  });

  it("gives a long-context turn that asks for a long answer more time, up to a ceiling", () => {
    const long = modelProviderTimeoutMs({ requestBytes: 2 * 1024 * 1024, maxOutputTokens: 4096 });
    expect(long).toBeGreaterThan(MODEL_PROVIDER_TIMEOUT_MS);
    expect(long).toBe(60_000 + 120_000 + 4096 * 40);
    expect(modelProviderTimeoutMs({ requestBytes: MODEL_SELLER_REQUEST_MAX_BYTES, maxOutputTokens: 32_000 })).toBe(MODEL_PROVIDER_MAX_TIMEOUT_MS);
    expect(modelQuoteTimeoutMs(MODEL_SELLER_REQUEST_MAX_BYTES)).toBeLessThanOrEqual(MODEL_QUOTE_MAX_TIMEOUT_MS);
    // Nonsense input never shortens a call below the floor.
    expect(modelProviderTimeoutMs({ requestBytes: Number.NaN, maxOutputTokens: -5 })).toBe(MODEL_PROVIDER_TIMEOUT_MS);
  });

  it("sizes every outer hop to outlast the longest call it carries", () => {
    expect(MODEL_GATEWAY_TIMEOUT_MS).toBeGreaterThan(MODEL_QUOTE_MAX_TIMEOUT_MS + MODEL_PROVIDER_MAX_TIMEOUT_MS + 60_000);
    // One cancelled call draining, then this call waiting out a gateway restart and running in full.
    expect(MODEL_BRIDGE_TIMEOUT_MS).toBeGreaterThan(2 * MODEL_GATEWAY_TIMEOUT_MS + MODEL_GATEWAY_RETRY_BUDGET_MS);
  });
});
