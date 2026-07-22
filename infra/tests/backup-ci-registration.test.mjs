#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath =
  process.argv[2] === undefined
    ? resolve(repoRoot, ".github", "workflows", "ci.yml")
    : resolve(process.cwd(), process.argv[2]);
if (process.argv.length > 3) {
  throw new Error("usage: backup-ci-registration.test.mjs [workflow-path]");
}
const workflow = readFileSync(workflowPath, "utf8");
const productionE2eHarnessPath = resolve(
  repoRoot,
  "infra",
  "tests",
  "backup-production-e2e.test.sh",
);
const productionE2eHarness = readFileSync(productionE2eHarnessPath, "utf8");

class RegistrationError extends Error {}

function fail(message) {
  throw new RegistrationError(`backup CI registration: ${message}`);
}

function requireHarnessFragment(source, fragment, message) {
  if (source.split(fragment).length !== 2) {
    fail(message);
  }
}

function harnessFunction(source, name, message) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...source.matchAll(new RegExp(`^${escaped}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "gm")),
  ];
  if (matches.length !== 1) {
    fail(message);
  }
  return matches[0][0];
}

function validateHarnessHostedRunnerContract(source) {
  requireHarnessFragment(
    source,
    '[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 \\\n  && "${GITHUB_ACTIONS:-}" == true \\\n  && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \\\n  || fail "disposable GitHub-hosted runner acknowledgement is required"',
    "production E2E outer hosted-runner gate is missing or ambiguous",
  );
  requireHarnessFragment(
    source,
    '  [[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 \\\n    && "${GITHUB_ACTIONS:-}" == true \\\n    && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \\\n    || fail "inner disposable GitHub-hosted acknowledgement is absent"',
    "production E2E inner hosted-runner gate is missing or ambiguous",
  );
  requireHarnessFragment(
    source,
    "  --env CODESTEAD_DISPOSABLE_HOST=1 --env GITHUB_ACTIONS=true \\\n  --env RUNNER_ENVIRONMENT=github-hosted \\",
    "production E2E toolbox hosted-runner marker is missing or ambiguous",
  );
  if (source.split("RUNNER_ENVIRONMENT").length !== 4) {
    fail("production E2E hosted-runner marker has a hidden carrier");
  }
}

function validateHarnessRegistryContract(source) {
  for (const [fragment, message] of [
    [
      'registry_digest="$(image_repo_digest registry:2 registry)"',
      "loopback registry RepoDigest resolution is missing or ambiguous",
    ],
    [
      'registry_image_id="$(docker image inspect --format \'{{.Id}}\' "$registry_digest")"',
      "loopback registry immutable image ID capture is missing or ambiguous",
    ],
    [
      '"$registry_digest")" || fail "loopback registry did not start"',
      "loopback registry is not started from its immutable digest",
    ],
    [
      'configured_image" == "$registry_digest"',
      "loopback registry configured image digest is not verified",
    ],
    [
      'runtime_image" == "$registry_image_id"',
      "loopback registry runtime image ID is not verified",
    ],
  ]) {
    requireHarnessFragment(source, fragment, message);
  }
  if (source.split("registry:2").length !== 3) {
    fail("mutable loopback registry tag has an extra or hidden use");
  }
}

function validateHarnessCredentialProbeCleanupContract(source) {
  const functionMatch =
    /^credential_probe_container_is_owned\(\) \{\n[\s\S]*?^\}$/m.exec(source);
  if (functionMatch === null) {
    fail("credential-probe cleanup validator is missing or malformed");
  }
  const validator = functionMatch[0];
  const rescanMatch =
    /^remove_owned_credential_probe_containers\(\) \{\n[\s\S]*?^\}$/m.exec(source);
  if (rescanMatch === null) {
    fail("credential-probe cleanup rescan is missing or malformed");
  }
  const rescan = rescanMatch[0];
  for (const [fragment, message] of [
    [
      'grep -Fxq -- "$id" "$pre_backup_container_ids"',
      "credential-probe cleanup lacks temporal provenance",
    ],
    [
      'expected_args=\'["--import","tsx","/app/scripts/backup/create-credential-probe.ts","/output/credential-probe.json","/run/secrets/credential_master_key"]\'',
      "credential-probe cleanup command identity is incomplete",
    ],
    [
      '"$configured_image" == "${operations_digest:-}"',
      "credential-probe cleanup configured image identity is incomplete",
    ],
    [
      '"$runtime_image" == "${operations_image_id:-}"',
      "credential-probe cleanup runtime image identity is incomplete",
    ],
    [
      '"$owner_label" == "${run_id:-}"',
      "credential-probe cleanup owner label is not verified",
    ],
    [
      '"$owner_project_label" == "${ownership_project:-}"',
      "credential-probe cleanup owner project label is not verified",
    ],
    [
      '"$compose_project" == "" && "$compose_working_dir" == ""',
      "credential-probe cleanup does not reject Compose containers",
    ],
    [
      '"$mount_type" == bind && "$mount_source" == "$test_root/config/secrets/credential_master_key"',
      "credential-probe cleanup secret bind identity is incomplete",
    ],
    [
      '^([0-9]{8}T[0-9]{6}Z)[.][A-Za-z0-9]{6}/probe-output$',
      "credential-probe cleanup output bind boundary is incomplete",
    ],
    [
      '"$credential_mount_count" == 1 && "$output_mount_count" == 1',
      "credential-probe cleanup does not require both exact bind mounts",
    ],
    [
      '"$unexpected_mount" == "" && "$tmpfs_mount_count" -le 1',
      "credential-probe cleanup does not reject extra mounts",
    ],
  ]) {
    if (!validator.includes(fragment)) {
      fail(message);
    }
  }
  if (validator.includes("{{.Name}}") || validator.includes("resource_prefix")) {
    fail("credential-probe cleanup relies on the daemon-generated name");
  }
  for (const [fragment, message] of [
    [
      'docker ps --all --quiet --no-trunc | sort >"$pre_backup_container_ids"',
      "pre-backup container snapshot is missing",
    ],
    [
      'elif credential_probe_container_is_owned "$id"; then',
      "credential-probe cleanup validator is not on the removal path",
    ],
    [
      'docker rm --force "$id" >/dev/null 2>&1',
      "credential-probe cleanup does not remove only the validated full ID",
    ],
    [
      "remove_owned_credential_probe_containers || cleanup_failed=1",
      "credential-probe cleanup lacks a post-toolbox race rescan",
    ],
  ]) {
    if (!source.includes(fragment)) {
      fail(message);
    }
  }
  for (const [fragment, message] of [
    [
      '--filter "ancestor=$operations_digest"',
      "credential-probe cleanup rescan discovery is not image-bounded",
    ],
    [
      'credential_probe_container_is_owned "$id"',
      "credential-probe cleanup rescan bypasses the exact validator",
    ],
    [
      'docker rm --force "$id" >/dev/null 2>&1',
      "credential-probe cleanup rescan does not remove the validated full ID",
    ],
  ]) {
    if (!rescan.includes(fragment)) {
      fail(message);
    }
  }
}

function validateHarnessCleanupEvidenceContract(source) {
  const appendQuery = harnessFunction(
    source,
    "append_docker_query_lines",
    "cleanup lacks status-preserving Docker query collection",
  );
  const confirmAbsent = harnessFunction(
    source,
    "docker_object_is_confirmed_absent",
    "cleanup cannot distinguish absent resources from Docker failures",
  );
  const queryEmpty = harnessFunction(
    source,
    "docker_query_is_empty",
    "cleanup lacks status-preserving final residue queries",
  );
  const rescan = harnessFunction(
    source,
    "remove_owned_credential_probe_containers",
    "credential-probe cleanup rescan is missing or malformed",
  );
  const cleanup = harnessFunction(
    source,
    "cleanup_test",
    "production E2E cleanup function is missing or malformed",
  );
  const dockerLossProof = harnessFunction(
    source,
    "assert_cleanup_rejects_docker_loss",
    "cleanup lacks an executable Docker-loss fail-closed proof",
  );
  for (const [body, fragment, message] of [
    [
      appendQuery,
      'output="$("$@")" || return 1',
      "Docker query collection accepts a failed command",
    ],
    [
      appendQuery,
      'local -n destination="$destination_name"',
      "Docker query collection does not append to the reviewed array",
    ],
    [
      confirmAbsent,
      'docker info >/dev/null 2>&1 || return 1',
      "absence confirmation does not require a reachable Docker daemon",
    ],
    [
      confirmAbsent,
      "docker image ls --all --digests --no-trunc",
      "image absence confirmation lacks structured inventory",
    ],
    [
      confirmAbsent,
      '"$image_id" != "$object_id"',
      "image absence confirmation does not compare immutable IDs",
    ],
    [
      confirmAbsent,
      '"$repository" != \'<none>\' && "$tag" != \'<none>\' \\\n          && "$repository:$tag" == "$object_id"',
      "image absence confirmation does not compare tags",
    ],
    [
      confirmAbsent,
      '"$repository" != \'<none>\' && "$digest" != \'<none>\' \\\n          && "$repository@$digest" == "$object_id"',
      "image absence confirmation does not compare RepoDigests",
    ],
    [
      queryEmpty,
      'output="$("$@")" || return 1',
      "final residue query accepts a failed command",
    ],
    [
      queryEmpty,
      '[[ -z "$output" ]]',
      "final residue query does not require empty output",
    ],
    [
      rescan,
      'append_docker_query_lines probe_candidates docker ps',
      "credential-probe rescan discards Docker query status",
    ],
    [
      rescan,
      'docker_object_is_confirmed_absent container "$id" || removal_failed=1',
      "credential-probe rescan removal is not fail-closed",
    ],
    [
      cleanup,
      'append_docker_query_lines candidates docker ps --all --quiet --no-trunc \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id"',
      "container cleanup discovery does not preserve Docker query status",
    ],
    [
      cleanup,
      "append_docker_query_lines monitor_candidates docker ps",
      "monitor cleanup discovery does not preserve Docker query status",
    ],
    [
      cleanup,
      "append_docker_query_lines candidates docker network ls",
      "network cleanup discovery does not preserve Docker query status",
    ],
    [
      cleanup,
      "append_docker_query_lines candidates docker volume ls",
      "volume cleanup discovery does not preserve Docker query status",
    ],
    [
      cleanup,
      'if ! docker inspect "$id" >/dev/null 2>&1; then\n      docker_object_is_confirmed_absent container "$id" || cleanup_failed=1\n      continue\n    fi',
      "container inspect failure is not fail-closed",
    ],
    [
      cleanup,
      'if ! docker rm --force "$id" >/dev/null 2>&1; then\n        docker_object_is_confirmed_absent container "$id" || cleanup_failed=1\n      fi',
      "credential-probe removal failure is not fail-closed",
    ],
    [
      cleanup,
      'docker_object_is_confirmed_absent network "$id"',
      "network inspect failure is not fail-closed",
    ],
    [
      cleanup,
      'docker_object_is_confirmed_absent volume "$name"',
      "volume inspect failure is not fail-closed",
    ],
    [
      cleanup,
      'docker_object_is_confirmed_absent image "$reference"',
      "image inspect failure is not fail-closed",
    ],
    [
      cleanup,
      "if ! docker info >/dev/null 2>&1; then\n    cleanup_failed=1\n  else",
      "cleanup does not require Docker availability before success",
    ],
    [
      cleanup,
      'docker_query_is_empty docker ps -aq \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id"',
      "final container residue query is not status preserving",
    ],
    [
      cleanup,
      'docker_query_is_empty docker network ls -q --no-trunc',
      "final network residue query is not status preserving",
    ],
    [
      cleanup,
      'docker_query_is_empty docker volume ls -q',
      "final volume residue query is not status preserving",
    ],
    [
      cleanup,
      'docker_query_is_empty docker image ls -aq',
      "final image residue query is not status preserving",
    ],
    [
      dockerLossProof,
      "docker() { return 1; }",
      "Docker-loss cleanup proof does not simulate daemon loss",
    ],
    [
      dockerLossProof,
      "inner_complete=1",
      "Docker-loss cleanup proof does not simulate an otherwise completed run",
    ],
    [
      dockerLossProof,
      '"$self_test_status" == 1',
      "Docker-loss cleanup proof does not require cleanup failure",
    ],
    [
      dockerLossProof,
      '"$self_test_output" != *backup-production-e2e-tests-ok*',
      "Docker-loss cleanup proof does not reject the success sentinel",
    ],
  ]) {
    if (!body.includes(fragment)) {
      fail(message);
    }
  }
  if (cleanup.split("docker_query_is_empty ").length !== 11) {
    fail("cleanup final residue query set is incomplete or ambiguous");
  }
  requireHarnessFragment(
    source,
    'assert_cleanup_rejects_docker_loss "$runner_temp"',
    "Docker-loss cleanup proof is not executed exactly once by the hosted gate",
  );
  if (cleanup.includes("done < <(docker")) {
    fail("cleanup discards a Docker discovery command status");
  }
}

function validateHarnessEphemeralRuntimeContract(source) {
  const runtimeCheck = harnessFunction(
    source,
    "assert_ephemeral_runtime_clean",
    "production E2E short ephemeral-runtime validator is missing or malformed",
  );
  for (const [fragment, message] of [
    ['local stage_root="$test_root/staging" ephemeral_root="/run/bpe"', "production E2E does not use the reviewed short in-container ephemeral root"],
    ["--tmpfs /run/bpe:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=0,gid=0", "production E2E short ephemeral root is not backed by an explicit private tmpfs"],
  ]) requireHarnessFragment(source, fragment, message);
  for (const [fragment, message] of [
    ['[[ "$root" == /run/bpe ]]', "ephemeral-runtime validator accepts a different or long root"],
    ['.managed-deadline-stop-00000000000000000000000000000000.sock', "ephemeral-runtime validator omits the deterministic AF_UNIX endpoint probe"],
    ['${#endpoint_probe} == 78 && ${#endpoint_probe} < 108', "ephemeral-runtime validator does not prove the exact AF_UNIX byte bound"],
    ['"$(stat -c \'%a:%u\' -- "$root")" == 700:0', "ephemeral-runtime validator omits exact mode/owner proof"],
    ['"$(findmnt -n -o SOURCE -T "$root")" == tmpfs', "ephemeral-runtime validator omits tmpfs source proof"],
    ['"$(findmnt -n -o FSTYPE -T "$root")" == tmpfs', "ephemeral-runtime validator omits tmpfs filesystem proof"],
    ['"$(findmnt -n -o TARGET -T "$root")" == "$root"', "ephemeral-runtime validator omits exact mount-target proof"],
    ['[[ -z "$(find -P "$root" -mindepth 1 -print -quit)" ]]', "ephemeral-runtime validator omits deterministic residue proof"],
  ]) if (!runtimeCheck.includes(fragment)) fail(message);
  if (source.split('assert_ephemeral_runtime_clean "$ephemeral_root"').length !== 3) {
    fail("production E2E does not prove ephemeral tmpfs state before and after backup");
  }
}

function validateHarnessRestoreEntrypointContract(source) {
  for (const [fragment, message] of [
    [
      'scripts/backup/restore.sh',
      "production E2E bypasses the real restore entrypoint",
    ],
    [
      '--destination "$restore_root" --restore-db "$restore_database"',
      "production E2E does not bind the verified extraction and isolated database to restore.sh",
    ],
    [
      '--env RESTORE_CREDENTIAL_PROBE=/restore/credential-probe.json',
      "production E2E does not recover the produced credential probe",
    ],
    [
      '--env CREDENTIAL_MASTER_KEY_FILE=/recovery/credential_master_key',
      "production E2E does not use the recovery master key",
    ],
    [
      '--import tsx /app/scripts/verify-restored-backup.ts',
      "production E2E does not run the real database/app-data/credential restore smoke",
    ],
    [
      '--network "container:$postgres_id" --read-only --cap-drop ALL',
      "production restore smoke is not isolated to the disposable PostgreSQL namespace",
    ],
  ]) {
    requireHarnessFragment(source, fragment, message);
  }
  for (const forbidden of [
    'docker exec "$postgres_id" createdb',
    'docker exec -i "$postgres_id" pg_restore',
  ]) {
    if (source.includes(forbidden)) {
      fail("production E2E still contains a manual restore bypass");
    }
  }
}

function normalizeWorkflow(document) {
  const withoutCrLf = document.replaceAll("\r\n", "");
  if (withoutCrLf.includes("\r")) {
    fail("workflow contains a stray bare carriage return");
  }
  if (document.includes("\r\n") && withoutCrLf.includes("\n")) {
    fail("workflow mixes LF and CRLF line endings");
  }
  return document.replaceAll("\r\n", "\n");
}

const registrationRun = "node infra/tests/backup-ci-registration.test.mjs";
const shellSyntaxRun = "bash -n scripts/backup/*.sh infra/tests/*.sh";
const pythonSyntaxRun =
  "python3 -m py_compile scripts/backup/run-managed-deadline.py infra/tests/managed-deadline-stop-channel-linux.py";
const productionE2eRun =
  "CODESTEAD_DISPOSABLE_HOST=1 bash infra/tests/backup-production-e2e.test.sh";
const rootFixturePrefix =
  "sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C bash";
const rootFixtureRun = (fixture) => `${rootFixturePrefix} ${fixture}`;
const rootRequiredFixtures = [
  "infra/tests/offsite-recovery.test.sh", "infra/tests/offsite-retention.test.sh",
  "infra/tests/recovery-kit.test.sh", "infra/tests/recovery-evidence-verifier.test.sh",
];
const requiredBackupRuns = [
  registrationRun,
  shellSyntaxRun,
  pythonSyntaxRun,
  "sudo apt-get update",
  "sudo apt-get install --yes age",
  "npm ci",
  "bash infra/tests/backup-config.test.sh",
  "bash infra/tests/restore-path-safety.test.sh",
  "bash infra/tests/managed-deadline-registration.test.sh",
  "bash infra/tests/managed-deadline-linux.test.sh",
  "bash infra/tests/credential-probe-cleanup.test.sh",
  "bash infra/tests/backup-consistency.test.sh",
  "bash infra/tests/backup-retention.test.sh",
  "bash infra/tests/emergency-backup-atomicity.test.sh",
  "bash infra/tests/backup-publication.test.sh",
  rootFixtureRun("infra/tests/offsite-recovery.test.sh"),
  rootFixtureRun("infra/tests/offsite-retention.test.sh"),
  rootFixtureRun("infra/tests/recovery-kit.test.sh"),
  "bash infra/tests/restore-chronology.test.sh",
  "node infra/tests/restore-drill-contract.test.mjs",
  "npm exec vitest run scripts/verify-restored-backup.test.ts",
  rootFixtureRun("infra/tests/recovery-evidence-verifier.test.sh"),
  "bash infra/tests/restore-drill-reminder.test.sh",
  "bash infra/tests/systemd-backup.test.sh",
];
const expectedApplicationRuns = [
  "npm ci",
  "npm run production-load:ci-registration",
  "npm run production-load:test-control:bundle",
  "npm run production-load:fixture-runtime:bundle",
  "npm run production-load:fixture-runtime:systemd",
  "CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:fixture-runtime:lifecycle",
  'sudo env "PATH=$PATH" CODESTEAD_REQUIRE_LINUX_ROOT=1 npm run production-load:test-control:runtime',
  "CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:peer-credentials",
  "CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:disposable-sandbox",
  "npm run lint",
  "npm run typecheck",
  "npm run security:dependencies:known",
  "npm run security:secrets",
  "npm run security:encoding",
  "npm run security:api-surface",
  "npm run architecture:check",
  "npm run ai:eval -- --check",
  "npm run test:auth-boundary",
  "npm run test:coverage",
  "npm run content:brand:check",
  "npm run content:validate",
  "npm run projects:catalog:validate",
  "npm run dsa:parity:check",
  "npm run c-cpp:executable:check",
  "npm run java-python:executable:check",
  "npm run ai-code:executable:check",
  "npm run web:executable:check",
  "npm run audit:release",
  "npm run evidence:verify",
  "npm run build",
  "npm audit --audit-level=moderate",
  "node infra/tests/validate-static.mjs",
  "node --test infra/tests/database-least-privilege-static.test.mjs",
  "node --test infra/tests/runtime-validator-ingress-policy.test.mjs",
  "node --test infra/tests/production-load-peer-preflight.test.mjs infra/tests/production-load-postgres-socket.test.mjs infra/tests/production-load-systemd.test.mjs",
  "node --test infra/tests/runner-power-rehearsal-control.test.mjs",
  "node --test infra/tests/ingress-control-ci-registration.test.mjs infra/tests/ingress-systemd.test.mjs",
  "node infra/tests/runtime-validator-structure.test.mjs",
  "node infra/tests/runtime-validator-harness-contract.test.mjs",
  "node --test infra/tests/runner-egress-gateway.test.mjs infra/tests/runner-egress-gateway-stream-failures.test.mjs",
  "sudo apt-get update",
  "sudo apt-get install --yes bubblewrap nftables shellcheck",
  "shellcheck --severity=warning infra/ops/capture-recovery-evidence.sh infra/ops/install-compose-ci.sh infra/ops/release-production.sh infra/ops/rollback-production.sh infra/ops/smoke-production.sh infra/ops/validate-production-load-fixture-runtime.sh infra/ops/validate-production-load-test-control-runtime.sh infra/runner-vm/install-guest.sh infra/tests/compose-release-cli-contract.test.sh infra/tests/power-evidence.test.sh infra/tests/production-load-disposable-sandbox.test.sh infra/tests/production-load-fixture-lifecycle.test.sh infra/tests/production-load-peer-credentials.test.sh infra/tests/production-load-test-control-runtime.test.sh infra/tests/recovery-evidence-entry.test.sh infra/tests/recovery-evidence-main.test.sh infra/tests/release-production.test.sh infra/tests/rollback-production.test.sh infra/tests/runner-firewall.test.sh infra/tests/runner-firewall-packets.test.sh infra/tests/runner-guest-installer.test.sh infra/tests/runner-vm-provision.test.sh infra/tests/smoke-production.test.sh",
  "shellcheck --severity=warning infra/tests/ingress-control-linux.test.sh",
  "shellcheck --severity=warning infra/ops/start-production-stack.sh infra/ops/recover-production-ingress.sh infra/tests/start-production-stack.test.sh infra/tests/start-production-stack-adversarial.test.sh infra/tests/ingress-recovery.test.sh",
  "shellcheck --severity=warning --exclude=SC2034 infra/ops/check-recovery.sh",
  "shellcheck --severity=warning --exclude=SC2128,SC2174,SC2178 infra/tests/power-recovery-check.test.sh",
  "bash -n scripts/backup/*.sh infra/docker/entrypoint.sh infra/ops/*.sh infra/runner/*.sh infra/tests/*.sh",
  "python3 infra/tests/runner-release-tree.test.py",
  "python3 infra/tests/release-tree-packaging.test.py",
  "python3 infra/tests/existing-container-baseline.test.py",
  "python3 infra/tests/capture-existing-containers.test.py",
  "sudo python3 infra/tests/capture-existing-containers-linux.test.py",
  "python3 infra/tests/test_production_load_browser_journey.py",
  "python3 infra/tests/test_production_load_control.py",
  "python3 infra/tests/test_production_load_peer_credentials.py",
  "sudo -n bash infra/tests/ingress-control-linux.test.sh",
  "sudo -n bash infra/tests/start-production-stack.test.sh",
  "sudo -n bash infra/tests/start-production-stack-adversarial.test.sh",
  "sudo -n bash infra/tests/ingress-recovery.test.sh",
  "bash infra/tests/runner-vm-provision.test.sh",
  "sudo bash infra/tests/runner-guest-installer.test.sh",
  "sudo bash infra/tests/runner-firewall.test.sh",
  "sudo bash infra/tests/runner-firewall-packets.test.sh",
  "python3 infra/tests/recovery-evidence-helper.test.py",
  "python3 infra/tests/recovery-evidence-provenance.test.py",
  "python3 infra/tests/recovery-evidence-storage-health.test.py",
  "python3 infra/tests/recovery-evidence-atomic.test.py",
  "python3 infra/tests/recovery-evidence-collection.test.py",
  "sudo bash infra/tests/power-evidence.test.sh",
  "sudo bash infra/tests/power-recovery-check.test.sh",
  "sudo bash infra/tests/systemd-recovery.test.sh",
  "bash infra/ops/install-compose-ci.sh",
  "bash infra/tests/smoke-production.test.sh",
  "bash infra/tests/release-production.test.sh",
  "bash infra/tests/rollback-production.test.sh",
  "REQUIRE_COMPOSE_MAJOR=5 bash infra/tests/compose-release-cli-contract.test.sh",
  "bash infra/tests/runner-reconciliation.test.sh",
  "bash infra/tests/runtime-validator-network-fixture.test.sh",
  "bash infra/tests/runtime-config.test.sh",
  "docker compose --env-file infra/env/compose.env.example config --quiet",
  "node infra/tests/validate-compose.mjs",
  "docker build --pull=false --tag learncoding-app:ci .",
  "docker build --pull=false --target regrade-worker --tag learncoding-regrade-worker:ci .",
];
const reviewedJobNames = [
  "application",
  "application-images",
  "production-topology",
  "backup-safety",
  "backup-production-e2e",
  "runner",
  "postgres-integration",
  "curriculum-runtime",
  "auth-browser",
  "browser",
];
const checkoutProjection = [
  "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
  "        with:",
  "          persist-credentials: false",
];
const setupNodeProjection = [
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  "        with:",
  "          node-version: 22.23.1",
  "          cache: npm",
];
const dockerSetupProjection = [
  "      - uses: docker/setup-docker-action@6d7cfa65f60a9dda7b46e5513fa982536f3c9877 # v5.3.0",
  "        with:",
  "          daemon-config: |",
  "            {",
  '              "features": {',
  '                "containerd-snapshotter": true',
  "              }",
  "            }",
];
const topologyDockerProjection = [
  "      - run: |",
  "          set -Eeuo pipefail",
  "          expected_endpoint=\u0027unix:///var/run/docker.sock\u0027",
  "          current_context=\"$(docker context show)\"",
  "          current_endpoint=\"$(docker context inspect --format \u0027{{.Endpoints.docker.Host}}\u0027 \"$current_context\")\"",
  "          effective_endpoint=\"${DOCKER_HOST:-$current_endpoint}\"",
  "          if [[ \"$current_endpoint\" != \"$expected_endpoint\" || \"$effective_endpoint\" != \"$expected_endpoint\" || ! -S /var/run/docker.sock ]]; then",
  "            echo \"The topology job requires the disposable host system Docker socket.\" \u003e\u00262",
  "            exit 1",
  "          fi",
  "          container_ids=\"$(docker ps -aq)\"",
  "          if [[ -n \"$container_ids\" ]]; then",
  "            echo \"The topology job refuses a host with pre-existing containers.\" \u003e\u00262",
  "            exit 1",
  "          fi",
  "          readonly docker_package_version=\u00275:29.6.1-1~ubuntu.24.04~noble\u0027",
  "          readonly docker_gpg_sha256=\u00271500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570\u0027",
  "          docker_gpg_key=\"$(mktemp)\"",
  "          trap \u0027rm -f -- \"$docker_gpg_key\"\u0027 EXIT",
  "          curl --fail --silent --show-error --location \\",
  "            https://download.docker.com/linux/ubuntu/gpg \\",
  "            --output \"$docker_gpg_key\"",
  "          printf \u0027%s  %s\\n\u0027 \"$docker_gpg_sha256\" \"$docker_gpg_key\" | sha256sum --check --status",
  "          . /etc/os-release",
  "          [[ \"$ID\" == ubuntu \u0026\u0026 \"$VERSION_CODENAME\" == noble ]] || {",
  "            echo \"The reviewed Docker package is pinned to Ubuntu 24.04 noble.\" \u003e\u00262",
  "            exit 1",
  "          }",
  "          sudo install -m 0755 -d /etc/apt/keyrings",
  "          sudo install -m 0644 \"$docker_gpg_key\" /etc/apt/keyrings/docker.asc",
  "          printf \u0027deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\\n\u0027 \\",
  "            \"$(dpkg --print-architecture)\" \"$VERSION_CODENAME\" \\",
  "            | sudo tee /etc/apt/sources.list.d/docker.list \u003e/dev/null",
  "          conflicting_packages=(",
  "            docker.io docker-doc docker-compose docker-compose-v2 podman-docker",
  "            containerd runc moby-engine moby-cli moby-buildx moby-compose",
  "          )",
  "          installed_conflicts=()",
  "          for package in \"${conflicting_packages[@]}\"; do",
  "            if dpkg-query -W -f=\u0027${db:Status-Abbrev}\u0027 \"$package\" 2\u003e/dev/null | grep -q \u0027^ii \u0027; then",
  "              installed_conflicts+=(\"$package\")",
  "            fi",
  "          done",
  "          if ((${#installed_conflicts[@]} \u003e 0)); then",
  "            sudo apt-get remove --yes \"${installed_conflicts[@]}\"",
  "          fi",
  "          sudo apt-get update",
  "          apt-cache madison docker-ce | awk \u0027{print $3}\u0027 | grep -Fx -- \"$docker_package_version\" \u003e/dev/null",
  "          apt-cache madison docker-ce-cli | awk \u0027{print $3}\u0027 | grep -Fx -- \"$docker_package_version\" \u003e/dev/null",
  "          sudo apt-get install --yes --no-install-recommends --allow-downgrades \\",
  "            docker-ce=$docker_package_version \\",
  "            docker-ce-cli=$docker_package_version \\",
  "            containerd.io \\",
  "            docker-buildx-plugin",
  "          sudo systemctl enable --now docker.service",
  "      - uses: docker/setup-compose-action@112d3e30db3bf437d207fea57f22510569d1ab97 # v2.0.0",
  "        with:",
  "          version: v5.3.1",
  "      - run: |",
  "          set -Eeuo pipefail",
  "          [[ \"$(docker version --format \u0027{{.Client.Version}}\u0027)\" == 29.6.1 ]]",
  "          [[ \"$(docker version --format \u0027{{.Server.Version}}\u0027)\" == 29.6.1 ]]",
  "          compose_version=\"$(docker compose version --short)\"",
  "          [[ \"${compose_version#v}\" == 5.3.1 ]]",
  "          current_context=\"$(docker context show)\"",
  "          current_endpoint=\"$(docker context inspect --format \u0027{{.Endpoints.docker.Host}}\u0027 \"$current_context\")\"",
  "          [[ \"$current_endpoint\" == unix:///var/run/docker.sock ]]",
  "          [[ \"${DOCKER_HOST:-$current_endpoint}\" == unix:///var/run/docker.sock ]]",
  "          [[ -S /var/run/docker.sock ]]",
  "          container_ids=\"$(docker ps -aq)\"",
  "          [[ -z \"$container_ids\" ]]",
];
const trivySetupProjection = [
  "      - uses: aquasecurity/setup-trivy@3fb12ec12f41e471780db15c232d5dd185dcb514 # v0.2.6",
  "        with:",
  "          version: 0.69.3",
  '      - run: trivy image --cache-dir "$RUNTIME_TRIVY_CACHE_DIR" --download-db-only',
  '      - run: trivy image --cache-dir "$RUNTIME_TRIVY_CACHE_DIR" --download-java-db-only',
];
function runtimeEvidenceUploadProjection(artifactName) {
  return [
    "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
    "        if: always()",
    "        with:",
    `          name: ${artifactName}`,
    "          path: |",
    "            services/runner/dist/runtime-inspection.json",
    "            services/runner/dist/runtime-images.env",
    "            services/runner/dist/runtime-images.json",
    "            services/runner/dist/runtime-security/**",
    "            services/runner/dist/.runtime-security.failed-*/**",
    "          if-no-files-found: warn",
    "          include-hidden-files: true",
    "          retention-days: 14",
  ];
}
const reviewedJobContracts = new Map([
  [
    "application",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 70",
      "    steps:",
      ...checkoutProjection,
      ...setupNodeProjection,
      ...expectedApplicationRuns.map((command) => `      - run: ${command}`),
    ],
  ],
  [
    "production-topology",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 45",
      "    env:",
      '      RUNNER_ENVIRONMENT: ${{ runner.environment }}',
      '      CODESTEAD_DISPOSABLE_DOCKER_DAEMON: "1"',
      '      CODESTEAD_TOPOLOGY_RESTART_DOCKER: "1"',
      "    steps:",
      ...checkoutProjection,
      ...topologyDockerProjection,
      "      - run: node infra/tests/production-topology-ci-registration.test.mjs",
      "      - run: |",
      "          bash -n infra/tests/production-topology.test.sh infra/tests/production-topology-early-cleanup.test.sh",
      "          bash infra/tests/production-topology-early-cleanup.test.sh",
      "          docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \\",
      '            --volume "$GITHUB_WORKSPACE:/repo:ro" \\',
      "            koalaman/shellcheck@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d \\",
      "            --severity=warning /repo/infra/tests/production-topology.test.sh /repo/infra/tests/production-topology-early-cleanup.test.sh",
      "      - run: CODESTEAD_DISPOSABLE_HOST=1 bash infra/tests/production-topology.test.sh",
    ],
  ],
  [
    "backup-safety",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 60",
      "    steps:",
      ...checkoutProjection,
      ...setupNodeProjection,
      ...requiredBackupRuns.map((command) => `      - run: ${command}`),
    ],
  ],
  [
    "backup-production-e2e",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 30",
      "    steps:",
      ...checkoutProjection,
      `      - run: ${productionE2eRun}`,
    ],
  ],
  [
    "runner",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 35",
      "    env:",
      "      RUNTIME_TRIVY_CACHE_DIR: ${{ runner.temp }}/trivy-cache",
      "      RUNTIME_LOCAL_RISK_ACCEPTANCE: accept-unsigned-local-buildkit-provenance-v1",
      "      RUNTIME_SOURCE_REPOSITORY: ${{ github.server_url }}/${{ github.repository }}",
      "      RUNTIME_SOURCE_REVISION: ${{ github.sha }}",
      "    defaults:",
      "      run:",
      "        working-directory: services/runner",
      "    steps:",
      ...checkoutProjection,
      "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      "        with:",
      "          node-version: 22.23.1",
      "          cache: npm",
      "          cache-dependency-path: services/runner/package-lock.json",
      "      - run: npm ci",
      "      - run: npm run typecheck",
      "      - run: npm test",
      "      - run: npm run build",
      ...dockerSetupProjection,
      "      - run: npm run runtime:build",
      "      - run: npm run runtime:inspect",
      "      - run: npm run runtime:test",
      ...trivySetupProjection,
      "      - run: npm run runtime:scan",
      "      - run: npm run runtime:record",
      "      - run: npm audit --audit-level=high",
      ...runtimeEvidenceUploadProjection("runner-runtime-release-evidence"),
    ],
  ],
  [
    "postgres-integration",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 20",
      "    steps:",
      ...checkoutProjection,
      ...setupNodeProjection,
      "      - run: npm ci",
      "      - run: npm run test:integration",
      "      - run: docker pull postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
      "      - run: docker pull node:22.23.1-alpine3.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737",
      "      - run: CODESTEAD_DISPOSABLE_HOST=1 bash infra/tests/database-least-privilege-integration.sh",
    ],
  ],
  [
    "curriculum-runtime",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 45",
      "    env:",
      "      RUNTIME_TRIVY_CACHE_DIR: ${{ runner.temp }}/trivy-cache",
      "      RUNTIME_LOCAL_RISK_ACCEPTANCE: accept-unsigned-local-buildkit-provenance-v1",
      "      RUNTIME_SOURCE_REPOSITORY: ${{ github.server_url }}/${{ github.repository }}",
      "      RUNTIME_SOURCE_REVISION: ${{ github.sha }}",
      "    steps:",
      ...checkoutProjection,
      ...setupNodeProjection,
      "      - run: npm ci",
      "      - run: npm ci",
      "        working-directory: services/runner",
      ...dockerSetupProjection,
      "      - run: npm run runtime:build",
      "        working-directory: services/runner",
      "      - run: npm run runtime:inspect",
      "        working-directory: services/runner",
      "      - run: npm run runtime:test",
      "        working-directory: services/runner",
      ...trivySetupProjection,
      "      - run: npm run runtime:scan",
      "        working-directory: services/runner",
      "      - run: npm run runtime:record",
      "        working-directory: services/runner",
      "      - run: npm run curriculum:runtime-pins:check",
      "      - run: npx playwright install --with-deps chromium",
      "      - run: npm run dsa:parity:verify",
      "      - run: npm run c-cpp:executable:verify",
      "      - run: npm run java-python:executable:verify",
      "      - run: npm run ai-code:executable:verify",
      "      - run: npm run web:executable:verify",
      ...runtimeEvidenceUploadProjection("curriculum-runtime-release-evidence"),
    ],
  ],
  [
    "auth-browser",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 30",
      "    steps:",
      ...checkoutProjection,
      ...setupNodeProjection,
      "      - run: npm ci",
      "      - run: npx playwright install --with-deps chromium firefox webkit",
      "      - run: npm run test:browser:auth",
    ],
  ],
  [
    "browser",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 25",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        include:",
      "          - project: chromium",
      "            browser: chromium",
      "          - project: firefox",
      "            browser: firefox",
      "          - project: webkit",
      "            browser: webkit",
      "          - project: tablet-safari",
      "            browser: webkit",
      "          - project: small-mobile",
      "            browser: webkit",
      "          - project: mobile-safari",
      "            browser: webkit",
      "    steps:",
      ...checkoutProjection,
      ...setupNodeProjection,
      "      - run: npm ci",
      "      - run: npx playwright install --with-deps ${{ matrix.browser }}",
      "      - run: npm run sync:monaco",
      "      - run: npm run test:e2e -- --project=${{ matrix.project }}",
    ],
  ],
]);

function canonicalJobBlocks(lines) {
  const topLevel = lines.filter((line) => /^[^\s#]/.test(line));
  const expectedTopLevel = ["name: CI", "on:", "permissions:", "jobs:"];
  if (topLevel.join("\n") !== expectedTopLevel.join("\n")) {
    fail("workflow top-level mapping is not the strict canonical contract");
  }
  const jobsStarts = lines
    .map((line, index) => (line === "jobs:" ? index : -1))
    .filter((index) => index >= 0);
  if (jobsStarts.length !== 1) {
    fail(`expected exactly one canonical jobs mapping, found ${jobsStarts.length}`);
  }
  const jobsStart = jobsStarts[0];
  const jobsEnd = lines.length - 1;
  const headers = [];
  for (let index = jobsStart + 1; index < jobsEnd; index += 1) {
    const line = lines[index];
    if (/^  #/.test(line) || !/^  \S/.test(line)) {
      continue;
    }
    const match = /^  ([a-zA-Z0-9_-]+):$/.exec(line);
    if (match === null) {
      fail(`non-canonical job key at workflow line ${index + 1}`);
    }
    headers.push({ name: match[1], index });
  }
  const names = headers.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    fail("workflow contains a duplicate job key");
  }
  return new Map(
    headers.map(({ name, index }, position) => [
      name,
      lines.slice(index, headers[position + 1]?.index ?? jobsEnd),
    ]),
  );
}

function behavioralJobProjection(block, name) {
  const projection = [];
  let namedStep = false;
  for (const line of block.slice(1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) {
      continue;
    }
    if (/^      - name:\s+\S/.test(line)) {
      if (namedStep) {
        fail(`${name} contains nested named workflow steps`);
      }
      namedStep = true;
      continue;
    }
    if (namedStep) {
      const implementation = /^        (uses|run):\s*(.+?)\s*$/.exec(line);
      if (implementation === null) {
        fail(`${name} named workflow step has no direct implementation`);
      }
      projection.push(`      - ${implementation[1]}: ${implementation[2]}`);
      namedStep = false;
      continue;
    }
    projection.push(line);
  }
  if (namedStep) {
    fail(`${name} ends with an incomplete named workflow step`);
  }
  return projection;
}

function requireReviewedExecutableContracts(blocks) {
  for (const [name, expected] of reviewedJobContracts) {
    const actual = behavioralJobProjection(requireJob(blocks, name), name);
    if (actual.join("\n") !== expected.join("\n")) {
      fail(`${name} executable contract changed`);
    }
  }
}

function requireCanonicalWorkflowPreamble(lines) {
  const jobsIndex = lines.indexOf("jobs:");
  const expected = [
    "name: CI",
    "on:",
    "  push:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
  ];
  const projection = lines
    .slice(0, jobsIndex + 1)
    .filter((line) => line.trim() !== "" && !/^\s*#/.test(line));
  if (
    jobsIndex < 0 ||
    projection.join("\n") !== expected.join("\n")
  ) {
    fail("workflow triggers and permissions are not the strict blocking contract");
  }
}

function requireJob(blocks, name) {
  const block = blocks.get(name);
  if (block === undefined) {
    fail(`expected exactly one ${name} job, found 0`);
  }
  return block;
}

function validateWorkflow(document) {
  if (
    document.startsWith("\uFEFF") ||
    document.includes("\0") ||
    document.includes("\t")
  ) {
    fail("workflow must be BOM-free, NUL-free, and indentation-tab-free");
  }
  if (!document.endsWith("\n")) {
    fail("workflow must end with a newline");
  }
  const normalized = normalizeWorkflow(document);
  const lines = normalized.split("\n");
  requireCanonicalWorkflowPreamble(lines);
  const blocks = canonicalJobBlocks(lines);
  const actualJobNames = [...blocks.keys()].sort();
  const expectedJobNames = [...reviewedJobNames].sort();
  if (actualJobNames.join("\n") !== expectedJobNames.join("\n")) {
    fail("workflow job set is outside the reviewed executable allowlist");
  }
  requireReviewedExecutableContracts(blocks);
  const backup = requireJob(blocks, "backup-safety");

  if (
    !backup.some((line) =>
      /complete unfiltered backup publication suite/i.test(line),
    )
  ) {
    fail("backup-safety timeout must document the complete unfiltered publication suite");
  }
}

function replaceExactly(document, needle, replacement) {
  const pieces = document.split(needle);
  if (pieces.length !== 2) {
    throw new Error(`self-test fixture expected exactly one ${JSON.stringify(needle)}`);
  }
  return `${pieces[0]}${replacement}${pieces[1]}`;
}

function replaceHarnessFunctionFragment(source, functionName, needle, replacement) {
  const body = harnessFunction(
    source,
    functionName,
    `self-test fixture could not find ${functionName}`,
  );
  const replacementBody = replaceExactly(body, needle, replacement);
  return replaceExactly(source, body, replacementBody);
}

function expectRejected(label, document) {
  try {
    validateWorkflow(document);
  } catch (error) {
    if (error instanceof RegistrationError) {
      return;
    }
    throw error;
  }
  throw new Error(`backup CI registration self-test accepted ${label}`);
}

function expectRejectedWithMessage(label, document, expectedMessage) {
  try {
    validateWorkflow(document);
  } catch (error) {
    if (
      error instanceof RegistrationError &&
      error.message.includes(expectedMessage)
    ) {
      return;
    }
    if (error instanceof RegistrationError) {
      throw new Error(
        `backup CI registration self-test rejected ${label} for the wrong reason: ${error.message}`,
      );
    }
    throw error;
  }
  throw new Error(`backup CI registration self-test accepted ${label}`);
}

function expectAccepted(label, document) {
  try {
    validateWorkflow(document);
  } catch (error) {
    if (error instanceof RegistrationError) {
      throw new Error(
        `backup CI registration self-test rejected harmless ${label}: ${error.message}`,
      );
    }
    throw error;
  }
}

function expectHarnessRejected(label, source, validator) {
  try {
    validator(source);
  } catch (error) {
    if (error instanceof RegistrationError) {
      return;
    }
    throw error;
  }
  throw new Error(`backup CI registration self-test accepted harness ${label}`);
}

function runHarnessAdversarialSelfTests(source) {
  for (const [label, needle, replacement] of [
    ["long ephemeral root", 'local stage_root="$test_root/staging" ephemeral_root="/run/bpe"', 'local stage_root="$test_root/staging" ephemeral_root="$test_root/ephemeral"'],
    ["ephemeral tmpfs backing", "--tmpfs /run/bpe:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=0,gid=0", "--tmpfs /run/bpe:rw,noexec,nosuid,nodev,size=16m,mode=0755,uid=0,gid=0"],
    ["AF_UNIX exact length", '${#endpoint_probe} == 78 && ${#endpoint_probe} < 108', '${#endpoint_probe} < 108'],
    ["ephemeral root ownership", '"$(stat -c \'%a:%u\' -- "$root")" == 700:0', '"$(stat -c \'%a\' -- "$root")" == 700'],
    ["ephemeral residue check", '[[ -z "$(find -P "$root" -mindepth 1 -print -quit)" ]]', "true"],
  ]) {
    expectHarnessRejected(
      label,
      replaceExactly(source, needle, replacement),
      validateHarnessEphemeralRuntimeContract,
    );
  }
  expectHarnessRejected(
    "self-hosted outer marker",
    replaceExactly(
      source,
      '\n  && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \\',
      '\n  && "${RUNNER_ENVIRONMENT:-}" == self-hosted ]] \\',
    ),
    validateHarnessHostedRunnerContract,
  );
  expectHarnessRejected(
    "missing inner hosted-runner marker",
    replaceExactly(
      source,
      '    && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \\\n',
      "",
    ),
    validateHarnessHostedRunnerContract,
  );
  expectHarnessRejected(
    "mutable registry execution",
    replaceExactly(
      source,
      '  "$registry_digest")" || fail "loopback registry did not start"',
      '  registry:2)" || fail "loopback registry did not start"',
    ),
    validateHarnessRegistryContract,
  );
  expectHarnessRejected(
    "unverified registry runtime image",
    replaceExactly(
      source,
      '  && "$runtime_image" == "$registry_image_id" \\\n',
      "",
    ),
    validateHarnessRegistryContract,
  );
  for (const [label, needle, replacement] of [
    [
      "credential-probe command path",
      "/app/scripts/backup/create-credential-probe.ts",
      "/app/scripts/backup/other.ts",
    ],
    [
      "credential-probe owner label",
      '"$owner_label" == "${run_id:-}"',
      '"$owner_label" != ""',
    ],
    [
      "credential-probe Compose exclusion",
      '"$compose_project" == "" && "$compose_working_dir" == ""',
      '"$compose_project" == "$PRODUCTION_COMPOSE_PROJECT"',
    ],
    [
      "credential-probe secret bind",
      '"$mount_source" == "$test_root/config/secrets/credential_master_key"',
      '"$mount_source" != ""',
    ],
    [
      "credential-probe output boundary",
      "^([0-9]{8}T[0-9]{6}Z)[.][A-Za-z0-9]{6}/probe-output$",
      "probe-output$",
    ],
    [
      "credential-probe mount cardinality",
      '"$credential_mount_count" == 1 && "$output_mount_count" == 1',
      '"$credential_mount_count" -ge 1',
    ],
    [
      "credential-probe temporal snapshot",
      'docker ps --all --quiet --no-trunc | sort >"$pre_backup_container_ids"',
      ': >"$pre_backup_container_ids"',
    ],
    [
      "credential-probe image-bounded discovery",
      'append_docker_query_lines probe_candidates docker ps --all --quiet --no-trunc \\\n    --filter "ancestor=$operations_digest"',
      'append_docker_query_lines probe_candidates docker ps --all --quiet --no-trunc \\\n    --filter status=running',
    ],
    [
      "credential-probe validated removal route",
      'elif credential_probe_container_is_owned "$id"; then',
      'elif [[ "$name" != "" ]]; then',
    ],
  ]) {
    expectHarnessRejected(
      label,
      replaceExactly(source, needle, replacement),
      validateHarnessCredentialProbeCleanupContract,
    );
  }
  expectHarnessRejected(
    "credential-probe post-toolbox rescan",
    replaceExactly(
      source,
      "remove_owned_credential_probe_containers || cleanup_failed=1",
      ": # credential-probe rescan disabled",
    ),
    validateHarnessCredentialProbeCleanupContract,
  );
  for (const [label, functionName, needle, replacement] of [
    [
      "cleanup final Docker availability",
      "cleanup_test",
      "if ! docker info >/dev/null 2>&1; then\n    cleanup_failed=1\n  else",
      "if false; then\n    cleanup_failed=1\n  else",
    ],
    [
      "cleanup container query status",
      "cleanup_test",
      'append_docker_query_lines candidates docker ps --all --quiet --no-trunc \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id"',
      'append_docker_query_lines candidates docker_missing ps --all --quiet --no-trunc \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id"',
    ],
    [
      "cleanup confirmed container absence",
      "cleanup_test",
      'if ! docker inspect "$id" >/dev/null 2>&1; then\n      docker_object_is_confirmed_absent container "$id" || cleanup_failed=1\n      continue\n    fi',
      'if ! docker inspect "$id" >/dev/null 2>&1; then\n      continue\n    fi',
    ],
    [
      "cleanup final residue status",
      "cleanup_test",
      'docker_query_is_empty docker ps -aq \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id"',
      '[[ -z "$(docker ps -aq --filter "label=$OWNER_LABEL_KEY=$run_id")" ]]',
    ],
    [
      "Docker query collector failure",
      "append_docker_query_lines",
      'output="$("$@")" || return 1',
      'output="$("$@")" || return 0',
    ],
    [
      "final residue query failure",
      "docker_query_is_empty",
      'output="$("$@")" || return 1',
      'output="$("$@")" || return 0',
    ],
    [
      "image ID absence comparison",
      "docker_object_is_confirmed_absent",
      '"$image_id" != "$object_id"',
      "true",
    ],
    [
      "image tag absence comparison",
      "docker_object_is_confirmed_absent",
      '"$repository:$tag" == "$object_id"',
      "true",
    ],
    [
      "image RepoDigest absence comparison",
      "docker_object_is_confirmed_absent",
      '"$repository@$digest" == "$object_id"',
      "true",
    ],
    [
      "credential-probe removal confirmation",
      "remove_owned_credential_probe_containers",
      'docker_object_is_confirmed_absent container "$id" || removal_failed=1',
      'docker inspect "$id" >/dev/null 2>&1 || :',
    ],
    [
      "credential-probe cleanup removal confirmation",
      "cleanup_test",
      'if ! docker rm --force "$id" >/dev/null 2>&1; then\n        docker_object_is_confirmed_absent container "$id" || cleanup_failed=1\n      fi',
      'docker rm --force "$id" >/dev/null 2>&1 || :',
    ],
    [
      "network final residue query",
      "cleanup_test",
      'docker_query_is_empty docker network ls -q --no-trunc \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1',
      ": # owner-label network residue query disabled",
    ],
    [
      "volume final residue query",
      "cleanup_test",
      'docker_query_is_empty docker volume ls -q \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1',
      ": # owner-label volume residue query disabled",
    ],
    [
      "image final residue query",
      "cleanup_test",
      'docker_query_is_empty docker image ls -aq \\\n      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1',
      ": # owner-label image residue query disabled",
    ],
  ]) {
    expectHarnessRejected(
      label,
      replaceHarnessFunctionFragment(source, functionName, needle, replacement),
      validateHarnessCleanupEvidenceContract,
    );
  }
  expectHarnessRejected(
    "cleanup Docker-loss proof execution",
    replaceExactly(
      source,
      'assert_cleanup_rejects_docker_loss "$runner_temp"',
      ": # Docker-loss cleanup proof disabled",
    ),
    validateHarnessCleanupEvidenceContract,
  );
}

function withBackupJobLine(document, line) {
  const anchor =
    "  backup-safety:\n    # 60 minutes covers the complete unfiltered backup publication suite and adjacent gates.\n";
  return replaceExactly(document, anchor, `${anchor}${line}\n`);
}

function withBackupStepProperty(document, property) {
  const anchor = `      - run: ${registrationRun}\n`;
  return replaceExactly(document, anchor, `${anchor}        ${property}\n`);
}

function withApplicationRun(document, command) {
  const anchor = "      - run: bash infra/tests/runner-reconciliation.test.sh\n";
  return replaceExactly(document, anchor, `      - run: ${command}\n${anchor}`);
}

function withRunnerRun(document, command) {
  const anchor =
    "      - run: npm run runtime:build\n      - run: npm run runtime:inspect\n";
  return replaceExactly(
    document,
    anchor,
    `      - run: npm run runtime:build\n      - run: ${command}\n      - run: npm run runtime:inspect\n`,
  );
}

function withProductionE2eJobLine(document, line) {
  const anchor = "  backup-production-e2e:\n";
  return replaceExactly(document, anchor, `${anchor}${line}\n`);
}

function withProductionE2eStepProperty(document, property) {
  const anchor = `      - run: ${productionE2eRun}\n`;
  return replaceExactly(document, anchor, `${anchor}        ${property}\n`);
}

function runAdversarialSelfTests(document) {
  const harmlessPresentation = replaceExactly(
    replaceExactly(
      replaceExactly(
        replaceExactly(
          document,
          "      - run: npm run build\n      - name: Set up Docker with containerd image store\n",
          "      - run: npm run build\n      - name: Prepare isolated runtime engine\n",
        ),
        "      - run: npm run lint\n",
        "      - name: Lint application\n        run: npm run lint\n",
      ),
      "  backup-production-e2e:\n",
      "  backup-production-e2e:\n    # This comment does not change gate execution.\n",
    ),
    "  runner:\n",
    "  runner:\n    # Human-readable comments do not change executable behavior.\n",
  );
  expectAccepted(
    "workflow comments and step-name edits",
    harmlessPresentation,
  );
  expectRejected(
    "manual-only workflow trigger",
    replaceExactly(
      document,
      "on:\n  push:\n  pull_request:\n",
      "on:\n  workflow_dispatch:\n",
    ),
  );
  expectRejected(
    "path-filtered workflow trigger",
    replaceExactly(
      document,
      "  pull_request:\n",
      "  pull_request:\n    paths:\n      - docs/**\n",
    ),
  );
  expectRejected(
    "write-capable workflow permissions",
    replaceExactly(document, "  contents: read\n", "  contents: write\n"),
  );

  for (const jobName of [
    "postgres-integration",
    "curriculum-runtime",
    "browser",
    "production-topology",
  ]) {
    for (const line of [
      "    needs: application",
      "    if: always()",
      "    continue-on-error: true",
    ]) {
      expectRejectedWithMessage(
        `${jobName} skip control ${line}`,
        replaceExactly(
          document,
          `  ${jobName}:\n`,
          `  ${jobName}:\n${line}\n`,
        ),
        `${jobName} executable contract changed`,
      );
    }
  }

  for (const line of [
    "    needs: application",
    "    if: true",
    "    continue-on-error: false",
    "    strategy:",
    "      matrix:",
    "        shard: [1]",
    "    services: {}",
    "    env: {}",
    "    defaults: {}",
    "    container: alpine:latest",
  ]) {
    expectRejected(
      `production e2e job control ${line}`,
      withProductionE2eJobLine(document, line),
    );
  }
  for (const property of [
    "if: true",
    "continue-on-error: false",
    "env: {}",
    "timeout-minutes: 29",
    "working-directory: .",
  ]) {
    expectRejected(
      `production e2e step control ${property}`,
      withProductionE2eStepProperty(document, property),
    );
  }

  expectRejected(
    "quoted production e2e job key",
    replaceExactly(
      document,
      "  backup-production-e2e:\n",
      '  "backup-production-e2e":\n',
    ),
  );
  expectRejected(
    "anchored production e2e job key",
    replaceExactly(
      document,
      "  backup-production-e2e:\n",
      "  backup-production-e2e: &production-gate\n",
    ),
  );
  expectRejected(
    "aliased production e2e steps",
    replaceExactly(
      document,
      "  backup-production-e2e:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps:\n",
      "  backup-production-e2e:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps: *production-steps\n",
    ),
  );
  expectRejected(
    "duplicate production e2e job key",
    `${document}  backup-production-e2e:\n    runs-on: windows-latest\n`,
  );
  expectRejected(
    "changed production e2e runner",
    replaceExactly(
      document,
      "  backup-production-e2e:\n    runs-on: ubuntu-24.04\n",
      "  backup-production-e2e:\n    runs-on: ubuntu-latest\n",
    ),
  );
  expectRejected(
    "changed production e2e timeout",
    replaceExactly(
      document,
      "  backup-production-e2e:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n",
      "  backup-production-e2e:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 31\n",
    ),
  );

  const productionStep = `      - run: ${productionE2eRun}`;
  const checkoutStep = "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0";
  const productionCheckout =
    `${checkoutStep}\n        with:\n          persist-credentials: false`;
  const productionStepsAnchor =
    "  backup-production-e2e:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps:\n";
  expectRejected(
    "missing production e2e run",
    replaceExactly(document, `${productionStep}\n`, ""),
  );
  expectRejected(
    "duplicate production e2e run",
    replaceExactly(document, productionStep, `${productionStep}\n${productionStep}`),
  );
  expectRejected(
    "reordered production e2e steps",
    replaceExactly(
      document,
      `${productionStepsAnchor}${productionCheckout}\n${productionStep}`,
      `${productionStepsAnchor}${productionStep}\n${productionCheckout}`,
    ),
  );
  expectRejected(
    "quoted production e2e command",
    replaceExactly(document, productionStep, `      - run: '${productionE2eRun}'`),
  );
  expectRejected(
    "wrapped production e2e command",
    replaceExactly(
      document,
      productionStep,
      `      - run: bash -c '${productionE2eRun}'`,
    ),
  );
  expectRejected(
    "production e2e checkout credentials persistence enabled",
    replaceExactly(
      document,
      `${productionCheckout}\n${productionStep}`,
      `${checkoutStep}\n        with:\n          persist-credentials: true\n${productionStep}`,
    ),
  );
  expectRejected(
    "production e2e checkout credentials setting missing",
    replaceExactly(
      document,
      `${productionCheckout}\n${productionStep}`,
      `${checkoutStep}\n${productionStep}`,
    ),
  );
  expectRejected(
    "production e2e checkout extra properties",
    replaceExactly(
      document,
      `${productionCheckout}\n${productionStep}`,
      `${productionCheckout}\n          fetch-depth: 0\n${productionStep}`,
    ),
  );
  for (const indicator of ["|", "|-", "|+", ">", ">-", ">+"]) {
    expectRejected(
      `production e2e ${indicator} block scalar`,
      replaceExactly(
        document,
        productionStep,
        `      - run: ${indicator}\n          ${productionE2eRun}`,
      ),
    );
  }
  expectAccepted(
    "comment mentioning the production e2e command",
    `${document}# Documentation example: ${productionE2eRun}\n`,
  );
  expectRejected(
    "production e2e acknowledgement in another job",
    replaceExactly(
      document,
      "  runner:\n",
      "  runner:\n    env:\n      CODESTEAD_DISPOSABLE_HOST: 1\n",
    ),
  );
  const reviewerSplitCarrier = [
    "  reviewer-split:",
    "    runs-on: self-hosted",
    "    steps:",
    '      - run: p=infra/tests/; s=backup-production-e2e.test.sh; k=CODESTEAD_DISPOSABLE; env "${k}_HOST=1" bash "$p$s"',
    "",
  ].join("\n");
  expectRejectedWithMessage(
    "reviewer split self-hosted carrier",
    replaceExactly(document, "  runner:\n", `${reviewerSplitCarrier}  runner:\n`),
    "workflow job set is outside the reviewed executable allowlist",
  );
  expectRejectedWithMessage(
    "fully fragmented carrier in reviewed runner job",
    withRunnerRun(
      document,
      'p=infra/tests/; s=backup-production-; e=e2e.test.sh; k=CODESTEAD_; d=DISPOSABLE; env "${k}${d}_HOST=1" bash "$p$s$e"',
    ),
    "runner executable contract changed",
  );
  expectRejectedWithMessage(
    "self-hosted postgres integration runner",
    replaceExactly(
      document,
      "  postgres-integration:\n    runs-on: ubuntu-24.04\n",
      "  postgres-integration:\n    runs-on: self-hosted\n",
    ),
    "postgres-integration executable contract changed",
  );
  expectRejectedWithMessage(
    "extra curriculum runtime command",
    replaceExactly(
      document,
      "      - run: npm run runtime:inspect\n        working-directory: services/runner\n",
      "      - run: npm run runtime:inspect\n        working-directory: services/runner\n      - run: echo unreviewed\n",
    ),
    "curriculum-runtime executable contract changed",
  );
  expectRejectedWithMessage(
    "browser step environment",
    replaceExactly(
      document,
      "      - run: npm run test:e2e -- --project=${{ matrix.project }}\n",
      "      - run: npm run test:e2e -- --project=${{ matrix.project }}\n        env:\n          CODESTEAD_DISPOSABLE_HOST: 1\n",
    ),
    "browser executable contract changed",
  );
  for (const command of [
    "bash infra/tests/backup-production-e2e.test.sh",
    "command bash infra/tests/backup-production-e2e.test.sh",
    "source infra/tests/backup-production-e2e.test.sh",
    'gate=infra/tests/backup-production-e2e.test.sh; bash "$gate"',
    "bash infra/tests/backup-production-*.test.sh",
    "bash infra/tests/backup-*.test.sh",
    "bash infra/tests/*.sh",
  ]) {
    expectRejected(
      `production e2e hidden carrier ${command}`,
      withRunnerRun(document, command),
    );
  }
  for (const indicator of ["|", "|-", "|+", ">", ">-", ">+"]) {
    expectRejected(
      `production e2e hidden ${indicator} run carrier`,
      withRunnerRun(
        document,
        `${indicator} # must be rejected\n          bash infra/tests/backup-*.test.sh`,
      ),
    );
  }
  expectRejected(
    "mixed LF and CRLF production workflow",
    replaceExactly(document, "name: CI\n", "name: CI\r\n"),
  );
  expectRejected(
    "bare carriage return production workflow",
    replaceExactly(document, "name: CI\n", "name: CI\r"),
  );

  for (const line of [
    "    if: false",
    '    "if": false',
    "    needs: application",
    '    "needs": application',
    "    <<: *skip-backup",
    "    runs-on: ubuntu-24.04",
  ]) {
    expectRejected(`backup job control ${line}`, withBackupJobLine(document, line));
  }
  for (const property of [
    "if: false",
    '"if": false',
    "continue-on-error: true",
    '"continue-on-error": true',
  ]) {
    expectRejected(
      `backup step control ${property}`,
      withBackupStepProperty(document, property),
    );
  }
  for (const fixture of rootRequiredFixtures) {
    const reviewedRun = `      - run: ${rootFixtureRun(fixture)}`;
    expectRejected(
      `unprivileged root-required fixture ${fixture}`,
      replaceExactly(document, reviewedRun, `      - run: bash ${fixture}`),
    );
    expectRejected(
      `sudo fixture without environment reset ${fixture}`,
      replaceExactly(document, reviewedRun, `      - run: sudo bash ${fixture}`),
    );
    expectRejected(
      `sudo fixture preserving caller environment ${fixture}`,
      replaceExactly(
        document,
        reviewedRun,
        `      - run: sudo -E bash ${fixture}`,
      ),
    );
    expectRejected(
      `sudo fixture with inherited PATH ${fixture}`,
      replaceExactly(
        document,
        reviewedRun,
        `      - run: sudo env -i "PATH=$PATH" HOME=/root LC_ALL=C bash ${fixture}`,
      ),
    );
    expectRejected(
      `sudo fixture with extra environment ${fixture}`,
      replaceExactly(
        document,
        reviewedRun,
        `      - run: ${rootFixtureRun(fixture)} UNREVIEWED=1`,
      ),
    );
  }

  const syntaxStep = `      - run: ${shellSyntaxRun}`;
  expectRejected(
    "quoted carrier job",
    replaceExactly(
      document,
      syntaxStep,
      `  "carrier":\n    if: false\n    steps:\n${syntaxStep}`,
    ),
  );

  for (const indicator of ["|", "|-", "|+", ">", ">-", ">+"]) {
    const registrationStep = `      - run: ${registrationRun}`;
    expectRejected(
      `backup ${indicator} block scalar`,
      replaceExactly(
        document,
        registrationStep,
        `      - run: ${indicator} # must be rejected\n          echo bypass\n${registrationStep}`,
      ),
    );
  }

  for (const command of [
    "bash infra/tests/backup-*.test.sh",
    'BACKUP_GATE=infra/tests/backup-retention.test.sh; bash "$BACKUP_GATE"',
    'for gate in infra/tests/backup-*.test.sh; do bash "$gate"; done',
    "bash -c 'bash infra/tests/backup-retention.test.sh'",
    "source infra/tests/backup-retention.test.sh",
    "alias backup_gate='bash infra/tests/backup-retention.test.sh'",
  ]) {
    expectRejected(
      `application backup wrapper ${command}`,
      withApplicationRun(document, command),
    );
  }
  expectRejected(
    "application multiline backup wrapper",
    withApplicationRun(
      document,
      "| # must be rejected\n          bash infra/tests/backup-retention.test.sh",
    ),
  );

  for (const duplicate of [
    '"jobs":\n  backup-safety:\n    runs-on: windows-latest\n',
    "jobs :\n  backup-safety:\n    runs-on: windows-latest\n",
    "jobs:\n  backup-safety:\n    runs-on: windows-latest\n",
    "jobs: &replacement\n  backup-safety:\n    runs-on: windows-latest\n",
    "!str jobs:\n  backup-safety:\n    runs-on: windows-latest\n",
    "<<: *replacement\n",
    "? jobs\n: replacement\n",
  ]) {
    expectRejected(`duplicate top-level mapping ${duplicate}`, `${document}${duplicate}`);
  }
  expectRejected(
    "anchored canonical jobs mapping",
    replaceExactly(document, "jobs:\n", "jobs: &replacement\n"),
  );
}

function verifyRegistration(document) {
  const normalized = normalizeWorkflow(document);
  validateWorkflow(normalized);
  runAdversarialSelfTests(normalized);
}

verifyRegistration(workflow);
verifyRegistration(
  normalizeWorkflow(workflow).replaceAll("\n", "\r\n"),
);
validateHarnessHostedRunnerContract(productionE2eHarness);
validateHarnessRegistryContract(productionE2eHarness);
validateHarnessCredentialProbeCleanupContract(productionE2eHarness);
validateHarnessCleanupEvidenceContract(productionE2eHarness);
validateHarnessEphemeralRuntimeContract(productionE2eHarness);
validateHarnessRestoreEntrypointContract(productionE2eHarness);
runHarnessAdversarialSelfTests(productionE2eHarness);

console.log("backup-ci-registration-tests-ok");
