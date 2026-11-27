- **The local CLI's `run_shell` runs in a sandbox.** A model's command could
  read the AgentCash wallet key or write anywhere you can. Now it writes only
  inside the workspace, cannot read credential locations, sees only its own
  processes, and its network is open, off, or an allowlist
  (`OPENCROWD_SHELL_NETWORK`).
  - bubblewrap on Linux, `sandbox-exec` on macOS. Where neither can run, commands run as before and `opencrowd doctor` and the ledger say why; a restricted network is refused instead of opened.
  - The session's budget, ledger and conversation, and the workspace's `.git/hooks` and `.git/config`, are read-only to a command.
