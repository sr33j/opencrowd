# OpenCrowd interactive commands

<!-- Generated from the live command registry by scripts/generate-command-docs.mjs. Do not edit by hand. -->

Interactive slash commands act on the current session. Wallet → spending limits also saves defaults for future queries.
Persistent defaults can also change through `opencrowd config` or `opencrowd wallet limits`.

| Command | What it does |
| --- | --- |
| `/status` | Session, provider, models, wallet/credit, budget, and approval mode |
| `/provider [help\|blockrun\|openrouter-x402-proxy\|venice\|openrouter]` | Show or select this session's LLM provider (validated immediately) |
| `/models [refresh]` | List models for the active provider (cached; `refresh` refetches) |
| `/model [id\|auto]` | Show or set this session's main model |
| `/submodel [id\|auto\|off]` | Show, set, auto-select, or disable this session's subagent model |
| `/budget <usd>` | Change the current query budget (saved defaults stay the same) |
| `/approval ask\|auto\|off` | Control external-service purchase approval for this session |
| `/approvals [allow <service> [--max-cost <usd>] [--session-max <usd>] \| remove <service> \| block <service>]` | List/manage stored service allow/block rules and caps |
| `/wallet` | Open Wallet: balance and editable spending limits |
| `/fund` | Show funding instructions and links for the shared wallet |
| `/ledger` | Show normalized LLM usage, purchases, top-ups, and totals (no secrets) |
| `/summary [verbose]` | Summarize work, artifacts, service calls, and spending so far |
| `/clear` | Archive and clear conversation context; keep session, spend, models, policy |
| `/new` | Start a new session with configured defaults |
| `/help` | Show the command registry |
| `/quit` | Finalize and exit (after required reviews are resolved) |

16 commands. Autocomplete, `/help`, and
`opencrowd --help` render from this same registry.
