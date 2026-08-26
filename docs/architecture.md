# OpenCrowd architecture and product contract

This document is the authoritative contract for the OpenCrowd runtime. Code,
tests, and user documentation must match it; when they diverge, this document
wins and the code is wrong.

## Product definition

OpenCrowd is a local, persistent CLI agent with a USDC wallet. The user gives
it a task and a local spend cap. The agent uses local tools when possible, can
buy external capabilities through one enforced purchase lifecycle, and records
work, costs, receipts, and reviews locally.

## Ownership boundaries

OpenCrowd owns:

- the agent loop and subagents;
- sessions and conversation history;
- the local workspace and artifacts;
- the local budget and approval policy;
- stable model-visible tool semantics;
- purchase lifecycle orchestration;
- receipts, reviews, and audit views;
- LLM provider selection and model policy;
- evals.

AgentCash owns:

- wallet creation and custody;
- public balances and funding addresses;
- service discovery and inspection primitives;
- SIWX, x402, MPP, bridging, and payment execution;
- Venice credit top-up execution where required.

CrowdCode owns:

- the pre-payment service reputation check;
- signed reviews after every confirmed paid use, including paid failures.

Venice and OpenRouter own inference. OpenCrowd must not implement another
wallet, service marketplace, reputation system, or payment protocol. Vendor
failure is explicit: there are no legacy or silent fallbacks anywhere in the
system — not between providers, not between economy paths.

## Package layout

```text
apps/cli
  -> packages/agent-runtime
  -> packages/economy
  -> packages/core

packages/evals
  -> packages/agent-runtime

packages/agent-runtime
  -> packages/core
  -> provider implementations

packages/economy
  -> packages/core contracts
  -> long-lived AgentCash MCP client
  -> long-lived CrowdCode MCP client
```

- `packages/core`: vendor-neutral state, storage, conversation, budget,
  approvals, ledger/receipts, artifacts, and tool-registry contracts.
- `packages/economy`: typed AgentCash/CrowdCode adapters and the enforced paid
  capability state machine.
- `packages/agent-runtime`: LLM loop, provider implementations, tool
  orchestration, compaction, subagents, and progress events.
- `packages/evals`: development/evaluation harness.
- `apps/cli`: interactive UI, headless CLI, configuration, and rendering.

There is no OpenCrowd MCP server package and no localhost API package. Using
MCP internally to talk to AgentCash and CrowdCode is valid; OpenCrowd itself is
not exposed as an MCP server. Only the `opencrowd` CLI package is published;
internal workspace packages carry no semver-stability promise.

## Core state model

### Session

One session persists:

- session ID and workspace;
- conversation history and compaction archives;
- resolved provider, main model, and subagent model;
- session budget, spent amount, and in-flight reservations;
- external-service approval mode;
- artifacts;
- LLM usage entries;
- service purchases, receipts, and review state.

Session-resolved provider/model choices survive `opencrowd run --session`.
Interactive model overrides are session state, never UI-process memory.

### Budget

The budget is a local cumulative cap on value consumed for the session:

- LLM inference counts against it.
- External paid-service use counts against it.
- Reservations are local and require no network request.
- A budget change does not move funds.
- A budget cannot be set below already finalized session spend.
- Wallet/provider balance is funding availability, not the budget.
- Provider credit top-ups and LLM usage are never double-counted: both
  cash-flow and usage facts may be persisted, but one unambiguous total spend
  is exposed.
- Any automatic top-up is bounded by the remaining session allowance and a
  configured per-top-up maximum.

The default cap is a fixed configurable value from local configuration.
Session creation never requires a live wallet-balance lookup.

### External-service approval

Approval governs external service purchases only. LLM calls do not prompt per
turn; they are governed by the session budget. The mode type is
`ApprovalMode`:

- `ask`: require approval unless a stored rule authorizes the service.
- `auto`: skip prompts, while still enforcing blocks, caps, reputation checks,
  payment lifecycle, and the session budget.
- `off`: prohibit external-service purchases. Local tools and LLM inference
  continue to work.

The approval UI supports: allow once; always allow this service with optional
method/per-call/session caps; deny once; block service. The legacy names
`PermissionMode`, `ask_first`, `yolo`, and `blocked` do not exist in the code.

### Wallet

There is one wallet: AgentCash's wallet. OpenCrowd may show public addresses,
balances, networks, assets, and funding links. It never shows wallet secrets
or raw payment proofs to the model or normal CLI output. There is no wallet
registry, no local key creation, no Keychain integration, and no generic
direct USDC send. Tests use an in-memory mock AgentCash adapter, never a fake
production wallet registry.

