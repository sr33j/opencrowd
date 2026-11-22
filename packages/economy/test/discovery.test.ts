import { it, expect, vi } from "vitest";
const check = vi.hoisted(() => vi.fn());
vi.mock("@agentcash/discovery", () => ({ checkEndpointSchema: check, discoverOriginSchema: vi.fn() }));
import { BaseServiceDiscovery, CATALOG_DEADLINE_MS, PROBE_DEADLINE_MS, VERIFY_SWEEP_DEADLINE_MS } from "../src/discovery.js";
import { BASE_USDC, SOLANA_NETWORK, SOLANA_USDC, TEMPO_USDC } from "../src/offers.js";
it("keeps only real Base USDC offers, including multi-rail and unreviewed endpoints", async () => {
  const options = [
    [{ protocol: "mpp", network: "tempo", asset: "USDC", amount: "10" }],
    [{ protocol: "x402", network: "eip155:8453", asset: "fake-USDC", amount: "10" }],
    [{ protocol: "x402", network: "eip155:1", asset: BASE_USDC, amount: "10" }],
    [{ protocol: "mpp", network: "tempo" }, { protocol: "x402", network: "eip155:8453", asset: BASE_USDC, amount: "200000" }],
  ];
  check.mockImplementation(async ({ url }) => ({ found: true, advisories: [{ method: "POST", authMode: "paid", paymentOptions: options[Number(url.at(-1))] }] }));
  const search = vi.fn(async () => ({ ok: true, data: { results: options.map((_, i) => ({ origin: { url: "https://new-provider.example" }, path: `/video/${i}`, method: "POST", summary: "Generate video" })) } }));
  const discovery = new BaseServiceDiscovery(search);
  expect((await discovery.search("video")).data).toMatchObject({ services: [{ endpoint: "https://new-provider.example/video/3", price_usd: 0.2, network: "eip155:8453" }] });
  expect(check).toHaveBeenCalledTimes(4);
});

