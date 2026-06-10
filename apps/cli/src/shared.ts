import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdout as output } from "node:process";
import type { ServiceCandidate } from "@opencrowd/core";

export function renderInlinePairs(rows: Array<[string, string]>): string {
  return rows.map(([key, value]) => `${style(key, "muted")} ${value}`).join("  ");
}

export function renderColumns(items: string[]): string {
  const width = terminalWidth();
  const columnWidth = width >= 110 ? 38 : width >= 82 ? 32 : width;
  const columnCount = Math.max(1, Math.min(3, Math.floor(width / columnWidth)));
  if (columnCount === 1) {
    return items.map((item) => `  ${item}`).join("\n");
  }
  const lines: string[] = [];
  for (let index = 0; index < items.length; index += columnCount) {
    const row = items.slice(index, index + columnCount)
      .map((item) => truncate(item, columnWidth - 4).padEnd(columnWidth - 2))
      .join("");
    lines.push(`  ${row.trimEnd()}`);
  }
  return lines.join("\n");
}

export function renderKeyValues(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `  ${style(key, "muted").padEnd(24)} ${formatCell(item, 80, key)}`)
    .join("\n");
}

export function renderTable(rows: Record<string, unknown>[], columns: Array<[string, string]>): string {
  if (rows.length === 0) {
    return "  none";
  }
  const width = terminalWidth();
  const visibleColumns = columns.filter(([key]) => rows.some((row) => row[key] !== undefined && row[key] !== ""));
  const maxDataWidths = visibleColumns.map(([key, header]) => Math.max(
    header.length,
    ...rows.map((row) => plain(formatCell(row[key], 160, key)).length)
  ));
  const minWidths = visibleColumns.map(([, header]) => Math.max(header.length, 8));
  const separators = Math.max(0, visibleColumns.length - 1) * 2;
  let widths = maxDataWidths.map((item, index) => Math.max(minWidths[index] ?? 8, item));
  let total = widths.reduce((sum, item) => sum + item, 0) + separators + 2;
  while (total > width && widths.some((item, index) => item > (minWidths[index] ?? 8))) {
    const widestIndex = widths.reduce((widest, item, index) => item > widths[widest] ? index : widest, 0);
    widths[widestIndex] -= 1;
    total -= 1;
  }
  const header = visibleColumns
    .map(([, label], index) => style(label.padEnd(widths[index] ?? label.length), "muted"))
    .join("  ");
  const body = rows.map((row) => visibleColumns
    .map(([key], index) => truncate(formatCell(row[key], 160, key), widths[index] ?? 12).padEnd(widths[index] ?? 12))
    .join("  "));
  return [`  ${header}`, ...body.map((row) => `  ${row}`)].join("\n");
}

export function formatCell(value: unknown, maxLength: number, key = ""): string {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  if ((typeof value === "number" || typeof value === "string") && /cost|cents|spend|remaining|budget|max/i.test(key)) {
    const cents = Number(value);
    if (Number.isFinite(cents)) {
      return formatCents(cents);
    }
  }
  if (typeof value === "number" && Number.isFinite(value) && /_cents$/.test(key)) {
    return formatCents(value);
  }
  if (Array.isArray(value)) {
    return truncate(value.join(","), maxLength);
  }
  if (typeof value === "object") {
    return truncate(JSON.stringify(value), maxLength);
  }
  const text = String(value);
  return text.startsWith("http://") || text.startsWith("https://") ? shortUrl(text) : truncate(text, maxLength);
}

export function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const tail = parts.at(-1);
    return tail ? `${url.hostname}/.../${tail}` : url.hostname;
  } catch {
    return truncateMiddle(value, 48);
  }
}

export function formatCents(cents: number): string {
  return `$${(Math.round(cents) / 100).toFixed(2)}`;
}

export function terminalWidth(): number {
  return Math.max(60, Math.min(140, output.columns ?? 100));
}

export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }
  return output.isTTY || Boolean(process.env.FORCE_COLOR);
}

export function style(value: string, kind: "bold" | "muted" | "accent" | "ok" | "error"): string {
  if (!shouldUseColor()) {
    return value;
  }
  const codes: Record<typeof kind, [number, number]> = {
    bold: [1, 22],
    muted: [2, 22],
    accent: [36, 39],
    ok: [32, 39],
    error: [31, 39]
  };
  const [open, close] = codes[kind];
  return `\x1b[${open}m${value}\x1b[${close}m`;
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function formatServiceCandidate(candidate: ServiceCandidate): Record<string, unknown> {
  return pruneUndefined({
    title: candidate.title,
    url: candidate.resource_url,
    methods: candidate.methods,
    price: candidate.price_display ?? (candidate.price_cents === undefined ? undefined : `$${(candidate.price_cents / 100).toFixed(2)}`),
    currency: candidate.currency,
    tags: candidate.tags,
    score: Number(candidate.score.toFixed(4))
  });
}

export function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function parseUsd(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid USD amount: ${value}`);
  }
  return Math.round(parsed * 100);
}

export function readOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

export function splitArgs(inputLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (const char of inputLine) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (quote) {
    throw new Error("unterminated quote in slash command");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

export function optionCents(args: string[], option: string): number | undefined {
  const value = readOption(args, option);
  return value === undefined ? undefined : parseUsd(value);
}

export function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isConsumedOption(args: string[], index: number, options: string[]): boolean {
  return options.includes(args[index]) || (index > 0 && options.includes(args[index - 1]));
}

export async function latestSessionId(workspaceRoot: string): Promise<string | undefined> {
  const sessionsDir = join(resolve(workspaceRoot), "sessions");
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
