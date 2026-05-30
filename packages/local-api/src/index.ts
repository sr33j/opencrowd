import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOpenCrowdSession, executeTool, type ToolName, TOOL_NAMES } from "@opencrowd/core";

export interface LocalApiOptions {
  port: number;
  host?: string;
  workspaceRoot?: string;
  budgetCents?: number;
}

export async function startLocalApi(options: LocalApiOptions): Promise<{ close: () => Promise<void>; url: string }> {
  const session = await createOpenCrowdSession({
    workspaceRoot: options.workspaceRoot,
    budgetCents: options.budgetCents,
    surface: "local-api"
  });
  const host = options.host ?? "127.0.0.1";
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return json(response, 200, { ok: true, session_id: session.sessionId });
      }
      if (request.method === "GET" && request.url === "/tools") {
        return json(response, 200, { tools: TOOL_NAMES });
      }
      const parsed = new URL(request.url ?? "/", `http://${host}:${options.port}`);
      if (request.method === "POST" && parsed.pathname.startsWith("/tools/")) {
        const tool = parsed.pathname.slice("/tools/".length) as ToolName;
        if (!TOOL_NAMES.includes(tool)) {
          return json(response, 404, { ok: false, error: "unknown tool" });
        }
        const body = await readJson(request);
        const result = await executeTool(tool, body, { session });
        return json(response, result.ok ? 200 : 400, result);
      }
      return json(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      return json(response, 500, { ok: false, error: (error as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve());
  });
  return {
    url: `http://${host}:${options.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}
