import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@opencrowd/core";
import {
  browseTreeNode,
  clearTreeCache,
  createCrowdCodeApi,
  EconomyGateway,
  fetchLiveTree,
  lookupReliability,
  MockAgentCashAdapter,
  MockCrowdCodeAdapter,
  treeVersionPin,
  type CrowdCodeApi,
  type Reliability
} from "../src/index.js";

const BASE = "https://crowdcode.test";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const roots: string[] = [];

beforeEach(() => clearTreeCache());
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("the live capability tree (C7)", () => {
  it("fetches the tree once per process and hour, by version", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(url); return json({ version: 7, built_at: "2026-11-17T02:00:00Z", l0: "  CrowdCode capability tree v7.\n- search: … ", nodes: [] }); }) as typeof fetch;
    let now = 1_000;
    const first = await fetchLiveTree({ base: BASE, fetcher, now: () => now });
    expect(first.tree).toEqual({ version: 7, builtAt: "2026-11-17T02:00:00Z", l0: "CrowdCode capability tree v7.\n- search: …", source: `${BASE}/api/tree` });
    now += 59 * 60_000;
    expect((await fetchLiveTree({ base: BASE, fetcher, now: () => now })).tree?.version).toBe(7);
    expect(urls).toEqual([`${BASE}/api/tree`]);
    await fetchLiveTree({ base: BASE, fetcher, version: "candidate", now: () => now });
    expect(urls.at(-1)).toBe(`${BASE}/api/tree?version=candidate`);
    now += 2 * 60_000;
    await fetchLiveTree({ base: BASE, fetcher, now: () => now });
    expect(urls.filter((url) => url === `${BASE}/api/tree`)).toHaveLength(2);
  });

  it("gives up within its deadline and says why, without throwing", async () => {
    const hanging = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const started = Date.now();
    const result = await fetchLiveTree({ base: BASE, fetcher: hanging, timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.tree).toBeUndefined();
    expect(result.error).toMatch(/capability tree unavailable/);
    const broken = (async () => json({ ok: false }, 503)) as typeof fetch;
    expect((await fetchLiveTree({ base: `${BASE}/b`, fetcher: broken })).error).toContain("HTTP 503");
    const empty = (async () => json({ version: 3, l0: "" })) as typeof fetch;
    expect((await fetchLiveTree({ base: `${BASE}/c`, fetcher: empty })).error).toContain("no l0");
  });

  it("takes a version pin from the run, then the environment, and ignores junk", () => {
    expect(treeVersionPin(undefined, {})).toBeUndefined();
    expect(treeVersionPin("candidate", { OPENCROWD_TREE_VERSION: "4" })).toBe("candidate");
    expect(treeVersionPin(undefined, { OPENCROWD_TREE_VERSION: " 12 " })).toBe("12");
    expect(treeVersionPin("../etc", { OPENCROWD_TREE_VERSION: "latest" })).toBeUndefined();
  });

  it("browses one node at the session's version, and names the top nodes for an unknown one", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return url.includes("/nope") ? json({ ok: false }, 404) : json({ version: 4, id: "search", kind: "node", text: "# search — Web search (tree v4)" });
    }) as typeof fetch;
    expect(await browseTreeNode("Search", { base: BASE, fetcher, version: 4 })).toEqual({ ok: true, data: { version: 4, id: "search", text: "# search — Web search (tree v4)" } });
    expect(urls).toEqual([`${BASE}/api/tree/search?version=4`]);
    const unknown = await browseTreeNode("nope", { base: BASE, fetcher });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("free-first, search");
    expect((await browseTreeNode("../../admin", { base: BASE, fetcher })).ok).toBe(false);
    expect(urls).toHaveLength(2);
  });
});