it("ranks with CrowdCode even when AgentCash search fails, probing GET when a catalog omits the method", async () => {
  check.mockImplementation(async ({ url }) => url.includes("tick")
    ? { found: true, advisories: [{ method: "GET", authMode: "paid", paymentOptions: [{ protocol: "x402", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "5000", payTo: "SoLpayee" }] }] }
    : { found: false, message: "HTTP 404" });
  const balances = vi.fn(async () => ({ base: 3, solana: 1 }));
  const rank = vi.fn(async () => ({ ok: true, data: { services: [
    { rank: 1, endpoint: "https://tick.example/price", method: null, quality: { score: 4.1, num_reviews: 2 }, best: { network: "solana", effective_price_usd: 0.005 }, sources: ["cdp-bazaar"] },
    { rank: 2, endpoint: "https://dead.example/x", method: "POST", best: { network: "base" }, sources: ["mpp"] }] } }));
  const discovery = new BaseServiceDiscovery(async () => ({ ok: false, error: "SIWX failed" }), { balances });
  const result = await discovery.search("token price", { rank });
  expect(rank).toHaveBeenCalledWith({ query: "token price", networks: ["base", "solana", "tempo"], balances: { base: 3, solana: 1 }, candidates: [], limit: 16 });
  expect(result).toMatchObject({ ok: true, data: { services: [{ rank: 1, endpoint: "https://tick.example/price", method: "GET", best_network: "solana",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", price_usd: 0.005, quality: { score: 4.1, reviews: 2 } }] } });
  expect((result.data as any).services).toHaveLength(1);
});

it("keeps the tier, why, model, capability and explore flag CrowdCode's index search ranks with (C13)", async () => {
  check.mockImplementation(async () => ({ found: true, advisories: [{ method: "POST", authMode: "paid", paymentOptions: [{ protocol: "x402", network: "eip155:8453", asset: BASE_USDC, amount: "400000", payTo: "0xbase" }] }] }));
  const rank = vi.fn(async () => ({ ok: true, data: { services: [
    { rank: 1, endpoint: "https://video.example/veo", method: "POST", tier: "popular", why: "12 payers in 30 days on the x402 Bazaar", model: "veo-3.1",
      capability: "video.generation", explore: true, best: { network: "base", effective_price_usd: 0.4 } }] } }));
  const result = await new BaseServiceDiscovery(async () => ({ ok: true, data: { results: [] } })).search("generate a video", { rank });
  expect((result.data as any).services[0]).toMatchObject({ endpoint: "https://video.example/veo", tier: "popular", why: "12 payers in 30 days on the x402 Bazaar",
    model: "veo-3.1", capability: "video.generation", explore: true, best_network: "base", effective_price_usd: 0.4 });
});

it("lists every network a result can be paid on, so a caller short on one can prefer another", async () => {
  // A quote sold only on Tempo next to one payable on Base or Solana: the
  // difference has to be visible in the search result, not only after a 402.
  check.mockImplementation(async ({ url }) => ({ found: true, advisories: [{ method: "GET", authMode: "paid", paymentOptions: url.endsWith("tempo-only")
    ? [{ protocol: "mpp", network: "tempo", asset: TEMPO_USDC, amount: "21000", payTo: "0xtempo" }]
    : [{ protocol: "x402", network: "eip155:8453", asset: BASE_USDC, amount: "50000", payTo: "0xbase" },
       { protocol: "x402", network: SOLANA_NETWORK, asset: SOLANA_USDC, amount: "50000", payTo: "SoLpayee" },
       { protocol: "x402", network: "eip155:1", asset: BASE_USDC, amount: "10" }] }] }));
  const search = vi.fn(async () => ({ ok: true, data: { results: ["tempo-only", "anywhere"].map((slug) => ({
    origin: { url: "https://quotes.example" }, path: `/${slug}`, method: "GET", summary: "Stock quote" })) } }));
  const services = ((await new BaseServiceDiscovery(search).search("stock quote")).data as any).services;
  expect(services.map((s: any) => s.networks)).toEqual([["tempo"], ["base", "solana"]]);
});

it("answers a search whose candidates never respond, instead of hanging the whole run", async () => {
  // Run 47a629fc-80d5-4c64-b9b7-13d2abb86f12: find_paid_service("page
  // extraction article text") ranked sixteen candidates, started probing them,
  // and never came back. Nine minutes later the supervisor gave up and the
  // owner lost a $0.57 run. Every probe carried a ten-second abort signal, and
  // that is exactly the detail that did not help — a signal only cancels what
  // the callee can cancel. This mock does what an unresolvable host does:
  // nothing, forever, signal or no signal.
  vi.useFakeTimers();
  try {
    check.mockImplementation(() => new Promise(() => undefined));
    const endpoints = Array.from({ length: 16 }, (_, i) => `https://quiet-${i}.example/extract`);
    const rank = vi.fn(async () => ({ ok: true, data: { services: endpoints.map((endpoint, i) => ({ rank: i + 1, endpoint })) } }));
    const discovery = new BaseServiceDiscovery(async () => ({ ok: true, data: { results: [] } }), { negotiated: true });
    const started = Date.now();
    let elapsed: number | undefined;
    const search = discovery.search("page extraction article text", { limit: 6, rank })
      .then((answer) => { elapsed = Date.now() - started; return answer; });
    await vi.advanceTimersByTimeAsync(VERIFY_SWEEP_DEADLINE_MS + PROBE_DEADLINE_MS + 1_000);
    const result = await search;
    expect(elapsed).toBeLessThanOrEqual(VERIFY_SWEEP_DEADLINE_MS + PROBE_DEADLINE_MS);
    expect(result.ok).toBe(true);
    // No service is payable, because none of them answered. Saying so is a
    // result the model can act on; the nine minutes were not.
    expect((result.data as any).services).toEqual([]);
    expect((result.data as any).note).toContain("time budget ran out");
  } finally { vi.useRealTimers(); }
});

it("keeps the candidates that do answer when a slow neighbour shares the sweep", async () => {
  vi.useFakeTimers();
  try {
    check.mockImplementation(async ({ url }: { url: string }) => url.includes("quiet")
      ? new Promise(() => undefined)
      : { found: true, advisories: [{ method: "GET", authMode: "paid",
        paymentOptions: [{ protocol: "x402", network: "eip155:8453", asset: BASE_USDC, amount: "6000", payTo: "0xbase" }] }] });
    const rank = vi.fn(async () => ({ ok: true, data: { services: [
      { rank: 1, endpoint: "https://quiet-a.example/extract", method: "GET" },
      { rank: 2, endpoint: "https://answers.example/extract", method: "GET" }] } }));
    const search = new BaseServiceDiscovery(async () => ({ ok: true, data: { results: [] } }), { negotiated: true })
      .search("page extraction", { limit: 6, rank });
    await vi.advanceTimersByTimeAsync(VERIFY_SWEEP_DEADLINE_MS + PROBE_DEADLINE_MS + 1_000);
    const services = ((await search).data as any).services;
    expect(services.map((service: any) => service.endpoint)).toEqual(["https://answers.example/extract"]);
  } finally { vi.useRealTimers(); }
});

it("gives up on a catalog that stops answering and still returns the other one's results", async () => {
  vi.useFakeTimers();
  try {
    check.mockImplementation(async () => ({ found: true, advisories: [{ method: "GET", authMode: "paid",
      paymentOptions: [{ protocol: "x402", network: "eip155:8453", asset: BASE_USDC, amount: "6000", payTo: "0xbase" }] }] }));
    // AgentCash never answers; CrowdCode's ranking does.
    const rank = vi.fn(async () => ({ ok: true, data: { services: [{ rank: 1, endpoint: "https://answers.example/extract", method: "GET" }] } }));
    const search = new BaseServiceDiscovery(() => new Promise(() => undefined), { negotiated: true })
      .search("page extraction", { limit: 6, rank });
    await vi.advanceTimersByTimeAsync(CATALOG_DEADLINE_MS + 1_000);
    const result = await search;
    expect(rank).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }));
    expect(((result.data as any).services)).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it("passes a task to CrowdCode, keeps why each pick fits, and says none fits instead of offering near misses (w107 phase 1)", async () => {
  check.mockImplementation(async () => ({ found: true, advisories: [{ method: "POST", authMode: "paid", paymentOptions: [{ protocol: "x402", network: "eip155:8453", asset: BASE_USDC, amount: "250000", payTo: "0xbase" }] }] }));
  const task = "a 5 second video of ocean waves at sunset";
  const rank = vi.fn(async () => ({ ok: true, data: { reranked: true, queries: ["text to video generation"], services: [
    { rank: 1, endpoint: "https://video.example/gen", method: "POST", tier: "popular", fit: "generates video from a text prompt", best: { network: "base" } }] } }));
  const discovery = new BaseServiceDiscovery(async () => ({ ok: true, data: { results: [] } }));
  const found = await discovery.search(task, { rank, task });
  expect(rank).toHaveBeenCalledWith(expect.objectContaining({ query: task, task }));
  expect(found.data).toMatchObject({ services: [{ endpoint: "https://video.example/gen", fit: "generates video from a text prompt" }] });

  const none = vi.fn(async () => ({ ok: true, data: { reranked: true, none_fit: true, queries: ["pangram ai detection"], services: [] } }));
  const nothing = await discovery.search("run the Pangram detector on my essay", { rank: none, task: "run the Pangram detector on my essay" });
  expect(nothing.data).toMatchObject({ services: [], none_fit: true, searched: ["pangram ai detection"] });
  expect((nothing.data as { note: string }).note).toMatch(/request_service/);
});

it("tells the owner the cheapest offer, and the most a by-use offer can charge, while the gateway's ceiling stays the highest (SRI-163)", async () => {
  // Browser Use's live 402: $1 and $5 exact, and `upto` $100. An agent read only price_usd ($100, the ceiling) and told an owner "$100 per session".
  check.mockImplementation(async () => ({ found: true, advisories: [{ method: "POST", authMode: "paid", paymentOptions: [
    { protocol: "x402", scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "1000000", payTo: "0xbu" },
    { protocol: "x402", scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "5000000", payTo: "0xbu" },
    { protocol: "x402", scheme: "upto", network: "eip155:8453", asset: BASE_USDC, amount: "100000000", payTo: "0xbu" }] }] }));
  const discovery = new BaseServiceDiscovery(async () => ({ ok: true, data: { results: [] } }), { negotiated: true });
  const inspected = await discovery.inspect({ url: "https://x402.api.browser-use.com/api/v3/sessions", method: "POST" });
  expect(inspected.data).toMatchObject({ price_usd: 100, price_from_usd: 1 });
  expect((inspected.data as any).offers.map((o: any) => o.scheme)).toEqual(["exact", "exact", "upto"]);
  // One offer: no second figure.
  check.mockImplementation(async () => ({ found: true, advisories: [{ method: "POST", authMode: "paid", paymentOptions: [
    { protocol: "x402", scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "100000", payTo: "0xsb" }] }] }));
  const single = await discovery.inspect({ url: "https://www.stablebrowser.dev/api/sessions", method: "POST" });
  expect(single.data).toMatchObject({ price_usd: 0.1 });
  expect((single.data as any).price_from_usd).toBeUndefined();
});
