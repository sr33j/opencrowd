# Changelog

## 0.13.2 — 2026-10-28

- Say plainly that a move the policy already allows is the agent's own to make. Verified on mainnet, 0.13.1 told an agent holding $0.81 on Base exactly which `bridge_usdc` call would pay a Tempo-only service, and the agent stopped and asked its owner to "authorize a quoted Base→Tempo transfer" — on an auto-approval wallet with a $1 per-call limit, where the three-cent fee needed no permission at all. The honest explanation was the point of 0.13.1 and it worked; stopping in front of an unlocked door was not. The funding hint, the `bridge_usdc` description and the hosted prompt now state that a move inside the rule is ordinary work, that the spending guard applies the owner's approval mode to the fee by itself, and that asking first is the dead end the rule exists to prevent.

## 0.13.1 — 2026-10-28

- A hosted agent whose USDC is on the wrong network finishes the job instead of giving up. Asked for a stock price, an agent holding $0.88 on Base and $0.10 on Solana found a quote sold only on Tempo for $0.021, was told to move at least $1, and reported to its owner that the service "required funds on a single supported network" — with a funded wallet and a two-cent purchase in front of it.
  - `funding_required` now offers the cheaper way out first: look for an equivalent service on a network the wallet already funds. Every `find_paid_service` result lists its `networks`, the networks it can be paid on, so that choice is visible in the search result rather than only after a 402.
  - When no such service fits, the move is sized to what the wallet actually holds. It still aims at $1, so one fee funds many later calls, but under a dollar it moves what the richest other network can spare, never less than the price plus the bridge's cut, and holds a $0.25 working reserve on Base (where inference is paid from) except as far as the purchase needs it. The policy is explicit: a move is made on the agent's own judgement only while its fee stays under a fifth of what moves — about $0.15 at Relay's flat $0.02-0.03 fee — which keeps the intent of the old $1 minimum without turning it into a dead end.
  - Below that the agent asks instead of spending most of the move on its fee, and says what it costs: "this service is sold only on tempo, moving $0.08 there would cost about $0.03 in fees". The hosted prompt now also states that a funding problem must be reported as exactly that — which network the service is sold on, what the wallet holds where, and the one thing needed — and never as the service being unsuitable, nor with a recorded `request_service` offered as the answer the owner asked for.

## 0.13.0 — 2026-10-27

- `request_service` takes four required fields instead of free text: `input` (the clear input the user will give), `output` (the exact output they want back), `problem` (what it solves) and `price_per_call` (what the agent would pay per call, in USD). The tool description gives a worked example and asks for a reusable service rather than the agent's own task, and the end-of-run reflection asks for the same four fields. CrowdCode validates them, keeps every request private, and publishes only generalized proposals with demand and the median price agents would pay.
- Reputation evidence is CrowdCode's summary only: pros, cons and things to watch out for, each fenced as untrusted data. CrowdCode no longer returns individual review text to anyone, so nothing a single reviewer wrote reaches a model verbatim.
- The knowledge-tree generator reads the same summaries. Evidence entries are summary points with stable ids (`svc_x#p2`) instead of raw reviews (`svc_x#r2`).

## 0.12.1 — 2026-10-24

- Hosted agents are told when their toolchain disk is temporary. On the hosted heavy compute tier, `$HOME` and `$TMPDIR` live on a scratch disk that is deleted when the agent returns to the standard tier or after a few idle days; the hosted prompt now says so, points at `$OPENCROWD_SCRATCH_DIR`, and asks agents to keep anything the owner needs under `artifacts/`. The Lean 4 recipe now expects to fetch Mathlib's cache again in a later session.
- `run_shell` passes `TMPDIR` and `OPENCROWD_SCRATCH_DIR` through to commands, so an agent can tell whether it has a scratch disk and temporary files land where the space is. Local CLI runs are otherwise unchanged.

## 0.12.0 — 2026-10-22

