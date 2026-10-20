import { it, expect, vi } from "vitest";
const check = vi.hoisted(() => vi.fn());
vi.mock("@agentcash/discovery", () => ({ checkEndpointSchema: check, discoverOriginSchema: vi.fn() }));
import { BaseServiceDiscovery } from "../src/discovery.js";
import { BASE_USDC } from "../src/offers.js";
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
