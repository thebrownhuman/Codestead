import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
  test: {
    include: ["integration/**/*.integration.test.ts"],
    environment: "node",
    globals: true,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/vitest-integration-final.json" },
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
