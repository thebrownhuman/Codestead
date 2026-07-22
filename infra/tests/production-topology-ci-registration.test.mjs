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

assert.match(job, /^  production-topology:\n    runs-on: ubuntu-24\.04\n/mu);
assert.doesNotMatch(job, /^    (?:needs|if):/mu, "topology gate must be independent");
assert.match(job, /timeout-minutes: 45/u);
assert.match(job, /RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}/u);
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
  "runner-stub",
  "runner-egress-gateway",
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
const reservationCallIndex = harness.indexOf("\nreserve_runner_client_network\n");
const firstImageBuildIndex = harness.indexOf("build_image runtime");
assert.ok(
  reservationCallIndex >= 0 && reservationCallIndex < firstImageBuildIndex,
  "the reviewed runner-client subnet must be reserved before expensive image builds",
);
assert.match(
  harness,
  /docker network create[\s\S]*--internal[\s\S]*--subnet "\$TOPOLOGY_RUNNER_CLIENT_SUBNET"[\s\S]*--ip-range "\$TOPOLOGY_RUNNER_CLIENT_RANGE"/u,
  "the early reservation must preserve the reviewed isolated IPAM",
);
assert.match(harness, /--label "com\.docker\.compose\.project=\$COMPOSE_PROJECT_NAME"/u);
assert.match(harness, /--label "com\.docker\.compose\.network=runner-client"/u);
assert.match(
  harness,
  /--label "io\.codestead\.fixture=production-topology-v1"/u,

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


for (const service of ["runner-stub", "runner-egress-gateway", "cloudflared", "app"])
  assert.match(overlay, new RegExp(`^  ${service}:`, "mu"));
const productionNetwork = (name) =>
  productionCompose.match(
    new RegExp(`^  ${name}:\\r?\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\r?$|^volumes:)`, "mu"),
  )?.[0] ?? "";
for (const [name, subnet, gateway, range] of [
  ["runner-client", "172.29.41.0/24", "172.29.41.1", "172.29.41.128/25"],
  ["runner-egress", "172.29.40.0/24", "172.29.40.1", "172.29.40.128/25"],
]) {
  const block = productionNetwork(name);
  assert.ok(block.includes(`subnet: ${subnet}`), `${name} must retain its declared subnet`);
  assert.ok(block.includes(`gateway: ${gateway}`), `${name} must retain its declared bridge gateway`);
  assert.ok(
    block.includes(`ip_range: ${range}`),
    `${name} must reserve the static .2 gateway outside Docker's dynamic allocation pool`,
  );
}

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
for (const variable of [
  "TOPOLOGY_RUNNER_CLIENT_SUBNET",
  "TOPOLOGY_RUNNER_CLIENT_RANGE",
  "TOPOLOGY_RUNNER_CLIENT_IP",
  "TOPOLOGY_RUNNER_EGRESS_SUBNET",
  "TOPOLOGY_RUNNER_EGRESS_RANGE",
  "TOPOLOGY_RUNNER_EGRESS_IP",
]) assert.match(harness, new RegExp(variable, "u"));
assert.match(
  harness,
  /TOPOLOGY_RUNNER_CLIENT_SUBNET="172\.29\.41\.0\/24"[\s\S]*TOPOLOGY_RUNNER_CLIENT_RANGE="172\.29\.41\.128\/25"[\s\S]*TOPOLOGY_RUNNER_CLIENT_IP="172\.29\.41\.2"/u,
  "the fixture must exercise the gateway entrypoint's exact reviewed runner-client address",
);
assert.match(
  harness,
  /TOPOLOGY_RUNNER_EGRESS_SUBNET="10\.251\.\$network_octet\.0\/24"[\s\S]*TOPOLOGY_RUNNER_EGRESS_RANGE="10\.251\.\$network_octet\.128\/25"/u,
  "the disposable egress network should remain collision-resistant",
);
assert.doesNotMatch(
  harness,
  /RUNNER_GATEWAY_LISTEN_HOST=.*10\.250/u,
  "the fixture must not bypass the gateway entrypoint's reviewed configuration",
);
assert.equal(overlay.match(/ipam: !override/gu)?.length, 2);
assert.equal(overlay.match(/ip_range:/gu)?.length, 2, "dynamic IPAM must exclude each static gateway IP");
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
