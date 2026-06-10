# Contributing to OpenCrowd

Thanks for your interest! Issues, bug reports, and PRs are all welcome.

## Development setup

Requirements: Node.js >= 20.

```sh
git clone https://github.com/sr33j/opencrowd.git
cd opencrowd
npm install
npm run build
npm test
```

Useful loops:

```sh
npm run typecheck        # tsc project-wide
npm test                 # vitest
node apps/cli/dist/index.js --demo   # run the TUI against mocks
```

Demo/test mode (`--demo`) uses a mock wallet, mock x402 services, and a mock
LLM — you never need real funds to develop or test.

## Project layout

| Package | Purpose |
| --- | --- |
| `packages/core` | Wallets, x402 payments, sessions, budgets, permissions, ledger |
| `packages/agent-runtime` | LLM loop, tool execution, progress events |
| `packages/mcp` | MCP server exposing the tool surface |
| `packages/local-api` | Localhost HTTP API |
| `apps/cli` | The `opencrowd` binary: TUI, one-shot commands |

## Pull requests

- Keep PRs focused; small is fast to review.
- Add or update tests for behavior changes — especially anything touching
  budgets, permissions, or payment signing.
- `npm run build && npm test` must pass.
- Changes that affect how money moves (defaults, caps, approval flows) should
  call that out explicitly in the PR description.

## Security issues

Do **not** open public issues for vulnerabilities that could put user funds
at risk — see [SECURITY.md](SECURITY.md).
