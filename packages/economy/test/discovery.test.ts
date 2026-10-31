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
