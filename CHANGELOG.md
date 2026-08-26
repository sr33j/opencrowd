# Changelog

## 0.3.0 — 2026-08-25

- Make BlockRun the default LLM provider, using its official x402 v2 SDK,
  with the prior x402 token proxy as the bounded per-call rescue provider.
- Require Node.js 22 or newer, matching the CLI's runtime dependencies.

## 0.2.1 — 2026-08-25

- `opencrowd --version` (also `-v` / `version`) prints the installed version.

## 0.2.0 — 2026-08-25

Breaking clean-architecture rewrite. There is no migration path; obsolete
surfaces were removed rather than shimmed (no wallet/config data on disk is
deleted).

Breaking removals:

- The OpenCrowd MCP server (`opencrowd mcp`) and localhost API
  (`opencrowd api`) are gone, along with their packages.
- The legacy wallet registry, local mnemonic creation, Keychain integration,
  fruit labels, `wallet new|use|list|fund|export`, and direct `wallet send`
  are gone. AgentCash's wallet (`~/.agentcash/wallet.json`) is the only
  wallet; OpenCrowd shows public addresses/balances and never manages keys.
- The Coinbase Bazaar fallback, generic x402 client, raw connector tool
  surface, and the `x402-tokens.fly.dev` LLM route are gone.
- `PermissionMode` (`ask_first`/`yolo`/`blocked`) is replaced by
  `ApprovalMode` (`ask`/`auto`/`off`); `OPENCROWD_PERMISSION_MODE` is now
  `OPENCROWD_APPROVAL_MODE` and `run --mode` is now `run --approval`.
- Interactive `/run`, `/search`, `/permissions`, `/models set`,
  `/test-mode`, `/test-seed`, and the non-TTY REPL are gone. Non-interactive
  callers use `opencrowd run --headless`.
- Config keys `x402LlmBaseUrl`, `x402LlmModel`, `x402LlmMaxCostCents`,
  `modelPolicy`, and `bazaarUrl` are replaced by `provider`,
  `venice`/`openrouter` model preferences, and explicit budget/approval
  defaults.
- Only the `opencrowd` CLI package is published; internal workspace packages
  carry no semver promise.

New architecture:

- Typed LLM providers: the x402 token proxy (default; OpenAI-compatible
  route, pay-per-request via wallet-signed upto challenges only when the
  route demands payment, streaming, cached-challenge pre-signing), Venice
  (wallet-native backup; SIWX auth, prepaid credit, one bounded automatic
  top-up with one retry), and direct OpenRouter (`OPENROUTER_API_KEY`).
  Sessions never silently migrate providers; switching is always explicit.
- Tail-latency hardening: every proxy call streams with liveness watching —
  a stream silent for 90s aborts as a transient timeout instead of waiting
  out the full deadline; transient faults ride a bounded ladder (one retry,
  then one ledgered rescue call on the paired backup provider, with the
  primary parked after three consecutive rescues); headless/eval runs cap
  the per-request deadline at 240s; sub-cent LLM costs keep fractional
  cents in the ledger instead of rounding to zero; in-flight proxy
  completions are capped (default 6) so excess concurrency queues
  client-side instead of inflating the proxy's time-to-first-token.
- Delegation policy: subagents are for parallel fan-out only — the prompt
  now requires two or more independent subagents per delegation and keeps
  sequential work in the main loop; `evals gaia` accepts
  `--subagent-model <model|off>`.
- Provider money/routing actions respect approval mode: in `ask` mode a
  backup-provider rescue call and an automatic Venice credit top-up each
  require explicit confirmation through the purchase-approval surface, and
  `off` mode disables automatic top-ups (Venice deposits are
  non-withdrawable); the default per-top-up cap drops from $10 to $5.
- One enforced paid-capability lifecycle behind a stable six-tool gateway:
  discover → inspect → CrowdCode pre-check → approval → budget reservation →
  AgentCash execution → reconciliation → immutable receipt → required
  CrowdCode review → audit. Pending reviews survive restarts and block both
  further purchases and session completion.
- Append-only `sessions/<id>/purchases.jsonl` receipts; payment proofs and
  tx hashes are stored for reviews but never shown to the model or CLI.
- Sessions own provider, exact resolved main/subagent model IDs, budget,
  approval mode, conversation, artifacts, and audit data; all of it survives
  `run --session`.
- One command registry drives slash commands, autocomplete, `/help`,
  `opencrowd --help`, and the generated `docs/commands.md` (CI fails on
  drift). New commands: `/status`, `/provider`, `/model`, `/submodel`,
  `/approval`, `/approvals`, `/fund`, `/new`, plus top-level
  `opencrowd config` (future-session defaults) and `opencrowd doctor`.
- The TUI renders instantly from local state; vendors, balances, and model
  catalogs initialize in the background. Balance calls are deduplicated and
  catalogs are cached with `/models refresh`.
- The local runtime is constructible via `createOpenCrowdRuntime({...})`
  dependency injection; the CLI is one adapter around it.
- `--demo` exercises the real enforced lifecycle over in-memory mock
  adapters — no real money, no network.

## 0.1.0 — unreleased

Initial open-source release (superseded by the 0.2.0 rewrite).
