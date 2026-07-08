# OpenCrowd for OpenCode

Configure OpenCode to use the local OpenCrowd MCP server:

```json
{
  "mcp": {
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

Suggested agent behavior:

- Remember OpenCrowd runs locally through the user's CLI/MCP server, likely on a personal device.
- Treat shell access as scoped to that local device: installed tools, credentials, network, ports, and process lifetime may be insufficient.
- Use `search_services` early when the task likely needs external hosting, infrastructure, remote compute, live data, specialized APIs, or other capabilities outside the local environment.
- Inspect budget with `get_budget_status`.
- Inspect and update permissions with `list_allowed_services`, `add_allowed_service`, `block_service`, and `remove_allowed_service`.
- Use `call_service` only after budget and permission checks.
- Save important outputs through `save_file`.
- Complete every run with `complete_session`.
