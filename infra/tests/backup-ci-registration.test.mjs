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
const requiredBackupRuns = [
  registrationRun,
  shellSyntaxRun,
  pythonSyntaxRun,
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
];
const expectedApplicationRuns = [
  "npm ci",
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
  "npm run content:validate",
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
  "bash -n scripts/backup/*.sh infra/docker/entrypoint.sh infra/ops/*.sh infra/runner/*.sh infra/tests/*.sh",
  "bash infra/tests/runner-reconciliation.test.sh",
  "bash infra/tests/runtime-config.test.sh",
  "docker compose --env-file infra/env/compose.env.example config --quiet",
  "node infra/tests/validate-compose.mjs",
  "docker build --pull=false --tag learncoding-app:ci .",
  "docker build --pull=false --target regrade-worker --tag learncoding-regrade-worker:ci .",
];
const reviewedJobNames = [
  "application",
  "backup-safety",
  "backup-production-e2e",
  "runner",
  "postgres-integration",
  "curriculum-runtime",
  "browser",
];
const setupNodeProjection = [
  "      - uses: actions/setup-node@v7",
  "        with:",
  "          node-version: 22.23.1",
  "          cache: npm",
];
const dockerSetupProjection = [
  "      - uses: docker/setup-docker-action@v5",
  "        with:",
  "          daemon-config: |",
  "            {",
  '              "features": {',
  '                "containerd-snapshotter": true',
  "              }",
  "            }",
];
const reviewedJobContracts = new Map([
  [
    "application",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 35",
      "    steps:",
      "      - uses: actions/checkout@v7",
      ...setupNodeProjection,
      ...expectedApplicationRuns.map((command) => `      - run: ${command}`),
    ],
  ],
  [
    "backup-safety",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 60",
      "    steps:",
      "      - uses: actions/checkout@v7",
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
      "      - uses: actions/checkout@v7",
      "        with:",
      "          persist-credentials: false",
      `      - run: ${productionE2eRun}`,
    ],
  ],
  [
    "runner",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 35",
      "    defaults:",
      "      run:",
      "        working-directory: services/runner",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - uses: actions/setup-node@v7",
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
      "      - run: npm run runtime:test",
      "      - run: npm audit --omit=dev --audit-level=high",
    ],
  ],
  [
    "postgres-integration",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 20",
      "    steps:",
      "      - uses: actions/checkout@v7",
      ...setupNodeProjection,
      "      - run: npm ci",
      "      - run: npm run test:integration",
    ],
  ],
  [
    "curriculum-runtime",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 45",
      "    steps:",
      "      - uses: actions/checkout@v7",
      ...setupNodeProjection,
      "      - run: npm ci",
      "      - run: npm ci",
      "        working-directory: services/runner",
      ...dockerSetupProjection,
      "      - run: npm run runtime:build",
      "        working-directory: services/runner",
      "      - run: npm run runtime:inspect",
      "        working-directory: services/runner",
      "      - run: npm run runtime:record",
      "        working-directory: services/runner",
      "      - run: npx playwright install --with-deps chromium",
      "      - run: npm run dsa:parity:verify",
      "      - run: npm run c-cpp:executable:verify",
      "      - run: npm run java-python:executable:verify",
      "      - run: npm run ai-code:executable:verify",
      "      - run: npm run web:executable:verify",
    ],
  ],
  [
    "browser",
    [
      "    runs-on: ubuntu-24.04",
      "    timeout-minutes: 25",
      "    steps:",
      "      - uses: actions/checkout@v7",
      ...setupNodeProjection,
      "      - run: npm ci",
      "      - run: npx playwright install --with-deps chromium firefox webkit",
      "      - run: npm run sync:monaco",
      "      - run: npm run test:e2e",
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
    "      - run: npm run runtime:build\n      - run: npm run runtime:test\n";
  return replaceExactly(
    document,
    anchor,
    `      - run: npm run runtime:build\n      - run: ${command}\n      - run: npm run runtime:test\n`,
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
  const checkoutStep = "      - uses: actions/checkout@v7";
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
      "          persist-credentials: false\n",
      "          persist-credentials: true\n",
    ),
  );
  expectRejected(
    "production e2e checkout credentials setting missing",
    replaceExactly(document, `${productionCheckout}\n`, `${checkoutStep}\n`),
  );
  expectRejected(
    "production e2e checkout extra properties",
    replaceExactly(
      document,
      `${productionCheckout}\n`,
      `${productionCheckout}\n          fetch-depth: 0\n`,
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
      "      - run: npm run test:e2e\n",
      "      - run: npm run test:e2e\n        env:\n          CODESTEAD_DISPOSABLE_HOST: 1\n",
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
runHarnessAdversarialSelfTests(productionE2eHarness);

console.log("backup-ci-registration-tests-ok");
