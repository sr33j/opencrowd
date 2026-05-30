import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEntry } from "./types.js";

export const LEDGER_COLUMNS = [
  "timestamp",
  "session_id",
  "type",
  "endpoint",
  "model",
  "resource_url",
  "method",
  "quoted_cost_cents",
  "charged_cost_cents",
  "status",
  "permission_mode",
  "payment_id",
  "tx_hash",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "artifact_path",
  "notes"
] as const;

export async function ensureLedger(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeFile(path, `${LEDGER_COLUMNS.join(",")}\n`, "utf8");
  }
}

export async function appendLedgerEntry(path: string, entry: LedgerEntry): Promise<void> {
  await ensureLedger(path);
  const row = LEDGER_COLUMNS.map((column) => csvCell(String(entry[column] ?? (column === "timestamp" ? new Date().toISOString() : "")))).join(",");
  const current = await readFile(path, "utf8");
  await writeFile(path, `${current}${row}\n`, "utf8");
}

export async function readLedger(path: string): Promise<Record<string, string>[]> {
  const text = await readFile(path, "utf8");
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  if (!headerLine) {
    return [];
  }
  const headers = parseCsvLine(headerLine);
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
