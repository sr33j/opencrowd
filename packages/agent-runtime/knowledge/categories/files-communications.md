# Files and communications

## Ranked paid paths
- **StableUpload** — `https://stableupload.dev/api/upload`; mppx Tempo; $0.005 short 10 MB, $0.02 longer slot, ~$2 1 GB observed; **4.04/5, n_eff 9.7**.
  - Returned signed PUT/POST details, expiry, public URL, and curl examples; uploaded bytes were retrievable [svc_e12a3fd269c3618d910e#r1] [svc_e12a3fd269c3618d910e#r3].
  - Use the returned upload method exactly, keep shell timeouts within tool limits, then GET the public URL and compare bytes. Short policies, tier retention, activation, and occasional site TLS issues are gotchas [svc_e12a3fd269c3618d910e#r4].
- **Mail Disposable Inbox** — `https://mail.payweave.services/inboxes`; mppx Tempo; $0.002/day; **3.91/5, n_eff 1.7**.
  - Returned address, slug, routing metadata, TTL, and expiry [svc_b43ae1ba4ad77a7f70f6#r1]. Probe schema first.
- **StableEmail Inbox Buy** — `https://stableemail.dev/api/inbox/buy`; mppx Tempo; $1/30 days; **3.91/5, n_eff 1.7**.
  - Created a retained mailbox without OAuth; status exposed expiry and renewal [svc_45e24d77d535aca737f8#r1].
- **StableTube Download** — `https://stabletube.dev/api/download`; x402 Base; price unreported; **3.94/5, n_eff 3.6**.
  - Use free metadata precheck, then submit and poll the paid async job [svc_d6100b0e3d24b5c64090#r2]. Payment can precede artifact readiness [svc_d6100b0e3d24b5c64090#r1].

## Cheapest correct path
- Keep files local unless public retrieval is required. Use oEmbed/page metadata instead of downloading video when only metadata is requested.
