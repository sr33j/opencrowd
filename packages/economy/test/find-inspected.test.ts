import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "@opencrowd/core";
import { describeInput, describeOutput, EconomyGateway, MockAgentCashAdapter, MockCrowdCodeAdapter, PROBE } from "../src/index.js";

/**
 * w107 phase 0: search already probes every result exactly as
 * inspect_paid_service would, so a search result is callable without a
 * second probe and a second model turn. Owner runs made 2.2 inspects per paid
 * call over Nov 7-21; find -> inspect -> call was three turns.
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const ENDPOINT = "https://search.example/api/search";
const probe = {
  endpoint: ENDPOINT, method: "POST", rail: "x402-base", payable: true, price_usd: 0.007, pay_to: "0xabc",
  input_schema: { type: "object", required: ["query"], properties: {
    query: { type: "string", description: "Search query" },
    numResults: { type: "number", description: "Number of results to return (max 10)" },
    type: { type: "string", enum: ["auto", "neural", "keyword"] } } },
  output_schema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: { title: {}, url: {}, text: {} } } }, requestId: {} } }
};

async function gatewayWithSearch() {
  const root = await mkdtemp(join(tmpdir(), "find-inspected-"));
  roots.push(root);
  const session = await createSession({ workspaceRoot: root, budgetCents: 100 });
  const agentcash = new MockAgentCashAdapter();
  const service: Record<string, unknown> = { endpoint: ENDPOINT, method: "POST", name: "Search", price_usd: 0.007, payable: true };
  Object.defineProperty(service, PROBE, { value: probe, enumerable: false });
  const plain = { endpoint: "https://other.example/x", method: "POST", name: "Other", price_usd: 0.01, payable: true };
  agentcash.search = async () => ({ ok: true, data: { services: [service, plain], note: "ranked" } });
  const gateway = new EconomyGateway({ session, agentcash, crowdcode: new MockCrowdCodeAdapter(), approvalMode: "auto", approvalRulesPath: join(root, "approvals.json") });
  return { gateway, agentcash };
}

describe("find_paid_service results come back inspected (w107 phase 0)", () => {
  it("shows a probed result's input fields and answer shape, and lets it be called without inspect_paid_service", async () => {
    const { gateway, agentcash } = await gatewayWithSearch();
    const found = await gateway.execute("find_paid_service", { query: "web search" });
    expect(found.ok).toBe(true);
    const [first, second] = (found.data as { services: Record<string, unknown>[] }).services;
    expect(first).toMatchObject({
      endpoint: ENDPOINT, inspected: true,
      input: { query: "string, required: Search query", numResults: "number: Number of results to return (max 10)", type: "string one of auto|neural|keyword" },
      returns: "{results[{title,url,text}],requestId}"
    });
    // A result the search did not probe still needs an inspection.
    expect(second.inspected).toBeUndefined();
    const call = await gateway.execute("call_paid_service", { url: ENDPOINT, method: "POST", body: { query: "x" }, purpose: "the task needs news; this call searches" });
    expect(call.ok).toBe(true);
    expect(agentcash.fetchCalls).toHaveLength(1);
    const refused = await gateway.execute("call_paid_service", { url: "https://other.example/x", method: "POST", body: {} });
    expect(refused.error).toMatch(/inspect_paid_service must run/);
  });

  it("reads the discovery extension's body/queryParams wrappers and stays within a few hundred characters", () => {
    expect(describeInput({ properties: { method: { enum: ["GET"] }, queryParams: { properties: { city: { type: "string", description: "City name" } }, required: ["city"] } } }))
      .toEqual({ city: "string, required: City name" });
    expect(describeInput({ type: "object" })).toBeUndefined();
    const wide = { properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, { type: "string", description: "x".repeat(200) }])) };
    expect(JSON.stringify(describeInput(wide)).length).toBeLessThan(640);
    expect(describeOutput({ type: "object" })).toBeUndefined();
    expect(describeOutput({ example: { data: [{ id: 1, name: "a" }], next: null } })).toBe("{data,next}");
  });
});
