# AX Improvement Plan: the OpenCrowd hosting contract

**Goal.** OpenCrowd agents will be launched, funded, supervised, and hosted by a
higher-level platform (orchestrator + web UI, agents running in Fly Machines).
Today OpenCrowd's implicit user is a *human at a TTY in a working directory*.
This plan redefines the contract so the primary consumer is a *program*, while
keeping the local human CLI/TUI experience fully intact as a client of the same
contract.

**The contract in one sentence:**

> An agent is a **directory** plus a **wallet** plus a **duplex event
> protocol**. Any process that boots from that directory resumes the agent; the
> host never needs to know anything that isn't in the directory or on the wire.

**Design rule for every change below:** the machine interface is primary, the
TUI/REPL becomes a consumer of it. Nothing here removes local-human usage —
`opencrowd` with no args still opens the Ink TUI.

---

## Current state (grounded in the code)

What already exists and is the right shape:

- `runAgentTask` accepts `onProgress` (typed `ProgressEvent`s for every loop
  step) and `onMessage` (per appended message) — the seed of the event stream
  (`packages/agent-runtime/src/index.ts`).
- `completeSession` builds a **structured** summary object (budget, llm_calls,
  service_calls, purchases, artifacts) — but `runAgentTask` renders it to a
  human string and discards the object (`packages/core/src/tools.ts`).
- Sessions are append-only files (`session.json`, `messages.jsonl`,
  `ledger.csv`) and completion is "soft" — `run --session <id>` resumes and
  continues. Crash-safe persistence already exists.
- The x402 payment stack, budget reserve/finalize ledger, and per-agent viem
  wallet on Base are solid and unchanged by this plan.

What violates the contract today:

- `opencrowd run` has **no JSON output mode**; stdout is pretty/compact human
  text; the return value is a rendered string.
- Exit codes are `0` or `1` only — a host cannot distinguish "done" from
  "out of money" from "crashed."
- **Out-of-funds is inconsistent:** service-payment failures degrade gracefully
  (tool error → retry guard → clean completion), but LLM budget/payment
  failures throw uncaught → **process exits 1**, stranding the budget
  reservation. Starting underfunded crashes on the first turn.
- State is split: wallet/config/permissions in `~/.config/opencrowd/`
  (`OPENCROWD_CONFIG_DIR`), sessions/ledger/artifacts under `process.cwd()`.
- Wallet secrets default to the **macOS keychain** (`security` CLI); Linux
  requires `OPENCROWD_WALLET_SECRET_STORE=file`. Headless Linux is not the
  default path.
- No mid-task steering (TUI blocks input while busy), no AbortSignal anywhere,
  no cancellation.
- Toolset is a fixed list of 13; the only capability switch is
  `OPENCROWD_SHELL_ENABLED`. No tool injection outside test mode.
- The funding poll (5s balance check + QR) lives inside a TUI React effect;
  only the URI/QR helpers in `apps/cli/src/tui/funding.ts` are reusable.

---

## Layer 1 — Process protocol: headless-first, TUI becomes a client

**Contract:** structured events out, control messages in, over stdio.

- New invocation mode (e.g. `opencrowd run --headless` or `opencrowd serve`):
  - **Events out:** newline-delimited JSON on stdout, one event per line.
    Vocabulary = the existing `ProgressEvent` types emitted as JSON instead of
    routed through `renderProgress`, plus new events:
    `assistant_message`, `payment_settled` (cents + running total),
    `funds_low`, `funding_required` (wallet address + suggested amount),
    `permission_request`, `session_compacted`, `completed` (carrying the full
    structured summary object from `completeSession`), `error` (typed).
  - **Control in:** JSON lines on stdin:
    `user_message` (steer inbox), `set_model`, `set_permission_mode`,
    `stop` (graceful), `permission_response` (async replacement for the TUI
    y/n modal — the loop emits `permission_request` and waits).
- The Ink TUI and REPL become renderers/clients of this protocol. Human
  experience unchanged; machine experience becomes first-class.
- Non-goal: token-delta streaming. Providers are non-streaming today;
  per-message events are sufficient for a chat UI.

