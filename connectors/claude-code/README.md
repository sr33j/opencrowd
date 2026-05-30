# OpenCrowd for Claude Code

Add an MCP server that launches the local OpenCrowd binary:

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

Operational rules:

- Keep all session state local under `./sessions/<session-id>/`.
- Check budget and permissions before paid calls.
- Use OWS only through OpenCrowd; do not request private wallet keys.
- Save purchased service responses or generated files as artifacts.
- Include the final purchase summary returned by `complete_session`.
