# Image, video, and audio

## Ranked paid paths
- **StableStudio Flux 2 Pro** — `https://stablestudio.dev/api/generate/flux-2-pro/generate`; mppx Tempo; $0.40–$3.20/job observed; **3.94/5, n_eff 6.6**.
  - Async jobs produced valid artifacts with good visual adherence [svc_845113a14ce0efabe6f0#r1] [svc_845113a14ce0efabe6f0#r2]. Text can be gibberish and polling can take seconds to minutes [svc_845113a14ce0efabe6f0#r3] [svc_845113a14ce0efabe6f0#r4].
  - Efficient workflow: inspect once, submit once, use returned job/poll URL, wait the recommended interval, poll without rediscovery, download the final URL, verify MIME/dimensions, save the requested filename.
- **GPT Image 1.5 Edit** — `https://stablestudio.dev/api/generate/gpt-image-1.5/edit`; x402 Base; $0.04–$0.05; **3.93/5, n_eff 3.3**.
  - Returned job/poll URLs and fetchable PNGs; reference likeness was strong [svc_4e699fe05d59d35e649e#r1] [svc_4e699fe05d59d35e649e#r2]. Inspect small text for hallucinations.
- **StableVoice** — `https://stablevoice.dev/api/speech`; mppx Tempo; $0.02; **3.91/5, n_eff 1.7**.
  - Queued MP3 generation and polling worked [svc_768e0e738336585b8ca4#r1]; requires a reserved output slot.
- **fal.ai Flux** — `https://fal.mpp.tempo.xyz/fal-ai/flux-pro/v1.1-ultra`; mppx Tempo; ~$0.06; **2.85/5, n_eff 3.3**.
  - Generated a usable high-resolution image [svc_75aece0751a86841b923#r1], but labels may be missing or hallucinated.

## Cheapest correct path
- Reuse assets or use SVG/Pillow/ImageMagick/local TTS first. For requested generation, avoid repeated inspect/discovery turns and save the final artifact locally.
