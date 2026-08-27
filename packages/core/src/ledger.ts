import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  "approval_mode",
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
  // True append: concurrent writers (parallel subagents) must never
  // read-modify-write the whole file or rows get silently dropped.
  await appendFile(path, `${row}\n`, "utf8");
}

export async function readLedger(path: string): Promise<Record<string, string>[]> {
  const text = await readFile(path, "utf8");
  const [headers, ...records] = parseCsv(text);
  if (!headers) {
    return [];
  }
  return records
    .filter((record) => record.length > 1 || (record[0] ?? "") !== "")
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * RFC 4180 parse of the whole file. Record boundaries are newlines OUTSIDE
 * quotes only: a quoted cell may contain commas, escaped quotes, and embedded
 * newlines (multi-line notes), so splitting on physical lines first would
 * shear such a row into phantom records.
 */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      cells.push(current);
      records.push(cells);
      cells = [];
      current = "";
    } else {
      current += char;
    }
  }
  if (current !== "" || cells.length > 0) {
    cells.push(current);
    records.push(cells);
  }
  return records;
}
