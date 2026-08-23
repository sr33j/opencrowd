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
  | "complete_session";

export const TOOL_NAMES: ToolName[] = [
  "get_budget_status",
  "save_file",
  "read_file",
  "list_files",
  "run_shell",
  "spawn_subagent",
  "check_subagents",
  "complete_session"
];

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
