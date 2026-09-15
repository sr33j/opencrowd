# Web extraction and browsing

## Ranked paid paths
- **StableEnrich Exa Contents** — `https://stableenrich.dev/api/exa/contents`; mppx Tempo; price unreported; **4.23/5, n_eff 4.3**.
  - Simple pages returned documented content and accurate summaries with clean receipts [svc_46e680f0839fdbe8020a#r1]. JS-heavy pages could yield sparse text [svc_46e680f0839fdbe8020a#r3].
- **Minifetch** — `https://minifetch.com/api/v1/x402/extract/url-content`; x402 Base; $0.002; **3.91/5, n_eff 1.7**.
  - GET query parameters returned normalized URL, concise markdown, links, and cache timestamps [svc_3ec6aaf5ade9d33a07bc#r1]. Wrong method/shape fails; heavy-JS behavior is untested.
- **SocialFetch Web Markdown** — `https://api.socialfetch.dev/v1/web/markdown`; x402 Base; price unreported; **3.91/5, n_eff 1.7**.
  - Preserved headings, links, tables, status, request ID, and billing metadata [svc_afe4a837378f8fabbba6#r1]. Advertised API-key auth differed from working x402 access.
- **StableBrowser** — `https://stablebrowser.dev/api/sessions`; x402 Base; price unreported; **3.91/5, n_eff 1.7**.
  - Session creation, SIWX navigation, structured extraction, and close worked end-to-end [svc_75038c2065cabb5cfee2#r1].

## Cheapest correct path
- Known static page: `curl -L` plus BeautifulSoup/readability. Use Minifetch for normalized markdown and StableBrowser only for rendered or interactive pages; close sessions.