## LLM provider contract

A provider supplies:

- a stable provider ID;
- a model catalog;
- a completion/streaming operation;
- normalized usage and actual-cost information;
- cache-read/cache-write metrics when supplied;
- provider-specific health/authentication errors.

### BlockRun (default)

Owner decision (2026-08-25), based on the same-model GAIA provider benchmark:

- Calls BlockRun's OpenAI-compatible route through the official `@blockrun/llm`
  SDK and pays x402 v2 USDC from the AgentCash wallet; no API key or prepaid
  provider balance is required.
- Defaults to `openai/gpt-5.6-sol` for the main loop and
  `openai/gpt-5.6-luna` for subagents.
- Streams text and tool calls, forwards the stable per-session prompt cache
  key, and records the SDK's settled x402 amount as actual cost.
- Creates one SDK client per in-flight completion so concurrent subagents do
  not mix the SDK's pending-payment or spending counters.
- Treats 90 seconds without a stream chunk, or the configured total deadline,
  as a transient timeout eligible for the bounded rescue ladder.

### x402 token proxy (rescue provider; explicitly selectable)

The previous default remains available and is BlockRun's paired rescue route:

- Calls an OpenAI-compatible, x402-metered proxy (`x402ProxyUrl`, default
  `https://x402-tokens.fly.dev/v1`) fronting OpenRouter-grade serving
  capacity.
- Pays per request only when challenged: an HTTP 402 challenge is signed
  with the AgentCash wallet key (upto-style — the challenge quotes a
  ceiling, the service settles actual usage). Unchallenged requests carry no
  payment overhead; after the first challenge the requirement is cached and
  the payment header attached preemptively, keeping steady state at one
  round trip per turn.
- Streams output; actual cost comes from settled-cost response headers, else
  the body's usage cost, else catalog pricing.
- Always requests a stream and watches liveness: if the stream goes silent
  for the stall window (default 90s), the request aborts as a transient
  timeout instead of waiting out the full deadline. The window is sized
  above measured silent-reasoning gaps (~37s observed) because the proxy
  forwards no bytes at all while the upstream model thinks.
- Caps in-flight completions per provider instance (default 6): the proxy's
  serving capacity is fixed, so excess concurrency just queues server-side
  and inflates time-to-first-token for every request. Queueing client-side
  is free — a parked call has not signed a payment or started its
  stall/timeout clocks yet.
- Trust caveat: the proxy is third-party infrastructure that sees prompts
  and holds the upstream key. It is retained as a reliability fallback;
  Venice remains the wallet-native alternative.

### Venice (backup: explicitly selectable, plus per-call rescue)

- Authenticates using the AgentCash wallet/SIWX path.
- Uses prepaid Venice credit.
- Reuses one long-lived client for the process/session.
- Does not query remote balance before every completion; it reads and caches
  balance information returned by inference.
- On insufficient credit, performs one bounded top-up through AgentCash and
  retries inference once. It never loops. Venice credit is deposit-only (no
  withdrawals), so the default per-top-up cap is $5, `ask` mode requires
  explicit confirmation of every top-up, and `off` mode disables automatic
  top-ups entirely.
- Sends a stable per-session `prompt_cache_key` and preserves byte-identical
  stable prompt/tool prefixes.
- Normalizes `cached_tokens` and cache-write fields into usage records.
- Streams output so time-to-first-token is visible.

Normal steady-state Venice inference is one network inference request per
turn. Local signing and local budget reservation are allowed; remote balance
preflight is not.

### OpenRouter (optional)

- Calls official OpenRouter directly through its OpenAI-compatible API.
- Uses `OPENROUTER_API_KEY` (or an injected secret), never wallet/SIWX auth.
- Consumes OpenRouter account credit.
- Uses returned usage/cost/cache fields without a separate balance query.

The session's selected provider never changes silently. What does exist is a
bounded per-call rescue ladder for transient faults (timeouts, stalls, rate
limits, 5xx, dropped connections):

1. retry the same provider once;
2. if that also fails transiently, make one rescue call on the paired backup
   provider (x402 for BlockRun/Venice, Venice for x402/OpenRouter) using its
   configured exact model IDs, recorded in the ledger with the reason;
3. after three consecutive rescues the primary is parked for the rest of the
   process and calls go straight to the backup (a fresh run probes again).