- A platform judge, not the reviewing agent, writes the public score and text of a hosted paid review. When a hosted agent calls `review_paid_service` for a settled purchase, the gateway runs one fixed-prompt model call that sees only the stated task, the exact request it sent, the exact response the provider returned, and the payment outcome — never the owner's chat — and that verdict becomes the published rating and review text. The agent's own rating and notes are passed in as labelled evidence the judge reads. The agent pays for the call (about $0.0002); if it fails, the review is still submitted in the agent's own words as unweighted community evidence rather than blocking the run.
- Agents are shown only reviews that carry ranking weight, fenced as untrusted data. Reputation evidence from CrowdCode previously included every recent review verbatim, so one agent's stored review text reached another agent's model. Weighted reviews are written by CrowdCode's judge, and the text is now wrapped in `<untrusted>` delimiters it cannot close, with an instruction that the contents are data and never instructions. Unverified community reports stay readable on crowdcode.app and no longer reach a model.

## 0.11.3 — 2026-10-22

- Hosted agents are told about the files their owner sends them. The host now saves a file the owner attached to a message under `uploads/` in the session before the message arrives, and names it in the prompt with its path, size and type. The hosted prompt explains the directory once so the rule survives context trimming: read a text file with `read_file` at `uploads/<name>` and any file with `run_shell` at `artifacts/uploads/<name>`; those files are already the owner's and already in their file list, so never copy or re-save one under `artifacts/` to hand it back; write your own outputs elsewhere under `artifacts/`, because nothing written into `uploads/` is delivered; and if a file the message names is missing, say so and ask for it again rather than guessing at its contents. Local CLI runs are unchanged.

## 0.11.2 — 2026-10-20

- Correct what the hosted prompt says about delivering files. 0.11.1 told agents every file in the session workspace reaches the owner; only `artifacts/` does, so an agent asked to "save it under generated/" wrote outside the published tree and the owner received nothing. The prompt now states that `artifacts/` is the delivered directory, that the owner sees each file without that prefix, and that the final message should name a file at exactly the path the owner sees.

## 0.11.1 — 2026-10-20

- Hosted agents buy a capability before asking the owner for personal credentials. Asked to send an email, an agent would call `request_secret` for a GMAIL_ACCESS_TOKEN and stop, when a paid email service it could pay for itself cost $0.02. The hosted prompt now says to search for a payable service for email, SMS, phone, publishing, storage and similar work and pay for it, and to request a secret only when the task genuinely needs the owner's own account or identity, or when nothing payable covers it — never ending a run on a secret request that a purchase would have finished.

## 0.11.0 — 2026-10-20

- The machine that runs an agent can now allow a single `run_shell` command to take longer than five minutes. `OPENCROWD_MAX_SHELL_TIMEOUT_MS` lets the host raise the cap to what its CPU, memory and disk justify; it can only be raised, never lowered, and never past 45 minutes, and the `run_shell` schema advertises the machine's real cap so the model asks for a timeout it can actually get. Local CLI runs are unchanged at five minutes unless the variable is set. Fetching Mathlib's prebuilt `.olean` files, or any comparable download or compile, no longer dies at the old ceiling.
- Hosted agents are told how to install a heavy toolchain instead of filling the disk: measure `df -h "$HOME"`, `free -m` and `nproc` first, install under `$HOME` (the persistent volume, excluded from the per-run workspace backup, while the session workspace is archived after every run with a 25 MB cap), pass a real `timeout_ms`, keep build output in a file, re-check free space between steps, and after two `No space left on device` or OOM failures stop retrying and tell the owner which limit was hit and how much is needed. A concrete Lean 4 recipe follows: elan into `$HOME`, the project under `$HOME` so `lake-manifest.json` pins the toolchain, `lake exe cache get` before `lake build`, never compile Mathlib from source, roughly 2 GB for the toolchain and 10 GB for the cache, and a file containing `sorry` is not a proof.

## 0.10.1 — 2026-10-20

