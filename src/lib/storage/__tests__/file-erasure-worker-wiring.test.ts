import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const source = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

function composeService(compose: string, name: string, nextName: string) {
  const start = compose.indexOf(`  ${name}:`);
  const end = compose.indexOf(`\n  ${nextName}:`, start + 1);
  expect(start, `${name} is absent from Compose`).toBeGreaterThan(-1);
  expect(end, `${name} Compose boundary is absent`).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("durable user-file erasure production wiring", () => {
  it("drains a bounded delete batch in a dedicated always-on worker", () => {
    const worker = source("scripts/process-file-erasures.ts");
    expect(worker).toContain("processUserFileErasures");
    expect(worker).toContain('integer("FILE_ERASURE_BATCH_SIZE", 25, 1, 100)');
    expect(worker).toContain('integer("FILE_ERASURE_LEASE_SECONDS", 300, 30, 900)');
    const drain = worker.indexOf("const summary = await processUserFileErasures");
    const healthy = worker.indexOf("healthReporter.success()", drain);
    expect(drain).toBeGreaterThan(-1);
    expect(healthy).toBeGreaterThan(drain);
    expect(worker.slice(drain, healthy)).toContain("objectStorageRoot: root");
    const failureGate = worker.indexOf("summary.failed > 0 || summary.exhausted > 0");
    expect(failureGate).toBeGreaterThan(drain);
    expect(failureGate).toBeLessThan(healthy);
    expect(worker.slice(drain, healthy)).toContain("limit: batchSize");
    expect(worker.slice(drain, healthy)).toContain("leaseMs");
    expect(worker).toContain('event: "storage.user_file_erasure_batch"');
    expect(worker).toContain('event: "storage.user_file_erasure_backlog_exhausted"');
  });

  it("mounts only the reviewed object root and has no ClamAV or upload-profile dependency", () => {
    const erasureWorker = composeService(source("compose.yaml"), "file-erasure-worker", "lifecycle");
    expect(erasureWorker).not.toContain("profiles:");
    expect(source("infra/tests/validate-compose.mjs")).toMatch(/const pilotServices = \[[\s\S]*?"file-erasure-worker"/u);
    expect(erasureWorker).toContain("restart: unless-stopped");
    expect(erasureWorker).not.toContain("CLAMD_");
    expect(erasureWorker).not.toContain("UPLOADS_ENABLED");
    expect(erasureWorker).not.toContain("scanner");
    expect(erasureWorker).not.toMatch(/source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\s+target: \/var\/lib\/learncoding(?:\s|$)/u);
    expect(erasureWorker).toMatch(/source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\/objects\s+target: \/var\/lib\/learncoding\/objects\s+read_only: false/u);
    expect(erasureWorker).toContain("database_worker_url");
    expect(erasureWorker).toContain("WORKER_HEALTH_ID: file-erasure-worker");
    expect(erasureWorker).toContain("/app/scripts/check-worker-health.ts");
  });

  it("ships the bounded processor in the reviewed generic worker image", () => {
    const dockerfile = source("Dockerfile");
    const worker = dockerfile.slice(
      dockerfile.indexOf("FROM final-base AS worker"),
      dockerfile.indexOf("FROM worker AS operations"),
    );
    expect(worker).toContain("scripts/process-file-erasures.ts");
    expect(worker).not.toContain("scripts/scan-uploads.ts");
    expect(dockerfile).toContain("COPY --chown=node:node src ./src");
  });
});