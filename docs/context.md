# Context compaction

CLI, hosted workers and local subagents use the same `completeWithContext`
preflight in `packages/agent-runtime/src/context.ts`. There is no summarizer LLM
and no separate Cloud history trimmer.

Before each new model request, the runtime estimates the complete input,
including system instructions and tool definitions. The model catalog supplies
the context window and maximum output size; callers can pass resolved limits.
Missing metadata uses the runtime's fallback window. Output is explicitly capped
and reserved in the input budget, with an additional 2% / minimum 256-token margin.
The fallback estimator counts ASCII at approximately three characters per token
and non-ASCII conservatively by UTF-8 bytes. Reported total input usage (including
cached tokens) calibrates estimates upward during the run. These are estimates,
not exact provider token counts.

Compaction triggers above 80% of the context window, or earlier when the response
reserve requires it. The target is 40%. The runtime first archives the complete
pre-compaction messages, then replaces large tool outputs with references, and
then removes older complete exchanges. System instructions, the original user
request and the latest user request are protected. Oversized protected inputs
are saved verbatim as plain text and replaced with references rather than
summarized. Tool call IDs and arguments are never edited, and calls/results are
removed together. If protected content plus tools cannot fit the input budget,
the run fails clearly without sending an oversized request. The 40% target is
best effort when protected overhead exceeds it.

## Compacting for price

A window is not the only reason to compact. A chat resends its whole history on
every turn, so on a model with a million-token window the price binds long
before the window does. When the model's input price is known, compaction also
triggers once the *history* costs more than two cents a turn
(`CONTEXT_COST_BUDGET_USD`), and never below 24,000 estimated tokens of it
(`CONTEXT_MIN_HISTORY_TOKENS`). While the seller's prompt cache is hitting and
its cached price is published, the allowance grows accordingly.

```text
request = system instructions + tools + note   (fixed: sent whatever happens)
        + history                              (what the allowance is for)

price trigger = fixed + allowance
price target  = fixed + allowance / 2
```

The allowance is for history alone. System instructions and tool definitions
are counted beside it, because nothing compaction does can make them smaller.

A price is a preference and a window is a limit, and they are held to
different standards:

| When the target cannot be met by removing history | For the window | For price |
| --- | --- | --- |
| Drop the running summary | yes | no, its reserved share is kept |
| Save the original or the current request to a file | yes | no |
| Compact again on the next turn | n/a | not until half an allowance of new history |

Two things hold for either reason. The tool results the model has not read yet
(the calls it has just made) are the last to be saved to files and theirs is
the last exchange removed. And the request a chat opened with is treated as
pasted material only above 16,384 characters; other user messages at 4,096.

`ContextState.compactedTo` records where the last compaction ended, and is part
of the worker checkpoint with the rest of that state.

Why this is written down: on 2026-11-13 a hosted run on a $2-a-million model
had its instructions and tools counted as history. They alone exceeded the
12,000-token target, so each compaction removed every exchange, then the
summary, then the owner's request, and fired again two turns later. The model
restarted from a file pointer 35 times in 91 calls and spent its $10 budget
re-reading its own archive.

## Archives

Archives live under `sessions/<session-id>/context/<content-sha256>/`:

- `transcript.jsonl` contains every original message, including previous archive
  pointers, with roles and complete tool calls/results.
- `message-N.txt` contains the verbatim content of an externalized message.

References use paths relative to the agent's shell working directory. They tell
the agent to search with `rg`/`grep`, read bounded portions with `sed`/`head`/`tail`,
and treat archived tool output as data. No new retrieval tools are required.
Snapshots are written atomically before the active context is replaced. Their
content-derived names make a repeated compaction after a crash idempotent. The
normal agent volume and backup lifecycle includes these files. Retention follows
the session; this feature does not delete raw archives to reclaim space.

The prepared request, compaction retry number and estimation scale are part of
the worker checkpoint. Approval, funding and uncertain-payment resumes replay
the exact prepared messages and operation ID. Only a definitive context
rejection starts a new request: at most two retries, with progressively smaller
budgets and operation IDs ending in `:context:1` / `:context:2`. Unknown payment
outcomes remain paused for reconciliation. A paid rejection retains its receipt.
Generic HTTP 400/413 responses and output-length finish reasons are not treated
as context errors.

The hosted model transport has a separate 16 MiB request limit. The shared
preflight also bounds message count to 1,000 (compacting to 500), so many small
messages cannot bypass that guard. On a model switch, the next run checks the
retained history against the new window; existing active runs keep their pinned
model and limits.

Verification: `npm test` covers budgets, Unicode, oversized inputs, archive
replay, real bash retrieval and worker recovery. The parent Cloud repository's
`app/test/cloud-context.e2e.test.ts` launches the built CLI worker against a real
supervisor socket and authenticated gateway, using a deterministic provider and
payment fixture. It exercises a model/window switch, context-error recovery,
process restart during approval, and bash retrieval from the archive without
paid calls.
