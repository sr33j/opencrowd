import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "@opencrowd/core";
import { extractMedia } from "../src/media.js";
it("saves inline media as a stable binary artifact and removes base64 from model context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "media-"));
  try {
    const session = await createSession({ workspaceRoot: dir });
    const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
    const response = { data: [{ b64_json: bytes.toString("base64"), media_type: "video/mp4", duration_seconds: 5 }] };
    const first: any = await extractMedia(session, response);
    expect(await extractMedia(session, response)).toEqual(first);
    expect(JSON.stringify(first).length).toBeLessThan(300);
    expect(first.data[0]).not.toHaveProperty("b64_json");
    expect((await readFile(join(session.sessionDir, first.data[0].artifact_path))).equals(bytes)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