describe("reliability lookups (C3)", () => {
  it("asks by origin and path, keeps the first reason, and caches the answer", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return json({ ok: true, service_id: "svc_1", state: "unverified", reasons: ["valid 402 in 1 of the last 1 daily probe (latest 2026-11-17 01:23 UTC)", "price fine"] });
    }) as typeof fetch;
    const verdict = await lookupReliability("https://api.exa.ai/search?q=secret+terms", "post", { base: BASE, fetcher });
    expect(verdict).toEqual({ state: "unverified", reason: "valid 402 in 1 of the last 1 daily probe", service_id: "svc_1" });
    expect(urls).toEqual([`${BASE}/api/reliability?url=${encodeURIComponent("https://api.exa.ai/search")}&method=POST`]);
    await lookupReliability("https://api.exa.ai/search", "POST", { base: BASE, fetcher });
    expect(urls).toHaveLength(1);
  });

  it("answers nothing when CrowdCode cannot say", async () => {
    const failing = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    expect(await lookupReliability("https://x.example/a", "GET", { base: BASE, fetcher: failing })).toBeUndefined();
    const odd = (async () => json({ ok: true, state: "great" })) as typeof fetch;
    expect(await lookupReliability("https://y.example/a", "GET", { base: BASE, fetcher: odd })).toBeUndefined();
  });
});

