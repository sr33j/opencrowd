import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opencrowd/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@opencrowd/agent-runtime": resolve(__dirname, "packages/agent-runtime/src/index.ts"),
      "@opencrowd/local-api": resolve(__dirname, "packages/local-api/src/index.ts"),
      "@opencrowd/mcp": resolve(__dirname, "packages/mcp/src/index.ts")
    }
  }
});
