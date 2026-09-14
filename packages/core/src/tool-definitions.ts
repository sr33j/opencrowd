/**
 * Built-in local tool registry. Paid capability is NOT here: it comes from
 * the economy gateway's stable tool surface, injected by the runtime.
 */
export type ToolName =
  | "get_budget_status"
  | "save_file"
  | "read_file"
  | "list_files"
  | "run_shell"
  | "spawn_subagent"
  | "check_subagents"
  | "complete_session"
  | "deploy_service";

export const TOOL_NAMES: ToolName[] = [
  "get_budget_status",
  "save_file",
  "read_file",
  "list_files",
  "run_shell",
  "spawn_subagent",
  "check_subagents",
  "complete_session",
  "deploy_service"
];

/**
 * Tools that only exist when a supervisor executes them on the agent's behalf.
 * Local runs never advertise them; the hosted worker routes them over the bridge.
 */
export const HOSTED_ONLY_TOOL_NAMES: ToolName[] = ["deploy_service"];

/** Tools a spawned subagent may use: local capabilities only, one level deep. */
export const SUBAGENT_TOOL_NAMES: ToolName[] = [
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
    case "get_budget_status":
      return "Inspect the current local session budget, spent amount, reserved amount, and remaining cap.";
    case "save_file":
      return "Save content as a session artifact.";
    case "read_file":
      return "Read a session artifact.";
    case "list_files":
      return "List session artifacts.";
    case "run_shell":
      return "Run a gated local shell command only when shell access is enabled for the session.";
    case "spawn_subagent":
      return "Delegate a bounded, parallelizable, low-judgment subtask (search, summarize, extract, mechanical work) to a cheap fast subagent with local tools only. Multiple spawn_subagent calls in one reply run in parallel. Give each an objective, expected output format, and clear boundaries so parallel subagents cannot conflict. Set background=true only for long tasks whose results you will collect later with check_subagents. Keep planning, paid-service decisions, and final answers in the main loop.";
    case "check_subagents":
      return "Check on background subagents started with spawn_subagent background=true: returns each one's status and, when finished, its structured result. Set wait=true to block until all outstanding background subagents finish.";
    case "complete_session":
      return "Finish the agent run and present a concise final answer.";
    case "deploy_service":
      return "Deploy a paid HTTP service you wrote to OpenCrowd's hosting. The entry file must be a JavaScript or TypeScript ES module saved with save_file that exports default { async fetch(request, env) }. Buyers pay the listed USDC price per call with x402; payments settle to this agent's own wallet. Vault secrets listed in `secrets` are exposed to the service as env vars (env.NAME) but contain opaque placeholders: the real value is substituted at the network boundary only for requests to `allowed_hosts`, so never print or return a secret. Redeploying the same slug updates the service in place. Returns the public URL and listing status.";
  }
}

function toolParameters(name: ToolName): JsonSchema {
  switch (name) {
    case "get_budget_status":
      return objectSchema({});
    case "list_files":
      return objectSchema({ prefix: stringSchema("Optional artifact path prefix.") });
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
    case "spawn_subagent":
      return objectSchema({
        task: stringSchema("Self-contained task description for the subagent."),
        context: stringSchema("Explicit context the subagent needs: relevant file paths, constraints, and prior findings. Subagents see none of this conversation."),
        expected_output: stringSchema("What the subagent should return in its final message, for example `a bullet list of matching files`."),
        background: { type: "boolean", description: "Run without blocking this turn; collect the result later with check_subagents. Default false." }
      }, ["task"]);
    case "check_subagents":
      return objectSchema({
        wait: { type: "boolean", description: "Block until all outstanding background subagents finish. Default false." }
      });
    case "complete_session":
      return objectSchema({
        final_message: stringSchema("Concise final message to show the user.")
      }, ["final_message"]);
    case "deploy_service":
      return objectSchema({
        slug: stringSchema("URL-safe identifier, lowercase letters, digits and dashes, 3-40 characters. Stable across redeploys."),
        name: stringSchema("Human-readable service name shown to buyers."),
        description: stringSchema("What the service does and returns; used by buyers and discovery search. One or two sentences."),
        price_usd: stringSchema("Price per paid call in USD, for example \"0.001\". Minimum 0.0001."),
        entry: stringSchema("Artifact path of the entry module saved with save_file, for example service/index.js."),
        routes: {
          type: "array",
          description: "Paid routes the service serves. Each route is discoverable; give an accurate input schema and output example.",
          items: objectSchema({
            method: stringSchema("HTTP method: GET or POST."),
            path: stringSchema("Route path starting with /, for example /price/:symbol. Use :param for path parameters."),
            description: stringSchema("What this route returns."),
            input_schema: { type: "object", description: "JSON Schema of query parameters (GET) or JSON body (POST). Use properties and required.", additionalProperties: true },
            output_example: { type: "object", description: "Example JSON response.", additionalProperties: true }
          }, ["method", "path", "description"])
        },
        secrets: { type: "array", description: "Names of vault secrets the service needs as env vars.", items: stringSchema("Vault secret name.") },
        allowed_hosts: { type: "array", description: "Upstream hostnames the service is allowed to call, for example api.coingecko.com. Any other outbound host is blocked.", items: stringSchema("Hostname.") }
      }, ["slug", "name", "description", "price_usd", "entry", "routes"]);
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
