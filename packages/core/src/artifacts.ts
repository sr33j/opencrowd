import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ArtifactRecord, SessionState } from "./types.js";
import { appendLedgerEntry } from "./ledger.js";
import { assertPathId, atomicWrite, containedPath } from "./paths.js";

export async function saveArtifact(
  state: SessionState,
  path: string,
  content: string | Uint8Array,
  metadata?: Record<string, unknown>
): Promise<ArtifactRecord> {
  const target = await safeArtifactPath(state, path);
  await mkdir(dirname(target), { recursive: true });
  await atomicWrite(target, content);
  const rel = relative(state.sessionDir, target);
  await appendLedgerEntry(state.ledgerPath, {
    session_id: state.sessionId,
    type: "artifact",
    status: "ok",
    approval_mode: state.approvalMode,
    artifact_path: rel,
    notes: metadata ? JSON.stringify(metadata) : undefined
  });
  return { path: rel, bytes: Buffer.byteLength(content), metadata };
}

export async function readArtifact(state: SessionState, path: string): Promise<string> {
  return readFile(await safeArtifactPath(state, path), "utf8");
}

export async function listArtifacts(state: SessionState, prefix = ""): Promise<string[]> {
  const start = await safeArtifactPath(state, prefix || ".");
  const files: string[] = [];
  await walkFiles(start, state.artifactsDir, files);
  return files.sort();
}

/** Files one other chat of this agent left in its own artifacts/ directory. */
export interface OtherChatFiles {
  session_id: string;
  /** That chat's artifacts/ directory relative to this session directory, where run_shell starts. */
  shell_dir: string;
  files: string[];
}

/** At most this many files from other chats in one listing, newest chats first. */
const OTHER_CHAT_FILE_LIMIT = 300;

/**
 * Every chat of an agent is its own session, with its own artifacts/
 * directory, but the owner's Files view lists all of them together. A
 * file made in one chat is invisible to `list_files` in the next unless
 * the agent asks for the others, which is how an agent holding three PDFs
 * told its owner it had none (agent 2aeb8505, 2026-11-04).
 */
export async function listOtherChatArtifacts(state: SessionState): Promise<{ chats: OtherChatFiles[]; truncated: boolean }> {
  const sessionsDir = dirname(state.sessionDir);
  let entries: Dirent[];
  try { entries = await readdir(sessionsDir, { withFileTypes: true }); }
  catch { return { chats: [], truncated: false }; }
  const others: { id: string; dir: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === state.sessionId) continue;
    try { assertPathId(entry.name); } catch { continue; }
    const dir = join(sessionsDir, entry.name, "artifacts");
    try {
      const info = await stat(join(sessionsDir, entry.name));
      others.push({ id: entry.name, dir, mtime: info.mtimeMs });
    } catch { /* gone between readdir and stat */ }
  }
  others.sort((a, b) => b.mtime - a.mtime);
  const chats: OtherChatFiles[] = [];
  let remaining = OTHER_CHAT_FILE_LIMIT, truncated = false;
  for (const other of others) {
    if (remaining <= 0) { truncated = true; break; }
    let root: string;
    try { root = await containedPath(sessionsDir, join(other.id, "artifacts")); } catch { continue; }
    const files: string[] = [];
    try { await walkFiles(root, root, files); } catch { continue; }
    if (!files.length) continue;
    files.sort();
    if (files.length > remaining) { truncated = true; files.length = remaining; }
    remaining -= files.length;
    chats.push({ session_id: other.id, shell_dir: `../${other.id}/artifacts`, files });
  }
  return { chats, truncated };
}

async function walkFiles(dir: string, root: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // Dirent types do not follow symlinks, so a link out of the tree is skipped.
    if (entry.isDirectory()) await walkFiles(full, root, out);
    else if (entry.isFile()) out.push(relative(root, full));
  }
}

function safeArtifactPath(state: SessionState, requestedPath: string): Promise<string> {
  const normalizedRequest = requestedPath.replace(/^artifacts\//, "");
  return containedPath(state.artifactsDir, normalizedRequest).catch((error: Error) => {
    throw new Error(`artifact path: ${error.message}`);
  });
}
