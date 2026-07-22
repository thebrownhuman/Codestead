import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("reward worker production wiring", () => {
  it("ships the reconciliation poller in the non-application worker image", () => {
    const dockerfile = source("Dockerfile");
    expect(dockerfile).toContain("FROM final-base AS worker");
    expect(dockerfile).toContain("scripts/process-rewards.ts ./scripts/process-rewards.ts");
    expect(dockerfile.indexOf("scripts/process-rewards.ts")).toBeLessThan(
      dockerfile.indexOf("FROM final-base AS runtime"),
    );
  });

  it("runs a restartable, read-only, database-only bounded worker without egress or secrets beyond DB", () => {
    const compose = source("compose.yaml");
    const start = compose.indexOf("  reward-worker:");
    const end = compose.indexOf("\n  regrade-worker:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const service = compose.slice(start, end);
    for (const required of [
      'command: ["node", "--import", "tsx", "/app/scripts/process-rewards.ts"]',
      "restart: unless-stopped",
      "REWARD_POLL_SECONDS: ${REWARD_POLL_SECONDS:-5}",
      "REWARD_BATCH_SIZE: ${REWARD_BATCH_SIZE:-20}",
      "source: database_worker_url",
      "target: database_url",
      "DATABASE_URL_FILE: /run/secrets/database_url",
      "- data",
      "<<: [*hardened, *codestead-managed]",
      "noexec",
      "mem_limit: 256m",
      "cpus: 0.25",
      "pids_limit: 64",
    ]) expect(service).toContain(required);
    expect(compose.slice(0, compose.indexOf("services:"))).toContain("read_only: true");
    for (const forbidden of [
      "runner-egress",
      "mail-egress",
      "github-egress",
      "frontend",
      "credential_master_key",
      "runner_shared_secret",
      "gmail_",
    ]) expect(service).not.toContain(forbidden);
  });

  it("exposes an operator command and validates bounded polling configuration", () => {
    const packageJson = source("package.json");
    const script = source("scripts/process-rewards.ts");
    expect(packageJson).toContain('"worker:rewards": "tsx scripts/process-rewards.ts"');
    expect(script).toContain('process.argv.includes("--once")');
    expect(script).toContain("pollSeconds < 2 || pollSeconds > 3_600");
    expect(script).toContain("batchSize < 1 || batchSize > 100");
  });
});