## Layer 2 — Lifecycle: crash-only, wake-on-demand, meaningful exits

**Contract:** every start is a resume; an idle agent exits; exit codes carry
meaning. This is what makes Fly autostop/autostart work *for* the platform.

- **`OPENCROWD_AGENT_HOME` (one directory = the agent).** Collapse the
  config-dir/cwd split: wallet, secrets, config, permissions, sessions,
  ledger, artifacts, workspace all under a single root set by one env var or
  flag. This directory is the mounted Fly volume. Local default remains the
  current layout for backward compatibility.
- **Boot = resume.** Load session if present → reconcile stale budget
  reservations left by a crash (they persist in `session.json`) → drain queued
  inbox messages → work until quiescent → exit 0. "Persistent agent" means the
  directory persists, not the process.
- **Typed exit codes** (minimum set):
  `0` completed / quiescent · `10` stopped by user · `20` wallet
  empty / funding required · `21` session budget exhausted · `30` unrecoverable
  error. Each maps to a distinct orchestrator reaction (mark done / mark
  stopped / show fund button / show raise-budget button / alert).

## Layer 3 — Money: running dry is a state, not a crash

**Contract:** the wallet is the leash; "out of funds" is the most expected
state in the system and must be fully handled.

- **Underfunded = pause.** On any insufficient-funds condition (including LLM
  budget/payment reservation failures, which currently crash): checkpoint,
  emit `funding_required` with address and shortfall, exit with code 20. A
  deposit + restart resumes mid-task.
- **Extract the funding poll from the TUI** into core: reusable
  `awaitFunding()` built on `walletBalance()` + the pure helpers already in
  `funding.ts`. The TUI wizard and the headless mode both consume it.
- **Wallet-lifetime budget semantics.** Replace the hardcoded
  `min($20, balance)`-at-session-creation default with: budget = wallet
  balance, continuously re-checked; the $20 cap becomes a host-settable
  parameter (`OPENCROWD_BUDGET_CAP_CENTS`), not a constant.
- **Spend as events.** Mirror every ledger reserve/settle as
  `payment_reserved` / `payment_settled` events → live burn-down in the UI
  for free.
