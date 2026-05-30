import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionState } from "./types.js";

export interface ConversationToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ConversationToolCall[];
}

export interface ConversationEntry {
  type: "message" | "compaction";
  timestamp: string;
  message?: ConversationMessage;
  archive_path?: string;
  tokens_before?: number;
}

export interface ConversationCompactionResult {
  compacted: boolean;
  archivePath?: string;
  tokensBefore: number;
  messages: ConversationMessage[];
}

const CONVERSATION_FILE = "messages.jsonl";

export function conversationPath(session: SessionState): string {
  return join(session.sessionDir, CONVERSATION_FILE);
}

export async function appendConversationMessage(session: SessionState, message: ConversationMessage): Promise<void> {
  await appendConversationEntry(session, {
    type: "message",
    timestamp: new Date().toISOString(),
    message
  });
}

export async function appendConversationEntry(session: SessionState, entry: ConversationEntry): Promise<void> {
  const path = conversationPath(session);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readConversationEntries(session: SessionState): Promise<ConversationEntry[]> {
  let text: string;
  try {
    text = await readFile(conversationPath(session), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ConversationEntry);
}

export async function readConversationMessages(session: SessionState): Promise<ConversationMessage[]> {
  return (await readConversationEntries(session))
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => entry.message as ConversationMessage);
}

export async function compactConversationIfNeeded(
  session: SessionState,
  options: { contextWindowTokens: number; thresholdRatio?: number; keepRecentTokens?: number } 
): Promise<ConversationCompactionResult> {
  const messages = await readConversationMessages(session);
  const tokensBefore = estimateConversationTokens(messages);
  const threshold = Math.floor(options.contextWindowTokens * (options.thresholdRatio ?? 0.5));
  if (tokensBefore <= threshold || messages.length < 4) {
    return { compacted: false, tokensBefore, messages };
  }

  const keepBudget = options.keepRecentTokens ?? Math.max(4_000, Math.floor(options.contextWindowTokens * 0.2));
  const recent: ConversationMessage[] = [];
  let recentTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const tokens = estimateConversationTokens([message]);
    if (recent.length > 0 && recentTokens + tokens > keepBudget) {
      break;
    }
    recent.unshift(message);
    recentTokens += tokens;
  }
  while (recent[0]?.role === "tool") {
    recent.shift();
  }

  const archived = messages.slice(0, Math.max(0, messages.length - recent.length));
  if (archived.length === 0) {
    return { compacted: false, tokensBefore, messages };
  }

  const archivePath = join("context", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const absoluteArchivePath = join(session.sessionDir, archivePath);
  await mkdir(dirname(absoluteArchivePath), { recursive: true });
  await writeFile(
    absoluteArchivePath,
    archived.map((message) => `${JSON.stringify({ timestamp: new Date().toISOString(), message })}\n`).join(""),
    "utf8"
  );

  const summary = summarizeArchivedMessages(archived, archivePath, tokensBefore);
  const compactedMessages: ConversationMessage[] = [
    { role: "user", content: summary },
    ...recent
  ];
  await writeFile(
    conversationPath(session),
    [
      `${JSON.stringify({ type: "compaction", timestamp: new Date().toISOString(), archive_path: archivePath, tokens_before: tokensBefore })}\n`,
      ...compactedMessages.map((message) => `${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message })}\n`)
    ].join(""),
    "utf8"
  );
  return { compacted: true, archivePath, tokensBefore, messages: compactedMessages };
}

export function estimateConversationTokens(messages: ConversationMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: ConversationMessage): number {
  const toolCalls = message.toolCalls ? JSON.stringify(message.toolCalls) : "";
  return Math.ceil((message.role.length + message.content.length + toolCalls.length) / 4);
}

function summarizeArchivedMessages(messages: ConversationMessage[], archivePath: string, tokensBefore: number): string {
  const counts = messages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  const firstUser = messages.find((message) => message.role === "user")?.content.trim();
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.content.trim())?.content.trim();
  return [
    "Earlier OpenCrowd conversation history was compacted to keep the model context small.",
    `Original transcript archive: ${archivePath}.`,
    `Estimated tokens before compaction: ${tokensBefore}.`,
    `Archived messages: user=${counts.user ?? 0}, assistant=${counts.assistant ?? 0}, tool=${counts.tool ?? 0}.`,
    firstUser ? `Initial user request: ${truncate(firstUser, 800)}` : undefined,
    lastAssistant ? `Most recent assistant progress before compaction: ${truncate(lastAssistant, 1200)}` : undefined,
    "Use the retained recent messages below as the active continuation context."
  ].filter(Boolean).join("\n");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
