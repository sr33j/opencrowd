import { expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "/old-global/bin/crowdcode-mcp") }));
import { execFileSync } from "node:child_process";
import { resolvePinnedCommand } from "../src/runtime.js";

it("honors the CrowdCode npm pin even when an older binary is on PATH", () => {
  const config = { command: "npx", args: ["--yes", "crowdcode-mcp@0.5.2"] };
  expect(resolvePinnedCommand(config, "crowdcode-mcp")).toEqual(config);
  expect(execFileSync).not.toHaveBeenCalled();
});
