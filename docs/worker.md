# JSONL worker (experimental)

`opencrowd worker --protocol jsonl --agent-home /path/to/home --demo` runs the existing agent loop with a scripted model and real local file tools. It has no paid execution or local wallet fallback. Ordinary CLI commands keep their existing configuration and provider behavior.

stdin accepts protocol-v1 commands from `@opencrowd/protocol`; stdout emits only validated protocol events. Diagnostics go to stderr. Keep stdin open to submit cancellation while a run is active. Closing stdin drains the active run and exits.

The caller owns command IDs, run IDs, and preferably session IDs. Re-deliver the exact command envelope after a process interruption. Reusing an ID with different contents is rejected. Completed commands are acknowledged without another model/tool execution. Waiting runs resume only when the cause, session, and pending operation match.

`metadata/worker.json` contains the authoritative checkpoint and command acknowledgements. Non-secret configuration and session files live beneath the explicit home. Session paths are recalculated when restoring to another location. Checkpoints are atomically replaced and synced before terminal outcomes. Model requests receive a stable operation ID; a remote payment adapter must use that ID for reconciliation and must never create another authorization for an ambiguous payment.

An interrupted shell action with no recorded result fails for manual reconciliation instead of automatically replaying its side effects. Local file writes are repeatable, and recorded tool results are reused. The supervisor must copy artifacts and the quiescent home before acknowledging the terminal event; it must recover a missed artifact event by listing the checkpointed session files.

For a supervised hosted model, replace `--demo` with `--bridge-socket /absolute/path/to/model.sock`. Exactly one mode is required. The Unix socket accepts a bounded `POST /model` request containing the run, session, stable model-operation ID, messages, and built-in tool definitions. A response is either `{status:"complete",response:{content,toolCalls,finishReason?}}` or `{status:"paused",outcome,operationId,message}`. The supervisor authenticates remote requests and must constrain them to the current run; the worker receives no signing credentials. Interrupted requests pause for payment reconciliation without a provider fallback.

The same socket accepts a bounded `POST /tool` request for supervisor-executed tools (`HOSTED_ONLY_TOOL_NAMES`, currently `deploy_service`). The body carries the run, session, tool name, and arguments, with the entry artifact's source inlined by the worker; the response is a plain `{ok, data}` or `{ok:false, error}` tool result. Hosted-only tools are advertised only to hosted models, are refused by the local executor, and are memoized per checkpoint turn like every other tool. A lost tool response is reported to the model as an error rather than treated as a payment, because deployments are idempotent per slug.

Tests include a real `SIGKILL` between a completed file tool and the next model response, followed by process restart: the artifact and single user prompt survive, the completed tool is not repeated, and the next model operation keeps its original ID. Hosted subagent checkpointing and production image rollouts remain separate integration gates.
