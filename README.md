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

First launch walks you through setup:

1. **Create a wallet** — a fresh keypair that lives only on your machine
   (seed phrase in your OS keychain, backup confirmed before anything is saved).
2. **Fund it** — scan the QR or tap the MetaMask link to send a few dollars of
   USDC on Base. The wallet is the agent's entire blast radius: it can never
   spend more than you put in.
3. **Give it a task** — type what you want. The agent searches the
   [Coinbase x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/welcome) for
   services that can help, and asks your permission before paying any new one.

```text
❯ find an x402 service that returns live weather and get today's forecast

  → search_services query="live weather forecast"
  ← search_services found 7 candidates; top: WeatherStation ($0.02 USDC)
  $ paid $0.02 → api.weatherstation.xyz (HTTP 200) · saved forecast.json

  Today: 72°F, clear. Full forecast saved to artifacts.
  summary: spent $0.05, remaining $19.95, services 1, artifacts 1
```

The LLM itself is paid the same way: OpenCrowd uses an x402-metered,
OpenAI-compatible route (Venice by default) funded from the same wallet — no
API keys, no subscriptions.

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

## Use it from Claude, Codex, or any MCP client

OpenCrowd doubles as an MCP server, so your existing coding agent can search
the bazaar, make x402 payments, and manage budgets using OpenCrowd's wallet:

```sh
claude mcp add opencrowd -- npx -y opencrowd mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "opencrowd": { "command": "npx", "args": ["-y", "opencrowd", "mcp"] }
  }
}
```

There's also a localhost HTTP API: `opencrowd api --port 8787`.

## Commands

Inside the interactive UI (`/help` shows this live):

| Command | What it does |
| --- | --- |
| `/budget <usd>` | Set the local session spend cap |
| `/mode ask_first\|yolo\|blocked` | Set permission mode (shift+tab toggles) |
| `/wallet new\|list\|balance\|use\|export` | Manage payment wallets |
| `/models list\|set <model>` | Pick the x402 LLM model |
| `/search "<query>"` | Search the x402 service bazaar |
| `/permissions list\|allow\|block <url>` | Manage allowed/blocked services |
| `/ledger show` | Show this session's spend ledger |
| `/summary` | Spend and artifacts so far |

One-shot and scripting forms:

```sh
opencrowd run --budget 1.00 "Find a service and summarize options"
opencrowd run --session <session-id> "Follow up on the previous result"
opencrowd search --json "stock price"
opencrowd wallet balance
```

## Local state

| What | Where |
| --- | --- |
| Config | `~/.config/opencrowd/config.json` |
| Wallet metadata | `~/.config/opencrowd/wallets.json` (no secrets) |
| Seed phrases | OS credential store (Keychain on macOS) |
| Service permissions | `~/.config/opencrowd/permissions.json` |
| Sessions, ledger, artifacts | `./sessions/<session-id>/` |

Conversations persist per session and are automatically compacted when they
outgrow the model's context window (archives kept under `sessions/<id>/context/`).

## Configuration notes

- **Model**: starts as `claude-opus-4-6` on the Venice x402 route. If your
  provider doesn't offer it, `opencrowd models list` then `models set <model>`.
- **Venice credit top-ups**: when the linked x402 credit drops below $5.00,
  OpenCrowd tops it back up to $7.50 from the wallet (configurable; recorded
  as `wallet_top_up` ledger rows).
- **Discovery**: Coinbase CDP Bazaar by default; custom bazaar URLs supported
  in config.
- **Env overrides**: `OPENCROWD_BUDGET_CENTS`, `OPENCROWD_PERMISSION_MODE`,
  `OPENCROWD_SHELL_ENABLED`, `OPENCROWD_CONFIG_DIR`, `OPENCROWD_TEST_MODE`.

## Development

```sh
npm install
npm run build
npm test
```

Monorepo layout: `packages/core` (wallets, x402, sessions, budgets, ledger),
`packages/agent-runtime` (LLM loop + tools), `packages/mcp`,
`packages/local-api`, `apps/cli` (the `opencrowd` binary and TUI).

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed [MIT](LICENSE).
