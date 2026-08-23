import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * One wallet: AgentCash's wallet. AgentCash creates and owns it at
 * `~/.agentcash/wallet.json`; OpenCrowd reads the key at signing time for the
 * Venice SIWX/x402 path and never copies, exports, or manages it. There is no
 * OpenCrowd wallet registry.
 */

export interface AgentCashWalletFile {
  address: string;
  privateKey: `0x${string}`;
}

export function agentCashWalletPath(): string {
  return process.env.AGENTCASH_WALLET_PATH ?? join(homedir(), ".agentcash", "wallet.json");
}

export async function readAgentCashWallet(): Promise<AgentCashWalletFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(agentCashWalletPath(), "utf8")) as Record<string, unknown>;
    const address = typeof parsed.address === "string" ? parsed.address : undefined;
    const privateKey = typeof parsed.privateKey === "string" && /^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey)
      ? parsed.privateKey as `0x${string}`
      : undefined;
    return address && privateKey ? { address, privateKey } : undefined;
  } catch {
    return undefined;
  }
}

export async function requireAgentCashWallet(): Promise<AgentCashWalletFile> {
  const wallet = await readAgentCashWallet();
  if (!wallet) {
    throw new Error(
      `No AgentCash wallet found at ${agentCashWalletPath()}. ` +
      "Install agentcash (its wallet is created automatically on first use) and retry."
    );
  }
  return wallet;
}
