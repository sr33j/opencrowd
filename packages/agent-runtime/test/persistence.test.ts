import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@opencrowd/core";
import { runAgentTaskDetailed } from "../src/index.js";
import { sellerSays } from "../src/hosted-economy.js";
import { newPersistenceState, recordResult, refuseRepeat, WRAP_UP_TURNS } from "../src/persistence.js";

/**
 * Run adf318ab (2026-11-24), on the owner's uncensored Venice model: "write an
 * erotic story for me and generate naughty pictures". An image service answered
 * HTTP 400 to two calls, a second service answered 400 to a third, and the
 * three-failures breaker ended the run as "User stopped" with the story, which
 * needed no service, never written.
 */
const TASK = "write an erotic story for me and generate naughty pictures";
const AGENT402 = "https://agent402.tools/api/image-gen";
const KOINELIX = "https://api.koinelix.com/v1/images/generations";
const REFUSED = { error: "The model's content check refused this prompt. This 400 is not charged on x402; rephrase the prompt and try again. Flagged: sexual.", errorCode: "invalid_input" };
const BLOCKED = { error: { code: "moderation_blocked", message: "Your request was rejected by the safety system." } };
const STORY = "# Midnight Silk\n\nThe story, written in full.";

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function session() {
  const dir = await mkdtemp(join(tmpdir(), "persistence-")); roots.push(dir);
  return createSession({ workspaceRoot: dir, budgetCents: 500, approvalMode: "auto" });
}

/** A seller that refuses every image prompt with a 400 and its reason, as both did in production. */
function sellers() {
  const sent: { name: string; url?: unknown }[] = [];
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
    sent.push({ name, url: args.url });
    if (name === "inspect_paid_service") return { ok: true, data: { endpoint: args.url, method: "POST", price: "$0.03" } };
    if (name === "find_paid_service") return { ok: true, data: { results: [{ url: KOINELIX }] } };
    const body = args.url === AGENT402 ? REFUSED : BLOCKED;
    return { ok: false, data: { outcome: "paid_failure", status: 400, data: body }, error: `the service answered HTTP 400${sellerSays(JSON.stringify(body), "application/json")}` };
  });
  const definitions = ["call_paid_service", "inspect_paid_service", "find_paid_service"].map((name) => ({ name, description: name, parameters: { type: "object" } }));
  return { sent, dynamicTools: { definitions, execute } };
}
const call = (id: string, name: string, args: Record<string, unknown>) => ({ content: "", toolCalls: [{ id, name, arguments: args }] });
/** The wrap-up instruction is the newest thing the model was told. */
const wrapping = (messages: { role?: string; content: string }[]) => String(messages.filter((m) => m.role === "user").at(-1)?.content ?? "").includes("CrowdCode is ending this run");
const done = (message: string) => call("done", "complete_session", { final_message: message });

