import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink";
import {
  budgetStatus,
  clearConversation,
  confirmWalletDraft,
  createOpenCrowdSession,
  createWalletDraft,
  ensureDefaultTestWallet,
  listStoredWallets,
  loadConfig,
  setPermissionMode,
  setSessionBudget,
  walletBalance,
  walletList,
  type PermissionMode,
  type ProgressEvent,
  type SessionState
} from "@opencrowd/core";
import { metamaskDeepLink, qrTerminal, SUGGESTED_FUND_CENTS, usdcTransferUri } from "./funding.js";
import { exportWalletSecret } from "@opencrowd/core";
import { buildSessionSummary, type PermissionRequest } from "@opencrowd/agent-runtime";
import { ensureMockRuntime, runPersistentAgentTask, type ReplState } from "../agent-task.js";
import { COMMANDS, matchCommands, runSlashCommand, type CommandResult } from "./commands.js";
import { envFlag, formatCents, shortUrl, truncateMiddle } from "../shared.js";

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
  | { type: "permission"; request: PermissionRequest; resolve: (approved: boolean) => void }
  | { type: "seed-export"; target: string; value: string; error?: string };

type WalletDraft = Awaited<ReturnType<typeof createWalletDraft>>;

type Wizard =
  | { step: "welcome" }
  | { step: "seed"; draft: WalletDraft; value: string; error?: string }
  | { step: "fund"; address: string; qr?: string; balanceCents: number }
  | { step: "done"; funded: boolean; budgetCents: number };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface AppProps {
  session: SessionState;
  initialTestMode: boolean;
  initialTestSeed?: string;
  defaultModel: string;
  needsOnboarding: boolean;
}

interface WalletInfo {
  label?: string;
  balanceCents?: number;
}

