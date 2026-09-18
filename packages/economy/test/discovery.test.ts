import { it, expect, vi } from "vitest";
const check = vi.hoisted(() => vi.fn());
vi.mock("@agentcash/discovery", () => ({ checkEndpointSchema: check, discoverOriginSchema: vi.fn() }));
import { BaseServiceDiscovery, BASE_USDC } from "../src/discovery.js";
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
