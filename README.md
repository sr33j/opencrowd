# OpenCrowd

Local-first OpenCrowd runtime for discovering services, gating paid x402 calls, storing artifacts, and exposing the same tool surface through a first-party CLI, MCP server, and localhost API.

The previous app is preserved under `scratch/` as archived reference material. New build and test scripts operate only on the workspace packages.

## Quick Start

```sh
npm install
npm run build
npm test
```

## Install

OpenCrowd is distributed as the `opencrowd` npm package. The package installs one binary, `opencrowd`, which includes the interactive CLI, one-shot commands, the MCP stdio server, and the localhost API.

For a global install:

```sh
npm install -g opencrowd
opencrowd --help
```

For one-off usage without a global install:

```sh
npx opencrowd --help
npx opencrowd run --budget 1.00 "Find a service and summarize options"
```

The package is published from `apps/cli`; the workspace root stays private. The `opencrowd` package depends on the published workspace libraries `@opencrowd/core`, `@opencrowd/agent-runtime`, `@opencrowd/mcp`, and `@opencrowd/local-api`, so publish those scoped packages at the same version before publishing `opencrowd`.

Release order:

```sh
npm run pack:check
npm publish --workspace @opencrowd/core --access public
npm publish --workspace @opencrowd/agent-runtime --access public
npm publish --workspace @opencrowd/mcp --access public
npm publish --workspace @opencrowd/local-api --access public
npm publish --workspace opencrowd
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

One-shot commands still work:

```sh
npm exec opencrowd -- --help
npm exec opencrowd -- search "stock price"
npm exec opencrowd -- run --budget 1.00 --model <model> "Find a service and summarize options"
npm exec opencrowd -- run --session <session-id> "Follow up on the previous result"
```

Start integrations:

```sh
npm exec opencrowd -- mcp --budget 0
npm exec opencrowd -- api --port 8787
```

For an installed package, drop `npm exec`:

```sh
opencrowd mcp --budget 0
opencrowd api --port 8787
```

MCP clients should launch OpenCrowd over stdio. For example:

```json
{
  "mcpServers": {
    "opencrowd": {
      "command": "npx",
      "args": ["opencrowd", "mcp", "--budget", "0"]
    }
  }
}
```

If `opencrowd` is installed globally, use `"command": "opencrowd"` and `"args": ["mcp", "--budget", "0"]` instead. Increase the budget when the MCP session should be allowed to spend from the configured wallet.

A curl installer is not required for the current Node-based distribution path because `npm install -g opencrowd` and `npx opencrowd` are the native package manager flows and keep dependency resolution, upgrades, and binary linking under npm. A future curl script should be a thin convenience wrapper around npm or a signed standalone binary only after release signing and update behavior are defined.

## Local State

- Config: `~/.config/opencrowd/config.json`
- Permissions: `~/.config/opencrowd/permissions.json`
- Sessions: `./sessions/<session-id>/`
- Artifacts: `./sessions/<session-id>/artifacts/`
- Ledger: `./sessions/<session-id>/ledger.csv`
- Conversation: `./sessions/<session-id>/messages.jsonl`
- Compacted context archives: `./sessions/<session-id>/context/`

For a local EVM wallet, `opencrowd wallet balance` reports the wallet's actual on-chain Base USDC balance as `spendable_balance` and includes Venice's linked x402 credit balance separately as `x402_credit_balance` when available.

## Wallet-Funded LLM Calls

The first-party CLI agent uses an x402-paid, OpenAI-compatible LLM route by default. Users fund the active payment wallet externally with USDC on the configured network, choose a model from the provider model list, and set a local session budget for each run.

Default model selection is explicit. OpenCrowd starts with `gpt-5.5`; if the configured x402 LLM provider does not return that model, run `opencrowd models list` and choose an available model with `opencrowd models set <model>` or pass `opencrowd run --model <model> ...`.

The session budget is a local cap, not a prepayment or escrow. By default, new OpenCrowd sessions use the active wallet's spendable balance as the local cap and run in `yolo` permission mode, where services are allowed unless explicitly blocked. You can override this with `--budget`, `--mode ask_first`, `--mode blocked`, or `OPENCROWD_BUDGET_CENTS`.

Unused budget never leaves the wallet. Each LLM loop iteration reserves the estimated maximum local cost, signs an x402 payment through the active wallet, records the actual charged cost from response metadata, and releases unused reservation. External service spend and LLM spend are separated in the final summary and `ledger.csv`. Every agent tool result includes the budget before and after that tool call.

When the default Venice x402 LLM route uses a local EVM wallet, OpenCrowd also checks Venice's linked x402 credit before each LLM call. If that Venice credit is below $2.00, it tops up enough Base USDC to bring the credit back to at least $5.00, subject to Venice's minimum top-up amount and the same local session budget. These transfers are recorded as `wallet_top_up` rows in `ledger.csv` and summarized separately from LLM usage and external service purchases.

Service discovery uses Coinbase CDP Bazaar by default. Existing configs that still point at the old Agentic Market default are migrated to Coinbase Bazaar on load; custom Bazaar URLs are still supported through local config.
