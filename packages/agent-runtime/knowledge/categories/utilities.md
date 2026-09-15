# DNS, RPC, OCR, calendar, and developer utilities

## Ranked paid paths
- **DNS Lookup API** — `https://tools.ipintel.ai/dns-lookup`; x402 Base; price unreported; **3.91/5, n_eff 1.7**.
  - Paid POST with domain and record types returned A, structured MX, TXT, and timestamp [svc_0af2e19563efe0ec4ec5#r1]. Bare GET only returns metadata.
- **Geographic DNS** — `https://geodns.iwsolutions.ca/api/resolve`; x402 Base; $0.005; **3.91/5, n_eff 1.7**.
  - Returned per-country records, resolver labels, TTL, timestamps, and latency [svc_16b5358afe7837590bef#r1].
- **OCR Extract** — `https://ocrext.xyz/api/extract`; mppx Tempo; price unreported; **3.91/5, n_eff 1.7**.
  - `imageUrl` or `imageBase64` accurately decoded a controlled QR into compact fields [svc_4ca3c6e82b9dcfb00a18#r1].
- **402utils ICS** — `https://402utils.com/v1/ics`; x402 Base; $0.002; **3.91/5, n_eff 1.7**.
  - Correct timezone conversion and standards-compliant folded ICS [svc_2a9a277e6a7c6028ffa1#r1].
- **AI JSON Repair** — `https://api.x402node.dev/ai/json-repair`; x402 Base; $0.006; **3.91/5, n_eff 1.7**.
  - Repaired common malformed JSON with diagnostics [svc_d9107c2642448208bbd5#r1]; POST route expects broken JSON in query parameters.
- **OneSource Network Info** — `https://api.onesource.io/api/chain/network-info`; x402 Base; $0.001; **3.93/5, n_eff 3.3**.
  - Fast chain ID, block, gas, and net version; block may be hex and lacks timestamp/provenance [svc_dc0db36c04ede57c0955#r1] [svc_dc0db36c04ede57c0955#r2].

## Cheapest correct path
- Use `dig`, `socket`, public RPC, Tesseract/zbar, Python `zoneinfo`, ICS libraries, and `json` locally. Buy only for remote geography, managed provenance, or zero-install convenience.
