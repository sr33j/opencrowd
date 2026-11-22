import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionPolicy, Command, Event } from "@opencrowd/protocol";
import { checkAction, newPolicyState } from "../src/action-policy.js";
import { MachineWorker } from "../src/worker.js";
import { runAgentTaskDetailed } from "../src/index.js";
import { createSession } from "@opencrowd/core";

/**
 * SRI-166, from a real owner's job-search org: "never submit applications or
 * take action on job sites. Information gathering only." A scheduled run of
 * its chief of staff then called call_paid_service on three
 * jobs.ashbyhq.com application URLs with the tool's default method, POST.
 */
const RULE = "Look at the job application for each role and draft longer-form questions, but never submit applications or take action on job sites. Information gathering only.";
const policy: ActionPolicy = { noActionHosts: ["ashbyhq.com", "greenhouse.io", "lever.co", "linkedin.com"], readOnlyWeb: true, rule: RULE };
const ASHBY = ["https://jobs.ashbyhq.com/ramp/fe280d10-4258-420a-b0bb-0dc9021bd803", "https://jobs.ashbyhq.com/nirvana/1bec097f-edfb-4d4d-847f-91be576e900c",
  "https://jobs.ashbyhq.com/Profound/52e2ff7b-1cff-42ba-9604-448eeb58d3d4"];
const check = (name: string, args: Record<string, unknown>, state = newPolicyState()) => checkAction(policy, state, name, args);

describe("the owner's standing no-action rule, enforced by the runtime (SRI-166)", () => {
  it("refuses the production calls: call_paid_service on Ashby application URLs with no method (the tool's default POST)", () => {
    for (const url of ASHBY) {
      const refused = check("call_paid_service", { url });
      expect(refused).toContain("Refused by the owner's standing rule");
      expect(refused).toContain("never submit applications or take action on job sites");
      expect(refused).toContain("on jobs.ashbyhq.com");
    }
    expect(check("call_paid_service", { url: ASHBY[0], method: "POST", body: { name: "x" } })).toBeDefined();
    expect(check("inspect_paid_service", { url: ASHBY[0], method: "POST" })).toBeDefined();
  });

  it("lets the run read the job sites, and buy extraction of them from a paid service", () => {
    expect(check("call_paid_service", { url: ASHBY[0], method: "GET" })).toBeUndefined();
    expect(check("read_service", { url: ASHBY[0] })).toBeUndefined();
    expect(check("call_paid_service", { url: "https://api.agentsearchhq.com/x402/v1/extract", method: "POST", body: { urls: ASHBY } })).toBeUndefined();
    expect(check("run_shell", { command: `curl -sL ${ASHBY[0]} | python3 -c 'import sys; print(sys.stdin.read()[:500])'` })).toBeUndefined();
  });

  it("refuses an autonomous browser task sent to a job site, whichever paid service runs it", () => {
    expect(check("call_paid_service", { url: "https://x402.api.browser-use.com/api/v3/sessions", method: "POST",
      body: { task: `Open ${ASHBY[0]} and capture the long-form questions without submitting` } })).toContain("An autonomous browser task");
    expect(check("call_paid_service", { url: "https://browser-use.x402.paywithlocus.com/browser-use/run-task", method: "POST",
      body: JSON.stringify({ task: "fill in the application", startUrl: ASHBY[1] }) })).toBeDefined();
  });

  it("lets a browser session navigate to and read a job site, and refuses its actions there", () => {
    const state = newPolicyState();
    const base = "https://www.stablebrowser.dev/api/sessions";
    expect(check("read_service", { url: `${base}/navigate`, method: "POST", body: { sessionId: "s-1", url: ASHBY[2] } }, state)).toBeUndefined();
    expect(check("read_service", { url: `${base}/extract`, method: "POST", body: { sessionId: "s-1", instruction: "the questions" } }, state)).toBeUndefined();
    expect(check("read_service", { url: `${base}/screenshot`, method: "POST", body: { sessionId: "s-1" } }, state)).toBeUndefined();
    expect(check("read_service", { url: `${base}/act`, method: "POST", body: { sessionId: "s-1", action: "Click Apply" } }, state))
      .toContain("A browser action (click, type, submit) on jobs.ashbyhq.com");
    expect(check("read_service", { url: `${base}/close`, method: "POST", body: { sessionId: "s-1" } }, state)).toBeUndefined();
  });

  it("refuses shell commands and vault requests that send data to a job site, and, information-only, to any website", () => {
    expect(check("run_shell", { command: "curl -X POST https://jobs.ashbyhq.com/api/non-user-graphql -H 'content-type: application/json' -d '{\"operationName\":\"ApiSubmitSingleApplicationFormAction\"}'" }))
      .toContain("A shell command that sends or submits data on jobs.ashbyhq.com");
    expect(check("run_shell", { command: "python3 -c \"import requests; requests.post('https://boards.greenhouse.io/x/jobs/1', data={'first_name': 'A'})\"" })).toBeDefined();
    expect(check("run_shell", { command: "curl -F resume=@cv.pdf https://example-startup.com/careers/apply" })).toContain("example-startup.com");
    expect(check("vault_request", { url: "https://api.linkedin.com/v2/ugcPosts", method: "POST", body: "{}" })).toBeDefined();
    expect(check("vault_request", { url: "https://api.linkedin.com/v2/me" })).toBeUndefined();
    // CrowdCode's own surfaces are not third-party sites.
    expect(check("run_shell", { command: "curl -X POST https://crowdcode.app/s/my-dashboard -d '{}'" })).toBeUndefined();
  });

  it("without information-only, protects only the named sites", () => {
    const narrow: ActionPolicy = { ...policy, readOnlyWeb: false };
    expect(checkAction(narrow, newPolicyState(), "run_shell", { command: "curl -X POST https://api.example.com/v1/x -d '{}'" })).toBeUndefined();
    expect(checkAction(narrow, newPolicyState(), "run_shell", { command: `curl -X POST ${ASHBY[0]} -d '{}'` })).toBeDefined();
    expect(checkAction(undefined, newPolicyState(), "call_paid_service", { url: ASHBY[0] })).toBeUndefined();
  });
});

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "action-policy-")); roots.push(dir); return dir; }

