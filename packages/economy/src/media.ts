import { createHash } from "node:crypto";
import { saveArtifact, type SessionState } from "@opencrowd/core";

/** Keep generated media out of model context, and out of the process. Content-addressed
 * paths also make replaying a stored paid response harmless. Both CLI and cloud use this
 * path. A service may return the bytes under any key it likes — `b64_json`, `audio_base64`,
 * `image`, a bare `data:` URI — so the shape is sniffed from the bytes, not from the key:
 * leaving 10 MB of base64 inline once cost a 512 MB executor its process (SRI-49). */

const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
/** Smaller than this is cheaper to leave inline than to store and dereference. */
const MIN_BASE64_CHARS = 1024;
/** Enough decoded bytes for every signature below, from a cheap prefix decode. */
const SNIFF_CHARS = 64;

const EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-msvideo": "avi",
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
  "audio/mp4": "m4a", "application/pdf": "pdf"
};

export interface ExtractedMedia { artifact_path: string; bytes: number; media_type: string }

export async function extractMedia(session: SessionState, value: unknown, depth = 0): Promise<unknown> {
  return walk(session, value, undefined, undefined, depth);
}

async function walk(
  session: SessionState,
  value: unknown,
  key: string | undefined,
  siblings: Record<string, unknown> | undefined,
  depth: number
): Promise<unknown> {
  if (depth > 20 || !value) return value;
  if (typeof value === "string") return (await extractString(session, value, key, siblings)) ?? value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return Promise.all(value.map(item => walk(session, item, key, siblings, depth + 1)));
  const source = value as Record<string, unknown>;
  const entries = await Promise.all(Object.entries(source).map(async ([name, item]) =>
    [name, await walk(session, item, name, source, depth + 1)] as const));
  // `b64_json` is the OpenAI-style shape that already existed here: the key is
  // dropped and the artifact fields join its siblings, so a caller reading
  // `data[0].artifact_path` keeps working. Any other key is simply replaced.
  const openAiStyle = entries.find(([name, item]) => name === "b64_json" && isReplacement(item));
  if (!openAiStyle) return Object.fromEntries(entries);
  return { ...Object.fromEntries(entries.filter(([name]) => name !== "b64_json")), ...openAiStyle[1] as object };
}

function isReplacement(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && ("artifact_path" in value || "media_error" in value));
}

/** The replacement object, or undefined to keep the string as it is. */
async function extractString(
  session: SessionState,
  value: string,
  key: string | undefined,
  siblings: Record<string, unknown> | undefined
): Promise<ExtractedMedia | { media_error: string; bytes: number; media_type: string } | undefined> {
  const payload = dataUriPayload(value) ?? { base64: value, declared: declaredMediaType(key, siblings) };
  if (payload.base64.length < MIN_BASE64_CHARS || !looksLikeBase64(payload.base64)) return undefined;
  // Sniff a prefix first: decoding 10 MB to discover it is not media is the
  // cost this guard exists to avoid.
  const mediaType = sniff(Buffer.from(payload.base64.slice(0, SNIFF_CHARS), "base64")) ?? payload.declared;
  if (!mediaType || !EXTENSIONS[mediaType] || !isCompleteBase64(payload.base64)) return undefined;
  const bytes = Buffer.from(payload.base64, "base64");
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    return { media_error: `Generated media exceeds ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MiB artifact limit`, bytes: bytes.length, media_type: mediaType };
  }
  const name = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
  const artifact = await saveArtifact(session, `generated/${name}.${EXTENSIONS[mediaType]}`, bytes, { media_type: mediaType });
  return { artifact_path: artifact.path, bytes: bytes.length, media_type: mediaType };
}

/** A declared type is trusted only where the key says the value is media. */
function declaredMediaType(key: string | undefined, siblings: Record<string, unknown> | undefined): string | undefined {
  if (key !== "b64_json") return undefined;
  const declared = siblings?.media_type ?? siblings?.mime_type;
  return typeof declared === "string" ? declared : "image/png";
}

function dataUriPayload(value: string): { base64: string; declared: string | undefined } | undefined {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z-]+=[^;,]*)*;base64,/i.exec(value);
  return match ? { base64: value.slice(match[0].length), declared: match[1]?.toLowerCase() } : undefined;
}

/** Cheap prefix test; the full string is only validated once a sniff matches. */
function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/_-]{64}/.test(value);
}

function isCompleteBase64(value: string): boolean {
  return /^[A-Za-z0-9+/_\-\s]*={0,2}$/.test(value);
}

/** Magic bytes, so the bytes themselves decide what they are. */
function sniff(bytes: Buffer): string | undefined {
  const ascii = (at: number, text: string) => bytes.length >= at + text.length && bytes.subarray(at, at + text.length).toString("latin1") === text;
  if (ascii(0, "RIFF")) return ascii(8, "WAVE") ? "audio/wav" : ascii(8, "WEBP") ? "image/webp" : ascii(8, "AVI ") ? "video/x-msvideo" : undefined;
  if (ascii(0, "ID3")) return "audio/mpeg";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "fLaC")) return "audio/flac";
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (ascii(4, "ftyp")) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    return brand.startsWith("qt") ? "video/quicktime" : /^(M4A|M4B|mp4a)/.test(brand) ? "audio/mp4" : "video/mp4";
  }
  // An MPEG audio frame sync: 11 set bits, then a layer and bitrate that are
  // not the reserved values a random byte pair would often land on.
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08
    && (bytes[1] & 0x06) !== 0 && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0xf0) !== 0) return "audio/mpeg";
  return undefined;
}
