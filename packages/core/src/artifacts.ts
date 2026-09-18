import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ArtifactRecord, SessionState } from "./types.js";
import { appendLedgerEntry } from "./ledger.js";
import { atomicWrite, containedPath } from "./paths.js";

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
  const { readdir } = await import("node:fs/promises");
  const start = await safeArtifactPath(state, prefix || ".");
  const files: string[] = [];
  await walk(start, files, state.artifactsDir);
  return files.sort();
  async function walk(dir: string, out: string[], root: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, out, root);
      } else if (entry.isFile()) {
        out.push(relative(root, full));
      }
    }
  }
}

function safeArtifactPath(state: SessionState, requestedPath: string): Promise<string> {
  const normalizedRequest = requestedPath.replace(/^artifacts\//, "");
  return containedPath(state.artifactsDir, normalizedRequest).catch((error: Error) => {
    throw new Error(`artifact path: ${error.message}`);
  });
}
