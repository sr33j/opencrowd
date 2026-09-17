import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionState } from "./types.js";
import { atomicWrite } from "./paths.js";

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
  type: "message" | "compaction" | "clear";
  timestamp: string;
  message?: ConversationMessage;
  archive_path?: string;
  tokens_before?: number;
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

export async function readConversationEntries(session: SessionState, onRecovery?: () => void): Promise<ConversationEntry[]> {
  let text: string;
  try {
    text = await readFile(conversationPath(session), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines = text.split(/\r?\n/);
  const entries: ConversationEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    try { entries.push(JSON.parse(lines[index]) as ConversationEntry); }
    catch (error) {
      if (index !== lines.length - 1 || text.endsWith("\n")) throw error;
      // Only a partial, non-newline-terminated final record is recoverable.
      await atomicWrite(conversationPath(session), lines.slice(0, index).join("\n") + (index ? "\n" : ""));
      if (onRecovery) onRecovery();
      else process.emitWarning("Recovered a partial trailing conversation record", { code: "OPENCROWD_JOURNAL_RECOVERY" });
    }
  }
  return entries;
}

export async function readConversationMessages(session: SessionState): Promise<ConversationMessage[]> {
  return (await readConversationEntries(session))
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => entry.message as ConversationMessage);
}

export interface ConversationClearResult {
  cleared: boolean;
  archivePath?: string;
  messagesCleared: number;
}

/**
 * Drop all prior conversation context for the session. The existing
 * transcript is archived under context/ (same convention as compaction)
 * rather than deleted, then messages.jsonl starts fresh.
 */
export async function clearConversation(session: SessionState): Promise<ConversationClearResult> {
  const messages = await readConversationMessages(session);
  if (messages.length === 0) {
    return { cleared: false, messagesCleared: 0 };
  }
  const archivePath = join("context", `cleared-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const absoluteArchivePath = join(session.sessionDir, archivePath);
  await mkdir(dirname(absoluteArchivePath), { recursive: true });
  await writeFile(
    absoluteArchivePath,
    messages.map((message) => `${JSON.stringify({ timestamp: new Date().toISOString(), message })}\n`).join(""),
    "utf8"
  );
  await writeFile(
    conversationPath(session),
    `${JSON.stringify({ type: "clear", timestamp: new Date().toISOString(), archive_path: archivePath })}\n`,
    "utf8"
  );
  return { cleared: true, archivePath, messagesCleared: messages.length };
}
