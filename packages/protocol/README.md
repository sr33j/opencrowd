# @opencrowd/protocol

Versioned, runtime-validated JSONL envelopes for OpenCrowd machine mode
(`opencrowd worker --protocol jsonl`). A supervisor writes **commands** to the
worker's stdin and reads **events** from its stdout, one JSON object per line.
This package is the only contract between the two sides: it has no runtime
dependency other than `zod`, and no knowledge of any hosting vendor.

## Envelope

Every message carries:

| Field             | Notes                                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| `protocolVersion` | Integer major version. Currently `1`.                                     |
| `id`              | Message ID. For commands this is the command ID.                          |
| `seq`             | Strictly increasing per stream (commands and events are separate streams). |
| `emittedAt`       | ISO 8601 timestamp with `Z` or offset.                                    |
| `type`            | Discriminator, e.g. `run.start`, `run.finished`.                          |
| `commandId`       | Events only: the command that caused the event, where applicable.         |
| `runId`           | Present on every run-scoped message.                                      |
| `payload`         | Typed per `type`.                                                         |

Monetary amounts are USDC atomic units (6 decimals) carried as base-10 integer
strings (`"1000000"` = 1 USDC). Floats are rejected.

## Commands (supervisor -> worker)

- `run.start`: session directive (`existing` or `create`), prompt, model policy, budget, approval mode.
- `run.resume`: session ID plus a typed `cause` (`approval_granted`, `funds_available`, `delegation_renewed`, `payment_reconciled`) and the resolved `operationId`. It must not carry a prompt; the runtime resumes from its checkpoint.
- `run.cancel`: reason.
- `worker.shutdown`: checkpoint any active run, then exit.

## Events (worker -> supervisor)

`worker.ready`, `command.accepted`, `command.rejected`, `run.state`,
`assistant.delta`, `assistant.message`, `tool.started`, `tool.finished`,
`artifact.created`, `usage.updated`, `approval.required`, `funding.required`,
`delegation.required`, `payment.unknown`, `checkpoint.completed`,
`run.finished`, `runtime.error`.

`run.finished` carries one of the typed outcomes: `completed`, `idle`,
`waiting_for_funds`, `waiting_for_approval`, `waiting_for_delegation`,
`budget_exhausted`, `user_stopped`, `payment_unknown`, `max_turns`, `failed`,
`cancelled`. Waiting outcomes name the pending `operationId` a later
`run.resume` must reference.

## Helpers

- `parseCommandLine(line)` / `parseEventLine(line)`: decode one JSONL line into
  `{ ok: true, value }` or `{ ok: false, error }`. They never throw. Error kinds:
  `invalid_json`, `invalid_envelope`, `unsupported_version`, `unknown_type`,
  `invalid_payload`.
- `encodeCommand(command)` / `encodeEvent(event)`: validate and emit exactly one
  line with a trailing newline. `encodeEvent` redacts the payload first (opt out
  with `{ redact: false }`). Both throw `ProtocolEncodeError` rather than emit an
  invalid line.
- `redact(value)`: deep-copies a value dropping keys that look like
  `authorization`, `cookie`, `token`, `secret`, `password`, `credential`, or
  `*key`. Token counts (`maxTokens`, `inputTokens`, `tokenCount`) are kept.
- `createSeqTracker()`: classifies incoming `seq` values as `accepted`,
  `duplicate`, or `out_of_order`.

## Version policy

- `protocolVersion` is a single integer major. Decoders accept exactly the
  major they were built for and fail closed (`unsupported_version`) on any other.
- Within a major, changes must be additive and optional: new event/command
  fields, new optional payload members. Objects are parsed with passthrough, so
  a newer peer's extra fields survive decode and re-encode on an older peer.
- Removing or renaming a field, changing a type, adding a required field,
  adding a new message `type`, or adding an enum member that an older peer
  must act on requires a new major.
- Golden fixtures under `test/fixtures/` are the compatibility corpus: every
  command and event type has a valid sample, and `test/fixtures/invalid/` pins
  the error kind for known-bad inputs.
