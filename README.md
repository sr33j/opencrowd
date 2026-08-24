# OpenCrowd

**A local CLI agent with its own USDC wallet.** Give it a task and a local
spend cap; it uses local tools when it can, buys external capabilities
through one enforced purchase lifecycle when it can't, and records work,
costs, receipts, and reviews on your machine.

[![CI](https://github.com/sr33j/opencrowd/actions/workflows/ci.yml/badge.svg)](https://github.com/sr33j/opencrowd/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![OpenCrowd demo: the agent asks approval, pays a service, and accounts for every cent](docs/demo.gif)

## Try it in 60 seconds (no crypto required)

```sh
npx opencrowd --demo
```

Demo mode runs the real enforced lifecycle — discovery, inspection,
reputation check, approval, payment, receipt, required review — over
in-memory mock adapters. No real money moves and nothing touches the
network.

## Installation and startup

```sh
npm install -g opencrowd   # or: npx opencrowd
opencrowd
```

The TUI renders immediately from local state; the AgentCash and CrowdCode
vendors, wallet balance, and model catalog initialize concurrently in the
background. `opencrowd doctor` diagnoses local dependencies, provider
authentication, the wallet, vendor connections, and the network explicitly.

First launch is two steps — there is no wallet setup:

1. **Fund the wallet** — it already exists (AgentCash creates it
   automatically at `~/.agentcash/wallet.json`; OpenCrowd, AgentCash, and
   CrowdCode all draw one balance). Scan the QR or tap the MetaMask link to
   send a few dollars of USDC on Base. The wallet is the agent's entire
   blast radius: it can never spend more than you put in.
2. **Give it a task** — type what you want. The agent discovers paid
   x402/MPP services, checks their CrowdCode reputation, and pays per call
   through the enforced lifecycle.

```text
❯ find a service that returns live weather and get today's forecast

  → find_paid_service "live weather forecast"
  → inspect_paid_service POST api.weatherstation.xyz/forecast
  $ paid $0.02 → api.weatherstation.xyz (paid_success) · saved forecast.json
  → review_paid_service rating=5

  Today: 72°F, clear. Full forecast saved to artifacts.
  summary: spent $0.05, remaining $19.95, services 1, artifacts 1
```

## Providers

The default provider is the **x402 token proxy** (`x402ProxyUrl`, an
OpenAI-compatible route metered with x402 micropayments): requests pass
through unchallenged, and when the route demands payment (HTTP 402) the
challenge is signed with the shared AgentCash wallet — upto-style, so the
service settles actual usage against a quoted ceiling. No API keys, no
prepaid balance, OpenRouter-grade serving latency.

**Venice** is the wallet-native backup (`opencrowd config set provider
venice` or `/provider venice`): SIWX authentication, prepaid Venice credit
topped up with USDC, at most one bounded automatic top-up per exhausted
call. **OpenRouter** direct is also available with `OPENROUTER_API_KEY`.
There is no automatic fallback between providers — switching is always an
explicit choice, and a provider failure surfaces with a remediation
message.

Model preferences are per provider (`auto` resolves from the live catalog at
session start; resolved IDs are recorded on the session so `run --session`
reproduces them exactly). Change the running session with `/provider`,
`/model`, and `/submodel`; change future-session defaults with
`opencrowd config set`.

## Wallet

There is one wallet: AgentCash's. OpenCrowd shows public addresses,
balances, and funding links (`/wallet`, `/fund`) and never manages, copies,
or exports keys. See [SECURITY.md](SECURITY.md) for the enforcement model.

## Budget

The session budget is a local cumulative cap on value consumed — LLM
inference and paid services both count against it. Reservations are local,
a budget change never moves money, and the cap can never drop below already
finalized spend. Defaults come from configuration
(`opencrowd config set budget 20`); session creation never needs a network
lookup.

## Approval

Approval governs external service purchases only (LLM calls are governed by
the budget):

- `ask` (default) — a human approves each new service: allow once,
  always-allow with per-call/session caps, deny, or block.
- `auto` — no prompts; blocks, caps, reputation checks, the payment
  lifecycle, and the budget still apply.
- `off` — external purchases are prohibited; local tools and inference keep
  working.

Stored rules are managed with `/approvals`. Every confirmed paid call —
success or failure — requires a signed CrowdCode review before the next
purchase; pending reviews survive restarts.

## Commands

The generated, drift-checked reference is [docs/commands.md](docs/commands.md)
(`/help` and `opencrowd --help` render the same registry). One-shot and
scripting forms:

```sh
opencrowd run --budget 1.00 "Find a service and summarize options"
opencrowd run --session <session-id> "Follow up on the previous result"
opencrowd config show
opencrowd wallet balance
opencrowd doctor
opencrowd evals gaia --tier smoke --harness opencrowd,claude,codex
```

## Headless runs

```sh
opencrowd run --headless --prompt "..." --output json
```

Headless execution never waits for UI input: the approval mode comes from
`--approval ask|auto|off` (or the configured default), and in `ask` mode
un-ruled purchases are denied with a clear error instead of hanging. The
JSON output includes the outcome, final message, spend split, turn count,
resolved model policy, artifacts, and service calls — the same contract the
eval runner uses.

## Local state

| What | Where |
| --- | --- |
| Config (defaults for future sessions) | `~/.config/opencrowd/config.json` |
| Wallet | `~/.agentcash/wallet.json` (owned by AgentCash; never copied) |
| Approval rules | `~/.config/opencrowd/approvals.json` |
| Sessions, conversation, ledger, artifacts | `./sessions/<session-id>/` |
| Purchase receipts (append-only) | `./sessions/<session-id>/purchases.jsonl` |

Conversations persist per session and are automatically compacted when they
outgrow the model's context window (archives kept under
`sessions/<id>/context/`). `/clear` archives context while keeping the
session's spend, models, and policy; `/new` starts fresh.

## Development

```sh
npm install
npm run typecheck
npm test
npm run smoke        # build + bundle + demo + headless smoke tests
npm run deadcode     # knip: unused files, exports, dependencies
```

Package layout (see [docs/architecture.md](docs/architecture.md) for the
full contract): `packages/core` (vendor-neutral sessions, budget, storage,
tool contracts), `packages/economy` (typed AgentCash/CrowdCode adapters and
the enforced purchase lifecycle), `packages/agent-runtime` (LLM loop,
providers, subagents, DI runtime), `packages/evals` (GAIA benchmark
runner), `apps/cli` (the `opencrowd` binary, TUI, and command registry).

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed [MIT](LICENSE).
