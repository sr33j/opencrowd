import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Static, Text, useApp, useInput, usePaste, useStdout } from "ink";
import {
  budgetStatus, updateConfig, saveSession, type SpendingApproval, type SpendingAnswer,
  clearConversation,
  createOpenCrowdSession,
  loadConfig,
  setApprovalMode,
  type ApprovalMode,
  type ProgressEvent,
  type SessionState
} from "@opencrowd/core";
import type { ApprovalAnswer, ApprovalRequest } from "@opencrowd/economy";
import { metamaskDeepLink, qrTerminal, SUGGESTED_FUND_CENTS, usdcTransferUri } from "./funding.js";
import { buildSessionSummary, normalizeProviderId } from "@opencrowd/agent-runtime";
import { walletSummary } from "../wallet.js";
import { ensureMockRuntime, runPersistentAgentTask, warmStartEconomy, type ReplState } from "../agent-task.js";
import {
  matchCommands,
  renderCommandHelp,
  runSlashCommand,
  sessionHasPendingReviews,
  type CommandResult
} from "../registry.js";
import { envFlag, parseUsd, formatCents, shortUrl, truncateMiddle } from "../shared.js";
import { insertInputText } from "./input.js";

let nextItemId = 1;

type Item =
  | { id: number; kind: "banner"; text: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "command"; text: string }
  | { id: number; kind: "agent"; text: string }
  | { id: number; kind: "block"; label?: string; text: string }
  | { id: number; kind: "tool"; text: string }
  | { id: number; kind: "tool-ok"; text: string }
  | { id: number; kind: "tool-err"; text: string }
  | { id: number; kind: "payment"; text: string }
  | { id: number; kind: "note"; text: string }
  | { id: number; kind: "error"; text: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Modal =
  | { type: "wallet"; tab: "overview" | "limits"; field: "call" | "query"; call: string; query: string }
  | { type: "spending"; request: SpendingApproval; resolve: (answer: SpendingAnswer) => void; budget?: string }
  | { type: "approval"; request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void };

type Wizard =
  | { step: "fund"; address: string; qr?: string; balanceCents: number }
  | { step: "done"; funded: boolean; budgetCents: number };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface AppProps {
  session: SessionState;
  initialTestMode: boolean;
  initialTestSeed?: string;
  defaultModel: string;
}

interface WalletInfo {
  label?: string;
  balanceCents?: number;
}

function App({ session: initialSession, initialTestMode, initialTestSeed, defaultModel }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = Math.max(60, Math.min(140, stdout?.columns ?? 100));

  const [session, setSession] = useState(initialSession);
  const stateRef = useRef<ReplState>({ testMode: initialTestMode, testSeed: initialTestSeed });
  const forceQuitRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const lastServiceUrlRef = useRef<string>("");
  const ctrlCArmedRef = useRef(false);
  const streamedTextRef = useRef("");

  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [modal, setModal] = useState<Modal | null>(null);
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const [wallet, setWallet] = useState<WalletInfo>({});
  const [tick, setTick] = useState(0);
  const [exiting, setExiting] = useState(false);

  const push = useCallback((item: DistributiveOmit<Item, "id">) => {
    setItems((prev) => [...prev, { ...item, id: nextItemId++ } as Item]);
  }, []);

  const refreshWallet = useCallback(async () => {
    if (stateRef.current.testMode) {
      setWallet({ label: "demo", balanceCents: 2500 });
      setTick((value) => value + 1);
      return;
    }
    try {
      const summary = await walletSummary();
      setWallet({ label: "agentcash", balanceCents: summary.totalCents });
    } catch {
      setWallet({});
    }
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    push({ kind: "banner", text: "" });
    // First render never waits on the network: vendors, wallet balance, and
    // catalogs initialize concurrently in the background after paint.
    if (stateRef.current.testMode) {
      void refreshWallet();
      return;
    }
    let cancelled = false;
    void (async () => {
      await warmStartEconomy();
      const summary = await walletSummary().catch(() => undefined);
      if (cancelled) {
        return;
      }
      setWallet({ label: "agentcash", balanceCents: summary?.totalCents });
      if (summary?.address && (summary.totalCents === undefined || summary.totalCents === 0)) {
        // The shared wallet exists but is unfunded: offer the deposit panel.
        setWizard((current) => current ?? { step: "fund", address: summary.address as string, balanceCents: 0 });
      }
      setTick((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!busy && wizard?.step !== "fund") {
      return;
    }
    const timer = setInterval(() => setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, [busy, wizard?.step]);

  const suggestions = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) {
      return [];
    }
    return matchCommands(input.slice(1));
  }, [input]);

  useEffect(() => {
    setSuggestionIndex(0);
  }, [input]);

  useEffect(() => {
    if (wizard?.step !== "fund") {
      return;
    }
    const address = wizard.address;
    let cancelled = false;
    if (!wizard.qr) {
      void qrTerminal(usdcTransferUri(address, SUGGESTED_FUND_CENTS))
        .then((qr) => setWizard((current) => !cancelled && current?.step === "fund" ? { ...current, qr } : current))
        .catch(() => {});
    }
    const poll = async () => {
      try {
        const summary = await walletSummary();
        const cents = summary.totalCents ?? Number.NaN;
        if (cancelled || !Number.isFinite(cents)) {
          return;
        }
        if (cents > 0) {
          const budgetCents = session.budgetCents;
          if (!cancelled) {
            setWizard({ step: "done", funded: true, budgetCents });
            void refreshWallet();
          }
          return;
        }
        setWizard((current) => current?.step === "fund" ? { ...current, balanceCents: Math.max(0, cents) } : current);
      } catch {
        // transient RPC failures are fine while polling
      }
    };
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizard?.step === "fund" ? wizard.address : null]);

  const finalize = useCallback(async (reason: string) => {
    if (exiting) {
      return;
    }
    if (!forceQuitRef.current && await sessionHasPendingReviews(session).catch(() => false)) {
      forceQuitRef.current = true;
      push({
        kind: "note",
        text: "a confirmed paid purchase still needs its CrowdCode review — ask the agent to submit it, or /quit again to exit with the review pending"
      });
      return;
    }
    setExiting(true);
    try {
      const summary = await buildSessionSummary(session, reason, { compact: false });
      push({ kind: "block", label: "Session summary", text: indent(summary) });
    } catch (error) {
      push({ kind: "error", text: (error as Error).message });
    }
    setTimeout(() => exit(), 80);
  }, [exit, exiting, push, session]);

  const handleProgress = useCallback((event: ProgressEvent) => {
    switch (event.type) {
      case "calling_llm":
        streamedTextRef.current = "";
        setActivity(event.message.replace(/^Calling LLM provider \(turn /, "thinking… (turn ").replace(/\)$/, ")"));
        return;
      case "assistant_delta":
        streamedTextRef.current += event.message;
        setActivity(streamedTextRef.current.slice(-120).replace(/\s+/g, " "));
        return;
      case "calling_tool": {
        const summary = event.message.replace(/^Tool call: /, "");
        const data = event.data as { tool?: string; arguments?: Record<string, unknown> } | undefined;
        if (data?.tool === "call_paid_service") {
          lastServiceUrlRef.current = String(data.arguments?.url ?? "");
        }
        push({ kind: "tool", text: summary });
        setActivity(summary);
        return;
      }
      case "tool_result": {
        const data = event.data as { tool?: string; ok?: boolean; error?: string; result?: Record<string, unknown> } | undefined;
        const summary = event.message.replace(/^Tool result: /, "");
        if (data?.tool === "call_paid_service" && data.ok && data.result) {
          const charged = Number(data.result.charged_cost_cents ?? 0);
          const outcome = String(data.result.outcome ?? "?");
          const artifact = data.result.artifact_path ? ` · saved ${String(data.result.artifact_path)}` : "";
          const host = lastServiceUrlRef.current ? shortUrl(lastServiceUrlRef.current) : "service";
          push({ kind: "payment", text: charged > 0 ? `paid ${formatCents(charged)} → ${host} (${outcome})${artifact}` : `${outcome} → ${host}${artifact}` });
        } else if (data?.ok === false) {
          push({ kind: "tool-err", text: summary });
        } else {
          push({ kind: "tool-ok", text: summary });
        }
        setTick((value) => value + 1);
        return;
      }
      case "requesting_permission":
        setActivity("waiting for your approval…");
        return;
      case "complete":
        push({ kind: "note", text: event.message });
        return;
      default:
        setActivity(event.message);
    }
  }, [push]);

  const submitTask = useCallback(async (task: string) => {
    const state = stateRef.current;
    const testMode = state.testMode;
    if (testMode) {
      ensureMockRuntime(state);
    }
    push({ kind: "user", text: task });
    setBusy(true);
    setActivity("starting…");
    try {
      const outputText = await runPersistentAgentTask(session, task, {
        testMode,
        testSeed: state.testSeed,
        mockProvider: testMode ? state.mockProvider : undefined,
        mockToolExecutor: testMode ? state.mockToolExecutor : undefined,
        compactOutput: true,
        onProgress: handleProgress,
        spendingHandler: (request) => new Promise<SpendingAnswer>((resolve) => {
          setModal({ type: "spending", request, resolve: answer => { setModal(null); resolve(answer); } });
          setActivity("waiting for spending approval…");
        }),
        approvalHandler: (request) => new Promise<ApprovalAnswer>((resolve) => {
          setModal({
            type: "approval",
            request,
            resolve: (answer) => {
              setModal(null);
              setActivity(`approval: ${answer.decision.replace("_", " ")}`);
              resolve(answer);
            }
          });
        })
      });
      push({ kind: "agent", text: outputText });
    } catch (error) {
      push({ kind: "error", text: (error as Error).message });
    }
    setBusy(false);
    setActivity("");
    void refreshWallet();
  }, [handleProgress, push, refreshWallet, session]);

  const handleCommandResult = useCallback(async (result: CommandResult) => {
    switch (result.kind) {
      case "wallet":
        setModal({ type: "wallet", tab: "overview", field: "call", call: String((session.perCallCents ?? 100) / 100), query: String(session.budgetCents / 100) });
        return;
      case "text":
        push({ kind: "block", label: result.label, text: result.body });
        return;
      case "help":
        push({ kind: "block", label: "Commands", text: renderCommandHelp() });
        return;
      case "clear": {
        const cleared = await clearConversation(session);
        // Static items already flushed to the terminal can only be removed
        // by clearing the screen; the items array must keep growing because
        // Static tracks how many entries it has rendered.
        stdout?.write("\x1b[2J\x1b[3J\x1b[H");
        push({ kind: "banner", text: "" });
        push({
          kind: "note",
          text: cleared.cleared
            ? `context cleared — ${cleared.messagesCleared} prior messages archived to ${cleared.archivePath}`
            : "context is already empty"
        });
        return;
      }
      case "exit":
        await finalize("Interactive session ended.");
        return;
      case "new-session": {
        const next = await createOpenCrowdSession({ workspaceRoot: process.cwd() });
        setSession(next);
        forceQuitRef.current = false;
        stdout?.write("\x1b[2J\x1b[3J\x1b[H");
        push({ kind: "banner", text: "" });
        push({ kind: "note", text: `new session ${next.sessionId}` });
        setTick((value) => value + 1);
        return;
      }
    }
  }, [finalize, push, session, stdout]);

  const handleSubmit = useCallback(async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    historyRef.current.push(trimmed);
    setHistoryIndex(-1);
    setInput("");
    setCursor(0);
    if (trimmed.startsWith("/")) {
      push({ kind: "command", text: trimmed });
      try {
        const result = await runSlashCommand({ session, state: stateRef.current }, trimmed.slice(1));
        await handleCommandResult(result);
      } catch (error) {
        push({ kind: "error", text: (error as Error).message });
      }
      setTick((value) => value + 1);
      void refreshWallet();
      return;
    }
    if (trimmed === ":quit" || trimmed === ":exit") {
      await finalize("Interactive session ended.");
      return;
    }
    await submitTask(trimmed);
  }, [finalize, handleCommandResult, push, refreshWallet, session, submitTask]);

  const toggleMode = useCallback(() => {
    const next: ApprovalMode = session.approvalMode === "auto" ? "ask" : "auto";
    void setApprovalMode(session, next).then(() => {
      push({ kind: "note", text: `permission mode → ${next}` });
      setTick((value) => value + 1);
    });
  }, [push, session]);

  const insertText = useCallback((text: string) => {
    const next = insertInputText(input, cursor, text);
    setInput(next.value);
    setCursor(next.cursor);
  }, [cursor, input]);

  usePaste((text) => {
    if (exiting || modal || wizard) {
      return;
    }
    insertText(text);
  });

  useInput((char, key) => {
    if (exiting) {
      return;
    }
    const isReturn = key.return || char === "\n" || char === "\r";
    if (key.ctrl && char === "c") {
      if (input) {
        setInput("");
        setCursor(0);
        return;
      }
      if (ctrlCArmedRef.current) {
        void finalize("Interactive session ended.");
        return;
      }
      ctrlCArmedRef.current = true;
      push({ kind: "note", text: "press ctrl+c again to quit" });
      setTimeout(() => {
        ctrlCArmedRef.current = false;
      }, 1500);
      return;
    }
    if (modal?.type === "wallet") {
      if (key.escape) { setModal(null); return; }
      if (key.leftArrow || key.rightArrow || key.tab) { setModal({ ...modal, tab: modal.tab === "overview" ? "limits" : "overview" }); return; }
      if (modal.tab === "limits") {
        if (key.upArrow || key.downArrow) { setModal({ ...modal, field: modal.field === "call" ? "query" : "call" }); return; }
        if (isReturn) {
          void (async () => {
            try {
              const perCall = parseUsd(modal.call), perQuery = parseUsd(modal.query);
              await updateConfig({ llmMaxCostCentsPerCall: perCall, defaultBudgetCents: perQuery });
              session.perCallCents = perCall; session.budgetCents = perQuery; await saveSession(session);
              setModal(null); push({ kind: "note", text: "Spending limits saved. Each new query gets a fresh budget." });
            } catch (e) { push({ kind: "error", text: (e as Error).message }); }
          })(); return;
        }
        const field = modal.field;
        if (key.backspace || key.delete) setModal({ ...modal, [field]: modal[field].slice(0, -1) });
        else if (/^[0-9.]+$/.test(char)) setModal({ ...modal, [field]: modal[field] + char });
      }
      return;
    }
    if (modal?.type === "spending") {
      if (key.escape || char.toLowerCase() === "n") { modal.resolve({ decision: "decline" }); return; }
      if (modal.budget !== undefined) {
        if (isReturn) {
          try {
            const cents = parseUsd(modal.budget);
            if (cents <= modal.request.queryLimitCents || cents < modal.request.projectedCents) throw new Error("Enter a higher budget covering this call and committed spending.");
            modal.resolve({ decision: "approve", queryBudgetCents: cents });
          } catch (e) { push({ kind: "error", text: (e as Error).message }); }
        } else if (key.backspace || key.delete) setModal({ ...modal, budget: modal.budget.slice(0,-1) });
        else if (/^[0-9.]+$/.test(char)) setModal({ ...modal, budget: modal.budget + char });
      } else if (char.toLowerCase() === "y") modal.resolve({ decision: "approve" });
      else if (char.toLowerCase() === "i") setModal({ ...modal, budget: String(Math.ceil(Math.max(modal.request.projectedCents, modal.request.queryLimitCents + 1) / 1000) * 10) });
      return;
    }
    if (modal?.type === "approval") {
      if (char === "y" || char === "Y") {
        modal.resolve({ decision: "allow_once" });
      } else if (char === "a" || char === "A") {
        modal.resolve({ decision: "always_allow" });
      } else if (char === "b" || char === "B") {
        modal.resolve({ decision: "block" });
      } else if (char === "n" || char === "N" || key.escape) {
        modal.resolve({ decision: "deny_once" });
      }
      return;
    }
    if (wizard) {
      if (wizard.step === "fund") {
        if (char === "s" || key.escape) {
          setWizard({ step: "done", funded: false, budgetCents: 0 });
        }
        return;
      }
      if (wizard.step === "done") {
        if (isReturn || key.escape || char === "s") {
          setWizard(null);
        }
        return;
      }
    }
    if (key.tab && key.shift) {
      toggleMode();
      return;
    }
    if (key.tab) {
      const selected = suggestions[suggestionIndex];
      if (selected) {
        setInput(`/${selected.name} `);
        setCursor(selected.name.length + 2);
      }
      return;
    }
    if (isReturn) {
      if (busy) {
        push({ kind: "note", text: "a task is still running — wait for it to finish" });
        return;
      }
      void handleSubmit(input);
      return;
    }
    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSuggestionIndex((index) => (index + suggestions.length - 1) % suggestions.length);
        return;
      }
      const history = historyRef.current;
      if (history.length === 0) {
        return;
      }
      const nextIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex] ?? "");
      setCursor((history[nextIndex] ?? "").length);
      return;
    }
    if (key.downArrow) {
      if (suggestions.length > 0) {
        setSuggestionIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      const history = historyRef.current;
      if (historyIndex === -1) {
        return;
      }
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(-1);
        setInput("");
        setCursor(0);
        return;
      }
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex] ?? "");
      setCursor((history[nextIndex] ?? "").length);
      return;
    }
    if (key.leftArrow) {
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((value) => Math.min(input.length, value + 1));
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput(input.slice(0, cursor - 1) + input.slice(cursor));
        setCursor(cursor - 1);
      }
      return;
    }
    if (key.ctrl && char === "u") {
      setInput("");
      setCursor(0);
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      insertText(char);
    }
  });

  const budget = budgetStatus(session);
  const state = stateRef.current;
  const modeLabel = session.approvalMode;
  const modelLabel = session.models
    ? `${normalizeProviderId(session.models.provider) ?? session.models.provider}/${session.models.main}`
    : defaultModel;

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => <TranscriptLine key={item.id} item={item} width={width} sessionId={session.sessionId} modeLabel={modeLabel} modelLabel={modelLabel} testMode={state.testMode} />}
      </Static>
      {modal?.type === "wallet" && <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Text bold>Wallet · {modal.tab === "overview" ? "[balance]   spending limits" : "balance   [spending limits]"}</Text>
        {modal.tab === "overview" ? <Text>{wallet.label ?? "Agent wallet"} · {formatCents(wallet.balanceCents ?? 0)}</Text> : <>
          <Text>Calls within these limits run automatically. Larger payments ask first.</Text>
          <Text color={modal.field === "call" ? "cyan" : undefined}>Per call  $ {modal.call}{modal.field === "call" ? "▏" : ""}</Text>
          <Text color={modal.field === "query" ? "cyan" : undefined}>Per query $ {modal.query}{modal.field === "query" ? "▏" : ""}</Text>
          <Text dimColor>One query includes its model, tool and subagent calls. Defaults apply to new queries.</Text>
          <Text dimColor>↑/↓ field · enter save · backspace edit</Text>
        </>}
        <Text dimColor>←/→ tabs · esc close</Text>
      </Box>}
      {modal?.type === "spending" && <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text color="yellow" bold>Spending approval required</Text>
        <Text>{modal.request.description}</Text>
        <Text>This call: {formatCents(modal.request.amountCents)} · per-call limit {formatCents(modal.request.perCallCents)}</Text>
        <Text>Query after call: {formatCents(modal.request.projectedCents)} / {formatCents(modal.request.queryLimitCents)}</Text>
        {modal.budget !== undefined ? <><Text>New query budget: $ {modal.budget}▏</Text><Text dimColor>enter approve and increase · esc decline</Text></>
          : <Text dimColor>[y] approve this call · [i] increase query budget · [n]/esc decline</Text>}
        <Text dimColor>Saved defaults stay the same. Future calls still respect the per-call limit.</Text>
      </Box>}
      {modal?.type === "approval" ? <ApprovalModal request={modal.request} /> : null}
      {wizard?.step === "fund" ? <FundPanel address={wizard.address} qr={wizard.qr} spinnerFrame={spinnerFrame} /> : null}
      {wizard?.step === "done" ? <DonePanel funded={wizard.funded} budgetCents={wizard.budgetCents} /> : null}
      {busy ? (
        <Box>
          <Text color="cyan">{SPINNER_FRAMES[spinnerFrame]} </Text>
          <Text dimColor>{truncateMiddle(activity || "working…", width - 4)}</Text>
        </Box>
      ) : null}
      {!modal && !wizard && !exiting ? (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan" bold>{"❯ "}</Text>
            <InputText value={input} cursor={cursor} busy={busy} />
          </Box>
          {suggestions.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2}>
              {suggestions.slice(0, 6).map((command, index) => (
                <Text key={command.name} color={index === suggestionIndex ? "cyan" : undefined} dimColor={index !== suggestionIndex}>
                  {index === suggestionIndex ? "▸ " : "  "}{command.usage.padEnd(46)} {command.summary}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}
      {!exiting ? (
        <StatusBar
          walletLabel={wallet.label}
          walletBalanceCents={wallet.balanceCents}
          spentCents={Number(budget.spent_cents ?? 0)}
          remainingCents={Number(budget.remaining_cents ?? 0)}
          model={modelLabel}
          mode={modeLabel}
          testMode={state.testMode}
          width={width}
          tick={tick}
        />
      ) : null}
    </Box>
  );
}

function InputText({ value, cursor, busy }: { value: string; cursor: number; busy: boolean }): React.ReactElement {
  if (busy && !value) {
    return <Text dimColor>…</Text>;
  }
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}

function TranscriptLine({ item, width, sessionId, modeLabel, modelLabel, testMode }: {
  item: Item;
  width: number;
  sessionId: string;
  modeLabel: string;
  modelLabel: string;
  testMode: boolean;
}): React.ReactElement {
  switch (item.kind) {
    case "banner":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
            <Text>
              <Text color="cyan" bold>OpenCrowd</Text>
              <Text dimColor> — an agent with its own wallet</Text>
            </Text>
            <Text dimColor>session {sessionId.slice(0, 8)}…{sessionId.slice(-6)} · mode {modeLabel} · model {modelLabel}{testMode ? " · DEMO — mock wallet, no real money" : ""}</Text>
          </Box>
          <Text dimColor>  type a task and press enter · /help for commands · shift+tab toggles ask/auto approval · ctrl+c to quit</Text>
        </Box>
      );
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>{"❯ "}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case "command":
      return (
        <Box marginTop={1}>
          <Text color="magenta">{item.text}</Text>
        </Box>
      );
    case "agent":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{item.text}</Text>
        </Box>
      );
    case "block":
      return (
        <Box flexDirection="column" marginTop={item.label ? 1 : 0}>
          {item.label ? <Text dimColor>{item.label}</Text> : null}
          <Text>{item.text}</Text>
        </Box>
      );
    case "tool":
      return <Text>  <Text color="yellow">→</Text> <Text dimColor>{truncateMiddle(item.text, width - 6)}</Text></Text>;
    case "tool-ok":
      return <Text>  <Text color="green">←</Text> <Text dimColor>{truncateMiddle(item.text, width - 6)}</Text></Text>;
    case "tool-err":
      return <Text>  <Text color="red">✗</Text> <Text color="red">{truncateMiddle(item.text, width - 6)}</Text></Text>;
    case "payment":
      return <Text>  <Text color="green" bold>$</Text> <Text color="green">{truncateMiddle(item.text, width - 6)}</Text></Text>;
    case "note":
      return <Text dimColor>  {truncateMiddle(item.text, width - 4)}</Text>;
    case "error":
      return <Text color="red">  {item.text}</Text>;
  }
}

