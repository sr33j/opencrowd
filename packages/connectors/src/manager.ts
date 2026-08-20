import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, ToolResult } from "@opencrowd/core";

/**
 * Generic MCP connector layer (integration spec). Vendor tools are ingested
 * verbatim — names prefixed with the server name, schemas and descriptions
 * untouched — so vendor updates flow through with no OpenCrowd code changes.
 * The harness adds no payment policy here: authority stays with the vendor
 * (and later the Capability Vault). Calls are never auto-retried; a failed
 * or ambiguous call is reported to the model as-is.
 */

const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface ConnectorToolDefinition {
  /** Prefixed name exposed to the model, e.g. `agentcash_fetch`. */
  name: string;
  server: string;
  originalName: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ConnectorInstructions {
  server: string;
  text: string;
}

export interface ConnectorManagerOptions {
  /** Test hook: supply transports (e.g. InMemory) instead of spawning stdio commands. */
  transportFactory?: (server: string, config: McpServerConfig) => Transport;
  log?: (message: string) => void;
}

export interface ConnectorCallResult extends ToolResult {
  /**
   * True when the failure happened in transport rather than as a vendor
   * error result: the call may or may not have executed on the vendor side.
   */
  transportError?: boolean;
}

interface ServerState {
  config: McpServerConfig;
  client?: Client;
}

export class ConnectorManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly tools = new Map<string, ConnectorToolDefinition>();
  private readonly serverInstructions = new Map<string, string>();

  private constructor(private readonly options: ConnectorManagerOptions) {}

  static async connect(
    servers: Record<string, McpServerConfig>,
    options: ConnectorManagerOptions = {}
  ): Promise<ConnectorManager> {
    const manager = new ConnectorManager(options);
    for (const [name, config] of Object.entries(servers)) {
      manager.servers.set(name, { config });
      await manager.connectServer(name);
    }
    return manager;
  }

  definitions(): ConnectorToolDefinition[] {
    return [...this.tools.values()];
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  instructions(): ConnectorInstructions[] {
    return [...this.serverInstructions.entries()].map(([server, text]) => ({ server, text }));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** Execute a prefixed connector tool. Never auto-retried. */
  async execute(name: string, args: Record<string, unknown>): Promise<ConnectorCallResult> {
    const definition = this.tools.get(name);
    if (!definition) {
      return { ok: false, error: `unknown connector tool: ${name}` };
    }
    return this.callServerTool(definition.server, definition.originalName, args);
  }

  /** Call a vendor tool by server + original name (CLI surfaces, tests). */
  async callServerTool(server: string, originalName: string, args: Record<string, unknown>): Promise<ConnectorCallResult> {
    const state = this.servers.get(server);
    if (!state) {
      return { ok: false, error: `unknown connector server: ${server}` };
    }
    let client: Client;
    try {
      client = await this.clientFor(server);
    } catch (error) {
      return { ok: false, error: `connector ${server} is unavailable: ${(error as Error).message}` };
    }
    try {
      const result = await client.callTool(
        { name: originalName, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS }
      );
      const body = parseToolContent(result.content);
      if (result.isError) {
        return { ok: false, error: typeof body === "string" ? body : JSON.stringify(body) };
      }
      return { ok: true, data: body };
    } catch (error) {
      // Drop the client so the NEXT call reconnects; this call is not retried —
      // a state-changing vendor call may or may not have executed.
      state.client = undefined;
      return {
        ok: false,
        transportError: true,
        error: `${server}.${originalName} failed: ${(error as Error).message}. The call was not retried; if it may have changed state (a payment or transfer), verify before calling again.`
      };
    }
  }

  async close(): Promise<void> {
    for (const state of this.servers.values()) {
      await state.client?.close().catch(() => undefined);
      state.client = undefined;
    }
  }

  private async clientFor(server: string): Promise<Client> {
    const state = this.servers.get(server);
    if (!state) {
      throw new Error(`unknown connector server: ${server}`);
    }
    if (!state.client) {
      await this.connectServer(server);
    }
    if (!state.client) {
      throw new Error(`connector ${server} failed to connect`);
    }
    return state.client;
  }

  private async connectServer(server: string): Promise<void> {
    const state = this.servers.get(server);
    if (!state) {
      return;
    }
    this.options.log?.(`connecting MCP server ${server} (${state.config.command} ${state.config.args.join(" ")})`);
    const transport = this.options.transportFactory
      ? this.options.transportFactory(server, state.config)
      : new StdioClientTransport({ command: state.config.command, args: state.config.args, stderr: "ignore" });
    const client = new Client({ name: "opencrowd", version: "0.1.0" });
    await client.connect(transport);
    state.client = client;
    const instructions = client.getInstructions();
    if (instructions) {
      this.serverInstructions.set(server, instructions);
    }
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (state.config.allow?.length && !state.config.allow.includes(tool.name)) {
        continue;
      }
      const prefixed = `${server}_${tool.name}`;
      this.tools.set(prefixed, {
        name: prefixed,
        server,
        originalName: tool.name,
        description: tool.description ?? `${server} tool ${tool.name}`,
        parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} }
      });
    }
  }
}

function parseToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const text = content
    .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
