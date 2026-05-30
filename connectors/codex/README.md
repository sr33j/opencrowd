# OpenCrowd for Codex

Use this connector when Codex should discover OpenCrowd services, manage local permissions, save artifacts, and call paid x402 services through the local OWS wallet.

Example MCP configuration:

```json
{
  "mcpServers": {
    "opencrowd": {
      "command": "opencrowd",
      "args": ["mcp"],
      "env": {
        "OPENCROWD_BUDGET_CENTS": "100"
      }
    }
  }
}
```

Agent instructions:

- Check `get_budget_status` before paid calls.
- Use `search_services` before selecting a service.
- In `ask_first` mode, call `list_allowed_services`; if the service is missing, ask the user to approve it or use `request_service_permission`.
- Never ask for wallet private keys or secret environment variables.
- Use `save_file` for outputs the user should inspect later.
- End with `complete_session` and summarize purchases, costs, statuses, and artifact paths.
- Treat `run_shell` as unavailable unless the user explicitly enabled it in local OpenCrowd config.
