#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => {
  try {
    return readFileSync(resolve(repoRoot, path), "utf8");
  } catch {
    return "";
  }
};

const workflow = read(".github/workflows/ci.yml");
const harness = read("infra/tests/production-topology.test.sh");
const overlay = read("infra/tests/fixtures/production-topology.compose.yaml");
const productionCompose = read("compose.yaml");
const deploymentGuide = read("docs/deployment.md");

const dockerIgnore = read(".dockerignore");
const job = workflow.match(
  /^  production-topology:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";

assert.match(
  job,
  /^  production-topology:\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 45\n    needs: changes\n    if: needs\.changes\.outputs\.topology == 'true'\n    env:\n/mu,
);
assert.deepEqual(
  job.match(/^    (?:needs|if|continue-on-error):.*$/gmu),
  ["    needs: changes", "    if: needs.changes.outputs.topology == 'true'"],
  "topology gate may only depend on the reviewed path-scope job",
);
// The changes job must keep every non-pull-request event (main, nightly,
// dispatch) running the topology gate unconditionally.
assert.match(
  workflow,
  /^      topology: \$\{\{ github\.event_name != 'pull_request' \|\| steps\.filter\.outputs\['topology-paths'\] == 'true' \}\}$/mu,
  "topology must always run outside pull requests",
);
assert.doesNotMatch(
  job,
  /^      RUNNER_ENVIRONMENT:/mu,
  "GitHub must provide RUNNER_ENVIRONMENT at step runtime",
);
assert.match(job, /CODESTEAD_DISPOSABLE_HOST=1 bash infra\/tests\/production-topology\.test\.sh/u);
assert.match(job, /bash -n infra\/tests\/production-topology\.test\.sh/u);
assert.match(
  job,
  /koalaman\/shellcheck@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d/u,
);
assert.equal(
  workflow.match(/CODESTEAD_DISPOSABLE_HOST=1 bash infra\/tests\/production-topology\.test\.sh/gu)?.length,
  1,
  "the real topology gate must run exactly once",
);
assert.match(dockerIgnore, /^\/\.next-\*$/mu, "ephemeral Next test builds must stay out of image contexts");
assert.doesNotMatch(
  dockerIgnore,
  /^!\/\.next-/mu,
  "no ephemeral Next test build may be re-included",
);

for (const required of [
  "COMPOSE_PROJECT_NAME",
  "production-topology.compose.yaml",
  "docker compose",
  "migrate",
  "platform-seed",
  "admin-bootstrap",
  "UPLOADS_ENABLED=false",
  "ClamAV/scanner services were started in pilot topology",
  "restart postgres app",
  "down --volumes --remove-orphans",
  "No real provider credentials",
]) {
  assert.match(harness, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
}

assert.match(harness, /GITHUB_ACTIONS.*github-hosted/su);
assert.match(harness, /trap cleanup EXIT/u);
assert.match(harness, /timeout/u);
assert.doesNotMatch(harness, /--privileged|0\.0\.0\.0:/u);
assert.doesNotMatch(
  harness,
  /(?:--volume|-v)[^\n]*\/var\/run\/docker\.sock|(?:source|target):?\s*\/var\/run\/docker\.sock/u,
  "The topology harness must never mount the host Docker socket into a container.",
);
const parseServiceInventory = (name) =>
  (harness.match(new RegExp(`${name}=\\(([^)]*)\\)`, "u"))?.[1] ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
const policyRecoveredServices = [
  "postgres",
  "app",
  "mail-worker",
  "reward-worker",
  "regrade-worker",
  "exam-finalization-worker",
  "practice-runner-recovery-worker",
  "project-review-correction-worker",
  "file-erasure-worker",
];
assert.deepEqual(
  parseServiceInventory("long_running_services"),
  [...policyRecoveredServices, "cloudflared"],
  "the ordinary restart matrix must cover the exact ordered pilot inventory",
);
assert.deepEqual(
  parseServiceInventory("policy_recovered_services"),
  policyRecoveredServices,
  "the Docker restart-policy matrix must cover every internal pilot service exactly",
);
assert.doesNotMatch(
  harness.match(/policy_recovered_services=\([^)]*\)/u)?.[0] ?? "",
  /cloudflared/u,
  "cloudflared is intentionally quarantined from Docker restart-policy recovery",
);
assert.match(
  harness,
  /assert_cloudflared_quarantined_after_daemon_restart/u,
  "the daemon-restart tranche must prove ingress remains stopped before guarded recovery",
);
assert.match(
  harness,
  /recover_ingress_after_daemon_restart[\s\S]*up --detach --no-build --pull never --no-deps cloudflared/u,
  "the daemon-restart tranche must model the guarded ingress authority with the reviewed no-build/no-pull activation",
);
const postgresStartIndex = harness.indexOf('up --detach --no-build --wait --wait-timeout 150 postgres');
const targetDatabaseReadyIndex = harness.indexOf('wait_for_query 1 "select 1;"');
const migrationLockIndex = harness.indexOf("# Hold the shared database-administration lock");
assert.ok(postgresStartIndex >= 0, "the gate must start PostgreSQL");
assert.ok(
  targetDatabaseReadyIndex > postgresStartIndex && targetDatabaseReadyIndex < migrationLockIndex,
  "the target database must accept a real query before the migration lock phase starts",
);
assert.match(
  harness,
  /kill -0 "\$lock_holder_pid" "\$bootstrap_pid" "\$migrate_pid"[\s\S]*database-administration contender succeeded while the external lock was still held/u,
  "the gate must prove both administration contenders remain blocked while the shared lock is held",
);
assert.doesNotMatch(harness, /locktype = 'advisory' and not granted/u);
assert.match(
  harness,
  /expected.*last observed.*query:/u,
  "PostgreSQL poll failures must report actionable fixture-only diagnostics",
);


for (const service of ["cloudflared", "app"])
  assert.match(overlay, new RegExp(`^  ${service}:`, "mu"));
// The legacy native runner, its VM gateway and its networks are retired.
for (const retired of ["runner-stub", "runner-egress-gateway", "runner-client", "runner-egress", "runner-stub-net"]) {
  assert.doesNotMatch(overlay, new RegExp(`^  ${retired}:`, "mu"), `${retired} must not return to the fixture`);
  assert.doesNotMatch(productionCompose, new RegExp(`^  ${retired}:`, "mu"), `${retired} must not return to production Compose`);
}
assert.doesNotMatch(harness, /TOPOLOGY_RUNNER_|runner_shared_secret/u, "the harness must not provision retired runner topology");

assert.match(overlay, /UPLOADS_ENABLED: "false"/u);
assert.doesNotMatch(overlay, /ports:/u);
assert.doesNotMatch(overlay, /clamav:|scan-worker:/u);
for (const variable of [
  "REWARD_POLL_SECONDS",
  "REGRADE_POLL_SECONDS",
  "EXAM_FINALIZATION_POLL_SECONDS",
  "PRACTICE_RECOVERY_POLL_SECONDS",
  "PROJECT_REVIEW_CORRECTION_POLL_SECONDS",
]) {
  assert.match(
    overlay,
    new RegExp(`${variable}: "2"`, "u"),
    `${variable} must respect the worker's minimum supported poll interval`,
  );
}
assert.doesNotMatch(overlay, /172\.29\.4[01]\./u, "fixture IPAM must not collide with production networks");
assert.match(
  overlay,
  /\/proc\/1\/comm[\s\S]*pg_isready/u,
  "fixture health must reject PostgreSQL's temporary initialization child",
);


assert.match(
  deploymentGuide,
  /Disposable production-topology gate[\s\S]*production-topology\.test\.sh/u,
);

await import("./production-topology-hardening.test.mjs");
