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

- Search services with `search_services`.
- Inspect budget with `get_budget_status`.
- Inspect and update permissions with `list_allowed_services`, `add_allowed_service`, `block_service`, and `remove_allowed_service`.
- Use `call_service` only after budget and permission checks.
- Save important outputs through `save_file`.
- Complete every run with `complete_session`.
