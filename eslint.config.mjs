import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".superpowers/**",
    ".next/**",
    ".next-e2e-*/**",
    "coverage/**",
    // Deterministic esbuild output is byte-compared to its linted TypeScript graph.
    // Keep this exact artifact excluded; sibling runtime files remain linted.
    "infra/runtime/production-load-test-control-service.mjs",
    "infra/runtime/production-load-fixture-runtime.mjs",
    "playwright-report/**",
    "public/monaco/**",
    "services/runner/dist/**",
    "test-artifacts/**",
    "test-results/**",
  ])
]);
