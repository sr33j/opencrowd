export type ToolName =
  | "search_services"
  | "get_budget_status"
  | "list_allowed_services"
  | "add_allowed_service"
  | "remove_allowed_service"
  | "block_service"
  | "request_service_permission"
  | "call_service"
  | "save_file"
  | "read_file"
  | "list_files"
  | "run_shell"
  | "complete_session";

export const TOOL_NAMES: ToolName[] = [
  "search_services",
  "get_budget_status",
  "list_allowed_services",
  "add_allowed_service",
  "remove_allowed_service",
  "block_service",
  "request_service_permission",
  "call_service",
  "save_file",
  "read_file",
  "list_files",
  "run_shell",
  "complete_session"
];

export interface JsonSchema {
  type?: string;
  description?: string;
  minimum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
}

export interface OpenCrowdToolDefinition {
  name: ToolName;
  description: string;
  parameters: JsonSchema;
}

export const OPEN_CROWD_TOOLS: OpenCrowdToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: toolDescription(name),
  parameters: toolParameters(name)
}));

export function openCrowdToolDefinition(name: ToolName): OpenCrowdToolDefinition {
  const definition = OPEN_CROWD_TOOLS.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`unknown OpenCrowd tool: ${name}`);
  }
  return definition;
}

function toolDescription(name: ToolName): string {
  switch (name) {
    case "search_services":
      return "Search the x402 service marketplace for bespoke paid services that provide external capabilities such as hosted services, deployment help, remote compute, live APIs, data access, or task-specific execution beyond the local device.";
    case "get_budget_status":
      return "Inspect the current local session budget, spent amount, reserved amount, and remaining cap.";
    case "list_allowed_services":
      return "List services currently allowed, pending, or blocked in local permission policy.";
    case "add_allowed_service":
      return "Allow a service URL under local permission policy with optional cost and method caps.";
    case "remove_allowed_service":
      return "Remove a service URL from local permission policy.";
    case "block_service":
      return "Block a service URL under local permission policy.";
    case "request_service_permission":
      return "Record a permission request for a service before making a paid call in ask-first mode.";
    case "call_service":
      return "Call an x402 paid service after selecting it from search_services and ensuring permission/budget.";
    case "save_file":
      return "Save content as a session artifact.";
    case "read_file":
      return "Read a session artifact.";
    case "list_files":
      return "List session artifacts.";
    case "run_shell":
      return "Run a gated local shell command only when shell access is enabled for the session.";
    case "complete_session":
      return "Finish the agent run and present a concise final answer.";
  }
}

function toolParameters(name: ToolName): JsonSchema {
  switch (name) {
    case "search_services":
      return objectSchema({
        query: stringSchema("Marketplace search query, for example `stock price TSLA`."),
        max_budget_cents: integerSchema("Maximum service call cost in cents."),
        limit: integerSchema("Maximum number of candidate services to return.")
      }, ["query"]);
    case "get_budget_status":
    case "list_allowed_services":
      return objectSchema({});
    case "list_files":
      return objectSchema({ prefix: stringSchema("Optional artifact path prefix.") });
    case "add_allowed_service":
      return objectSchema({
        resource_url: stringSchema("Exact service URL to allow."),
        caps: capsSchema()
      }, ["resource_url"]);
    case "remove_allowed_service":
    case "block_service":
      return objectSchema({ resource_url: stringSchema("Exact service URL.") }, ["resource_url"]);
    case "request_service_permission":
      return objectSchema({
        resource_url: stringSchema("Exact service URL selected from search_services."),
        reason: stringSchema("Short reason this service is needed for the user's task."),
        caps: capsSchema()
      }, ["resource_url", "reason"]);
    case "call_service":
      return objectSchema({
        resource_url: stringSchema("Exact service URL selected from search_services."),
        method: stringSchema("HTTP method. Use the method returned by search_services."),
        quoted_cost_cents: integerSchema("Maximum quoted cost in cents from search_services."),
        content_type: stringSchema("Optional request Content-Type, for example `text/html` when uploading raw HTML."),
        body: {
          description: "Request body for POST-like services. Use an object for JSON APIs or a string for raw uploads such as HTML files."
        }
      }, ["resource_url", "quoted_cost_cents"]);
    case "save_file":
      return objectSchema({
        path: stringSchema("Relative artifact path."),
        content: stringSchema("File content to save."),
        metadata: { type: "object", additionalProperties: true }
      }, ["path", "content"]);
    case "read_file":
      return objectSchema({ path: stringSchema("Relative artifact path.") }, ["path"]);
    case "run_shell":
      return objectSchema({
        command: stringSchema("Shell command."),
        cwd: stringSchema("Working directory inside the workspace."),
        timeout_ms: integerSchema("Timeout in milliseconds.")
      }, ["command"]);
    case "complete_session":
      return objectSchema({
        final_message: stringSchema("Concise final message to show the user.")
      }, ["final_message"]);
  }
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function stringSchema(description: string): JsonSchema {
  return { type: "string", description };
}

function integerSchema(description: string): JsonSchema {
  return { type: "integer", minimum: 0, description };
}

function capsSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      max_cost_cents: integerSchema("Maximum cost per call in cents."),
      session_max_cents: integerSchema("Maximum total service spend for this session in cents."),
      methods: {
        type: "array",
        items: { type: "string" },
        description: "Allowed HTTP methods."
      }
    },
    additionalProperties: false
  };
}
