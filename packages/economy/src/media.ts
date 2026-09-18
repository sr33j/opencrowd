import { createHash } from "node:crypto";
import { saveArtifact, type SessionState } from "@opencrowd/core";

/** Keep generated media out of model context. Content-addressed paths also make
 * replaying a stored paid response harmless. Both CLI and cloud use this path. */
export async function extractMedia(session: SessionState, value: unknown, depth = 0): Promise<unknown> {
  if (depth > 20 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Promise.all(value.map(item => extractMedia(session, item, depth + 1)));
  const source = value as Record<string, unknown>;
  const extensions: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/mpeg": "mp3", "audio/wav": "wav" };
  const mime = String(source.media_type ?? source.mime_type ?? "image/png");
  if (typeof source.b64_json === "string" && extensions[mime] && /^[A-Za-z0-9+/\r\n]*={0,2}$/.test(source.b64_json)) {
    const bytes = Buffer.from(source.b64_json, "base64");
    if (bytes.length > 24 * 1024 * 1024) {
      const { b64_json: _inline, ...metadata } = source;
      return { ...metadata, media_error: "Generated media exceeds 24 MiB artifact limit", bytes: bytes.length };
    }
    const name = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
    const artifact = await saveArtifact(session, `generated/${name}.${extensions[mime]}`, bytes, { media_type: mime });
    const { b64_json: _inline, ...metadata } = source;
    return { ...metadata, artifact_path: artifact.path, bytes: bytes.length };
  }
  return Object.fromEntries(await Promise.all(Object.entries(source).map(async ([key, item]) => [key, await extractMedia(session, item, depth + 1)])));
}