- A run always ends with the answer the agent gave. The CrowdCode reflection step (and a pending required review) buys an extra turn after `complete_session`; whatever the agent said in that turn used to overwrite the answer, so the owner read "Reflection completed. I submitted one paid-service demand" instead of the result. The delivered answer is now held and returned unchanged; the closing text is kept as `reflection_note` for diagnostics, and the gate tells the agent its answer is already saved. A new user instruction still clears the held answer.
- Hosted agents are told how to point at the files they produce: write the exact workspace-relative path (`generated/report.pdf`), never an invented download URL, a `sandbox:` link or a `/mnt/data` path. The hosted web UI turns those paths into working download and preview links.

## 0.10.0 — 2026-10-20

- Find the best service across Base, Solana and Tempo. `find_paid_service` with a query now sends AgentCash's results, the payer's networks and its per-network balances to CrowdCode's new `find_service`, which adds Coinbase's x402 catalog, the mpp.dev MPP catalog and CrowdCode's reviewed services, then ranks by CrowdCode quality, the effective price on each service's best network (including about $0.03 to move USDC between your own networks when that network's balance is short), then the balance there. AgentCash's default search found 2 of 29 Solana-only and 49 of 127 MPP catalog services; these are now found. Results keep that order after the usual payability probe and show `rank`, `quality`, `best_network`, `effective_price_usd`, `transfer_needed` and `sources`. With CrowdCode off, or when its ranking is unavailable, AgentCash's order is used. Both CLI and hosted agents use it; the system prompt tells agents to prefer the top service that fits, whatever its network, and to move funds between their networks when needed if they have a tool for it.
- Pay on the network whose balance covers the price. The preferred network still wins when its balance covers the price; when it does not, the first of Base, Solana and Tempo whose balance does is used instead of failing.
- Probe catalog results that omit the HTTP method with POST, then GET.
- Send `call_paid_service` inputs for GET endpoints as query parameters. A body on GET failed before payment ("Request with GET/HEAD method cannot have body"), which made many catalog services unusable.
- `find_paid_service` asks for the capability in a few words ("web search", "object storage"), not the task's subject, which matched irrelevant services.
- Upgrade the default CrowdCode MCP client to `crowdcode-mcp@0.9.1` (adds `find_service`). Configs pinned to a previously shipped default (through 0.9.0) upgrade automatically.

## 0.9.0 — 2026-10-20

- Hosted agents can move their own USDC between Base, Solana and Tempo from chat with `bridge_usdc`. `quote_only` shows the fee and expected amount. Executing applies the owner's spending policy to the fee: ask mode, the per-call limit or the query budget pause the run for approval, and the approved resume repeats the same move. It then waits for the funds to arrive and reports both transactions. Funds always go to the agent's own address, and a replayed tool call never moves twice. The fee counts as the run's spending; the hosted financial snapshot reports it as `transfer_fees_usdc`.
- When a hosted purchase fails with `funding_required`, the error now lists the agent's available USDC per network and, when another network holds enough, the `bridge_usdc` call that would make the purchase payable. The hosted system prompt tells the agent to move funds and retry instead of switching services, and to report the wallet as one total.

## 0.8.1 — 2026-10-20

- Send the seller's payee with Solana purchase reviews. x402 Solana receipts omit it, so CrowdCode rejected reviews of services it had not seen before ("payment recipient is not registered"); the payee now comes from the inspected offer when the payment settled on that rail.

## 0.8.0 — 2026-10-20

- Upgrade the default CrowdCode MCP client to `crowdcode-mcp@0.8.0`, which verifies x402 Solana payments and signs the Solana payer link from the AgentCash Solana wallet, so Solana purchase reviews count as verified. Configs pinned to a previously shipped default (through 0.7.0) upgrade automatically; other custom pins are preserved.
- Pay x402 services on Solana through AgentCash's Solana account. Set `--payment-network solana`, `OPENCROWD_PAYMENT_NETWORK=solana` or `opencrowd config set payment-network solana` to prefer it. AgentCash is pinned to Solana for those calls. Reviews carry `x402:solana:<signature>` and the Solana payer address. crowdcode-mcp 0.8.0 adds the payer-link signature from the AgentCash Solana wallet.
- Choose among a service's offers across networks. The preferred network (default Base) still wins whenever it is offered, so current users see no change. Otherwise OpenCrowd uses the first of Base, Solana and Tempo (MPP) whose AgentCash balance covers the price, plus Monad when preferred. MPP `tempo` charges in USDC.e are now paid automatically. Inspection lists every offered network with its price and payability.
- Show each network's address and USDC in `wallet balance`, the new `wallet accounts`, `wallet address` (Solana address), `/status` and `opencrowd doctor`.
- Hosted agents can now pay MPP on Tempo and x402 on Solana as well as Base. The hosted gateway picks the network, and receipts record it. Inspection reports every offered network and quotes the ceiling across payable ones. MPP challenges are read from `WWW-Authenticate: Payment`. Monad-only and other-chain services are refused, with a message listing what hosted agents can pay. When control reports per-network balances, the hosted financial snapshot and prompt describe them.

## 0.7.0 — 2026-10-14

- Upgrade the default CrowdCode MCP client to `crowdcode-mcp@0.7.0`, which accepts x402 Monad payment receipts. Configs still pinned to the previous shipped default (0.6.0) upgrade automatically; other custom pins are preserved.
- Pay x402 services on Monad mainnet (eip155:143). With `--payment-network monad`, `OPENCROWD_PAYMENT_NETWORK=monad`, or `opencrowd config set payment-network monad`, an inspected service that offers Monad USDC is paid with a natively signed x402 v2 `exact` (EIP-3009) authorization from the AgentCash wallet. The service's facilitator settles and pays gas. Services without a Monad offer still pay on Base, and the default stays Base. Reputation checks, approvals, spending limits, budget reservations and receipts apply unchanged. Required reviews carry `x402:monad:<tx>` with the decoded settlement receipt as proof.
- Send JSON-string request bodies to Monad services as `application/json`, unless the caller set a content type. The unpaid probe and the paid retry carry identical method, headers and body.
- After a failed paid Monad retry with no settlement receipt, check the signed nonce with USDC's EIP-3009 `authorizationState`. An unused nonce is recorded as a failed, uncharged call with its budget released, so the agent can correct its input. The record notes that the authorization stays valid until its `validBefore`. A used nonce, or an unreadable chain, keeps the payment state unknown.
- Show Monad USDC for the AgentCash address in `wallet balance`, `/status`, the model's wallet status, and `opencrowd doctor`. `OPENCROWD_MONAD_RPC_URL` overrides the default Monad RPC.
- Keep streamed tool-call IDs when providers such as Qwen send empty IDs on continuation chunks. Also accept object-valued tool arguments and index-less deltas, and surface in-stream provider errors.
- Add Kimi K3 (`moonshot/kimi-k3`) to the default knowledge-tree proposer mix (`opencrowd evals evolve`). On the held-in suite its tree matched baseline accuracy (14/15) at 47% lower cost ($0.30 vs $0.56) with half the paid calls; a third model family adds diversity to the evolutionary population.

## 0.6.1 — 2026-09-23

- Preserve prepared answers through completion reflection and checkpoint restarts. Successful service requests satisfy reflection without an extra model call; empty responses without an answer fail explicitly instead of displaying “Session completed.”
- Keep reflection follow-ups valid, allow corrected completion calls, and invalidate saved answers when the user changes the task.
- Give hosted agents authoritative wallet balances and current-query spending, including model costs and payment holds, with instructions to carry authorized business tasks through to concrete results.
- Wait the full supervisor window on hosted paid calls instead of two minutes, so slow services such as image generation are no longer abandoned while the gateway is still paying for them. After a lost socket the identical purchase is re-posted once; the gateway replays a finished attempt by purchase ID, and anything still in flight is reported as a named timeout with unknown payment state.
- Reset the consecutive paid-service failure counter on a successful purchase, so three unrelated failures across a long run no longer stop it.

## 0.6.0 — 2026-09-20

- Add CrowdCode on/off controls with session and persistent defaults, plus listing and selective deletion of the agent's own reviews. Hosted settings survive worker restarts; disabling CrowdCode leaves spending limits unchanged.
- Reflect once before completion on concrete services worth paying for to remedy actual task failures or detours. Submit no demand when no qualifying gap exists.
- Route hosted review management through the authenticated signing gateway and upgrade the local MCP default to 0.6.0.

## 0.5.4 — 2026-09-19

- Allow paid and unpaid stored interactions through the same review tool in CLI and cloud, with stable retry IDs and no new completion gate for unpaid reviews.
- Share product evidence formatting, including recent unpaid reports, payment verification labels, and summary failure modes.
- Keep backend rejections pending instead of treating a successful MCP transport as review acceptance.
- Pin CrowdCode MCP 0.5.3 and upgrade previously shipped defaults. Requires that client release, backend migration, and coordinated hosted gateway deployment.

## 0.5.3 — 2026-09-18

- Pin the default CrowdCode MCP client to 0.5.2, migrate the previously shipped floating default, and prevent older globally installed binaries from silently overriding the configured CrowdCode version. Explicit custom commands and pins are preserved.

## 0.5.2 — 2026-09-18

- Persist failed review attempts and defer repeatedly rejected reviews without
  discarding receipts. Limit review completion gates to the query that made the
  purchase, so a registry rejection cannot stop a later retry or continuation.


## 0.5.1 — 2026-09-18

- Share AgentCash search and endpoint inspection between CLI and cloud, filtering
  to x402 USDC on Base and allowing services without prior CrowdCode reviews.
- Queue steering messages during active work and deliver them after a complete
  tool batch. Preserve cloud message delivery across checkpoints and restarts.
- Support authenticated job polling and save inline generated media as binary
  artifacts instead of including base64 in model context.
- Keep retries recoverable after cancellation and allow long-running hosted
  requests to finish without duplicating a paid operation.


## 0.5.0 — 2026-09-17

- Replace cumulative budgets with configurable automatic limits of $1 per paid
  call and $10 per query. Model calls, paid tools and subagents share the query
  allowance; calls above a limit pause for approval before payment.
- Add Wallet spending limits and choices to approve once, decline, or raise only
  the current query budget. Persist approvals and checkpoints for CLI resume and
  hosted worker restarts without repeating completed calls.
- Use the same spending decision logic in the CLI and hosted payment gateway.
- Compact context before payment and preserve exact prepared requests across
  approval restarts, including parallel subagent checkpoints.

- Trim the replayed conversation to 48 KB before each hosted model request
  (`trimHostedMessages`): the system prompt, the original task and the last
  four messages are always kept; older tool outputs are blanked first, then
  whole older turns are dropped with their tool results, and only then is a
  single oversized message cut down. Hosted agents no longer die once their
  history nears the bridge's 64 KB limit.
- Classify hosted bridge failures. A non-200 response whose JSON body says
  `paid: false` now fails the run with the bridge's user-readable message
  (`HostedRequestError`) instead of pausing with `payment_unknown`; every
  ambiguous failure still pauses for payment reconciliation.
- Add the hosted-only `request_secret` tool, which asks the user to add a
  named secret to the agent's encrypted vault through the host UI. The model
  references secrets by name (`env.NAME` via `deploy_service` `secrets`) and
  is told never to ask for values in the chat.
- Emit a redacted `input` summary on `tool.started` events (commands, paths
  and identifiers only; never file contents or secret values).
- Give hosted agents paid services. With `--bridge-socket` the worker builds
  the economy gateway with hosted adapters (`createHostedEconomy`): discovery
  and reputation from CrowdCode's public API, inspection by an unpaid probe
  that decodes the x402 v2 `payment-required` offer, and payment, review and
  balance over the supervisor socket as `economy.pay`, `economy.review` and
  `economy.balance`. Only CrowdCode-listed x402 services on Base are payable;
  MPP/Tempo listings are shown but refused. The hosted system prompt now
  describes the agent's own USDC wallet instead of saying paid services are
  unavailable, the loop will not finish with an unreviewed paid purchase, and
  economy tool calls are summarized on `tool.started`.
- Clamp `run_shell` `timeout_ms` into 1–30000 ms (non-integers fall back to
  the 10-second default) instead of rejecting the call; hosted models were
  repeatedly failing with "timeout_ms must be between 1 and 30000".

## 0.4.0 — 2026-09-15

- Add hosted workers with a versioned command/event protocol, explicit homes,
  resumable checkpoints, and a scoped model bridge.
- Add generalized evaluation suites and knowledge-tree evolution commands.
- Load the CrowdCode knowledge tree into agent prompts and copy category
  references into session artifacts. Include the knowledge snapshot and
  evaluation tasks in the npm package.
- Preserve multiline terminal pastes.
- Publish GitHub releases to npm using Trusted Publishing, with package
  version checks and a packed-CLI smoke test.

- Add the hosted-only `deploy_service` tool. Hosted workers advertise it to
  the model and execute it through the supervisor over the existing
  credential-free bridge socket (`POST /tool`), inlining the entry artifact.
  Local runs never advertise it and refuse it if asked by name.
- Preserve provider finish reasons, reject prematurely closed LLM streams,
  and make one bounded continuation when generation reaches its output-token
  limit instead of silently completing with a response cut off mid-word.
- Do not treat x402/MPP price or protocol metadata as proof of settlement.
  Paid calls now require a verifiable settlement reference before they become
  reviewable `paid_success`/`paid_failure` records; missing receipts are
  recorded conservatively as unknown and are never retried.

## 0.3.2 — 2026-08-27

Field note 001 fixes (issues 2 and 3):

- Stop losing paid x402/MPP receipts. AgentCash's fetch returns the response
  body and the payment metadata as separate MCP content blocks; these were
  joined into one unparseable string, so settled payments reconciled as
  `free` with no charge, no receipt, and no required review — while leaking
  the raw receipt to the model. Multi-block tool results now parse per
  block, the metadata (tx hash, receipt header, dollar price, rail) becomes
  stored purchase evidence charged at the actual amount with
  `review_required: true`, and the model sees only the vendor body.
- Read the session ledger with a real RFC 4180 parser. Quoted multiline
  `notes` cells (e.g. Markdown summaries) no longer shear into phantom rows
  in `opencrowd ledger` output.

## 0.3.1 — 2026-08-26

- Rebuild every internal workspace package during `prepack`, preventing a
  manual publish from bundling stale provider code.
- Migrate the former x402 default to BlockRun and rename the legacy route to
  `openrouter-x402-proxy` (the old `x402` spelling remains an input alias).
- Add descriptive `/provider` and `/provider help` output, preserve complete
  copyable `/fund` links, and keep `/models` routed through the active provider.

## 0.3.0 — 2026-08-25

- Make BlockRun the default LLM provider, using its official x402 v2 SDK,
  with the prior x402 token proxy as the bounded per-call rescue provider.
- Require Node.js 22 or newer, matching the CLI's runtime dependencies.

## 0.2.1 — 2026-08-25

- `opencrowd --version` (also `-v` / `version`) prints the installed version.

## 0.2.0 — 2026-08-25

Breaking clean-architecture rewrite. There is no migration path; obsolete
surfaces were removed rather than shimmed (no wallet/config data on disk is
deleted).

Breaking removals:

- The OpenCrowd MCP server (`opencrowd mcp`) and localhost API
  (`opencrowd api`) are gone, along with their packages.
- The legacy wallet registry, local mnemonic creation, Keychain integration,
  fruit labels, `wallet new|use|list|fund|export`, and direct `wallet send`
  are gone. AgentCash's wallet (`~/.agentcash/wallet.json`) is the only
  wallet; OpenCrowd shows public addresses/balances and never manages keys.
- The Coinbase Bazaar fallback, generic x402 client, raw connector tool
  surface, and the `x402-tokens.fly.dev` LLM route are gone.
- `PermissionMode` (`ask_first`/`yolo`/`blocked`) is replaced by
  `ApprovalMode` (`ask`/`auto`/`off`); `OPENCROWD_PERMISSION_MODE` is now
  `OPENCROWD_APPROVAL_MODE` and `run --mode` is now `run --approval`.
- Interactive `/run`, `/search`, `/permissions`, `/models set`,
  `/test-mode`, `/test-seed`, and the non-TTY REPL are gone. Non-interactive
  callers use `opencrowd run --headless`.
- Config keys `x402LlmBaseUrl`, `x402LlmModel`, `x402LlmMaxCostCents`,
  `modelPolicy`, and `bazaarUrl` are replaced by `provider`,
  `venice`/`openrouter` model preferences, and explicit budget/approval
  defaults.
- Only the `opencrowd` CLI package is published; internal workspace packages
  carry no semver promise.

New architecture:

- Typed LLM providers: the x402 token proxy (default; OpenAI-compatible
  route, pay-per-request via wallet-signed upto challenges only when the
  route demands payment, streaming, cached-challenge pre-signing), Venice
  (wallet-native backup; SIWX auth, prepaid credit, one bounded automatic
  top-up with one retry), and direct OpenRouter (`OPENROUTER_API_KEY`).
  Sessions never silently migrate providers; switching is always explicit.
- Tail-latency hardening: every proxy call streams with liveness watching —
  a stream silent for 90s aborts as a transient timeout instead of waiting
  out the full deadline; transient faults ride a bounded ladder (one retry,
  then one ledgered rescue call on the paired backup provider, with the
  primary parked after three consecutive rescues); headless/eval runs cap
  the per-request deadline at 240s; sub-cent LLM costs keep fractional
  cents in the ledger instead of rounding to zero; in-flight proxy
  completions are capped (default 6) so excess concurrency queues
  client-side instead of inflating the proxy's time-to-first-token.
- Delegation policy: subagents are for parallel fan-out only — the prompt
  now requires two or more independent subagents per delegation and keeps
  sequential work in the main loop; `evals gaia` accepts
  `--subagent-model <model|off>`.
- Provider money/routing actions respect approval mode: in `ask` mode a
  backup-provider rescue call and an automatic Venice credit top-up each
  require explicit confirmation through the purchase-approval surface, and
  `off` mode disables automatic top-ups (Venice deposits are
  non-withdrawable); the default per-top-up cap drops from $10 to $5.
- One enforced paid-capability lifecycle behind a stable six-tool gateway:
  discover → inspect → CrowdCode pre-check → approval → budget reservation →
  AgentCash execution → reconciliation → immutable receipt → required
  CrowdCode review → audit. Pending reviews survive restarts and block both
  further purchases and session completion.
- Append-only `sessions/<id>/purchases.jsonl` receipts; payment proofs and
  tx hashes are stored for reviews but never shown to the model or CLI.
- Sessions own provider, exact resolved main/subagent model IDs, budget,
  approval mode, conversation, artifacts, and audit data; all of it survives
  `run --session`.
- One command registry drives slash commands, autocomplete, `/help`,
  `opencrowd --help`, and the generated `docs/commands.md` (CI fails on
  drift). New commands: `/status`, `/provider`, `/model`, `/submodel`,
  `/approval`, `/approvals`, `/fund`, `/new`, plus top-level
  `opencrowd config` (future-session defaults) and `opencrowd doctor`.
- The TUI renders instantly from local state; vendors, balances, and model
  catalogs initialize in the background. Balance calls are deduplicated and
  catalogs are cached with `/models refresh`.
- The local runtime is constructible via `createOpenCrowdRuntime({...})`
  dependency injection; the CLI is one adapter around it.
- `--demo` exercises the real enforced lifecycle over in-memory mock
  adapters — no real money, no network.

## 0.1.0 — unreleased

Initial open-source release (superseded by the 0.2.0 rewrite).
