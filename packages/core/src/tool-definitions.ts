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
  | "deploy_service"
  | "request_secret"
  | "vault_request"
  | "automations";

export const TOOL_NAMES: ToolName[] = [
  "get_budget_status",
  "save_file",
  "read_file",
  "list_files",
  "run_shell",
  "spawn_subagent",
  "check_subagents",
  "complete_session",
  "deploy_service",
  "request_secret",
  "vault_request",
  "automations"
];

/**
 * Tools that only exist when a supervisor executes them on the agent's behalf.
 * Local runs never advertise them; the hosted worker routes them over the bridge.
 */
export const HOSTED_ONLY_TOOL_NAMES: ToolName[] = ["deploy_service", "request_secret", "vault_request", "automations"];

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
  pattern?: string;
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
    case "request_secret":
      return "Use action=list first when you need to see this agent's vault secret titles and statuses (values are never exposed). Use action=create to ask the user to add a named API key or token to the encrypted vault. The user enters the value in their own UI; never ask them to paste a secret into chat. For create, provide name, allowed_hosts, and reason. Reference an active secret by name in deploy_service `secrets` and read it in service code as env.NAME; the real value is substituted only on requests to allowed_hosts.";
    case "vault_request":
      return "Send one HTTPS request to an external API with vault secrets injected by the platform. Write {{SECRET_NAME}} anywhere in the url, headers, or body and the real value is substituted at the network boundary, only for hosts the user approved for that secret; you never see the value and the response is blocked if it echoes one. Use it to call APIs on the user's behalf (for example posting to X with an OAuth token). The body is a string (JSON, form encoding, or text), or a workspace file up to 25 MB via body_artifact (sent raw, or as one multipart/form-data file part when body_field is set, with form_fields alongside). Returns the status, content-type, and the response body text (truncated at 64 KB). Check request_secret action=list for available secret names first.";
    case "automations":
      return "Create, list, update, pause, resume, run now, or delete persistent automations for this hosted agent. Use create proactively when the user's goal clearly needs a future follow-up, reminder, monitoring loop, recurring report, or maintenance task. Automations run in this same conversation. Never create duplicates or hide a schedule from the user.";
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
        cwd: stringSchema("Working directory inside the workspace. Use artifacts/<dir> to run where save_file writes (cd inside the command does not reach it)."),
        timeout_ms: integerSchema("Timeout in milliseconds (default 10000, maximum 300000).")
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
    case "request_secret":
      return objectSchema({
        action: { type: "string", description: "list to inspect secret titles/statuses; create to request or reuse a secret." },
        name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,63}$", description: "Secret name in SCREAMING_SNAKE_CASE, for example OPENAI_API_KEY. This is the env var name your service reads." },
        allowed_hosts: { type: "array", description: "Hostnames the secret may be sent to, for example api.openai.com. The vault only substitutes the real value on requests to these hosts.", items: stringSchema("Hostname.") },
        reason: stringSchema("One short sentence shown to the user explaining why the secret is needed.")
      }, []);
    case "vault_request":
      return objectSchema({
        url: stringSchema("Full https:// URL. May contain {{SECRET_NAME}} placeholders; substituted values are URL-encoded."),
        method: { type: "string", description: "GET, POST, PUT, PATCH, or DELETE. Default GET." },
        headers: { type: "object", description: "Request headers, for example { \"authorization\": \"Bearer {{X_ACCESS_TOKEN}}\", \"content-type\": \"application/json\" }.", additionalProperties: { type: "string" } },
        body: stringSchema("Request body as a string (JSON, form encoding or text). Omit for GET or when using body_artifact."),
        body_artifact: stringSchema("Workspace file to send as the body, as a path under artifacts/ (for example demos/clip.part00). Up to 25 MB; the file is uploaded first."),
        body_field: stringSchema("When set, the file is sent as a multipart/form-data part with this field name (for example media) instead of raw bytes."),
        form_fields: { type: "object", description: "Extra multipart text fields sent with the file, for example { \"segment_index\": \"0\" }.", additionalProperties: { type: "string" } },
        reason: stringSchema("One short sentence shown to the user describing what this request does.")
      }, ["url"]);
    case "automations":
      return automationSchema({ action: { type: "string", description: "create, list, update, pause, resume, run, or delete." }, automation_id: stringSchema("Automation ID, except for create and list.") }, ["action"]);
  }
}

/**
 * Redacted view of a tool call for progress events. Only names, paths and
 * short commands are surfaced; file contents and secret values never are.
 */
export function summarizeToolInput(name: string, args: Record<string, unknown>): Record<string, string | string[]> | undefined {
  const text = (value: unknown, max = 200) => typeof value === "string" ? value.slice(0, max) : typeof value === "number" ? String(value) : undefined;
  const hosts = (value: unknown) => Array.isArray(value) ? value.filter((host): host is string => typeof host === "string").map((host) => host.slice(0, 200)) : undefined;
  const pick = (fields: Record<string, string | string[] | undefined>) =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Record<string, string | string[]>;
  switch (name) {
    case "run_shell":
      return { command: String(args.command).slice(0, 200) };
    case "save_file":
    case "read_file":
      return pick({ path: text(args.path) });
    case "list_files":
      return pick({ path: text(args.path ?? args.prefix) });
    case "deploy_service":
      return pick({ slug: text(args.slug), name: text(args.name), price_usd: text(args.price_usd) });
    case "request_secret":
      return pick({ action: text(args.action), name: text(args.name), allowed_hosts: hosts(args.allowed_hosts) });
    case "vault_request":
      return pick({ method: text(args.method ?? "GET", 10), url: text(args.url), body_artifact: text(args.body_artifact), reason: text(args.reason, 120) });
    case "automations":
      return pick({ action: text(args.action), automation_id: text(args.automation_id), name: text(args.name), prompt: text(args.prompt, 120) });
    case "complete_session":
      return pick({ summary: text(args.final_message ?? args.summary ?? args.message) });
    case "find_paid_service":
      return pick({ query: text(args.query), origin: text(args.origin) });
    case "inspect_paid_service":
      return pick({ url: text(args.url), method: text(args.method) });
    case "call_paid_service":
      return pick({ url: text(args.url), method: text(args.method), max_cost_cents: text(args.max_cost_cents) });
    case "review_paid_service":
      return pick({ purchase_id: text(args.purchase_id), rating: text(args.rating) });
    default:
      return undefined;
  }
}

function automationSchema(extra: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return objectSchema({
    ...extra,
    name: stringSchema("Short human-readable schedule name."),
    prompt: stringSchema("Prompt to run in this same conversation."),
    kind: { type: "string", description: "at for one time, cron for a five-field cron schedule." },
    atTime: stringSchema("ISO 8601 timestamp for a one-time schedule."),
    cronExpression: stringSchema("Five-field cron expression, for example 50 19 * * 3."),
    timezone: stringSchema("IANA timezone, for example America/Los_Angeles."),
    model: stringSchema("Optional model ID."),
  }, required);
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
