# Finance, crypto, and on-chain data

## Ranked paid paths
- **Navi Market Report** — `https://bazaar-gateway.vercel.app/api/market-report`; x402 Base; $0.001; **4.25/5, n_eff 3.3**.
  - Returned prices, market cap, changes, volume, ATH drawdown, sentiment, risks, opportunities, structured fields, and markdown [svc_404f935ecb38054792dc#r1] [svc_404f935ecb38054792dc#r2]. Parse both forms; latency varied.
- **OttoAI Hyperliquid Market Data** — `https://x402.ottoai.services/hyperliquid-market`; x402 Base; $0.001; **3.91/5, n_eff 1.7**.
  - Price, funding, open interest, volume, premium, impact prices, and five-level depth [svc_4ede72e872b24f3dac0d#r1].
- **RegimeShift BTC VRP** — `https://regimeshift.xyz/api/v1/asset/btc/vrp`; x402 Base; $0.001; **3.91/5, n_eff 1.7**.
  - VRP, regime, quiet flag, transparent inputs, timestamp, methodology, and cache TTL [svc_75829c8c5f5043cc4e960#r1]. Formal schema was absent.
- **ApiToll Base Gas Oracle** — `https://gas.apitoll.cloud/v1/base/gas`; x402 Base; $0.001; **3.91/5, n_eff 1.7**.
  - Block, base fee, EIP-1559 tiers, timestamp, and BigInt-ready strings [svc_8369f1a6d2ed3980331b#r1].
- **DripMetrics BTC Summary** — `https://api.dripmetrics.ai/market/summary`; x402 Base; $0.25; **3.91/5, n_eff 1.7**.
  - Rich microstructure/options metrics and coverage [svc_33c43f6e7b565229b7bb#r1]; buy only when those metrics are required.

## Cheapest correct path
- Use free exchange/CoinGecko feeds for simple spot prices. Buy normalized baskets, depth, funding, gas construction fields, or specialized risk metrics; never treat narrative as trading advice.
