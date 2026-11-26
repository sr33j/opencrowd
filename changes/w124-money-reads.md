- **Hosted runs can read their money less often, behind a flag.** With
  `OPENCROWD_MONEY_READS=on_change` a hosted run keeps its financial snapshot
  and reads it again only when money may have moved: after a model call (at
  the first tool result that follows it), after any tool not known to be free
  (a paid call, a transfer, a subagent, an unknown tool), when the snapshot
  is more than 30 s old, or at every point while a background subagent runs.
  A turn of free tools reads once, where it read 2 + k times. The default,
  `every_step`, is unchanged. Nothing the gateway enforces depends on these
  reads (`money-reads.ts`).
  - `run.finished` carries `moneyReads`: the mode, how many reads the run
    made and how long they took.
