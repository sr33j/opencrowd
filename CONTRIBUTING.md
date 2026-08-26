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
npm run typecheck        # tsc project-wide (noUnusedLocals/Parameters on)
npm test                 # vitest, including architecture invariants
npm run deadcode         # knip: unused files, exports, dependencies
npm run smoke            # build + bundle + demo + headless smoke tests
node apps/cli/dist/index.js --demo   # run the TUI against mocks
```

Demo mode uses in-memory mock AgentCash/CrowdCode adapters through the real
enforced lifecycle — you never need real funds to develop or test. Live paid
tests must stay explicit, low-value, and opt-in.

## Project layout

| Package | Purpose |
| --- | --- |
| `packages/core` | Vendor-neutral sessions, budget, conversation, artifacts, ledger, local tool contracts |
| `packages/economy` | Typed AgentCash/CrowdCode adapters, approval rules, purchase receipts, the enforced gateway |
| `packages/agent-runtime` | LLM loop, BlockRun/x402/Venice/OpenRouter providers, subagents, DI runtime |
| `packages/evals` | GAIA benchmark runner |
| `apps/cli` | The `opencrowd` binary: TUI, command registry, headless runs |

`docs/architecture.md` is the authoritative product/architecture contract;
`docs/commands.md` is generated from the live command registry (CI fails on
drift — regenerate with `node scripts/generate-command-docs.mjs` after a
build).

## Pull requests

- Keep PRs focused; small is fast to review.
- Add or update tests for behavior changes — especially anything touching
  budgets, approvals, the purchase lifecycle, or payment evidence handling.
- `npm run typecheck && npm test && npm run smoke` must pass.
- Changes that affect how money moves (defaults, caps, approval flows)
  should call that out explicitly in the PR description.

## Security issues

Do **not** open public issues for vulnerabilities that could put user funds
at risk — see [SECURITY.md](SECURITY.md).
