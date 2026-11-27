- **A hosted run reads its money only when it may have moved.** It used to
  read the hosted financial state before and after every model call and
  after every tool call (2 + k reads a turn, about 185 ms and 18 control
  queries each). It now keeps the snapshot and reads again after a model
  call (at the first tool result that follows it), after any tool not known
  to be free (a paid call, a transfer, a subagent, an unknown tool,
  `get_budget_status`, `complete_session`), when the snapshot is more than
  30 s old, after a failed read, and at every point while a background
  subagent runs. A turn of free tools reads once. The "Money:" line still
  counts every payment of the run; outside money (a top-up, a shared wallet)
  is at most 30 s old in it. The gateway's holds, budgets and approvals are
  unchanged and were never read from here (`money-reads.ts`, w124).
  - On production (132 paired runs): money reads per task −54%, harness
    overhead −20% (about 0.9 s a task), no change in tokens, turns, cost or
    caching.
  - `run.finished` carries `moneyReads`: how many reads the run made and how
    long they took.
