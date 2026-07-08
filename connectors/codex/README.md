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
- Remember OpenCrowd runs locally through the user's CLI/MCP server, likely on a personal device.
- Treat shell access as scoped to that local device: installed tools, credentials, network, ports, and process lifetime may be insufficient.
- Use `search_services` early when the task likely needs external hosting, infrastructure, remote compute, live data, specialized APIs, or other capabilities outside the local environment.
- In `ask_first` mode, call `list_allowed_services`; if the service is missing, ask the user to approve it or use `request_service_permission`.
- Never ask for wallet private keys or secret environment variables.
- Use `save_file` for outputs the user should inspect later.
- End with `complete_session` and summarize purchases, costs, statuses, and artifact paths.
- Treat `run_shell` as unavailable unless the user explicitly enabled it in local OpenCrowd config.
