import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const source = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const WORKERS = [
  ["mail-worker", "scripts/process-outbox.ts"],
  ["reward-worker", "scripts/process-rewards.ts"],
  ["regrade-worker", "scripts/process-assessment-regrades.ts"],
  ["exam-finalization-worker", "scripts/process-exam-finalizations.ts"],
  ["practice-runner-recovery-worker", "scripts/process-practice-runner-recoveries.ts"],
  ["project-review-correction-worker", "scripts/process-project-review-corrections.ts"],
  ["scan-worker", "scripts/scan-uploads.ts"],
  ["file-erasure-worker", "scripts/process-file-erasures.ts"],
] as const;

function composeService(compose: string, name: string, nextName: string | undefined) {
  const start = compose.indexOf(`  ${name}:`);
  expect(start, `${name} is absent from Compose`).toBeGreaterThan(-1);
  const end = nextName ? compose.indexOf(`\n  ${nextName}:`, start + 1) : compose.length;
  expect(end, `${name} Compose boundary is absent`).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("production worker heartbeat wiring", () => {
  it.each(WORKERS)("advances %s health only from its processing loop", (worker, path) => {
    const workerSource = source(path);
    expect(workerSource).toContain("createWorkerHealthReporter");
    expect(workerSource).toContain(`worker: "${worker}"`);
    expect(workerSource).toMatch(/\.success\(\)/);
    expect(workerSource).toMatch(/\.retry\(error\)/);
    expect(workerSource).toMatch(/\.terminalFailure\(error\)/);
    expect(workerSource).not.toMatch(/setInterval\([^)]*\.success/);
  });

  it("ships the reporter and fail-closed checker in every worker-derived image", () => {
    const dockerfile = source("Dockerfile");
    const workerStart = dockerfile.indexOf("FROM final-base AS worker");
    const operationsStart = dockerfile.indexOf("FROM worker AS operations", workerStart);
    const workerStage = dockerfile.slice(workerStart, operationsStart);
    expect(workerStage).toContain("scripts/lib/worker-health.ts");
    expect(workerStage).toContain("scripts/check-worker-health.ts");
  });

  it("gives every long-running worker an identity-bound recent-heartbeat healthcheck", () => {
    const compose = source("compose.yaml");
    const serviceNames = WORKERS.map(([name]) => name);
    for (const [index, name] of serviceNames.entries()) {
      const block = composeService(compose, name, serviceNames[index + 1] ?? "lifecycle");
      expect(block).toContain(`WORKER_HEALTH_ID: ${name}`);
      expect(block).toMatch(/WORKER_HEALTH_MAX_AGE_SECONDS: "[1-9][0-9]*"/);
      expect(block).toContain('WORKER_HEALTH_MAX_FAILURES: "2"');
      expect(block).toContain("healthcheck:");
      expect(block).toContain("/app/scripts/check-worker-health.ts");
    }
  });
});