function App({ session, initialTestMode, initialTestSeed, defaultModel, needsOnboarding }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = Math.max(60, Math.min(140, stdout?.columns ?? 100));

  const stateRef = useRef<ReplState>({ testMode: initialTestMode, testSeed: initialTestSeed });
  const historyRef = useRef<string[]>([]);
  const lastServiceUrlRef = useRef<string>("");
  const ctrlCArmedRef = useRef(false);

  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [modal, setModal] = useState<Modal | null>(null);
  const [wizard, setWizard] = useState<Wizard | null>(needsOnboarding ? { step: "welcome" } : null);
  const [wallet, setWallet] = useState<WalletInfo>({});
  const [tick, setTick] = useState(0);
  const [exiting, setExiting] = useState(false);

  const push = useCallback((item: DistributiveOmit<Item, "id">) => {
    setItems((prev) => [...prev, { ...item, id: nextItemId++ } as Item]);
  }, []);

  const refreshWallet = useCallback(async () => {
    try {
      const wallets = await walletList();
      const active = wallets.find((entry) => entry.active);
      setWallet({ label: active?.label, balanceCents: active?.spendable_balance_cents });
    } catch {
      setWallet({});
    }
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    push({ kind: "banner", text: "" });
    void refreshWallet();
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

  const startWalletCreation = useCallback(async (label?: string) => {
    try {
      const draft = await createWalletDraft(label);
      setWizard({ step: "seed", draft, value: "" });
    } catch (error) {
      setWizard(null);
      push({ kind: "error", text: (error as Error).message });
    }
  }, [push]);

  const handleSeedSubmit = useCallback(async (wizardState: Extract<Wizard, { step: "seed" }>, submitted: string) => {
    const words = wizardState.draft.mnemonic.split(/\s+/);
    const expected = [words[2], words[7], words[11]].join(" ").toLowerCase();
    if (submitted.trim().toLowerCase() !== expected) {
      setWizard({ ...wizardState, value: "", error: "those words do not match — check the seed phrase and try again (esc to cancel)" });
      return;
    }
    try {
      const wallet = await confirmWalletDraft(wizardState.draft);
      push({ kind: "block", label: "Wallet created", text: [
        `  label    ${wallet.label}`,
        `  address  ${wallet.address}`,
        `  network  ${wallet.network}`,
        `  asset    ${wallet.asset}`
      ].join("\n") });
      setWizard({ step: "fund", address: wallet.address, balanceCents: 0 });
      void refreshWallet();
    } catch (error) {
      setWizard(null);
      push({ kind: "error", text: (error as Error).message });
    }
  }, [push, refreshWallet]);

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
        const balance = await walletBalance();
        const cents = balance.spendable_balance_cents ?? Math.floor(Number(balance.spendable_balance) * 100);
        if (cancelled || !Number.isFinite(cents)) {
          return;
        }
        if (cents > 0) {
          const budgetCents = Math.min(2000, cents);
          await setSessionBudget(session, budgetCents);
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
        setActivity(event.message.replace(/^Calling LLM provider \(turn /, "thinking… (turn ").replace(/\)$/, ")"));
        return;
      case "calling_tool": {
        const summary = event.message.replace(/^Tool call: /, "");
        const data = event.data as { tool?: string; arguments?: Record<string, unknown> } | undefined;
        if (data?.tool === "call_service") {
          lastServiceUrlRef.current = String(data.arguments?.resource_url ?? "");
        }
        push({ kind: "tool", text: summary });
        setActivity(summary);
        return;
      }
      case "tool_result": {
        const data = event.data as { tool?: string; ok?: boolean; error?: string; result?: Record<string, unknown> } | undefined;
        const summary = event.message.replace(/^Tool result: /, "");
        if (data?.tool === "call_service" && data.ok && data.result) {
          const charged = Number(data.result.charged_cost_cents ?? 0);
          const status = String(data.result.status ?? "?");
          const artifact = data.result.artifact_path ? ` · saved ${String(data.result.artifact_path)}` : "";
          const host = lastServiceUrlRef.current ? shortUrl(lastServiceUrlRef.current) : "service";
          push({ kind: "payment", text: `paid ${formatCents(charged)} → ${host} (HTTP ${status})${artifact}` });
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

  const submitTask = useCallback(async (task: string, overrides: { model?: string; testMode?: boolean; testSeed?: string } = {}) => {
    const state = stateRef.current;
    const testMode = overrides.testMode ?? state.testMode;
    if (testMode) {
      ensureMockRuntime(state);
    }
    push({ kind: "user", text: task });
    setBusy(true);
    setActivity("starting…");
    try {
      const outputText = await runPersistentAgentTask(session, task, {
        model: overrides.model ?? state.model,
        testMode,
        testSeed: overrides.testSeed ?? state.testSeed,
        mockProvider: testMode ? state.mockProvider : undefined,
        mockToolExecutor: testMode ? state.mockToolExecutor : undefined,
        compactOutput: true,
        onProgress: handleProgress,
        onPermissionRequest: (request) => new Promise<boolean>((resolve) => {
          setModal({
            type: "permission",
            request,
            resolve: (approved) => {
              setModal(null);
              setActivity(approved ? "permission approved" : "permission denied");
              resolve(approved);
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
      case "text":
        push({ kind: "block", label: result.label, text: result.body.startsWith("__summary__")
          ? indent(await buildSessionSummary(session, "Interactive summary.", { compact: !result.body.endsWith("verbose") }))
          : result.body });
        return;
      case "help":
        push({ kind: "block", label: "Commands", text: renderHelp() });
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
      case "run-task":
        if (result.overrides.budgetCents !== undefined) {
          await setSessionBudget(session, result.overrides.budgetCents);
        }
        await submitTask(result.task, result.overrides);
        return;
      case "wallet-new":
        await startWalletCreation(result.label);
        return;
      case "wallet-export":
        setModal({ type: "seed-export", target: result.target, value: "" });
        return;
    }
  }, [finalize, push, session, startWalletCreation, stdout, submitTask]);

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
        const result = await runSlashCommand(session, stateRef.current, trimmed.slice(1));
        await handleCommandResult(result);
      } catch (error) {
        push({ kind: "error", text: (error as Error).message });
      }
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
    const next: PermissionMode = session.permissionMode === "yolo" ? "ask_first" : "yolo";
    void setPermissionMode(session, next).then(() => {
      push({ kind: "note", text: `permission mode → ${next}` });
      setTick((value) => value + 1);
    });
  }, [push, session]);

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
    if (modal?.type === "permission") {
      if (char === "y" || char === "Y") {
        modal.resolve(true);
      } else if (char === "n" || char === "N" || key.escape) {
        modal.resolve(false);
      }
      return;
    }
    if (wizard) {
      if (wizard.step === "welcome") {
        if (isReturn) {
          void startWalletCreation();
        } else if (key.escape || char === "s") {
          setWizard(null);
          push({ kind: "note", text: "skipped setup — run /wallet new whenever you are ready, or /test-mode on to try it without funds" });
        }
        return;
      }
      if (wizard.step === "seed") {
        if (key.escape) {
          setWizard(null);
          push({ kind: "note", text: "wallet creation cancelled; nothing was saved" });
          return;
        }
        if (isReturn) {
          void handleSeedSubmit(wizard, wizard.value);
          return;
        }
        if (key.backspace || key.delete) {
          setWizard({ ...wizard, value: wizard.value.slice(0, -1) });
          return;
        }
        if (char && !key.ctrl && !key.meta) {
          const [first, hasNewline] = splitChunk(char);
          const nextValue = wizard.value + first;
          setWizard({ ...wizard, value: nextValue });
          if (hasNewline) {
            void handleSeedSubmit(wizard, nextValue);
          }
        }
        return;
      }
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
    if (modal?.type === "seed-export") {
      if (key.escape) {
        setModal(null);
        push({ kind: "note", text: "export cancelled" });
        return;
      }
      if (isReturn) {
        void handleModalSubmit();
        return;
      }
      if (key.backspace || key.delete) {
        setModal({ ...modal, value: modal.value.slice(0, -1) });
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        const [first, hasNewline] = splitChunk(char);
        setModal({ ...modal, value: modal.value + first });
        if (hasNewline) {
          void handleModalSubmit(modal.value + first);
        }
      }
      return;
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
      const [first, hasNewline] = splitChunk(char);
      const nextValue = input.slice(0, cursor) + first + input.slice(cursor);
      if (hasNewline) {
        if (busy) {
          push({ kind: "note", text: "a task is still running — wait for it to finish" });
          return;
        }
        setInput("");
        setCursor(0);
        void handleSubmit(nextValue);
        return;
      }
      setInput(nextValue);
      setCursor(cursor + first.length);
    }
  });

  const handleModalSubmit = useCallback(async (valueOverride?: string) => {
    if (!modal || modal.type === "permission") {
      return;
    }
    const submitted = valueOverride ?? modal.value;
    if (modal.type === "seed-export") {
      if (submitted.trim() !== "EXPORT") {
        setModal({ ...modal, value: "", error: "type EXPORT exactly to reveal the seed phrase (esc to cancel)" });
        return;
      }
      try {
        const result = await exportWalletSecret(modal.target);
        setModal(null);
        push({ kind: "block", label: "Wallet seed phrase", text: [
          `  label    ${result.wallet.label}`,
          `  address  ${result.wallet.address}`,
          `  mnemonic ${result.mnemonic}`
        ].join("\n") });
      } catch (error) {
        setModal(null);
        push({ kind: "error", text: (error as Error).message });
      }
    }
  }, [modal, push, refreshWallet]);

  const budget = budgetStatus(session);
  const state = stateRef.current;
  const modeLabel = session.permissionMode;
  const modelLabel = state.model ?? defaultModel;

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => <TranscriptLine key={item.id} item={item} width={width} sessionId={session.sessionId} modeLabel={modeLabel} modelLabel={modelLabel} testMode={state.testMode} />}
      </Static>
      {modal?.type === "permission" ? <PermissionModal request={modal.request} /> : null}
      {modal?.type === "seed-export" ? <SeedExportModal value={modal.value} error={modal.error} /> : null}
      {wizard?.step === "welcome" ? <WelcomePanel /> : null}
      {wizard?.step === "seed" ? <SeedBackupPanel mnemonic={wizard.draft.mnemonic} value={wizard.value} error={wizard.error} /> : null}
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
          <Text dimColor>  type a task and press enter · /help for commands · shift+tab toggles ask_first/yolo · ctrl+c to quit</Text>
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

function PermissionModal({ request }: { request: PermissionRequest }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>Permission request — the agent wants to pay a new service</Text>
      <Text>  service  <Text color="cyan">{request.resource_url}</Text></Text>
      {request.reason ? <Text>  reason   {request.reason}</Text> : null}
      {request.caps?.max_cost_cents !== undefined ? <Text>  max cost {formatCents(request.caps.max_cost_cents)} per call</Text> : null}
      {request.caps?.session_max_cents !== undefined ? <Text>  max this session {formatCents(request.caps.session_max_cents)}</Text> : null}
      <Text dimColor>  [y] approve · [n]/esc deny</Text>
    </Box>
  );
}

function WelcomePanel(): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>Let's set up your agent's wallet</Text>
      <Text>OpenCrowd gives the agent its own small USDC wallet on Base. You stay in control:</Text>
      <Text>  1. Create a fresh wallet (it lives only on this machine)</Text>
      <Text>  2. Back up its seed phrase</Text>
      <Text>  3. Fund it with a few dollars of USDC — this is the agent's entire blast radius</Text>
      <Text dimColor>enter: create wallet · s: skip for now (try /test-mode on for a zero-cost demo)</Text>
    </Box>
  );
}

function FundPanel({ address, qr, spinnerFrame }: { address: string; qr?: string; spinnerFrame: number }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>Fund the agent wallet (suggested: {formatCents(SUGGESTED_FUND_CENTS)} USDC on Base)</Text>
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
          <Text>Session budget set to {formatCents(budgetCents)}. The agent asks before paying any new service.</Text>
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

function SeedBackupPanel({ mnemonic, value, error }: { mnemonic: string; value: string; error?: string }): React.ReactElement {
  const words = mnemonic.split(/\s+/);
  const rows: string[] = [];
  for (let index = 0; index < words.length; index += 4) {
    rows.push(words.slice(index, index + 4).map((word, offset) => `${String(index + offset + 1).padStart(2)}. ${word.padEnd(12)}`).join(" "));
  }
  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>Back up this seed phrase now</Text>
      <Text dimColor>OpenCrowd cannot recover this wallet without it. Write it down somewhere safe.</Text>
      <Box flexDirection="column" marginY={1}>
        {rows.map((row) => <Text key={row}>  {row}</Text>)}
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text>Enter words 3, 8, and 12 separated by spaces: <Text inverse>{value || " "}</Text></Text>
      <Text dimColor>esc to cancel</Text>
    </Box>
  );
}

function SeedExportModal({ value, error }: { value: string; error?: string }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="red" bold>Reveal seed phrase?</Text>
      <Text>Anyone with the seed phrase can spend this wallet's funds.</Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Text>Type EXPORT to continue: <Text inverse>{value || " "}</Text></Text>
      <Text dimColor>esc to cancel</Text>
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
    : "no wallet — /wallet new";
  const left = ` ${walletPart} · spent ${formatCents(spentCents)} / left ${formatCents(remainingCents)} · ${model}`;
  const modeBadge = ` ${mode}${testMode ? " · TEST" : ""} `;
  const hint = "shift+tab: mode";
  const padding = Math.max(1, width - left.length - modeBadge.length - hint.length - 2);
  return (
    <Box marginTop={1}>
      <Text dimColor>{truncateMiddle(left, Math.max(20, width - modeBadge.length - hint.length - 3))}</Text>
      <Text>{" ".repeat(padding)}</Text>
      <Text color={mode === "yolo" ? "red" : "green"} bold>{modeBadge}</Text>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}

function splitChunk(chunk: string): [string, boolean] {
  const normalized = chunk.replace(/\r\n?/g, "\n");
  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex === -1) {
    return [normalized, false];
  }
  return [normalized.slice(0, newlineIndex), true];
}

function renderHelp(): string {
  return COMMANDS.map((command) => `  ${command.usage.padEnd(50)} ${command.summary}`).join("\n");
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

export async function startTui(options: { testMode?: boolean; testSeed?: string } = {}): Promise<void> {
  const testMode = options.testMode ?? envFlag("OPENCROWD_TEST_MODE");
  if (testMode) {
    await ensureDefaultTestWallet();
  }
  let needsOnboarding = false;
  if (!testMode) {
    try {
      const wallets = await listStoredWallets({ includeBalances: false });
      needsOnboarding = wallets.filter((wallet) => wallet.kind !== "test").length === 0;
    } catch {
      needsOnboarding = false;
    }
  }
  const session = await createOpenCrowdSession({
    workspaceRoot: process.cwd(),
    surface: "cli",
    useWalletBalanceBudget: true
  });
  const config = await loadConfig();
  const { waitUntilExit } = render(
    <App
      session={session}
      initialTestMode={testMode}
      initialTestSeed={options.testSeed ?? process.env.OPENCROWD_TEST_SEED}
      defaultModel={config.x402LlmModel}
      needsOnboarding={needsOnboarding}
    />,
    { exitOnCtrlC: false }
  );
  await waitUntilExit();
}
