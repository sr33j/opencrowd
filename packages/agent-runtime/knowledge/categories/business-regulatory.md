# Business, regulatory, and health data

## Ranked paid paths
- **RxAtlas** — `https://api.rxatlas.dev/v1/drugs`; mppx Tempo; $0.10 search, $0.025 record; **3.95/5, n_eff 4.9**.
  - Ingredient/source/limit/count searches returned NDC and product details, provenance, totals, and cursors [svc_4db66f8e9da43f25a7d4#r1] [svc_4db66f8e9da43f25a7d4#r4]; IDs dereferenced to rich records [svc_4db66f8e9da43f25a7d4#r3]. Wrong parameters may still charge, so validate first.
- **agentstack SEC announcements** — `https://agentstack-research-3bnlllaboa-ts.a.run.app/v1/us/announcements/:ticker`; x402 Base; $0.005; **3.94/5, n_eff 3.3**.
  - `since` and `limit` returned parsed EDGAR arrays and machine-readable empty results [svc_cb6b39d6df1aa571fa60#r1] [svc_cb6b39d6df1aa571fa60#r2]. Empty results lack provenance; confirm with SEC.
- **ApiToll EDGAR Insider** — `https://edgar.apitoll.cloud/v1/edgar/insider`; x402 Base; $0.003; **3.91/5, n_eff 1.7**.
  - Free coverage precheck preceded parsed Form 4 records, SEC URLs, transaction types, shares, prices, and holdings [svc_9ed3e96b2fa499dca1f3#r1]. Handle pagination.
- **FDA Product Recalls** — `https://x402-endpoints.onrender.com/recalls/search`; x402 Base; $0.01; **3.62/5, n_eff 3.3**.
  - Structured food and drug enforcement records were relevant [svc_3aa1e492253afe77de15#r1] [svc_3aa1e492253afe77de15#r2]. Discovery incorrectly said payment was not required.
- **Data Legion company enrichment** — `https://agents.datalegion.ai/company/base`; x402 Base; price unreported; **3.56/5, n_eff 2.5**.
  - Domain/ticker calls returned useful company fields [svc_bccc8ac2d51346eb111e#r1] [svc_bccc8ac2d51346eb111e#r2]; filter noisy metadata.

## Cheapest correct path
- Use SEC EDGAR, openFDA, DailyMed, and RxNorm free APIs for simple identifiers and public records. Buy normalization, provenance, enrichment, or pagination.
