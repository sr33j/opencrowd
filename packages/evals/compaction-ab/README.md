# Compaction A/B (harness experiment 3, w125)

Long-horizon tasks that run past compaction, with a recall probe at the end,
for comparing two opencrowd builds' compaction (the A/B behind the model-written
summaries: `main` at ef540ab, with the one-line digest, against the summary branch).

- `tasks.mjs`: three deterministic local worlds (files in the workspace), the
  owner's wakes (prompts sent in turn to one session, as a mission's are), and
  graders: a deliverable check (`success`) and one check per numbered probe
  answer (`recall`).
  - `vendor_selection`: 10 supplier quotes over 4 wakes, two corrections and a
    raised budget on wake 3, a tie broken by a preference given on wake 2.
  - `incident_logs`: 20 log files read one per step without notes, then 8 CSVs,
    then questions about the logs.
  - `assistant_mission`: 7 wakes of small tasks; preferences and facts given in
    passing on wakes 2 and 3 have to be applied on wake 6 and recalled on wake 7.
- `run.mjs`: one run of one arm against a built opencrowd checkout (`--root`),
  paying for the model from the AgentCash wallet at `AGENTCASH_WALLET_PATH`. The
  arm is the build; `--arm` only labels it. `--window 32000` forces compaction
  on a cheap model (its real window is a million tokens).
- `matrix.sh <arm> <root> <wallet> <out> <model> <reps>`: an arm's runs, in order.
  Venice pays `upto` with a sequential permit nonce, so give each concurrent arm
  its own wallet.
- `analyze.py <out>`: per-arm means ± sd, the difference from baseline and a
  permutation p-value, per-task rows and the recall items missed.

Connectors are disabled: the model is the only thing bought.