describe("the gateway's view of the tree and reliability", () => {
  const ranked = [
    { endpoint: "https://a.example/search", method: "POST", name: "A", price_usd: 0.01, payment_provider: "x402", network: "eip155:8453", networks: ["eip155:8453"], payable: true, rank: 1, quality: { score: 4.1, n_eff: 3, reviews: 5, verified_reviews: 0 }, sources: ["cdp-bazaar"] },
    { endpoint: "https://b.example/search", method: "POST", name: "B", price_usd: 0.007, payment_provider: "x402", network: "eip155:8453", networks: ["eip155:8453", "solana"], payable: true, rank: 2, quality: { score: 4.5 }, sources: ["agentcash"] },
    { endpoint: "https://c.example/search", method: "GET", name: "C", price_usd: 0.002, payment_provider: "x402", network: "eip155:8453", payable: true, rank: 3, sources: [] }
  ];
  const states: Record<string, Reliability> = {
    "https://a.example/search": { state: "unverified", reason: "valid 402 in 1 of the last 1 daily probe" },
    "https://b.example/search": { state: "reliable", reason: "valid 402 in 3 of the last 3 daily probes" },
    "https://c.example/search": { state: "unreliable", reason: "the last 3 probes all failed" }
  };

  async function gatewayWith(api: CrowdCodeApi | undefined, enabled = true) {
    const root = await mkdtemp(join(tmpdir(), "opencrowd-tree-test-"));
    roots.push(root);
    const session = await createSession({ workspaceRoot: root, budgetCents: 100 });
    const agentcash = new MockAgentCashAdapter();
    agentcash.search = async () => ({ ok: true, data: { services: structuredClone(ranked), note: "Ranked by CrowdCode" } });
    const crowdcode = new MockCrowdCodeAdapter();
    Object.assign(crowdcode, {
      findServices: async () => ({ ok: true, data: { services: [] } }),
      manage: async (name: string) => name === "crowdcode_status" ? { ok: true, data: { enabled } } : { ok: true, data: {} }
    });
    const gateway = new EconomyGateway({ session, agentcash, crowdcode, approvalMode: "auto", crowdcodeApi: api, approvalRulesPath: join(root, "rules.json") });
    return { session, gateway };
  }

  const api = (calls: string[] = []): CrowdCodeApi => ({
    browse: async (node, version) => { calls.push(`browse ${String(node)} ${String(version)}`); return { ok: true, data: { version, id: node, text: "text" } }; },
    reliability: async (url, method) => { calls.push(`reliability ${method} ${url}`); return states[url]; }
  });

  it("ranks reliable first and unreliable last, each with its state and first reason, in compact form", async () => {
    const { gateway } = await gatewayWith(api());
    const result = await gateway.execute("find_paid_service", { query: "web search" });
    expect(result.ok).toBe(true);
    const data = result.data as { services: Record<string, unknown>[]; note: string; unreliable_left_out: string[] };
    expect(data.services.map((service) => [service.name, service.reliability])).toEqual([
      ["B", "reliable: valid 402 in 3 of the last 3 daily probes"],
      ["A", "unverified: valid 402 in 1 of the last 1 daily probe"]
    ]);
    // Refused before payment, so named once rather than offered.
    expect(data.unreliable_left_out).toEqual(["https://c.example/search"]);
    expect(data.services[0]).toEqual({ endpoint: "https://b.example/search", method: "POST", name: "B", price_usd: 0.007, networks: ["eip155:8453", "solana"],
      quality: { score: 4.5 }, reliability: "reliable: valid 402 in 3 of the last 3 daily probes" });
    expect(data.services[1].quality).toEqual({ score: 4.1, n_eff: 3, reviews: 5 });
    expect(data.note).toContain("Unverified may need the owner's approval");
    expect(data.note).not.toContain("partial");
    // The target is about 800 tokens for a search; three results are far under it.
    expect(Buffer.byteLength(JSON.stringify(data)) / 3).toBeLessThan(800);
  });

  it("asks for six ranked results unless the agent asks for more", async () => {
    const { gateway } = await gatewayWith(api());
    const limits: unknown[] = [];
    const agentcash = (gateway as unknown as { options: { agentcash: MockAgentCashAdapter } }).options.agentcash;
    const search = agentcash.search.bind(agentcash);
    agentcash.search = async (query, options) => { limits.push(options?.limit); return search(query, options); };
    await gateway.execute("find_paid_service", { query: "web search" });
    await gateway.execute("find_paid_service", { query: "web search", limit: 10 });
    expect(limits).toEqual([6, 10]);
  });

  it("leaves the search as it was when CrowdCode cannot say, is off, or is not configured", async () => {
    const silent = await gatewayWith({ ...api(), reliability: async () => undefined });
    expect(((await silent.gateway.execute("find_paid_service", { query: "web search" })).data as { services: unknown[] }).services).toEqual(ranked);
    const calls: string[] = [];
    const off = await gatewayWith(api(calls), false);
    await off.gateway.execute("find_paid_service", { query: "web search" });
    expect(calls).toEqual([]);
    const none = await gatewayWith(undefined);
    expect(((await none.gateway.execute("find_paid_service", { query: "web search" })).data as { services: unknown[] }).services).toEqual(ranked);
    expect((await none.gateway.execute("browse_services", { node: "search" })).error).toContain("unavailable");
  });

  it("shows the reliability on inspection", async () => {
    const { gateway } = await gatewayWith(api());
    const result = await gateway.execute("inspect_paid_service", { url: "https://a.example/search", method: "POST" });
    expect((result.data as { reliability: string }).reliability).toBe("unverified: valid 402 in 1 of the last 1 daily probe");
  });

  it("browses at the tree version the session's instructions came from", async () => {
    const calls: string[] = [];
    const { gateway, session } = await gatewayWith(api(calls));
    session.knowledge = { version: "capability-tree-v9", source: `${BASE}/api/tree`, loadedAt: "2026-11-17T00:00:00Z", tree: 9 };
    expect((await gateway.execute("browse_services", { node: "image" })).ok).toBe(true);
    session.knowledge = { version: "g1@abc", source: "/bundled", loadedAt: "2026-11-17T00:00:00Z" };
    await gateway.execute("browse_services", { node: "image" });
    expect(calls).toEqual(["browse image 9", "browse image undefined"]);
  });

  it("is built from the default client against any base", async () => {
    const fetcher = (async () => json({ version: 2, id: "llm", text: "# llm" })) as typeof fetch;
    expect((await createCrowdCodeApi({ base: BASE, fetcher }).browse("llm")).data).toEqual({ version: 2, id: "llm", text: "# llm" });
  });
});
