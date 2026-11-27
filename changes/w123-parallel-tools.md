- **Read-only tool calls of one reply run together.** Consecutive
  `find_paid_service`, `inspect_paid_service`, `browse_services`, `read_file`,
  status reads, a GET `read_service`, and shell commands that only read start at
  the same time, at most four at once. The system prompt says so, so the
  model batches independent reads. In a hosted A/B (w123), three independent
  searches finished 34% sooner; success, turns and cost were unchanged.
  - Every other call is a barrier and runs alone where the model put it:
    paid calls, their holds and approvals, file writes, `vault_request`, and
    control and hosted tools. The model reads every result in the order it
    wrote the calls.
  - The hosted worker keys each call by the id the runtime gives it, not by
    "the first unfinished call with this name", and `tool.started` carries
    the call's `parallel` group for the trace.
  - The prompt says `vault_request` is only for requests that need a vault
    secret; told reads run together, models had fetched free URLs with it.
