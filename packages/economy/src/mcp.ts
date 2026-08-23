import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@opencrowd/core";

/**
 * One long-lived MCP connection per vendor process. Calls are never
 * auto-retried: a transport failure on a state-changing call is ambiguous —
 * the vendor may or may not have executed it — and is reported as such.
 */

const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface McpCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** True when the failure happened in transport: the call may or may not have executed. */
  transportError?: boolean;
}

export interface McpConnectionOptions {
  /** Test hook: supply a transport (e.g. InMemory) instead of spawning a stdio command. */
  transportFactory?: (config: McpServerConfig) => Transport;
  log?: (message: string) => void;
}

export class McpConnection {
  private client?: Client;
  private connecting?: Promise<Client>;
  private instructionsText?: string;

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly options: McpConnectionOptions = {}
  ) {}

  instructions(): string | undefined {
    return this.instructionsText;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    let client: Client;
    try {
      client = await this.connect();
    } catch (error) {
      return { ok: false, error: `${this.name} is unavailable: ${(error as Error).message}` };
    }
    try {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      const body = parseToolContent(result.content);
      if (result.isError) {
        return { ok: false, error: typeof body === "string" ? body : JSON.stringify(body) };
      }
      return { ok: true, data: body };
    } catch (error) {
      // Drop the client so the NEXT call reconnects; this call is not retried.
      this.client = undefined;
      return {
        ok: false,
        transportError: true,
        error: `${this.name}.${tool} failed: ${(error as Error).message}. The call was not retried; if it may have changed state (a payment or transfer), verify before calling again.`
      };
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.connecting = undefined;
  }

  async connect(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        this.options.log?.(`connecting MCP server ${this.name} (${this.config.command} ${this.config.args.join(" ")})`);
        const transport = this.options.transportFactory
          ? this.options.transportFactory(this.config)
          : new StdioClientTransport({ command: this.config.command, args: this.config.args, stderr: "ignore" });
        const client = new Client({ name: "opencrowd", version: "0.1.0" });
        await client.connect(transport);
        this.client = client;
        this.instructionsText = client.getInstructions();
        return client;
      })();
      this.connecting.catch(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
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
