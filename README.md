# OpenCrowd

**A CLI agent with its own wallet.** Give it a task and a budget; it finds paid
[x402](https://www.x402.org/) services on the open market, pays for them in
USDC on Base, and gets the job done — asking you before it spends on anything
new, and writing every cent to a local ledger.

[![CI](https://github.com/sr33j/opencrowd/actions/workflows/ci.yml/badge.svg)](https://github.com/sr33j/opencrowd/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![OpenCrowd demo: the agent asks permission, pays an x402 service, and accounts for every cent](docs/demo.gif)

## Try it in 60 seconds (no crypto required)

```sh
npx opencrowd --demo
```

Demo mode runs the full loop — service discovery, payment, artifacts, ledger —
against a mock wallet, mock x402 services, and a mock LLM. No real money moves.

## Run it for real

```sh
npx opencrowd
```

First launch is two steps — there is no wallet setup:

1. **Fund the wallet** — it already exists (created automatically, shared
   with the AgentCash and CrowdCode tools so everything draws one balance).
   Scan the QR or tap the MetaMask link to send a few dollars of USDC on
   Base. The wallet is the agent's entire blast radius: it can never spend
   more than you put in.
2. **Give it a task** — type what you want. The agent discovers paid
   x402/MPP services through its connectors, checks their CrowdCode
   reputation, and pays per call.

```text
❯ find a service that returns live weather and get today's forecast

  → find_paid_service "live weather forecast"
  → inspect_paid_service POST api.weatherstation.xyz/forecast
  $ paid $0.02 → api.weatherstation.xyz (paid_success) · saved forecast.json
  → review_paid_service rating=5

  Today: 72°F, clear. Full forecast saved to artifacts.
  summary: spent $0.05, remaining $19.95, services 1, artifacts 1
```

The LLM itself is paid from the same wallet: Venice inference runs on
prepaid credit topped up with USDC — no API keys, no subscriptions.

## Safety model

Real money demands real guardrails. The defaults:

- **`ask_first` permission mode** — the agent must show you the service URL,
  reason, and cost caps before its first payment to any service. Approve with
  one key. Shift+tab toggles to `yolo` (auto-approve) when you want speed.
- **Session budgets** — default `min($20, wallet balance)`, enforced locally
  with reserve/finalize accounting around every paid call. Unused budget never
  leaves the wallet.
- **Burner-wallet design** — the agent has its own low-value wallet, never
  your main one. Worst case is bounded by what you deposited.
- **Full ledger** — every LLM call, service payment, and top-up lands in
  `sessions/<id>/ledger.csv` with costs, tx hashes, and artifacts.
- **No telemetry** — everything stays on your machine.

Read [SECURITY.md](SECURITY.md) for the full threat model, including how we
treat marketplace content as prompt-injection input.

## Commands

Inside the interactive UI (`/help` shows this live):

| Command | What it does |
| --- | --- |
| `/budget <usd>` | Set the local session spend cap |
| `/mode ask_first\|yolo\|blocked` | Set permission mode (shift+tab toggles) |
| `/wallet address\|balance` | Show the shared AgentCash wallet |
| `/models list\|set <model>` | Pick the x402 LLM model |
| `/ledger show` | Show this session's spend ledger |
| `/summary` | Spend and artifacts so far |

One-shot and scripting forms:

```sh
opencrowd run --budget 1.00 "Find a service and summarize options"
opencrowd run --session <session-id> "Follow up on the previous result"
opencrowd run --headless --prompt "..." --output json   # programmatic run contract
opencrowd wallet balance
opencrowd evals gaia --tier smoke --harness opencrowd,claude,codex
```

`evals gaia` runs the GAIA validation split
against OpenCrowd — and optionally Claude Code and Codex with the same prompt
template and scorer — reporting accuracy and cost per question (OpenCrowd's
cost is measured on-chain spend; comparators are estimates).

## Local state

| What | Where |
| --- | --- |
| Config | `~/.config/opencrowd/config.json` |
| Wallet | `~/.agentcash/wallet.json` (owned by AgentCash; never copied) |
| Service permissions | `~/.config/opencrowd/permissions.json` |
| Sessions, ledger, artifacts | `./sessions/<session-id>/` |

Conversations persist per session and are automatically compacted when they
outgrow the model's context window (archives kept under `sessions/<id>/context/`).

## Configuration notes

- **Provider**: Venice is the default LLM provider, authenticated with the
  shared AgentCash wallet (SIWX) and paid from prepaid Venice credit.
  OpenRouter is optional via `OPENROUTER_API_KEY`. There is no automatic
  fallback between providers.
- **Models**: per-provider `model`/`submodel` preferences in config
  (`"venice": {"model": "auto", "submodel": "auto"}`). `auto` resolves from
  the live catalog at session start; the resolved IDs are recorded on the
  session for reproducibility. The main loop gets
  `spawn_subagent`/`check_subagents` tools (local tools only, one level deep,
  parallel with background mode).
- **Connectors**: paid capability comes from vendor MCP servers (AgentCash
  for wallet/payments, CrowdCode for reputation), configured under
  `mcpServers` in config with pinned versions. Their tools are ingested
  verbatim (`agentcash_fetch`, `crowdcode_get_service_score`, ...) and their
  own instructions become prompt context.
- **Env overrides**: `OPENCROWD_BUDGET_CENTS`, `OPENCROWD_PERMISSION_MODE`,
  `OPENCROWD_SHELL_ENABLED`, `OPENCROWD_CONFIG_DIR`, `OPENCROWD_TEST_MODE`.

## Development

```sh
npm install
npm run build
npm test
```

Monorepo layout: `packages/core` (wallets, x402, sessions, budgets, ledger),
`packages/agent-runtime` (LLM loop + tools + subagents), `packages/evals`
(GAIA benchmark runner), `apps/cli` (the `opencrowd` binary and TUI).

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed [MIT](LICENSE).
