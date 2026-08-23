import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opencrowd/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@opencrowd/agent-runtime": resolve(__dirname, "packages/agent-runtime/src/index.ts")
    }
  }
});
