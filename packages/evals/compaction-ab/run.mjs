// One run of one arm on one task (w125 compaction A/B).
//   node run.mjs --root <opencrowd checkout> --arm baseline|llm|llm_keep3 --task <id> --rep <n> --model <id> --window <tokens> --out <dir>
// The arm is the opencrowd build at --root; everything else (model, window, tasks, wallet) is the same.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const root = resolve(arg("root")), arm = arg("arm"), taskId = arg("task"), rep = arg("rep", "1");
const provider = arg("provider", "venice"), model = arg("model", "openai-gpt-6-luna"), windowTokens = Number(arg("window", "32000")), maxTurns = Number(arg("max-turns", "30"));
const out = resolve(arg("out")), maxOutput = Number(arg("max-output", "1536"));
const task = TASKS[taskId];
if (!task) throw new Error(`unknown task ${taskId}`);
const runDir = join(out, `${taskId}__${arm}__${model.replace(/\W+/g, "-")}__r${rep}`);
await rm(runDir, { recursive: true, force: true });
const workspace = join(runDir, "workspace"), configDir = join(runDir, "config");
await mkdir(workspace, { recursive: true }); await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, "config.json"), JSON.stringify({ provider, [provider]: { model, submodel: "off" } }));
process.env.OPENCROWD_CONFIG_DIR = configDir;
process.env.OPENCROWD_DISABLE_CONNECTORS = "1"; // no paid tools, no live tree: only the model is bought
// The arm is the build at --root (the A/B compared opencrowd main ef540ab with the summary branch); its name only labels the run.
await task.setup(workspace);

const rt = await import(join(root, "packages/agent-runtime/dist/index.js"));
const runtime = rt.createOpenCrowdRuntime({
  workspace,
  llmProvider: async (session) => {
    const llm = await rt.resolveLlmRuntime(session, { model, nonInteractive: true });
    // Same output cap in every arm: BlockRun quotes (and charges) on max_tokens.
    llm.catalog = llm.catalog.map((m) => (m.id === llm.models.main ? { ...m, maxOutputTokens: maxOutput } : m));
    return { kind: "typed", main: { provider: llm.provider, model: llm.models.main, maxCostCentsPerCall: llm.maxCostCentsPerCall,
      maxTopUpCentsPerAction: 0, promptCacheKey: session.sessionId, catalog: llm.catalog }, contextWindowTokens: windowTokens };
  },
});
const session = await runtime.createSession({ budgetCents: Number(arg("budget-cents", "60")), approvalMode: "auto", shellEnabled: true });
const wakes = [], answers = [], compactions = [];
for (const [index, prompt] of task.wakes.entries()) {
  const started = Date.now(); let firstStep;
  const events = [];
  let result, error;
  try {
    result = await runtime.runTask(session, prompt, { maxTurns, onProgress: (event) => {
      if (firstStep === undefined && ["tool_call", "assistant_delta", "tool_result"].includes(event.type)) firstStep = Date.now() - started;
      if (event.message?.startsWith("Compacted context")) compactions.push({ wake: index, ...event.data });
      events.push({ t: Date.now() - started, type: event.type, message: String(event.message ?? "").slice(0, 300) });
    } });
  } catch (e) { error = String(e?.stack ?? e).slice(0, 2000); }
  const answer = result?.summary?.final_message ?? "";
  answers.push(answer);
  wakes.push({ index, prompt: prompt.slice(0, 120), outcome: result?.outcome ?? "error", turns: result?.turns, ms: Date.now() - started, firstStepMs: firstStep, answer, error });
  await writeFile(join(runDir, `wake-${index}-events.json`), JSON.stringify(events, null, 1));
  process.stdout.write(`${taskId} ${arm} r${rep} wake ${index}: ${result?.outcome ?? "error"} turns=${result?.turns} ${((Date.now() - started) / 1000).toFixed(0)}s${error ? ` ERROR ${error.slice(0, 200)}` : ""}\n`);
}
// Every model call, from the session ledger: tokens, cache and what was paid.
const parseCsv = (text) => {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else if (c === '"') quoted = true; else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...rest] = rows; return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};
const ledger = parseCsv(await readFile(session.ledgerPath, "utf8").catch(() => ""));
const calls = ledger.filter((e) => e.type === "llm_call").map((e) => ({ ...e, charged_cost_cents: Number(e.charged_cost_cents || 0), input_tokens: Number(e.input_tokens || 0), output_tokens: Number(e.output_tokens || 0), latency_ms: Number(e.latency_ms || 0) }));
const cachedOf = (e) => { try { return Number(JSON.parse(e.notes || "{}").cached_input_tokens ?? 0); } catch { return 0; } };
const grade = await task.grade(workspace, answers);
const record = {
  task: taskId, arm, provider, model, rep: Number(rep), windowTokens, maxOutput, root,
  wakes, compactions, grade,
  calls: calls.map((e) => ({ status: e.status, in: e.input_tokens, out: e.output_tokens, cached: cachedOf(e), cents: e.charged_cost_cents, ms: e.latency_ms, notes: e.notes })),
};
await writeFile(join(runDir, "record.json"), JSON.stringify(record, null, 1));
const recall = Object.values(grade.recall);
process.stdout.write(`${taskId} ${arm} r${rep} DONE success=${grade.success} recall=${recall.filter(Boolean).length}/${recall.length} calls=${calls.length} cents=${calls.reduce((a, e) => a + (e.charged_cost_cents ?? 0), 0).toFixed(3)} compactions=${compactions.length}\n`);
