# Security

OpenCrowd is a local agent that holds a real USDC wallet and spends real money.
Read this before pointing it at funds you care about.

## Reporting a vulnerability

Please email **7104877+sr33j@users.noreply.github.com** with a description and reproduction
steps. Do not open a public issue for anything that could put user funds at
risk. You should receive a response within 72 hours.

## Threat model

### The agent wallet is a blast radius, not a bank account

OpenCrowd is designed around a dedicated, low-value wallet:

- The wizard creates a **fresh wallet** that exists only on your machine.
  Fund it with what you are willing to let an autonomous agent spend.
- Session budgets default to **min($20, wallet balance)** and are enforced
  locally with reserve/finalize accounting before every paid call.
- **Never** point OpenCrowd at a primary wallet. Budgets are a local policy
  gate; if the machine or key is compromised, the entire wallet is exposed.

### Untrusted marketplace content (prompt injection)

The agent reads service titles, descriptions, and responses from public x402
marketplaces (Coinbase Bazaar by default). That content is **untrusted input
to an LLM that controls a funded wallet**. A malicious listing could try to
talk the agent into paying for it.

Mitigations:

- The default permission mode is **`ask_first`**: the agent must ask you
  before paying any service it has not been granted, and the approval prompt
  shows the service URL, the stated reason, and cost caps.
- Per-service caps (`max_cost_cents`, `session_max_cents`) and the session
  budget bound the damage of any single bad decision.
- `yolo` mode (auto-approve unless blocked) is an explicit opt-in via
  shift+tab or `--mode yolo`. Use it with budgets you can afford to lose.

### Key storage

- Seed phrases are stored in the **OS credential store** (e.g. macOS
  Keychain) when available. They are never written to `config.json` or
  `wallets.json`.
- `OPENCROWD_WALLET_SECRET_STORE=file` switches to a plaintext
  `wallet-secrets.json` with `0600` permissions. This exists for headless
  environments and tests; treat it as unencrypted key material on disk.
- `OPENCROWD_WALLET_PRIVATE_KEY` / `WALLET_PRIVATE_KEY` env vars (and `.env`)
  are supported as an escape hatch. Shell history, process listings, and
  committed `.env` files are common leak paths — prefer the managed wallet,
  and only use burner keys here.
- `opencrowd wallet export` reveals the seed phrase after an explicit
  interactive confirmation. Anyone with the phrase can spend the wallet.

### Shell access

The CLI agent has a gated shell tool (enabled by default in the interactive
CLI, disabled by default for the MCP server and local API). Commands run with
your user's privileges in the workspace. Disable it with `--disable-shell` or
`OPENCROWD_SHELL_ENABLED=0` if you do not want the model running commands.

### What OpenCrowd does not do

- No telemetry; nothing is phoned home. Sessions, ledgers, and artifacts stay
  in `./sessions/` and config stays in `~/.config/opencrowd/`.
- No custodial service: there is no server holding your keys, and no way to
  recover a wallet without the seed phrase backup.
