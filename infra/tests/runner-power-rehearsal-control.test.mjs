import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("ships the root-only rehearsal controller in the reviewed operations image", async () => {
  const [dockerfile, packageJson] = await Promise.all([
    read("Dockerfile"),
    read("package.json").then(JSON.parse),
  ]);
  assert.equal(
    packageJson.scripts["runner:power-rehearsal"],
    "tsx scripts/runner-power-rehearsal.ts",
  );
  assert.match(
    dockerfile,
    /FROM worker AS operations[\s\S]*COPY --chown=node:node scripts\/runner-power-rehearsal\.ts \.\/scripts\/runner-power-rehearsal\.ts/,
  );
  assert.match(
    dockerfile,
    /FROM worker AS operations[\s\S]*COPY --chown=node:node scripts\/lib\/runner-power-rehearsal-cli\.ts \.\/scripts\/lib\/runner-power-rehearsal-cli\.ts/,
  );
});

test("host wrapper is fixed-path, root-only, and cannot build or pull during the gate", async () => {
  const wrapper = await read("infra/ops/runner-power-rehearsal-control.sh");
  assert.match(wrapper, /set -Eeuo pipefail/);
  assert.match(wrapper, /EUID/);
  assert.match(wrapper, /\/opt\/learncoding/);
  assert.match(wrapper, /\/etc\/learncoding\/compose\.env/);
  assert.match(wrapper, /--profile operations/);
  assert.match(wrapper, /run --rm --no-deps --user 0:0/);
  assert.match(wrapper, /platform-seed/);
  assert.match(wrapper, /node --import tsx \/app\/scripts\/runner-power-rehearsal\.ts/);
  assert.match(wrapper, /"\$@"/);
  assert.doesNotMatch(wrapper, /(?:^|\s)(?:--build|build|--pull|pull)(?:\s|$)/m);
  assert.doesNotMatch(wrapper, /DATABASE_URL|cat .*secret|set -x/);
});

test("runbook uses only the reviewed wrapper for state changes", async () => {
  const runbook = await read("docs/runbooks/power-loss-recovery.md");
  assert.match(runbook, /runner-power-rehearsal-control\.sh arm/);
  assert.match(runbook, /runner-power-rehearsal-control\.sh status/);
  assert.match(runbook, /runner-power-rehearsal-control\.sh release/);
  assert.match(runbook, /runner-power-rehearsal-control\.sh abort/);
  assert.doesNotMatch(runbook, /insert into runner_power_rehearsal_event/i);
  assert.doesNotMatch(runbook, /update runner_power_rehearsal_event/i);
});

test("runbook proves both held rows are pristine before physical power removal", async () => {
  const runbook = await read("docs/runbooks/power-loss-recovery.md");
  assert.match(runbook, /dispatch_snapshot_present/i);
  assert.match(runbook, /remote_runner_job_absent/i);
  assert.match(runbook, /recovery_state/i);
  assert.match(runbook, /submission_status/i);
  assert.match(runbook, /runner_status/i);
  assert.match(runbook, /both runner and submission statuses `leased`/i);
});
