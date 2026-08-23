# Security

OpenCrowd is a local agent that spends real USDC. Read this before pointing
it at funds you care about.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/sr33j/opencrowd/security/advisories/new)
with a description and reproduction steps. Do not open a public issue for
anything that could put user funds at risk. You should receive a response
within 72 hours.

## Security model: enforcement in code, not prompt trust

Economic safety never depends on the model following instructions. Every
guardrail below runs in ordinary code on every paid call, regardless of what
the model asks for:

- **A stable gateway is the only paid surface.** The model sees six tools
  (`get_wallet_status`, `find_paid_service`, `inspect_paid_service`,
  `call_paid_service`, `review_paid_service`, `bridge_usdc`). Raw vendor
  tools are never exposed to it.
- **The enforced purchase lifecycle** runs for every potentially paid call:
  inspect → CrowdCode reputation pre-check → approval policy → local budget
  reservation → AgentCash execution → outcome reconciliation → immutable
  receipt → required review → audit entry. A CrowdCode outage blocks new
  payments. Only rails CrowdCode verifies end-to-end (x402 USDC on Base,
  MPP USDC on Tempo) may pay automatically.
- **Approval policy** (`ask` by default) requires a human decision — allow
  once, always-allow with caps, deny, or block — before the first payment to
  any service. `auto` skips prompts but still enforces blocks, caps,
  reputation checks, the lifecycle, and the budget. `off` prohibits
  purchases entirely.
- **Session budgets** are a local cumulative cap on LLM and service spend,
  enforced with reserve/finalize accounting. A budget change never moves
  money, and the budget can never be set below already-finalized spend.
- **Payment evidence is quarantined.** Payment proofs, payer identity, and
  transaction hashes are captured by adapters into immutable receipts; they
  never enter prompts, model-visible tool results, or normal CLI output. The
  model cannot supply or forge review evidence — reviews are built from the
  stored receipt.
- **Ambiguous outcomes are never retried.** A transport failure on a
  state-changing call is recorded as `unknown`, conservatively charged at
  the quoted ceiling, and requires human attention before any retry.
- **Subagents structurally cannot pay**: they get local read/write tools
  only, cannot approve anything, and cannot spawn deeper subagents.

### Untrusted marketplace content (prompt injection)

Service listings, schemas, and responses are untrusted input to an LLM. A
malicious listing can try to talk the agent into paying for it — which is
why approval, reputation, caps, and budgets are enforced in code, not left
to the model's judgment.

### The wallet

AgentCash owns wallet creation and custody (`~/.agentcash/wallet.json`).
OpenCrowd reads the key at signing time for Venice SIWX authentication and
never copies, exports, or stores it elsewhere. There is no OpenCrowd wallet
registry, no seed-phrase export, and no key material under
`~/.config/opencrowd/`. Treat the AgentCash wallet as a dedicated, low-value
agent wallet: budgets are local policy, and a compromised machine exposes
whatever the wallet holds.

### Shell access

The agent has a gated shell tool (enabled by default in the interactive
CLI). Commands run with your user's privileges in the workspace. Disable it
with `--disable-shell` or `OPENCROWD_SHELL_ENABLED=0`.

### What OpenCrowd does not do

- No telemetry; nothing is phoned home. Sessions, ledgers, receipts, and
  artifacts stay in `./sessions/`, and config stays in
  `~/.config/opencrowd/`.
- No custodial service: no server holds keys or funds on your behalf.
