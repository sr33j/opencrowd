export const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = 8453;
export const SUGGESTED_FUND_CENTS = 2000;

function usdcUnits(cents: number): bigint {
  // USDC has 6 decimals; 1 cent = 10^4 units
  return BigInt(Math.max(0, Math.round(cents))) * 10_000n;
}

export function usdcTransferUri(address: string, cents: number): string {
  return `ethereum:${BASE_USDC_CONTRACT}@${BASE_CHAIN_ID}/transfer?address=${address}&uint256=${usdcUnits(cents)}`;
}

export function metamaskDeepLink(address: string, cents: number): string {
  return `https://metamask.app.link/send/${BASE_USDC_CONTRACT}@${BASE_CHAIN_ID}/transfer?address=${address}&uint256=${usdcUnits(cents)}`;
}

export async function qrTerminal(text: string): Promise<string> {
  const { toString } = await import("qrcode");
  return toString(text, { type: "terminal", small: true });
}
