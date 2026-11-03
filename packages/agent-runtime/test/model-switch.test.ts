import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createSession } from "@opencrowd/core";
import { compactContext, type ContextState } from "../src/context.js";
import { runAgentTaskDetailed, type LlmMessage } from "../src/index.js";

/**
 * SRI-81, as reliability sweep #2 found it. An owner pastes four ~40,000-token
 * logs into one chat, asks for the four "IMPORTANT FACT" lines, gets all four,
 * then switches to a dearer model and asks again. The switch compacted the
 * chat from 178,000 tokens to 14,000 and the new model answered "Part 2
 * reported no specific important fact": the turn that pasted part 2 had
 * missed it, and that stale line was what survived of the chat.
 */
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function session() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "model switch ")); roots.push(workspaceRoot);
  return createSession({ workspaceRoot, shellEnabled: true });
}

const FACTS = ["the vessel is AMBERJACK-7", "the cargo was 4,312 tonnes", "it docked on 14 March", "it used berth 19"];
const STALE = "[Part 2 reported no specific important fact — routine maritime jargon only]";
const CORRECT = `The four important facts: Part 1: ${FACTS[0]}. Part 2: ${FACTS[1]}. Part 3: ${FACTS[2]}. Part 4: ${FACTS[3]}.`;
const QUESTION = "List the IMPORTANT FACT line from each of parts 1-4.";

function log(part: number): string {
  const filler = Array.from({ length: 1700 }, (_, i) => `${part}.${i} pilot boarded, tug made fast, ballast trimmed, VHF 12 watch kept, draught read aft 9.4 m`);
  filler.splice(900, 0, `IMPORTANT FACT: ${FACTS[part - 1]}.`);
  return `Here is part ${part} of 4 of our port operations log. Reply with only the IMPORTANT FACT it contains.\n${filler.join("\n")}`;
}

const REFLECT = "Your final answer is already saved and will be delivered to the user exactly as written. " + "Reflect once on services worth paying for. ".repeat(20);
let call = 0;
/** An answer, then the housekeeping a hosted turn ends with, as production records it. */
function answered(content: string): LlmMessage[] {
  const id = `c${call++}`;
  return [{ role: "assistant", content }, { role: "user", content: REFLECT },
    { role: "assistant", content: "", toolCalls: [{ id, name: "complete_session", arguments: { summary: "done" } }] },
    { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, data: { completed: true } }) }];
}

/** The sweep's chat: an earlier task, four pasted logs, a recall, the same question after the switch. */
function longChat(): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: "You are a hosted CrowdCode agent.\n" + "Rule: be careful with money. ".repeat(740) },
    { role: "user", content: "Compare the Lisbon to Porto trains and save a table to artifacts/trains.md." }];
  for (let i = 0; i < 6; i++) {
    const id = `r${i}`;
    messages.push({ role: "assistant", content: `Checking source ${i}.`, toolCalls: [{ id, name: "run_shell", arguments: { command: `curl -s cp.pt/${i}` } }] },
      { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, data: { stdout: "fare table ".repeat(400) } }) });
  }
  messages.push(...answered("Saved artifacts/trains.md: Alfa Pendular is faster, Intercidades is cheaper."));
  for (let part = 1; part <= 4; part++) {
    messages.push({ role: "user", content: log(part) });
    // The turn that pasted part 2 missed its fact: a model miss, and the line
    // that must not outlive the correction.
    messages.push(...answered(part === 2 ? STALE : `The important fact: ${FACTS[part - 1]}.`));
  }
  messages.push({ role: "user", content: QUESTION }, ...answered(CORRECT));
  // The same question, now on the switched model.
  messages.push({ role: "user", content: QUESTION });
  return messages;
}

// The switched-to model as production priced it: venice/deepseek-v4-flash.
const switched = { contextWindowTokens: 1_000_000, maxOutputTokens: 4096, tools: [{ name: "run_shell", description: "d".repeat(20_000) }],
  prices: { inputPriceUsdPerMillion: 0.1656, cachedInputPriceUsdPerMillion: 0.0336 } };
const note = "[Automatic note from CrowdCode, not written by the user; do not reply to it. Current hosted financial snapshot: {}]";

it("keeps the newest answer word for word and the pasted logs searchable when a model switch compacts a long chat", async () => {
  const s = await session(), messages = longChat(), state: ContextState = { note };
  const result = await compactContext(s, messages, { ...switched, state });
  expect(result.archivePath).toBeTruthy();
  expect(result.tokensBefore).toBeGreaterThan(150_000);
  expect(result.tokensAfter).toBeLessThan(result.tokensBefore / 2);

  // The answer from one turn earlier is still in the request, verbatim, and
  // the question it answered is too.
  expect(messages.filter(m => m.role === "assistant").map(m => m.content)).toContain(CORRECT);
  expect(messages.at(-1)).toEqual({ role: "user", content: QUESTION });
  // So are the older answers, the stale one included: the pasted logs were
  // what was big, and they were saved to files rather than any exchange cut.
  expect(result.summarized).toBe(0);
  expect(result.saved).toBe(10); // the six research results, then the four logs
  const at = (content: string) => messages.findIndex(m => m.content === content);
  expect(at(CORRECT)).toBeGreaterThan(at(STALE));

  // Each log is a pointer that says what it was and where it is, and the
  // file holds every word: grep finds all four facts.
  const pointers = messages.filter(m => m.role === "user" && m.content.includes("saved verbatim"));
  expect(pointers).toHaveLength(4);
  pointers.forEach((pointer, i) => expect(pointer.content).toContain(`It began: "Here is part ${i + 1} of 4 of our port operations log.`));
  const found = execFileSync("grep", ["-rh", "IMPORTANT FACT", "context/"], { cwd: s.sessionDir, encoding: "utf8" });
  for (const fact of FACTS) expect(found).toContain(fact);
  // And the model is told to look there rather than trust a summary.
  const reference = messages.find(m => m.contextArchive)!.content;
  expect(reference).toMatch(/search the archive and any saved message files/);
});

