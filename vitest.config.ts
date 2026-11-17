import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No test reaches CrowdCode's real backend: the live tree and reliability
    // lookups find a closed port and fall back, as they would offline.
    env: { OPENCROWD_CROWDCODE_URL: "http://127.0.0.1:9" }
  },
  resolve: {
    alias: {
      "@opencrowd/protocol": resolve(__dirname, "packages/protocol/src/index.ts"),
      "@opencrowd/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@opencrowd/economy": resolve(__dirname, "packages/economy/src/index.ts"),
      "@opencrowd/agent-runtime": resolve(__dirname, "packages/agent-runtime/src/index.ts")
    }
  }
});