describe("a scheduled run with the standing rule (SRI-166)", () => {
  it("refuses the three Ashby calls in the agent loop before any economy call, and the run finishes", async () => {
    const session = await createSession({ workspaceRoot: await root(), budgetCents: 100, approvalMode: "auto" });
    const execute = vi.fn(async () => ({ ok: true, data: {} }));
    const dynamicTools = { definitions: [{ name: "call_paid_service", description: "pay", parameters: { type: "object" } }], execute };
    let turn = 0;
    const provider = { complete: vi.fn(async () => turn++ === 0
      ? { content: "", toolCalls: ASHBY.map((url, i) => ({ id: `c${i}`, name: "call_paid_service", arguments: { url } })) }
      : { content: "", toolCalls: [{ id: "end", name: "complete_session", arguments: { final_message: "I did not open the application forms: the owner's rule forbids acting on job sites." } }] }) };
    const result = await runAgentTaskDetailed(session, "Render the 10 application forms without submitting, capture exact long-form questions.",
      { provider, dynamicTools, actionPolicy: policy, knowledge: false });
    expect(result.outcome).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    const refusals = JSON.stringify(provider.complete.mock.calls[1]).match(/Refused by the owner's standing rule/g) ?? [];
    expect(refusals).toHaveLength(3);
  });

  it("holds a hosted run to the rule from run.start: shell and vault requests to a job site never reach the supervisor", async () => {
    const events: Event[] = []; let turn = 0;
    const hosted = vi.fn(async () => ({ ok: true, data: {} }));
    const provider = { complete: vi.fn(async () => turn++ === 0
      ? { content: "", toolCalls: [
        { id: "sh", name: "run_shell", arguments: { command: `curl -X POST ${ASHBY[0]} -d '{"name":"A"}'` } },
        { id: "vr", name: "vault_request", arguments: { url: "https://api.linkedin.com/v2/ugcPosts", method: "POST", body: "{}" } }] }
      : { content: "", toolCalls: [{ id: "end", name: "complete_session", arguments: { final_message: "Not submitted: the owner's rule." } }] }) };
    const command: Command = { protocolVersion: 1, id: "command-1", runId: "run-1", seq: 1, emittedAt: "2026-11-22T05:37:38Z", type: "run.start",
      payload: { session: { kind: "create", sessionId: "session-1" }, prompt: "Render the 10 application forms without submitting.",
        modelPolicy: {}, budget: { limit: "1000000" }, approvalMode: "auto", actionPolicy: policy } };
    const worker = new MachineWorker({ agentHome: await root(), provider: () => provider, hostedTools: () => hosted, output: (line) => { events.push(JSON.parse(line)); } });
    await worker.initialize(); await worker.handleLine(JSON.stringify(command)); await worker.drain();
    const finished = events.filter((e) => e.type === "tool.finished" && ["run_shell", "vault_request"].includes(String(e.payload.toolName)));
    expect(finished).toHaveLength(2);
    for (const event of finished) expect(String(event.payload.error)).toContain("Refused by the owner's standing rule");
    expect(hosted).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "run.finished").at(-1)?.payload.outcome).toBe("completed");
  });
});