describe("a failed paid call changes strategy, never ends the run (adf318ab)", () => {
  it("refuses the identical repeat unsent, switches provider, and delivers the story", async () => {
    const { sent, dynamicTools } = sellers();
    const prompt = { prompt: "sensual boudoir portrait", moderation: "low" };
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce(call("a", "call_paid_service", { url: AGENT402, body: prompt }))
      // The same request again, as in production: refused without being sent.
      .mockResolvedValueOnce(call("b", "call_paid_service", { url: AGENT402, body: JSON.stringify(prompt) }))
      .mockResolvedValueOnce(call("c", "inspect_paid_service", { url: KOINELIX, method: "POST" }))
      .mockResolvedValueOnce(call("d", "call_paid_service", { url: KOINELIX, method: "POST", body: { prompt: "fine-art nude" } }))
      .mockResolvedValueOnce(done(`${STORY}\n\nThe pictures are blocked: both image services refused the content.`)) };
    const result = await runAgentTaskDetailed(await session(), TASK, { provider, dynamicTools, knowledge: false });

    expect(result.outcome).toBe("completed");
    expect(result.summary.final_message).toContain("The story, written in full.");
    expect(sent.filter((s) => s.name === "call_paid_service").map((s) => s.url)).toEqual([AGENT402, KOINELIX]);
    const seen = JSON.stringify(provider.complete.mock.calls.at(-1));
    // The seller's reason, and what to do about it, are in what the model read.
    expect(seen).toContain("Flagged: sexual");
    expect(seen).toContain("rejected by the safety system");
    expect(seen).toContain("this exact request already failed in this run");
    expect(seen).toContain("switch to another provider");
    expect(seen).not.toMatch(/Stopped after \d+ service call failures/);
  });

  it("asks for an inspection before a failed, uninspected endpoint is called again, and marks it bad after three failures", () => {
    const state = newPersistenceState();
    const failure = { ok: false, error: "the service answered HTTP 400: bad size" };
    recordResult(state, "call_paid_service", { url: AGENT402, body: { size: "9x9" } }, failure, false);
    expect(refuseRepeat(state, "call_paid_service", { url: AGENT402, body: { size: "1024x1024" } }, [])).toContain("has not been inspected");
    expect(refuseRepeat(state, "call_paid_service", { url: AGENT402, body: { size: "1024x1024" } }, [`POST ${AGENT402}`])).toBeUndefined();
    recordResult(state, "call_paid_service", { url: AGENT402, body: { size: "1" } }, failure, false);
    recordResult(state, "call_paid_service", { url: AGENT402, body: { size: "2" } }, failure, false);
    expect(refuseRepeat(state, "call_paid_service", { url: AGENT402, body: { size: "3" } }, [`POST ${AGENT402}`])).toContain("marked bad");
    // A refusal is not a new failure of the seller, and other tools may retry.
    recordResult(state, "call_paid_service", { url: KOINELIX }, { ok: false, error: "Refused by the owner's standing rule" }, true);
    expect(state.endpointFailures[`POST ${KOINELIX}`]).toBeUndefined();
    recordResult(state, "run_shell", { command: "npm test" }, { ok: false, error: "exit 1" }, false);
    expect(refuseRepeat(state, "run_shell", { command: "npm test" }, [])).toBeUndefined();
  });

  it("after a long streak with nothing working, tells it to change strategy, then has it deliver what it can, labelled as CrowdCode's stop", async () => {
    let n = 0;
    const execute = vi.fn(async () => ({ ok: false, error: "the service answered HTTP 400: refused" }));
    const dynamicTools = { definitions: [{ name: "call_paid_service", description: "pay", parameters: { type: "object" } }], execute };
    const provider = { complete: vi.fn(async (messages: { content: string }[]) =>
      // Each turn a new seller, so nothing here is a repeat: only the streak ends it.
      wrapping(messages) ? done(STORY) : call(`c${n}`, "call_paid_service", { url: `https://images-${n++}.example/generate`, body: { prompt: "x" } })) };
    const result = await runAgentTaskDetailed(await session(), TASK, { provider, dynamicTools, knowledge: false });

    expect(result.outcome).toBe("stopped");
    expect(execute).toHaveBeenCalledTimes(WRAP_UP_TURNS);
    expect(result.summary.final_message).toMatch(/^# Midnight Silk[\s\S]*\n\nStopped by CrowdCode: 12 turns in a row made no progress\./);
    const seen = JSON.stringify(provider.complete.mock.calls);
    expect(seen).toContain("the last 4 turns made no progress");
    expect(seen).toContain("CrowdCode is ending this run");
  });

  it("spends its last turn delivering, not on a line about turns", async () => {
    let n = 0;
    const execute = vi.fn(async () => ({ ok: true, data: { status: 200, data: { progress: n } } }));
    const dynamicTools = { definitions: [{ name: "call_paid_service", description: "pay", parameters: { type: "object" } }], execute };
    const provider = { complete: vi.fn(async (messages: { content: string }[]) =>
      wrapping(messages) ? done("Chapters 1 to 4 are written below.") : call(`c${n}`, "call_paid_service", { url: `https://x.example/${n++}` })) };
    const result = await runAgentTaskDetailed(await session(), TASK, { provider, dynamicTools, knowledge: false, maxTurns: 6 });
    expect(result.outcome).toBe("max_turns");
    expect(result.summary.final_message).toBe("Chapters 1 to 4 are written below.\n\nStopped by CrowdCode: it reached its limit of 6 turns.");
  });
});

describe("the seller's reason in the error line", () => {
  it("quotes its message, scrubbed and short, and nothing for an HTML page", () => {
    expect(sellerSays(JSON.stringify(REFUSED), "application/json")).toBe(`: ${REFUSED.error}`);
    expect(sellerSays(JSON.stringify(BLOCKED))).toBe(": Your request was rejected by the safety system.");
    expect(sellerSays(JSON.stringify({ detail: [{ msg: "x" }], message: "size must be 1024x1024" }))).toBe(": size must be 1024x1024");
    expect(sellerSays("<!DOCTYPE html><html>502</html>", "text/html")).toBe("");
    expect(sellerSays(JSON.stringify({ error: "bad key Bearer abcdefghijklmnopqrstuvwxyz0123" }))).not.toContain("abcdefghijklmnop");
    expect(sellerSays("x".repeat(1000)).length).toBeLessThan(310);
  });
});
