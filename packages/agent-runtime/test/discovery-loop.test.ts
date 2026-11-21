import { describe, expect, it } from "vitest";
import { discoveryKey, emptyServiceLog, recordServiceResult, repeatedDiscovery, SEARCHES_BEFORE_DECIDING } from "../src/service-strategy.js";

/**
 * w107 phase 0. Run d20be67e (2026-11-20) called find_paid_service("image
 * generation") 9 times, browse_services("image.generate") 10 times and
 * inspected the same four endpoints four or five times each, in 54 turns, and
 * bought nothing.
 */
describe("discovery loops", () => {
  it("refuses the same search, tree read or inspection a third time, unasked and unpaid", () => {
    const log = emptyServiceLog();
    const ok = { ok: true, data: { services: [] } };
    for (let i = 0; i < 2; i++) {
      expect(repeatedDiscovery(log, "find_paid_service", { query: "Image  generation" })).toBeUndefined();
      recordServiceResult(log, "find_paid_service", { query: i ? "image generation" : "Image  generation" }, ok);
    }
    expect(repeatedDiscovery(log, "find_paid_service", { query: "image generation " })).toMatch(/Not run again.*2 times.*Nothing was paid/);
    // A different question is fine.
    expect(repeatedDiscovery(log, "find_paid_service", { query: "text to image" })).toBeUndefined();
    // Query-string variants of one endpoint are one inspection; a sample_body quote is not limited.
    recordServiceResult(log, "inspect_paid_service", { url: "https://a.example/atlas?lat=1", method: "GET" }, { ok: true, data: {} });
    recordServiceResult(log, "inspect_paid_service", { url: "https://a.example/atlas?lat=2", method: "GET" }, { ok: true, data: {} });
    expect(repeatedDiscovery(log, "inspect_paid_service", { url: "https://a.example/atlas?lat=3", method: "GET" })).toBeDefined();
    expect(discoveryKey("inspect_paid_service", { url: "https://a.example/atlas", sample_body: { q: 1 } })).toBeUndefined();
    // A failed call is not counted.
    recordServiceResult(log, "browse_services", { node: "image" }, { ok: false });
    recordServiceResult(log, "browse_services", { node: "image" }, { ok: false });
    expect(repeatedDiscovery(log, "browse_services", { node: "image" })).toBeUndefined();
  });

  it("asks the run to decide after several searches without a paid call, and resets when one answers", () => {
    const log = emptyServiceLog();
    let hint: string | undefined;
    for (let i = 0; i < SEARCHES_BEFORE_DECIDING; i++) hint = recordServiceResult(log, "find_paid_service", { query: `q${i}` }, { ok: true, data: {} });
    expect(hint).toMatch(/6 searches and tree reads since this run's last paid call\. Decide now/);
    recordServiceResult(log, "call_paid_service", { url: "https://a.example/x" }, { ok: true, data: { data: { a: 1 } } });
    expect(recordServiceResult(log, "browse_services", { node: "image" }, { ok: true, data: {} })).toBeUndefined();
  });
});