- **Sweep hook.** On terminal states, an optional configured hook (or event)
  lets the host reclaim leftover USDC to the owner's address as part of the
  lifecycle rather than a scavenging job. (Note: outbound USDC transfers need
  gas ETH; x402 payments themselves are gasless via EIP-3009 — the gas drip is
  the host's job.)

## Layer 4 — Control: steering, stopping, switching

- **Turn-boundary inbox in the loop itself.** Between LLM turns, the loop
  drains queued `user_message` control messages into the conversation. This
  also gives the local TUI mid-task steering it currently lacks.
- **Graceful stop flag** checked at turn boundaries (bounded by one LLM call's
  latency — acceptable, and payment-safe: never aborts an in-flight x402
  reservation). Process kill remains the hard fallback; Layer 2's
  reservation-reconciliation on boot makes it safe.
- **Model / permission-mode switching** via control messages; effective next
  turn. (Per-session model override already exists — this just exposes it.)
- Non-goal: hard mid-call aborts / AbortSignal plumbing through providers.

## Layer 5 — Capabilities: the host declares what the agent can touch

- **Capability profile at launch:** which of the built-in tools are enabled
  (generalize the shell on/off pattern to a per-tool enable list in config or
  env), workspace as the only writable root.
- **Open the tool-injection seam.** `runAgentTask` already accepts a custom
  `toolExecutor`; expose tool registration through `runPersistentAgentTask`
  and the headless CLI so a host can inject tools — first target: a
  `deploy_service` tool backed by the orchestrator (Fly machine per deployed
  service, rent metered from the agent's wallet).
- Non-goal for now: MCP *client* support (agent consuming external MCP
  servers). Host-injected tools cover the MVP.

## Layer 6 — Model-facing AX: the agent knows the truth about its life

The system prompt currently describes a local CLI session. A hosted agent
behaves better when its self-model matches reality (it sleeps, its wallet is
its lifespan, its owner reads a dashboard). But OpenCrowd must remain a great
*local human* tool — so the prompt is assembled dynamically per environment.

### Mechanism: environment profiles + explicit override

The system prompt is composed from three parts:

1. **Base prompt** — identity, tools, x402 usage. Shared by all environments.
2. **Environment profile** — a named block chosen at startup:
   - `local` (default): current behavior/prompt. Interactive human owner,
     terminal output, machine doesn't sleep.
   - `hosted`: adds the hosted facts —
     *"You run in a machine that sleeps between tasks; only your workspace
     directory persists — keep working state and a status note in files.
     Your wallet is your lifespan: you have $X; every model and service call
     spends it; if you run dry you are paused until your owner tops you up —
     budget your approach and flag tasks that look more expensive than your
     balance. Your owner can message you between turns; treat new messages as
     steering, not a new task. Finish with `complete_session` and a structured
     result — your owner reads it in a dashboard, not a terminal."*
3. **Host addendum (optional)** — free-text fragment supplied by the launcher
   (owner identity, task budget, platform-specific tools like
   `deploy_service`), via flag/env pointing at a file in `AGENT_HOME`
   (e.g. `context.md`).

### Selection precedence (explicit beats detected)

1. `--env-profile <local|hosted>` CLI flag
2. `OPENCROWD_ENV_PROFILE` env var (the orchestrator sets `hosted` on every
   machine — this is the normal hosted path)
3. **Auto-detection**, only when neither is set:
   - Fly machine indicators present (`FLY_APP_NAME` / `FLY_MACHINE_ID`) →
     `hosted`
   - containerized (`/.dockerenv`, cgroup markers) **and** no TTY → `hosted`
   - headless mode invoked with no TTY → `hosted`
   - otherwise → `local`
4. Default: `local`

Auto-detection is a convenience fallback; the orchestrator always sets the
env var explicitly, and a human can always force either profile (e.g. run the
`hosted` prompt locally for testing). Emit the resolved profile as a startup
event/log line so it's never ambiguous which prompt is in play.

### Dynamic values, not stale prose

Balance, budget, model, and owner-message expectations are injected as live
values at prompt-assembly time (and refreshed on resume), not baked into
static text — a resumed agent should see its *current* balance.

### `complete_session` enrichment

Extend the completion tool to accept explicit structured fields (outcome
status, artifacts produced, deployed URLs, follow-ups suggested) rather than
only a final message — in hosted mode this object is the deliverable the
dashboard renders.

---

## What changes where

**In OpenCrowd (contract-level, TUI benefits too):** headless stream-json
mode; JSON events from existing `onProgress`/`onMessage`; structured
completion output; typed exit codes; underfunded-as-pause + extracted funding
poll; `OPENCROWD_AGENT_HOME`; file secret store as the non-darwin default;
turn-boundary inbox + stop flag; capability profile / tool-injection seam;
environment-profile prompt assembly.

**In the orchestrator (host policy, not agent contract):** wallet minting and
funding UX, SIWE auth, WebSocket fan-out of the event stream to browsers,
sweep execution + gas drip, Fly machine lifecycle, `deploy_service` backend,
per-user metering, setting `OPENCROWD_ENV_PROFILE=hosted` + the host addendum.

**Explicit non-goals now:** token-delta streaming, hard mid-call interrupts,
MCP client, any rework of the x402/session/ledger core.

## Suggested order

1. **Layer 1 + Layer 2 exit codes** — headless event/control protocol and
   typed exits. Everything else composes with this; the orchestrator can be
   built against it immediately.
2. **Layer 3** — underfunded-as-pause, funding poll extraction, spend events.
   Highest product-critical bug surface today (LLM underfunding crashes).
3. **Layer 2 `AGENT_HOME` + Linux file secret store default** — required
   before the first real Fly deployment.
4. **Layer 4** — inbox steering + graceful stop (the UI's interrupt box).
5. **Layer 6** — environment profiles (cheap once 1–4 exist; do the flag/env
   plumbing early, the prompt content iterates freely afterward).
6. **Layer 5** — capability profiles + `deploy_service` injection (v1 hosting
   feature, not needed for first launch).
