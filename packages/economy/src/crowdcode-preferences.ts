import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionState } from "@opencrowd/core";

/** Hosted settings live on this agent's volume; session overrides survive a wake. */
export class CrowdCodePreferences {
  constructor(private readonly session: SessionState) {}
  private path(scope: "session" | "default") {
    return join(scope === "session" ? this.session.sessionDir : this.session.workspaceRoot, "crowdcode-preferences.json");
  }
  private async read(scope: "session" | "default"): Promise<boolean | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path(scope), "utf8"));
      return typeof value.enabled === "boolean" ? value.enabled : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async status() {
    const default_enabled = (await this.read("default")) ?? true;
    const session_enabled = await this.read("session");
    return { enabled: session_enabled ?? default_enabled, default_enabled, scope: session_enabled === undefined ? "default" : "session" };
  }
  private async write(scope: "session" | "default", enabled?: boolean) {
    const path = this.path(scope), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify({ enabled }) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  }
  async set(enabled: boolean, scope: "session" | "default") {
    await this.write(scope, enabled);
    if (scope === "default") await this.write("session");
    return this.status();
  }
}
