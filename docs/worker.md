# JSONL worker (experimental)

`opencrowd worker --protocol jsonl --agent-home /path/to/home --demo` runs the existing agent loop with a scripted model and real local file tools. It has no paid execution or local wallet fallback. Ordinary CLI commands keep their existing configuration and provider behavior.

stdin accepts protocol-v1 commands from `@opencrowd/protocol`; stdout emits only validated protocol events. Diagnostics go to stderr. Keep stdin open to submit cancellation while a run is active. Closing stdin drains the active run and exits.

The caller owns command IDs, run IDs, and preferably session IDs. Re-deliver the exact command envelope after a process interruption. Reusing an ID with different contents is rejected. Completed commands are acknowledged without another model/tool execution. Waiting runs resume only when the cause, session, and pending operation match.

`metadata/worker.json` contains the authoritative checkpoint and command acknowledgements. Non-secret configuration and session files live beneath the explicit home. Session paths are recalculated when restoring to another location. Checkpoints are atomically replaced and synced before terminal outcomes. Model requests receive a stable operation ID; a remote payment adapter must use that ID for reconciliation and must never create another authorization for an ambiguous payment.

An interrupted shell action with no recorded result fails for manual reconciliation instead of automatically replaying its side effects. Local file writes are repeatable, and recorded tool results are reused. The supervisor must copy artifacts and the quiescent home before acknowledging the terminal event; it must recover a missed artifact event by listing the checkpointed session files.

The current CLI intentionally requires `--demo`. Remote payments, hosted subagent checkpointing, and production image rollouts are separate integration gates.
