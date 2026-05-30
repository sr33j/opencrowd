import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createOpenCrowdSession,
  executeTool,
  OPEN_CROWD_TOOLS,
  type JsonSchema,
  type ToolName
} from "@opencrowd/core";

const schemas = Object.fromEntries(
  OPEN_CROWD_TOOLS.map((tool) => [tool.name, zodRawShape(tool.parameters)])
) as Record<ToolName, z.ZodRawShape>;

export async function startMcpServer(options: { workspaceRoot?: string; budgetCents?: number } = {}): Promise<void> {
  const session = await createOpenCrowdSession({
    workspaceRoot: options.workspaceRoot,
    budgetCents: options.budgetCents,
    surface: "mcp"
  });
  const server = new McpServer({
    name: "opencrowd",
    version: "0.1.0"
  });

  for (const [name, schema] of Object.entries(schemas) as [ToolName, z.ZodRawShape][]) {
    server.tool(name, schema, async (args) => {
      const result = await executeTool(name, args as Record<string, unknown>, { session });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ],
        isError: !result.ok
      };
    });
  }

  await server.connect(new StdioServerTransport());
}

function zodRawShape(schema: JsonSchema): z.ZodRawShape {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    const parsed = zodForSchema(value);
    return [key, required.has(key) ? parsed : parsed.optional()];
  }));
}

function zodForSchema(schema: JsonSchema): z.ZodTypeAny {
  switch (schema.type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int().refine((value) => schema.minimum === undefined || value >= schema.minimum);
    case "array":
      return z.array(schema.items ? zodForSchema(schema.items) : z.unknown());
    case "object": {
      if (schema.properties) {
        return z.object(zodRawShape(schema)).passthrough();
      }
      return z.record(z.unknown());
    }
    default:
      return z.unknown();
  }
}
