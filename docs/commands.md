# OpenCrowd interactive commands

<!-- Generated from the live command registry by scripts/generate-command-docs.mjs. Do not edit by hand. -->

All interactive slash commands mutate or inspect the current session.
Persistent defaults change only through `opencrowd config`.

| Command | What it does |
| --- | --- |
| `/status` | Session, provider, models, wallet/credit, budget, and approval mode |
| `/provider [x402\|venice\|openrouter]` | Show or select this session's LLM provider (validated immediately) |
| `/models [refresh]` | List models for the active provider (cached; `refresh` refetches) |
| `/model [id\|auto]` | Show or set this session's main model |
| `/submodel [id\|auto\|off]` | Show, set, auto-select, or disable this session's subagent model |
| `/budget <usd>` | Set this session's cumulative local spend cap (never moves money) |
| `/approval ask\|auto\|off` | Control external-service purchase approval for this session |
| `/approvals [allow <service> [--max-cost <usd>] [--session-max <usd>] \| remove <service> \| block <service>]` | List/manage stored service allow/block rules and caps |
| `/wallet` | Show public AgentCash balances and deposit addresses |
| `/fund` | Show funding instructions and links for the shared wallet |
| `/ledger` | Show normalized LLM usage, purchases, top-ups, and totals (no secrets) |
| `/summary [verbose]` | Summarize work, artifacts, service calls, and spending so far |
| `/clear` | Archive and clear conversation context; keep session, spend, models, policy |
| `/new` | Start a new session with configured defaults |
| `/help` | Show the command registry |
| `/quit` | Finalize and exit (after required reviews are resolved) |

16 commands. Autocomplete, `/help`, and
`opencrowd --help` render from this same registry.
