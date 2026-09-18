# Changelog

## 0.5.3 — 2026-09-18

- Pin the default CrowdCode MCP client to 0.5.2, migrate the previously shipped floating default, and prevent older globally installed binaries from silently overriding the configured CrowdCode version. Explicit custom commands and pins are preserved.

## Unreleased

## 0.5.2 — 2026-09-18

- Persist failed review attempts and defer repeatedly rejected reviews without
  discarding receipts. Limit review completion gates to the query that made the
  purchase, so a registry rejection cannot stop a later retry or continuation.


## 0.5.1 — 2026-09-18

- Share AgentCash search and endpoint inspection between CLI and cloud, filtering
  to x402 USDC on Base and allowing services without prior CrowdCode reviews.
- Queue steering messages during active work and deliver them after a complete
  tool batch. Preserve cloud message delivery across checkpoints and restarts.
- Support authenticated job polling and save inline generated media as binary
  artifacts instead of including base64 in model context.
- Keep retries recoverable after cancellation and allow long-running hosted
  requests to finish without duplicating a paid operation.


## 0.5.0 — 2026-09-17

- Replace cumulative budgets with configurable automatic limits of $1 per paid
  call and $10 per query. Model calls, paid tools and subagents share the query
  allowance; calls above a limit pause for approval before payment.
- Add Wallet spending limits and choices to approve once, decline, or raise only
  the current query budget. Persist approvals and checkpoints for CLI resume and
  hosted worker restarts without repeating completed calls.
- Use the same spending decision logic in the CLI and hosted payment gateway.
- Compact context before payment and preserve exact prepared requests across
  approval restarts, including parallel subagent checkpoints.

- Trim the replayed conversation to 48 KB before each hosted model request
  (`trimHostedMessages`): the system prompt, the original task and the last
  four messages are always kept; older tool outputs are blanked first, then
  whole older turns are dropped with their tool results, and only then is a
  single oversized message cut down. Hosted agents no longer die once their
  history nears the bridge's 64 KB limit.
- Classify hosted bridge failures. A non-200 response whose JSON body says
  `paid: false` now fails the run with the bridge's user-readable message
  (`HostedRequestError`) instead of pausing with `payment_unknown`; every
  ambiguous failure still pauses for payment reconciliation.
- Add the hosted-only `request_secret` tool, which asks the user to add a
  named secret to the agent's encrypted vault through the host UI. The model
  references secrets by name (`env.NAME` via `deploy_service` `secrets`) and
  is told never to ask for values in the chat.
- Emit a redacted `input` summary on `tool.started` events (commands, paths
  and identifiers only; never file contents or secret values).
- Give hosted agents paid services. With `--bridge-socket` the worker builds
  the economy gateway with hosted adapters (`createHostedEconomy`): discovery
  and reputation from CrowdCode's public API, inspection by an unpaid probe
  that decodes the x402 v2 `payment-required` offer, and payment, review and
  balance over the supervisor socket as `economy.pay`, `economy.review` and
  `economy.balance`. Only CrowdCode-listed x402 services on Base are payable;
  MPP/Tempo listings are shown but refused. The hosted system prompt now
  describes the agent's own USDC wallet instead of saying paid services are
  unavailable, the loop will not finish with an unreviewed paid purchase, and
  economy tool calls are summarized on `tool.started`.
- Clamp `run_shell` `timeout_ms` into 1–30000 ms (non-integers fall back to
  the 10-second default) instead of rejecting the call; hosted models were
  repeatedly failing with "timeout_ms must be between 1 and 30000".

## 0.4.0 — 2026-09-15

- Add hosted workers with a versioned command/event protocol, explicit homes,
  resumable checkpoints, and a scoped model bridge.
- Add generalized evaluation suites and knowledge-tree evolution commands.
- Load the CrowdCode knowledge tree into agent prompts and copy category
  references into session artifacts. Include the knowledge snapshot and
  evaluation tasks in the npm package.
- Preserve multiline terminal pastes.
- Publish GitHub releases to npm using Trusted Publishing, with package
  version checks and a packed-CLI smoke test.

- Add the hosted-only `deploy_service` tool. Hosted workers advertise it to
  the model and execute it through the supervisor over the existing
  credential-free bridge socket (`POST /tool`), inlining the entry artifact.
  Local runs never advertise it and refuse it if asked by name.
- Preserve provider finish reasons, reject prematurely closed LLM streams,
  and make one bounded continuation when generation reaches its output-token
  limit instead of silently completing with a response cut off mid-word.
- Do not treat x402/MPP price or protocol metadata as proof of settlement.
  Paid calls now require a verifiable settlement reference before they become
  reviewable `paid_success`/`paid_failure` records; missing receipts are
  recorded conservatively as unknown and are never retried.

## 0.3.2 — 2026-08-27

Field note 001 fixes (issues 2 and 3):

- Stop losing paid x402/MPP receipts. AgentCash's fetch returns the response
  body and the payment metadata as separate MCP content blocks; these were
  joined into one unparseable string, so settled payments reconciled as
  `free` with no charge, no receipt, and no required review — while leaking
  the raw receipt to the model. Multi-block tool results now parse per
  block, the metadata (tx hash, receipt header, dollar price, rail) becomes
  stored purchase evidence charged at the actual amount with
  `review_required: true`, and the model sees only the vendor body.
- Read the session ledger with a real RFC 4180 parser. Quoted multiline
  `notes` cells (e.g. Markdown summaries) no longer shear into phantom rows
  in `opencrowd ledger` output.

## 0.3.1 — 2026-08-26

- Rebuild every internal workspace package during `prepack`, preventing a
  manual publish from bundling stale provider code.
- Migrate the former x402 default to BlockRun and rename the legacy route to
  `openrouter-x402-proxy` (the old `x402` spelling remains an input alias).
- Add descriptive `/provider` and `/provider help` output, preserve complete
  copyable `/fund` links, and keep `/models` routed through the active provider.

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