In `ask` approval mode each rescue call requires explicit human confirmation
through the same approval surface as purchases (headless ask-mode runs have
no confirmation surface, so the rescue is denied and the original error
surfaces); degraded-first routing is skipped in ask mode so the primary is
always probed. Non-transient failures skip the ladder and surface with
remediation. Rescue uses exact model IDs only — an `auto` backup preference
falls back to the shipped default model, because resolving a catalog
mid-outage is exactly the wrong moment. Headless and eval runs additionally
cap the per-request deadline at 240s (`NON_INTERACTIVE_LLM_TIMEOUT_MS`);
interactive sessions keep the configured `llmTimeoutMs`.

### Model policy

Configuration specifies a default provider and provider-specific default main
and subagent model preferences. Session creation resolves and records exact
model IDs. `auto` may resolve from live catalog data, but resolved IDs are
persisted for reproducibility. Provider model IDs are validated against the
active provider's catalog.

## Paid capability gateway

Raw vendor MCP tools are never exposed to the model. The stable OpenCrowd
surface is:

| Tool | Meaning |
| --- | --- |
| `get_wallet_status` | Public AgentCash balances, deposit addresses, and funding links. |
| `find_paid_service` | Discover a known origin directly or search an unknown capability. |
| `inspect_paid_service` | Exact endpoint, input schema, price ceiling, supported rail, and CrowdCode evidence. |
| `call_paid_service` | Revalidate and execute one inspected call through the enforced lifecycle. |
| `review_paid_service` | Review one immutable stored purchase using its receipt evidence. |
| `bridge_usdc` | Optional explicit financial action through AgentCash. |

The model never supplies payment proof, payer identity, transaction hashes, or
review evidence. Adapters obtain those from immutable stored results.

Every potentially paid call follows:

```text
find/discover
  -> inspect exact endpoint/schema/price
  -> CrowdCode pre-check
  -> approval rule or human decision
  -> local budget reservation
  -> AgentCash execution (never auto-replay ambiguous writes)
  -> reconcile free/SIWX/paid/unknown outcome
  -> persist artifact and immutable receipt
  -> finalize/release budget reservation
  -> submit CrowdCode review for confirmed paid result
  -> append audit entry
```

Invariants (each is runtime-enforced and tested):

- A CrowdCode outage or rejected check prevents a new payment.
- `unproven` evidence alone does not automatically reject a service.
- Free or SIWX-authenticated results create no paid receipt/review.
- Confirmed paid successes and paid failures create receipts and reviews.
- Ambiguous state-changing calls are recorded unknown and never auto-retried.
- A second purchase and session completion are blocked while a confirmed paid
  purchase has a pending required review.
- Pending reviews survive restart.
- Raw payment proof is stored for review but omitted from the model and normal
  CLI rendering.
- Only rails CrowdCode verifies end-to-end are allowed for automatic payment:
  Base x402 and Tempo MPP normalized to `mppx`. Unsupported automatic paid
  rails are rejected.

Purchases live in an append-only `sessions/<session-id>/purchases.jsonl`.
Full responses belong in artifacts, not the ledger.

## Agent loop

One loop implementation serves main agents and subagents, parameterized by
provider, tools, limits, and persistence. Turn semantics:

1. Compact only when required by context pressure.
2. Reserve local budget for the LLM request.
3. Stream one provider completion.
4. Persist the assistant message.
5. If there are no tool calls, complete with the assistant response.
6. Validate each tool call against the stable registry.
7. Execute independent subagents concurrently within the configured bound.
8. Execute other calls through their owning registry/gateway.
9. Persist normalized tool results and budget/receipt effects.
10. Stop on explicit completion, repeated identical failures, budget
    exhaustion, an unresolved paid-state ambiguity, or maximum turns.

Subagents:

- use the configured `/submodel` choice;
- share the parent budget and audit stores;
- have namespaced trajectories/artifacts;
- cannot spawn deeper subagents;
- cannot make paid-service decisions or payments;
- may use only explicitly allowed local/read-only capabilities.

System instructions and tool schemas stay stable across turns to maximize
provider cache hits. Live balance/timestamp facts stay out of the stable
prefix.

## User command contract

All interactive slash commands mutate or inspect the current session.
Persistent defaults change only through the top-level `opencrowd config`
command, which affects future sessions, never a running one.