function ApprovalModal({ request }: { request: ApprovalRequest }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>Approval — the agent wants to pay a service</Text>
      <Text>  service  <Text color="cyan">{request.endpoint}</Text></Text>
      <Text>  method   {request.method} · up to {formatCents(request.quotedCostCents)}</Text>
      {request.evidenceSummary ? <Text>  reputation {request.evidenceSummary}</Text> : null}
      <Text dimColor>  [y] allow once · [a] always allow this service · [n]/esc deny · [b] block service</Text>
    </Box>
  );
}

function FundPanel({ address, qr, spinnerFrame }: { address: string; qr?: string; spinnerFrame: number }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>Your agent's wallet is ready — fund it to begin (suggested: {formatCents(SUGGESTED_FUND_CENTS)} USDC on Base)</Text>
      <Text>  address  <Text color="cyan">{address}</Text></Text>
      <Text>  send USDC on Base from any wallet or exchange — or scan / tap below</Text>
      {qr ? <Text>{qr}</Text> : null}
      <Text>  MetaMask mobile: <Text color="cyan">{metamaskDeepLink(address, SUGGESTED_FUND_CENTS)}</Text></Text>
      <Box marginTop={1}>
        <Text color="cyan">{SPINNER_FRAMES[spinnerFrame]} </Text>
        <Text dimColor>waiting for USDC to arrive — checking every few seconds…</Text>
      </Box>
      <Text dimColor>  s: skip for now (you can fund this address any time)</Text>
    </Box>
  );
}

