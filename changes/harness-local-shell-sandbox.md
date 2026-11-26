- **`OPENCROWD_LOCAL_SANDBOX=1` runs the local CLI's `run_shell` in a sandbox.**
  A model's command could read the AgentCash wallet key or write anywhere you
  can. Now, when asked for, it writes only inside the workspace, cannot read
  credential locations, sees only its own processes, and its network is open,
  off, or an allowlist (`OPENCROWD_SHELL_NETWORK`). Off by default.
  - bubblewrap on Linux, `sandbox-exec` on macOS; refused, never unconfined, when it cannot run.
  - The session's budget, ledger and conversation, and the workspace's `.git/hooks` and `.git/config`, are read-only to a command.
