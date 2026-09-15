# Web search

## Ranked paid paths
- **StableEnrich Exa Search** — `https://stableenrich.dev/api/exa/search`; x402 Base; $0.007–$0.02 observed; **4.23/5, n_eff 12.4**.
  - Best evidence depth: relevant canonical pages, authoritative sources, fast responses, and predictable schemas [svc_bf60cbf36c3e8ec4ecd4#r1] [svc_bf60cbf36c3e8ec4ecd4#r4].
  - Contradictory snippets, mangled code, empty titles, omitted fields, and receipt metadata problems occurred [svc_bf60cbf36c3e8ec4ecd4#r2] [svc_bf60cbf36c3e8ec4ecd4#r3]. Open primary sources for critical claims.
- **Parallel MPP Search** — `https://parallelmpp.dev/api/search`; mppx Tempo; $0.01 observed; **4.31/5, n_eff 3.8**.
  - Fast results with search ID, URLs, titles, dates, and long excerpts [svc_e91d4c0dfb719d9fefe8#r1]; supported follow-up company research [svc_e91d4c0dfb719d9fefe8#r2]. Probe accepted fields first.
- **Exa direct** — `https://api.exa.ai/search`; mppx Tempo; $0.007 observed; **4.25/5, n_eff 3.3**.
  - POST `query`, `numResults`, `type`, and `contents.summary`; returned URLs, summaries, timing, request ID, and cost [svc_1f2a3095bedbe7fa9eec#r1].
- **Tavily** — `https://x402.tavily.com/search`; x402 Base; $0.01; **3.31/5, n_eff 3.3**.
  - Current cited retrieval was fast, but synthesized answers overstated or omitted source details [svc_60a7c58a6e52728ffd8d#r1] [svc_60a7c58a6e52728ffd8d#r2].

## Cheapest correct path
- Known URL or local corpus: direct fetch, `rg`, or Python. Buy search only for discovery; verify claims at original URLs.
