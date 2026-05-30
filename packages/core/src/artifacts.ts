import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ArtifactRecord, SessionState } from "./types.js";
import { appendLedgerEntry } from "./ledger.js";

export async function saveArtifact(
  state: SessionState,
  path: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<ArtifactRecord> {
  const target = safeArtifactPath(state, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  const rel = relative(state.sessionDir, target);
  await appendLedgerEntry(state.ledgerPath, {
    session_id: state.sessionId,
    type: "artifact",
    status: "ok",
    permission_mode: state.permissionMode,
    artifact_path: rel,
    notes: metadata ? JSON.stringify(metadata) : undefined
  });
  return { path: rel, bytes: Buffer.byteLength(content), metadata };
}

export async function readArtifact(state: SessionState, path: string): Promise<string> {
  return readFile(safeArtifactPath(state, path), "utf8");
}

export async function listArtifacts(state: SessionState, prefix = ""): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const start = safeArtifactPath(state, prefix || ".");
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

function safeArtifactPath(state: SessionState, requestedPath: string): string {
  const normalizedRequest = requestedPath.replace(/^artifacts\//, "");
  const target = resolve(state.artifactsDir, normalizedRequest);
  const root = resolve(state.artifactsDir);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error("artifact path must stay inside the session artifacts directory");
  }
  return target;
}