| Command | Exact meaning |
| --- | --- |
| `/status` | Show session, provider, resolved models, wallet/credit status, budget, and approval mode. |
| `/provider [blockrun\|x402\|venice\|openrouter]` | Show or select this session's provider. Validate configuration immediately. |
| `/models` | List models for the active provider. No mutation. |
| `/model [id\|auto]` | Show or set the current session's main model. |
| `/submodel [id\|auto\|off]` | Show, set, auto-select, or disable the session's subagent model. |
| `/budget <usd>` | Set the session's cumulative local spend cap; never move money. |
| `/approval ask\|auto\|off` | Control external-service purchase approval for this session. |
| `/approvals` | List/manage stored service allow/block rules and caps. |
| `/wallet` | Show public AgentCash balances and deposit addresses. |
| `/fund` | Show funding instructions/links. |
| `/ledger` | Show normalized LLM usage, purchases, top-ups, receipts, and totals without secrets. |
| `/summary` | Summarize final work, artifacts, service calls, and spending. |
| `/clear` | Archive and clear conversation context only; retain the session, spend, provider, models, and policy. |
| `/new` | Start a new session with configured defaults. |
| `/help` | Render the canonical command registry. |
| `/quit` | Finalize and exit after required reviews are resolved. |

Removed from the interactive UI: `/run` (plain text runs a task), `/search`,
`/permissions` and old modes, `/models set`, `/test-mode`, `/test-seed`,
legacy wallet management, `/mcp`, `/api`.

`opencrowd --demo` remains the public zero-money demo, built on injected mock
provider/economy adapters. Test seeds and mocks may exist as internal/test
flags but are not product commands.

Headless contract for scripts and evals:

```sh
opencrowd run --headless --prompt "..." --output json
```

Headless execution never silently selects `auto` approval. It requires an
explicit approval mode (or configured non-interactive default) and fails
instead of waiting for UI input.

Top-level configuration commands with future-session semantics:

```sh
opencrowd config show
opencrowd config set provider venice
opencrowd config set model auto
opencrowd config set submodel auto
opencrowd config set budget 20
opencrowd config set approval ask
```

One command registry drives parsing, execution, autocomplete, `/help`,
`opencrowd --help`, and generated documentation.

## Startup requirements

`opencrowd` renders the TUI from local state immediately. Initial render never
blocks on `npx` installation, AgentCash/CrowdCode connection, on-chain wallet
balance, Venice credit balance, or model catalog download.

After render:

- provider/economy/wallet status initialize concurrently in the background;
- one long-lived AgentCash and one long-lived CrowdCode process/client are
  reused;
- pinned installed package binaries are resolved instead of running `npx`
  during every normal startup;
- paid capabilities initialize lazily if background startup is not ready;
- loading/unavailable status is shown without blocking local chat setup;
- model catalogs are cached with an explicit refresh path;
- all balance calls are deduplicated.

`opencrowd doctor` performs explicit local dependency, provider auth, wallet,
connector, and network diagnostics.

Performance acceptance:

- TUI first render does not require network access.
- Normal Venice turns perform no balance preflight and one inference request.
- Time-to-first-token is surfaced and benchmarked.
- Cache metrics are recorded so repeated-turn hit rates can be verified.

## Cloud boundary

OpenCrowd Cloud is out of scope. The local runtime is constructible through
dependency injection rather than terminal globals:

```ts
createOpenCrowdRuntime({
  storage,
  llmProvider,
  economy,
  approvalHandler,
  workspace
})
```

The CLI is an adapter around this runtime. A later closed-source cloud wrapper
can inject hosted storage, custody, secrets, and approvals.

## Security model

Economic safety is enforced by the runtime, not by prompt trust:

- The model sees only the stable gateway tools; adapters hold vendor access.
- Payment proof, payer identity, and signatures never enter prompts, normal
  tool results, or logs.
- Approval, budget, reputation, rail, and review gates run in code on every
  paid call regardless of what the model requests.
- Subagents structurally cannot pay, approve, or spawn deeper subagents.

## Acceptance gates

The rewrite (and any later change) is complete only when:

- one wallet exists in code: AgentCash;
- one paid-service lifecycle exists and is runtime-enforced;
- one stable economic tool surface is shown to the model;
- one LLM provider abstraction supports Venice default and direct OpenRouter;
- one session state owns provider, main model, submodel, budget, approvals,
  context, artifacts, and audit data;
- one command registry drives all interactive command behavior and help;
- startup renders without waiting on the network;
- no silent provider or economy migration remains: sessions keep their
  provider; transient-fault rescue calls are bounded, ledgered, and
  per-call only;
- no legacy wallet/Bazaar/generic x402/OpenCrowd MCP/local API code remains;
- docs describe the running implementation exactly (CI fails when live help
  and documented help diverge);
- typecheck, tests, dead-code checks, bundle, demo, and headless smoke tests
  pass.

Live paid tests are explicit, low-value, and opt-in. Ordinary tests never
spend real funds.
