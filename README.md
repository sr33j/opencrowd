# OpenCrowd

Local-first OpenCrowd runtime for discovering services, gating paid x402 calls, storing artifacts, and exposing the same tool surface through a first-party CLI, MCP server, and localhost API.

The previous app is preserved under `scratch/` as archived reference material. New build and test scripts operate only on the workspace packages.

## Quick Start

```sh
npm install
npm run build
npm test
```

Run the interactive CLI:

```sh
npm exec opencrowd
```

Inside the REPL, use slash commands for setup and run tasks:

```text
/wallet init
/wallet address
/wallet balance
/models list
/models set <model>
/budget 1.00
Find a service and summarize options
```

CLI sessions persist follow-up context in `messages.jsonl`. When a session grows beyond half of the active model context window, OpenCrowd archives the older raw transcript under `context/` and keeps a compacted continuation message in the active context.

`/wallet init` is the recommended wallet setup path. It selects the Agentic Wallet flow for new users, shows the active address, network, and asset, then prints concise funding instructions. Fund that address with Base USDC and run `/wallet balance` to verify spendable funds. Raw private keys in `.env` are treated as a legacy fallback, not the normal setup path.

One-shot commands still work:

```sh
npm exec opencrowd -- --help
npm exec opencrowd -- search "stock price"
npm exec opencrowd -- run --budget 1.00 --model <model> "Find a service and summarize options"
npm exec opencrowd -- run --session <session-id> "Follow up on the previous result"
```

Start integrations:

```sh
npm exec opencrowd -- mcp
npm exec opencrowd -- api --port 8787
```

## Local State

- Config: `~/.config/opencrowd/config.json`
- Permissions: `~/.config/opencrowd/permissions.json`
- Sessions: `./sessions/<session-id>/`
- Artifacts: `./sessions/<session-id>/artifacts/`
- Ledger: `./sessions/<session-id>/ledger.csv`
- Conversation: `./sessions/<session-id>/messages.jsonl`
- Compacted context archives: `./sessions/<session-id>/context/`

For a local EVM wallet fallback, `opencrowd wallet balance` reports the wallet's actual on-chain Base USDC balance as `spendable_balance` and includes Venice's linked x402 credit balance separately as `x402_credit_balance` when available.

## Wallet-Funded LLM Calls

The first-party CLI agent uses an x402-paid, OpenAI-compatible LLM route by default. Users initialize a payment wallet with `opencrowd wallet init`, fund the displayed address externally with USDC on the configured network, choose a model from the provider model list, and set a local session budget for each run.

Default model selection is explicit. OpenCrowd starts with `gpt-5.5`; if the configured x402 LLM provider does not return that model, run `opencrowd models list` and choose an available model with `opencrowd models set <model>` or pass `opencrowd run --model <model> ...`.

The session budget is a local cap, not a prepayment or escrow. By default, new OpenCrowd sessions use the active wallet's spendable balance as the local cap and run in `yolo` permission mode, where services are allowed unless explicitly blocked. You can override this with `--budget`, `--mode ask_first`, `--mode blocked`, or `OPENCROWD_BUDGET_CENTS`.

Unused budget never leaves the wallet. Each LLM loop iteration reserves the estimated maximum local cost, signs an x402 payment through the active wallet, records the actual charged cost from response metadata, and releases unused reservation. External service spend and LLM spend are separated in the final summary and `ledger.csv`. Every agent tool result includes the budget before and after that tool call.

When the default Venice x402 LLM route uses a local EVM wallet, OpenCrowd also checks Venice's linked x402 credit before each LLM call. If that Venice credit is below $2.00, it tops up enough Base USDC to bring the credit back to at least $5.00, subject to Venice's minimum top-up amount and the same local session budget. These transfers are recorded as `wallet_top_up` rows in `ledger.csv` and summarized separately from LLM usage and external service purchases.

Service discovery uses Coinbase CDP Bazaar by default. Existing configs that still point at the old Agentic Market default are migrated to Coinbase Bazaar on load; custom Bazaar URLs are still supported through local config.
