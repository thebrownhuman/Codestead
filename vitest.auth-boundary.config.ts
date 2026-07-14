import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Mandatory non-coverage security gate. The endpoint sweep imports every API
 * route and proves that each handler invokes the expected guard before work.
 * The authz unit suite executes the real requireAuth/requireAdmin decision
 * logic, including durable account status, MFA, and role rechecks. These are
 * boundary/guard probes, not cross-owner execution of every service graph, so
 * they must not redefine the unit-coverage denominator.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
  test: {
    include: [
      "src/lib/security/__tests__/endpoint-auth-boundaries.test.ts",
      "src/lib/http/__tests__/authz.test.ts",
    ],
    environment: "jsdom",
    globals: true,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/vitest-auth-boundary-final.json" },
    setupFiles: [path.resolve(process.cwd(), "src/test/setup.ts")],
    coverage: { enabled: false },
    testTimeout: 30_000,
  },
});
