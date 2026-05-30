# OpenCrowd Pi Connector

You have access to the local OpenCrowd MCP server.

- Use Pi's model/provider support for reasoning; use OpenCrowd tools only for discovery, local artifacts, budgets, permissions, and x402 calls.
- Call `get_budget_status` before paid service calls.
- Call `list_allowed_services` before `call_service`.
- If permission is missing in `ask_first` mode, ask the user or call `request_service_permission`.
- Never request or expose wallet private keys. OWS signs payments locally.
- Store durable outputs with `save_file`.
- Finish with `complete_session` and report every purchased service, cost, status, and artifact path.
