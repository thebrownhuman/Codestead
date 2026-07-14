import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("project-review correction durable worker wiring", () => {
  it("runs corrections only from a supervised poller rather than an HTTP handler", () => {
    const decisionRoute = source("src/app/api/admin/appeals/[appealId]/decision/route.ts");
    const collectionRoute = source("src/app/api/admin/project-review-corrections/route.ts");
    const retryRoute = source("src/app/api/admin/project-review-corrections/[correctionId]/run/route.ts");
    for (const route of [decisionRoute, collectionRoute, retryRoute]) {
      expect(route).not.toContain("processOneProjectReviewCorrection");
    }
    expect(retryRoute).toContain("requestProjectReviewCorrectionRetry");
    expect(source("scripts/process-project-review-corrections.ts"))
      .toContain("processProjectReviewCorrectionBatch");
  });

  it("ships a restartable least-privilege Compose service and dedicated image target", () => {
    const compose = source("compose.yaml");
    const dockerfile = source("Dockerfile");
    const packageJson = source("package.json");
    expect(compose).toContain("project-review-correction-worker:");
    expect(compose).toContain("target: project-review-correction-worker");
    expect(compose).toMatch(/project-review-correction-worker:[\s\S]*?restart: unless-stopped/);
    expect(compose).toMatch(/project-review-correction-worker:[\s\S]*?networks:[\s\S]*?- data[\s\S]*?- github-egress/);
    expect(dockerfile).toContain("FROM worker AS project-review-correction-worker");
    expect(dockerfile).toContain("scripts/process-project-review-corrections.ts");
    expect(packageJson).toContain('"worker:project-review-corrections"');
  });

  it("fences every settlement by attempt generation and gives each process a unique identity", () => {
    const service = source("src/lib/projects/review-correction-service.ts");
    const worker = source("scripts/process-project-review-corrections.ts");
    expect(service.match(/status = 'running' and lease_owner = \$\d+[\s\S]{0,100}and attempt_count = \$\d+/g))
      .toHaveLength(2);
    expect(worker).toContain("process.pid");
    expect(worker).toContain("randomUUID().slice(0, 8)");
  });

  it("makes model-call and source-appeal ledger bindings immutable in migration 0033", () => {
    const migration = source("drizzle/0033_project_review_ledger_fencing.sql");
    expect(migration).toContain('OR NEW."model_call_id" IS DISTINCT FROM OLD."model_call_id"');
    expect(migration).toContain('OR NEW."source_appeal_id" IS DISTINCT FROM OLD."source_appeal_id"');
    expect(migration).not.toMatch(/model_call_id" IS DISTINCT[^\n]+IS NOT NULL/);
    expect(migration).not.toMatch(/source_appeal_id" IS DISTINCT[^\n]+IS NOT NULL/);
  });
});
