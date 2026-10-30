import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, type SessionState } from "@opencrowd/core";
import { extractMedia } from "../src/media.js";

async function withSession<T>(run: (session: SessionState) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "media-"));
  try { return await run(await createSession({ workspaceRoot: dir })); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

/** A minimal but real RIFF/WAVE file: the header is what the sniffer reads. */
function wav(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes, 7)]);
}

function png(dataBytes: number): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(dataBytes, 3)]);
}

it("saves inline media as a stable binary artifact and removes base64 from model context", async () => {
  await withSession(async session => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
    const response = { data: [{ b64_json: bytes.toString("base64"), media_type: "video/mp4", duration_seconds: 5 }] };
    const first: any = await extractMedia(session, response);
    expect(await extractMedia(session, response)).toEqual(first);
    expect(JSON.stringify(first).length).toBeLessThan(300);
    expect(first.data[0]).not.toHaveProperty("b64_json");
    expect(first.data[0].duration_seconds).toBe(5);
    expect((await readFile(join(session.sessionDir, first.data[0].artifact_path))).equals(bytes)).toBe(true);
  });
});

it("extracts base64 media under any key, as x402.forgemesh.io/tts returns it", async () => {
  await withSession(async session => {
    // The shape that OOM-killed a 512 MB executor: 7.5 MB of WAV under a key
    // extraction did not know about, left inline in every copy of the result.
    const bytes = wav(7_533_936);
    const result: any = await extractMedia(session, { audio_base64: bytes.toString("base64"), format: "wav" });
    expect(result.format).toBe("wav");
    expect(result.audio_base64).toEqual({ artifact_path: expect.stringMatching(/^artifacts\/generated\/[0-9a-f]{20}\.wav$/), bytes: bytes.length, media_type: "audio/wav" });
    expect(JSON.stringify(result).length).toBeLessThan(300);
    expect((await readFile(join(session.sessionDir, result.audio_base64.artifact_path))).equals(bytes)).toBe(true);
  });
});

it("extracts a data: URI and trusts the sniffed bytes over the declared type", async () => {
  await withSession(async session => {
    const bytes = png(200_000);
    const result: any = await extractMedia(session, { image: `data:image/jpeg;base64,${bytes.toString("base64")}` });
    expect(result.image.media_type).toBe("image/png");
    expect(result.image.artifact_path).toMatch(/\.png$/);
    expect((await readFile(join(session.sessionDir, result.image.artifact_path))).equals(bytes)).toBe(true);
  });
});

it("extracts media nested in arrays and leaves short strings alone", async () => {
  await withSession(async session => {
    const bytes = wav(4_000);
    const result: any = await extractMedia(session, { items: [{ clip: bytes.toString("base64") }], note: "hello" });
    expect(result.note).toBe("hello");
    expect(result.items[0].clip.media_type).toBe("audio/wav");
  });
});

it("leaves a large non-media base64 blob inline for the string cap to handle", async () => {
  await withSession(async session => {
    const blob = Buffer.alloc(3 * 1024 * 1024, 42).toString("base64");
    const result: any = await extractMedia(session, { embedding: blob, key: "value" });
    expect(result.embedding).toBe(blob);
    expect(result.key).toBe("value");
  });
});

it("refuses to store media over the artifact limit and reports its size", async () => {
  await withSession(async session => {
    const bytes = wav(25 * 1024 * 1024);
    const result: any = await extractMedia(session, { audio_base64: bytes.toString("base64") });
    expect(result.audio_base64).toEqual({ media_error: "Generated media exceeds 24 MiB artifact limit", bytes: bytes.length, media_type: "audio/wav" });
  });
});
