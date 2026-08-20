import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * GAIA validation-split adapter. The dataset is gated on Hugging Face:
 * accept the terms at https://huggingface.co/datasets/gaia-benchmark/GAIA
 * once, then pass a token via --hf-token or HF_TOKEN. Files are cached
 * locally so the token is only needed on first fetch.
 */

const GAIA_BASE_URL = "https://huggingface.co/datasets/gaia-benchmark/GAIA/resolve/main/2023/validation";
const GAIA_ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=gaia-benchmark%2FGAIA&config=2023_all&split=validation";

export interface GaiaQuestion {
  task_id: string;
  question: string;
  level: 1 | 2 | 3;
  final_answer: string;
  file_name?: string;
  /** Absolute path of the cached attachment, when one exists and was fetched. */
  file_path?: string;
}

export const GAIA_TIERS = {
  smoke: { description: "first 10 validation questions", limit: 10 },
  level1: { description: "all Level 1 validation questions", level: 1 as const },
  full: { description: "all 165 validation questions" }
} as const;

export type GaiaTier = keyof typeof GAIA_TIERS;

/** Attachment extensions no compared harness can consume; skipped and counted. */
const UNSUPPORTED_EXTENSIONS = [
  ".mp3", ".wav", ".m4a", ".flac", ".ogg",
  ".mp4", ".mov", ".avi", ".webm",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp"
];

export function isUnsupportedModality(fileName: string | undefined): boolean {
  if (!fileName) {
    return false;
  }
  const lower = fileName.toLowerCase();
  return UNSUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function defaultGaiaCacheDir(): string {
  return process.env.OPENCROWD_GAIA_CACHE_DIR ?? join(homedir(), ".cache", "opencrowd", "gaia", "2023", "validation");
}

export interface FetchGaiaOptions {
  hfToken?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export async function fetchGaiaValidation(options: FetchGaiaOptions = {}): Promise<GaiaQuestion[]> {
  const cacheDir = options.cacheDir ?? defaultGaiaCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const metadataPath = join(cacheDir, "metadata.jsonl");
  let metadataText: string;
  try {
    metadataText = await readFile(metadataPath, "utf8");
  } catch {
    metadataText = await fetchValidationRows(options);
    await writeFile(metadataPath, metadataText, "utf8");
  }
  return metadataText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseGaiaRecord(JSON.parse(line) as Record<string, unknown>));
}

/** The repo stores metadata as parquet; the datasets-server rows API serves it as JSON. */
async function fetchValidationRows(options: FetchGaiaOptions): Promise<string> {
  const lines: string[] = [];
  const headers: Record<string, string> = {};
  if (options.hfToken) {
    headers.authorization = `Bearer ${options.hfToken}`;
  }
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const url = `${GAIA_ROWS_URL}&offset=${offset}&length=100`;
    options.log?.(`fetching ${url}`);
    const response = await (options.fetchImpl ?? fetch)(url, { headers });
    if (response.status === 401 || response.status === 403) {
      throw new Error([
        `GAIA download was rejected (${response.status}).`,
        "The dataset is gated: accept the terms at https://huggingface.co/datasets/gaia-benchmark/GAIA",
        "and pass a token with --hf-token <token> or the HF_TOKEN environment variable."
      ].join(" "));
    }
    if (!response.ok) {
      throw new Error(`GAIA rows fetch failed: ${response.status} ${response.statusText}`);
    }
    const body = await response.json() as { num_rows_total?: number; rows?: Array<{ row?: Record<string, unknown> }> };
    total = body.num_rows_total ?? 0;
    const rows = body.rows ?? [];
    if (rows.length === 0) {
      break;
    }
    for (const item of rows) {
      if (item.row) {
        lines.push(JSON.stringify(item.row));
      }
    }
    offset += rows.length;
  }
  if (lines.length === 0) {
    throw new Error("GAIA rows fetch returned no rows");
  }
  return `${lines.join("\n")}\n`;
}

/** Download attachments for the selected questions only (called after tier selection). */
export async function ensureGaiaAttachments(questions: GaiaQuestion[], options: FetchGaiaOptions = {}): Promise<void> {
  const cacheDir = options.cacheDir ?? defaultGaiaCacheDir();
  for (const question of questions) {
    if (question.file_name && !isUnsupportedModality(question.file_name)) {
      const filePath = join(cacheDir, question.file_name);
      await cachedDownload(filePath, `${GAIA_BASE_URL}/${encodeURIComponent(question.file_name)}`, options, true);
      question.file_path = filePath;
    }
  }
}

export function selectGaiaTier(questions: GaiaQuestion[], tier: GaiaTier): GaiaQuestion[] {
  const config = GAIA_TIERS[tier];
  let selected = questions;
  if ("level" in config) {
    selected = selected.filter((question) => question.level === config.level);
  }
  if ("limit" in config) {
    selected = selected.slice(0, config.limit);
  }
  return selected;
}

function parseGaiaRecord(record: Record<string, unknown>): GaiaQuestion {
  const level = Number(record.Level ?? record.level);
  return {
    task_id: String(record.task_id ?? ""),
    question: String(record.Question ?? record.question ?? ""),
    level: (level === 1 || level === 2 || level === 3 ? level : 1),
    final_answer: String(record["Final answer"] ?? record.final_answer ?? ""),
    file_name: typeof record.file_name === "string" && record.file_name.length > 0 ? record.file_name : undefined
  };
}

async function cachedDownload(
  path: string,
  url: string,
  options: FetchGaiaOptions,
  binary = false
): Promise<string> {
  try {
    await access(path);
    return binary ? "" : await readFile(path, "utf8");
  } catch {
    // fall through to network fetch
  }
  options.log?.(`fetching ${url}`);
  const headers: Record<string, string> = {};
  if (options.hfToken) {
    headers.authorization = `Bearer ${options.hfToken}`;
  }
  const response = await (options.fetchImpl ?? fetch)(url, { headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error([
      `GAIA download was rejected (${response.status}).`,
      "The dataset is gated: accept the terms at https://huggingface.co/datasets/gaia-benchmark/GAIA",
      "and pass a token with --hf-token <token> or the HF_TOKEN environment variable."
    ].join(" "));
  }
  if (!response.ok) {
    throw new Error(`GAIA download failed: ${response.status} ${response.statusText} for ${url}`);
  }
  await mkdir(dirname(path), { recursive: true });
  if (binary) {
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(path, buffer);
    return "";
  }
  const text = await response.text();
  await writeFile(path, text, "utf8");
  return text;
}
