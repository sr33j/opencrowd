- **Read-only tool calls of one reply can run together, behind a flag.**
  `OPENCROWD_PARALLEL_TOOLS=1` starts consecutive read-only calls
  (`find_paid_service`, `inspect_paid_service`, `browse_services`, `read_file`,
  a GET `read_service`, a shell command that only reads) at the same time, at
  most four at once; `=hint` also tells the model so. Off when unset, which is
  every hosted agent today (harness experiment w123).
  - Every other call is a barrier and runs alone where the model put it, so a
    paid call, its hold and approval, a file write and the read after it keep
    their order. The model reads every result in the order it wrote the calls.
  - The hosted worker keys each call by the id the runtime gives it, not by
    "the first unfinished call with this name", and `tool.started` carries the
    call's `parallel` group for the trace.
