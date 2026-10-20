import { expect, it } from "vitest";
import { walletNetworkRows } from "../src/wallet.js";

it("renders one wallet row per network with its own address, including Solana's", () => {
  expect(walletNetworkRows({
    address: "0xagent",
    monadCents: 125,
    accounts: [
      { network: "base", address: "0xagent", usdc: 1.5 },
      { network: "solana", address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", usdc: 2 },
      { network: "tempo", address: "0xagent" }
    ]
  })).toEqual({
    base: "1.500000 USDC · 0xagent",
    solana: "2.000000 USDC · 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    tempo: "unknown · 0xagent",
    monad: "1.25 USDC · 0xagent"
  });
  expect(walletNetworkRows({ address: "0xagent" })).toEqual({});
});
