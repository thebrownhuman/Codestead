import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src")
    }
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // This route-import sweep intentionally loads the complete API graph. It
    // has its own mandatory gate so those import-only modules do not become
    // uncovered unit-coverage subjects.
    exclude: [
      ...configDefaults.exclude,
      "src/lib/security/__tests__/endpoint-auth-boundaries.test.ts",
    ],
    environment: "jsdom",
    globals: true,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/vitest-unit-final.json" },
    // Coverage instrumentation plus the full component/content corpus can
    // exceed Vitest's 5s per-test default on the small NUC/Windows pilot host.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    setupFiles: [path.resolve(process.cwd(), "src/test/setup.ts")],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      // These files are PostgreSQL catalogs/transaction adapters. Route-unit
      // tests intentionally import them while mocking their I/O boundary, so
      // V8 would otherwise count import-only callbacks that require real
      // constraints, locks, concurrency, and rollback behavior. Their behavior
      // is instead mandatory in the disposable-PostgreSQL integration gate:
      // - schema + daily review: integration/postgres.integration.test.ts and
      //   integration/daily-review.integration.test.ts
      // - learning store: integration/postgres.integration.test.ts,
      //   integration/daily-review.integration.test.ts,
      //   integration/inactivity.integration.test.ts,
      //   integration/practice-learning.integration.test.ts, and
      //   integration/learner-journey.integration.test.ts
      // - community: integration/community-battles.integration.test.ts
      // - curriculum admin: integration/curriculum-publication.integration.test.ts
      //   and integration/learner-journey.integration.test.ts
      // - career: integration/career-certificates-portfolio.integration.test.ts
      // - module projects: integration/module-projects-trophies.integration.test.ts
      // Keep this list explicit: application logic without an exact real-DB
      // mapping remains part of the unit-coverage denominator.
      exclude: [
        "src/lib/db/schema.ts",
        "src/lib/daily-review/service.ts",
        "src/lib/learning-service/drizzle-store.ts",
        "src/lib/community/service.ts",
        "src/lib/curriculum-publication/admin-service.ts",
        "src/lib/career/service.ts",
        "src/lib/projects/module-project-service.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80
      }
    }
  }
});