it("summarizes a superseded answer before its correction, and the correction in full", async () => {
  // The chat goes on after the switch until even the questions and answers
  // about the logs have to go. Their lines in the summary then carry all four
  // facts, not the first 160 characters of them, after the stale line they
  // correct, and under a rule that says which one stands.
  const s = await session(), messages = longChat();
  messages[0] = { role: "system", content: "You are a hosted CrowdCode agent." };
  await compactContext(s, messages, { ...switched, state: {} });
  messages.push(...answered(CORRECT));
  for (let i = 0; i < 6; i++)
    messages.push({ role: "user", content: `Draft section ${i} of the port report.` }, { role: "assistant", content: `Section ${i}: ` + "The berth schedule held. ".repeat(250) });
  messages.push({ role: "user", content: QUESTION });
  const result = await compactContext(s, messages, { contextWindowTokens: 16_000, maxOutputTokens: 1024, tools: [], state: {} });
  expect(result.summarized).toBeGreaterThan(0);
  expect(messages.some(m => m.content === CORRECT)).toBe(false);
  const reference = messages.find(m => m.contextArchive)!.content;
  const lines = reference.split("\n").filter(line => line.startsWith("- "));
  const stale = lines.findIndex(line => line.includes("no specific important fact"));
  const correct = lines.findIndex(line => line.includes(FACTS[3]) && line.includes(FACTS[0]));
  expect(stale).toBeGreaterThan(-1);
  expect(correct).toBeGreaterThan(stale);
  for (const fact of FACTS) expect(lines[correct]).toContain(fact);
  expect(reference).toMatch(/later one stands/);
  // The newest exchange before the question is still there word for word.
  expect(messages.some(m => m.content.startsWith("Section 5: "))).toBe(true);
});

it("removes the newest answer only after every older exchange", async () => {
  const s = await session();
  const messages: LlmMessage[] = [{ role: "system", content: "Rules." }, { role: "user", content: "Start." }];
  for (let i = 0; i < 30; i++) messages.push({ role: "user", content: `Question ${i} ` + "context ".repeat(300) }, { role: "assistant", content: `Answer ${i} ` + "detail ".repeat(300) });
  messages.push({ role: "user", content: "And now?" });
  const result = await compactContext(s, messages, { contextWindowTokens: 16_000, maxOutputTokens: 1024, tools: [], state: {} });
  expect(result.summarized).toBeGreaterThan(0);
  expect(messages.some(m => m.content.startsWith("Answer 29 "))).toBe(true);
  expect(messages.some(m => m.content.startsWith("Question 29 "))).toBe(true);
  expect(messages.some(m => m.content.startsWith("Answer 0 "))).toBe(false);
  const raw = await readFile(join(s.sessionDir, result.archivePath!), "utf8");
  expect(raw).toContain("Answer 0 ");
});

it("lets the switched model find all four facts in the saved logs through the real agent loop", async () => {
  const s = await session(), chat = longChat(), task = chat.pop()!.content;
  let calls = 0;
  const result = await runAgentTaskDetailed(s, task, { ...switched, tools: ["run_shell"], history: chat.slice(1), provider: {
    complete: async (messages) => {
      calls++;
      if (calls === 1) {
        // The request is the compacted one: every log is still there, as a
        // pointer or, where it fits, in full; the newest answer is still
        // there; and the model is told to search.
        expect(messages.filter(m => m.content.includes("port operations log"))).toHaveLength(4);
        expect(messages.filter(m => m.content.includes("saved verbatim") && m.content.includes("port operations log")).length).toBeGreaterThan(0);
        expect(messages.some(m => m.content === CORRECT)).toBe(true);
        expect(messages.find(m => m.contextArchive)?.content).toMatch(/search the archive and any saved message files/);
        return { content: "Checking the saved logs.", toolCalls: [{ id: "grep", name: "run_shell",
          arguments: { command: "grep -rhoE 'IMPORTANT FACT: [^.]*' context/ | sort -u" } }] };
      }
      const output = messages.at(-1)!.content;
      for (const fact of FACTS) expect(output).toContain(fact);
      return { content: CORRECT, toolCalls: [] };
    }
  } });
  expect(result.outcome).toBe("completed");
  expect(result.summary.final_message).toBe(CORRECT);
});