function DonePanel({ funded, budgetCents }: { funded: boolean; budgetCents: number }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={1} marginTop={1}>
      {funded ? (
        <>
          <Text color="green" bold>Funds received — you're ready to go</Text>
          <Text>Each query can spend up to {formatCents(budgetCents)} automatically; larger payments ask first. Edit /wallet → spending limits.</Text>
        </>
      ) : (
        <>
          <Text color="green" bold>Setup complete</Text>
          <Text>Fund the wallet address any time; the agent can't spend what isn't there.</Text>
        </>
      )}
      <Text>Try: <Text color="cyan">find an x402 service that returns live weather and get today's forecast</Text></Text>
      <Text dimColor>enter to start</Text>
    </Box>
  );
}

function StatusBar({ walletLabel, walletBalanceCents, spentCents, remainingCents, model, mode, testMode, width }: {
  walletLabel?: string;
  walletBalanceCents?: number;
  spentCents: number;
  remainingCents: number;
  model: string;
  mode: string;
  testMode: boolean;
  width: number;
  tick: number;
}): React.ReactElement {
  const walletPart = walletLabel
    ? `${walletLabel}${walletBalanceCents !== undefined ? ` ${formatCents(walletBalanceCents)}` : ""}`
    : "wallet initializing…";
  const left = ` ${walletPart} · spent ${formatCents(spentCents)} / left ${formatCents(remainingCents)} · ${model}`;
  const modeBadge = ` ${mode}${testMode ? " · TEST" : ""} `;
  const hint = "shift+tab: mode";
  const padding = Math.max(1, width - left.length - modeBadge.length - hint.length - 2);
  return (
    <Box marginTop={1}>
      <Text dimColor>{truncateMiddle(left, Math.max(20, width - modeBadge.length - hint.length - 3))}</Text>
      <Text>{" ".repeat(padding)}</Text>
      <Text color={mode === "auto" ? "red" : "green"} bold>{modeBadge}</Text>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

export async function startTui(options: { testMode?: boolean; testSeed?: string } = {}): Promise<void> {
  const testMode = options.testMode ?? envFlag("OPENCROWD_TEST_MODE");
  // Session creation and config are local-only; the TUI paints immediately
  // and everything network-touching initializes in the background.
  const session = await createOpenCrowdSession({
    workspaceRoot: process.cwd()
  });
  const config = await loadConfig();
  const { waitUntilExit } = render(
    <App
      session={session}
      initialTestMode={testMode}
      initialTestSeed={options.testSeed ?? process.env.OPENCROWD_TEST_SEED}
      defaultModel={`${config.provider}/${config[config.provider].model}`}
    />,
    { exitOnCtrlC: false }
  );
  await waitUntilExit();
}
