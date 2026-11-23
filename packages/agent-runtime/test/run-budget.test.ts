import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSession, hostOffers, RunBudgetReached } from "@opencrowd/core";
import { createHostedProvider } from "../src/hosted-provider.js";
import { runAgentTaskDetailed } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { delete process.env.OPENCROWD_SITES; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "oc-run-budget-")); roots.push(dir); return dir; }

/** A bridge that answers every model request with `answer`, recording the tools it was offered. */
async function bridge(answer: (n: number) => { status: number; body: unknown }) {
  const home = await root(), socketPath = join(home, "bridge.sock"), offered: string[][] = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    offered.push(JSON.parse(Buffer.concat(chunks).toString()).tools.map((tool: { name: string }) => tool.name));
    const { status, body } = answer(n++);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, offered, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

// The taskmarket org's hourly sweep had a $0.05 run budget and spent $0.36
// (2026-11-23). The gateway now refuses a scheduled run's next call at its
// budget; the run ends there, as budget_exhausted, instead of failing or pausing.
const AT_BUDGET = "This scheduled run reached its $0.05 budget ($0.06 spent), so it stops here.";

it("reads the gateway's run_budget_reached as a budget stop, not a failed or uncertain payment", async () => {
  const fake = await bridge(() => ({ status: 409, body: { error: "run_budget_reached", message: AT_BUDGET, status: 409, paid: false } }));
  try {
    await expect(createHostedProvider({ socketPath: fake.socketPath, runId: "run-1", sessionId: "session-1" })
      .complete([{ role: "user", content: "sweep" }], { operationId: "run-1:llm:0" }))
      .rejects.toMatchObject({ name: "RunBudgetReached", message: AT_BUDGET });
  } finally { await fake.close(); }
});

it("ends a hosted run at its budget with what it has, in the host's words", async () => {
  const session = await createSession({ workspaceRoot: await root(), budgetCents: 1000, approvalMode: "auto", shellEnabled: true });
  let calls = 0;
  const result = await runAgentTaskDetailed(session, "Run the sweep.", {
    hosted: true, runId: "run-1", knowledge: false,
    toolExecutor: async () => ({ ok: true, data: "3 open bounties" }),
    provider: { complete: async () => {
      if (calls++ === 0) return { content: "", toolCalls: [{ id: "a", name: "read_file", arguments: { path: "notes.md" } }] };
      throw new RunBudgetReached(AT_BUDGET);
    } },
  });
  expect(result.outcome).toBe("budget_exhausted");
  expect(String(result.summary.final_message)).toContain(AT_BUDGET);
});

it("offers publish_site only when the host serves sites", async () => {
  expect(hostOffers("publish_site", {})).toBe(false);
  expect(hostOffers("publish_site", { OPENCROWD_SITES: "1" })).toBe(true);
  expect(hostOffers("run_shell", {})).toBe(true);
  const fake = await bridge(() => ({ status: 200, body: { status: "complete", response: { content: "ok", toolCalls: [] } } }));
  try {
    await createHostedProvider({ socketPath: fake.socketPath, runId: "run-1", sessionId: "s" }).complete([{ role: "user", content: "hi" }], { operationId: "run-1:llm:0" });
    process.env.OPENCROWD_SITES = "1";
    await createHostedProvider({ socketPath: fake.socketPath, runId: "run-1", sessionId: "s" }).complete([{ role: "user", content: "hi" }], { operationId: "run-1:llm:1" });
    expect(fake.offered[0]).not.toContain("publish_site");
    expect(fake.offered[1]).toContain("publish_site");
  } finally { await fake.close(); }
});
