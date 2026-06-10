# Changelog

## 0.1.0 — unreleased

Initial open-source release.

- Interactive terminal UI (Ink): status bar, payment-aware transcript,
  slash-command autocomplete, shift+tab permission-mode toggle
- First-run wizard: wallet creation, seed backup, QR/deep-link funding screen
  with balance polling
- `opencrowd --demo`: full agent loop against mocks, no real money
- Human-in-the-loop `ask_first` permission mode (default) with per-call and
  per-session service cost caps
- Session budgets default to min($20, wallet balance) with reserve/finalize
  accounting and a per-session CSV ledger
- x402-paid LLM route (Venice default) and Coinbase Bazaar service discovery
- MCP server and localhost HTTP API exposing the same tool surface
