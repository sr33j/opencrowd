# Free-first workflows

## Default decision
- Try local/free once; if the result meets the requested format and freshness, answer immediately. Do **not** call `find_paid_service` afterward.
- Attached CSV/JSON/text: read once; use Python, `jq`, `csv`, `statistics`, and `pathlib` for filtering, medians, validation, and artifacts.
- Deterministic work: Python for arithmetic, ISO 7064 checks, dates, business-day rules, timezone conversion, ICS, JSON cleanup, translation, and token estimates.
- Known static page: `curl -L` or Python HTTP, then parse HTML/source. Use paid extraction only after static fetching is insufficient.
- DNS: `dig`, `getent`, or Python `socket`. Weather: Open-Meteo or national feeds. Geocoding: Nominatim with attribution and respectful limits.
- Public identifiers/data: RxNav/RxNorm for RxCUI; SEC EDGAR JSON for CIK/filings; openFDA/DailyMed for public health records.
- YouTube metadata: oEmbed or page metadata; downloading is unnecessary for title/channel/duration questions.
- Basic media: Pillow, ImageMagick, Tesseract/zbar, local TTS, and browser print-to-PDF.

## Buy rule
- Buy for current normalized multi-source data, pagination, remote rendering, public hosting, anti-bot access, or managed generation.
- Validate required fields before settlement. Reconcile receipts independently: one search payment was misclassified as free [svc_bf60cbf36c3e8ec4ecd4#r2], and an LLM gateway falsely described settled payments as free [svc_cad620304fe24134611a#r1].
