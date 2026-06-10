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
/wallet new
/wallet list
/wallet address
/wallet balance
/models list
/models set <model>
/budget 1.00
Find a service and summarize options
```

CLI sessions persist follow-up context in `messages.jsonl`. When a session grows beyond half of the active model context window, OpenCrowd archives the older raw transcript under `context/` and keeps a compacted continuation message in the active context.

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
- Wallet metadata: `~/.config/opencrowd/wallets.json`
- Permissions: `~/.config/opencrowd/permissions.json`
- Sessions: `./sessions/<session-id>/`
- Artifacts: `./sessions/<session-id>/artifacts/`
- Ledger: `./sessions/<session-id>/ledger.csv`
- Conversation: `./sessions/<session-id>/messages.jsonl`
- Compacted context archives: `./sessions/<session-id>/context/`

`opencrowd wallet new` creates a fresh OpenCrowd wallet, assigns a random unused fruit label, and shows a seed phrase backup flow before the wallet is activated. Wallet metadata is stored in `wallets.json`; seed phrases are stored in the OS credential store when available and are not written to config. If you lose the computer and did not back up the seed phrase, OpenCrowd cannot recover the wallet.

Use `opencrowd wallet list` to show all wallets and balances, and `opencrowd wallet use <label-or-address>` to switch the active wallet. For a local EVM wallet, `opencrowd wallet balance` reports the wallet's actual on-chain Base USDC balance as `spendable_balance` and includes Venice's linked x402 credit balance separately as `x402_credit_balance` when available.

In `--test-mode`, OpenCrowd uses test wallets with mock USDC balances. `/wallet fund <amount>` is available only in test mode and funds the active test wallet for mock LLM calls and mock x402 services.

## Wallet-Funded LLM Calls

The first-party CLI agent uses an x402-paid, OpenAI-compatible LLM route by default. Users fund the active payment wallet externally with USDC on the configured network, choose a model from the provider model list, and set a local session budget for each run.

Default model selection is explicit. OpenCrowd starts with `claude-opus-4-6`; if the configured x402 LLM provider does not return that model, run `opencrowd models list` and choose an available model with `opencrowd models set <model>` or pass `opencrowd run --model <model> ...`.

The session budget is a local cap, not a prepayment or escrow. By default, new OpenCrowd sessions use the active wallet's spendable balance as the local cap and run in `yolo` permission mode, where services are allowed unless explicitly blocked. You can override this with `--budget`, `--mode ask_first`, `--mode blocked`, or `OPENCROWD_BUDGET_CENTS`.

Unused budget never leaves the wallet. Each LLM loop iteration reserves the estimated maximum local cost, signs an x402 payment through the active wallet, records the actual charged cost from response metadata, and releases unused reservation. External service spend and LLM spend are separated in the final summary and `ledger.csv`. Every agent tool result includes the budget before and after that tool call.

When the default Venice x402 LLM route uses a local EVM wallet, OpenCrowd also checks Venice's linked x402 credit before each LLM call. If that Venice credit is below $5.00, it tops up enough Base USDC to bring the credit back to at least $7.50, subject to Venice's minimum top-up amount and the same local session budget. These transfers are recorded as `wallet_top_up` rows in `ledger.csv` and summarized separately from LLM usage and external service purchases.

Service discovery uses Coinbase CDP Bazaar by default. Existing configs that still point at the old Agentic Market default are migrated to Coinbase Bazaar on load; custom Bazaar URLs are still supported through local config.
