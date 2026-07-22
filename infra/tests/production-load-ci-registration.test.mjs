#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath) => {
  try {
    return readFileSync(resolve(repoRoot, relativePath), "utf8");
  } catch {
    return "";
  }
};

class RegistrationError extends Error {}

function fail(message) {
  throw new RegistrationError(`production-load CI registration: ${message}`);
}

function exactlyOnce(source, fragment, message) {
  if (source.split(fragment).length !== 2) fail(message);
}

const scriptEntries = [
  [
    "production-load:ci-registration",
    "node infra/tests/production-load-ci-registration.test.mjs",
  ],
  [
    "production-load:test-control:bundle",
    "node infra/tests/production-load-test-control-bundle.test.mjs",
  ],
  [
    "production-load:fixture-runtime:bundle",
    "node infra/tests/production-load-fixture-runtime-bundle.test.mjs",
  ],
  [
    "production-load:fixture-runtime:systemd",
    "node infra/tests/production-load-fixture-runtime-systemd.test.mjs",
  ],
  [
    "production-load:fixture-runtime:lifecycle",
    "bash infra/tests/production-load-fixture-lifecycle.test.sh",
  ],
  [
    "production-load:test-control:runtime",
    "bash infra/tests/production-load-test-control-runtime.test.sh",
  ],
  [
    "production-load:peer-credentials",
    "bash infra/tests/production-load-peer-credentials.test.sh",
  ],
  [
    "production-load:disposable-sandbox",
    "bash infra/tests/production-load-disposable-sandbox.test.sh",
  ],
  [
    "production-load:release-gates",
    "npm run production-load:ci-registration && npm run production-load:test-control:bundle && npm run production-load:fixture-runtime:bundle && npm run production-load:fixture-runtime:systemd",
  ],
];

const ciCommands = [
  "npm run production-load:ci-registration",
  "npm run production-load:test-control:bundle",
  "npm run production-load:fixture-runtime:bundle",
  "npm run production-load:fixture-runtime:systemd",
  "CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:fixture-runtime:lifecycle",
  'sudo env "PATH=$PATH" CODESTEAD_REQUIRE_LINUX_ROOT=1 npm run production-load:test-control:runtime',
  "CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:peer-credentials",
  "CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:disposable-sandbox",
];

function validatePackageManifest(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    fail("package.json is missing or invalid");
  }
  const scripts = manifest.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    fail("package scripts are missing");
  }
  const keys = Object.keys(scripts);
  let previousIndex = -1;
  for (const [name, command] of scriptEntries) {
    if (scripts[name] !== command) fail(`script ${name} is missing or changed`);
    const index = keys.indexOf(name);
    if (index <= previousIndex) fail("production-load package scripts were reordered");
    previousIndex = index;
  }
  const check = scripts.check;
  if (typeof check !== "string"
    || !check.startsWith("npm run production-load:release-gates && npm run lint")) {
    fail("portable production-load release gates are not first in npm check");
  }
}

function validateWorkflow(source) {
  const block = ciCommands.map((command) => `      - run: ${command}`).join("\n");
  exactlyOnce(source, block, "security gates are missing, duplicated, or reordered");
  for (const command of ciCommands) {
    exactlyOnce(source, `      - run: ${command}`, `CI command is ambiguous: ${command}`);
  }
  const application = source.match(/^  application:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n)/m)?.[0] ?? "";
  if (!application.includes("    runs-on: ubuntu-24.04\n")) {
    fail("security gates are not bound to the Ubuntu application job");
  }
  if (application.indexOf(block) <= application.indexOf("      - run: npm ci\n")
    || application.indexOf(block) >= application.indexOf("      - run: npm run lint\n")) {
    fail("security gates must run immediately after install and before whole-tree lint");
  }
  const shellcheckLine = source.split("\n").find((line) =>
    line.includes("shellcheck --severity=warning ")) ?? "";
  if (!shellcheckLine.includes("infra/tests/production-load-fixture-lifecycle.test.sh")) {
    fail("fixture lifecycle harness is not shellchecked");
  }
}

function validateEslintSource(source) {
  const exactIgnores = [
    '    "infra/runtime/production-load-test-control-service.mjs",',
    '    "infra/runtime/production-load-fixture-runtime.mjs",',
  ];
  for (const exactIgnore of exactIgnores) {
    exactlyOnce(source, exactIgnore, "exact generated bundle ignore is missing or ambiguous");
  }
  for (const broadIgnore of [
    '    "infra/runtime/**",',
    '    "infra/runtime/*.mjs",',
    '    "infra/runtime/production-load-*",',
  ]) {
    if (source.includes(broadIgnore)) fail("generated bundle ignore was broadened");
  }
}

function validateSandboxHarness(source) {
  for (const [fragment, message] of [
    [
      '[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]',
      "hosted disposable-runner acknowledgement is missing",
    ],
    [
      "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94",
      "proof image is not pinned by digest",
    ],
    ["docker build --pull=false --iidfile", "proof image build is not ID-bound"],
    ["--network none", "positive proof is not default-deny"],
    ["--read-only", "positive proof root filesystem is writable"],
    ["--user 65532:65532", "positive proof lacks the fixed non-root identity"],
    ["--cap-drop ALL", "positive proof retains ambient capabilities"],
    ["--security-opt no-new-privileges:true", "positive proof allows privilege gain"],
    ["expected root identity rejection", "root negative proof is missing"],
    ["expected routed network rejection", "routed-network negative proof is missing"],
    ["com.codestead.proof=production-load-disposable-sandbox-v1", "cleanup ownership label is missing"],
    ['runtime_image_id="$(docker image inspect --format \'{{.Id}}\' "$image_id")"', "runtime image identity capture is missing"],
    ['"$configured_image" == "$runtime_image_id"', "container cleanup is not runtime-image bound"],
  ]) {
    if (!source.includes(fragment)) fail(message);
  }
}

function validateLifecycleHarness(source) {
  for (const [fragment, message] of [
    [
      '[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]',
      "fixture lifecycle hosted-runner acknowledgement is missing",
    ],
    [
      "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94",
      "fixture lifecycle image is not pinned by digest",
    ],
    ["scripts/run-production-load-fixture-lifecycle-proof.ts", "real lifecycle proof is not bundled"],
    ["docker build --pull=false --iidfile", "lifecycle proof image is not ID-bound"],
    ["--network none", "lifecycle proof is not default-deny"],
    ["--add-host production-load-postgres:127.0.0.1", "Postgres alias is not loopback-bound"],
    ["--add-host production-load-app:127.0.0.1", "application alias is not loopback-bound"],
    ["--read-only", "lifecycle proof root filesystem is writable"],
    ["--user 65532:65532", "lifecycle proof lacks the fixed non-root identity"],
    ["--cap-drop ALL", "lifecycle proof retains ambient capabilities"],
    ["--security-opt no-new-privileges:true", "lifecycle proof allows privilege gain"],
    ["--pids-limit 128", "lifecycle proof lacks a PID limit"],
    ["--memory 256m", "lifecycle proof lacks a memory limit"],
    ["--cpus 1", "lifecycle proof lacks a CPU limit"],
    [
      "--tmpfs /var/lib/learncoding-production-load-fixtures:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=65532,gid=65532",
      "quota lifecycle proof lacks its bounded tmpfs",
    ],
    [
      "production load fixture lifecycle proof passed: learners=10 runner_max=2 queued>=1 faults=7",
      "lifecycle proof receipt is missing",
    ],
  ]) {
    if (!source.includes(fragment)) fail(message);
  }
  if (source.includes("--privileged") || source.includes("/var/run/docker.sock")
    || source.includes("/run/docker.sock") || source.includes("--network host")) {
    fail("fixture lifecycle proof opens an unreviewed host-control boundary");
  }
}
function validatePeerHarness(source) {

  for (const [fragment, message] of [
    [
      '[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]',
      "peer proof hosted-runner acknowledgement is missing",
    ],
    [
      "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94",
      "peer proof Node image is not pinned by digest",
    ],
    [
      "python:3.12.13-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b",
      "peer proof Python image is not pinned by digest",
    ],
    [
      "install -o 0 -g 0 -m 0755 /usr/local/bin/python3.12 /usr/bin/python3.12",
      "peer proof interpreter is not a root-owned regular executable",
    ],
    ["infra/tests/fixtures/run-production-load-peer-credentials-proof.ts", "real peer proof fixture is not bundled"],
    ["infra/ops/production-load-peer-credentials.py", "reviewed SO_PEERCRED helper is not included"],
    ["docker build --pull=false --iidfile", "peer proof image build is not ID-bound"],
    ["--network none", "peer proof is not default-deny"],
    ["--read-only", "peer proof root filesystem is writable"],
    ["--user 0:0", "peer proof does not start from a real root peer"],
    ["--cap-drop ALL", "peer proof retains ambient capabilities"],
    ["--cap-add SETUID", "peer proof cannot create the fixed non-root peer"],
    ["--cap-add SETGID", "peer proof cannot create the fixed non-root group"],
    ["--security-opt no-new-privileges:true", "peer proof allows privilege gain"],
    [
      "--tmpfs /run:rw,noexec,nosuid,nodev,size=4m,mode=0755,uid=0,gid=0",
      "peer proof lacks its private bounded runtime directory",
    ],
    [
      "linux SO_PEERCRED proof passed: root peer=accepted non-root peer=denied adapter_calls=1",
      "peer proof does not assert the canonical end-to-end receipt",
    ],
    ["com.codestead.proof=production-load-peer-credentials-v1", "peer cleanup ownership label is missing"],
    ['runtime_image_id="$(docker image inspect --format \'{{.Id}}\' "$image_id")"', "peer runtime image identity capture is missing"],
    ['"$configured_image" == "$runtime_image_id"', "peer container cleanup is not image-bound"],
  ]) {
    if (!source.includes(fragment)) fail(message);
  }
  if (source.includes("--privileged") || source.includes("/var/run/docker.sock")
    || source.includes("/run/docker.sock")) {
    fail("peer proof opens an unreviewed host-control boundary");
  }
}

function replaceExactly(source, needle, replacement) {
  exactlyOnce(source, needle, `self-test mutation anchor is ambiguous: ${needle}`);
  return source.replace(needle, replacement);
}

const packageSource = read("package.json");
const workflowSource = read(".github/workflows/ci.yml");
const eslintSource = read("eslint.config.mjs");
const sandboxHarnessSource = read("infra/tests/production-load-disposable-sandbox.test.sh");
const lifecycleHarnessSource = read(
  "infra/tests/production-load-fixture-lifecycle.test.sh");

validatePackageManifest(packageSource);
const peerHarnessSource = read("infra/tests/production-load-peer-credentials.test.sh");
validateWorkflow(workflowSource);
validateEslintSource(eslintSource);
validateSandboxHarness(sandboxHarnessSource);
validateLifecycleHarness(lifecycleHarnessSource);

const eslint = new ESLint({ cwd: repoRoot });
validatePeerHarness(peerHarnessSource);
assert.equal(
  await eslint.isPathIgnored(resolve(repoRoot, "infra/runtime/production-load-test-control-service.mjs")),
  true,
  "the exact immutable generated bundle must be ignored",
);
assert.equal(
  await eslint.isPathIgnored(resolve(repoRoot, "infra/runtime/production-load-test-control-service.sibling.mjs")),
  false,
  "a sibling runtime artifact must remain linted",
);
assert.equal(
  await eslint.isPathIgnored(resolve(repoRoot, "infra/runtime/production-load-fixture-runtime.mjs")),
  true,
  "the exact disposable fixture runtime artifact must be ignored",
);
assert.equal(
  await eslint.isPathIgnored(resolve(repoRoot, "scripts/build-production-load-test-control-runtime.mjs")),
  false,
  "the bundle generator source must remain linted",
);

assert.throws(
  () => validatePackageManifest(replaceExactly(
    packageSource,
    '    "production-load:test-control:bundle": "node infra/tests/production-load-test-control-bundle.test.mjs",\n',
    "",
  )),
  RegistrationError,
);
assert.throws(
  () => validateWorkflow(replaceExactly(
    workflowSource,
    ciCommands.map((command) => `      - run: ${command}`).join("\n"),
    [...ciCommands].reverse().map((command) => `      - run: ${command}`).join("\n"),
  )),
  RegistrationError,
);
assert.throws(
  () => validatePackageManifest(replaceExactly(
    packageSource,
    '    "production-load:peer-credentials": "bash infra/tests/production-load-peer-credentials.test.sh",\n',
    "",
  )),
  RegistrationError,
);
assert.throws(
  () => validateWorkflow(replaceExactly(
    workflowSource,
    "      - run: CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:peer-credentials",
    "      - run: CODESTEAD_DISPOSABLE_HOST=1 npm run production-load:*",
  )),
  RegistrationError,
);
assert.throws(
  () => validatePeerHarness(replaceExactly(
    peerHarnessSource,
    "python:3.12.13-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b",
    "python:3.12.13-slim-bookworm",
  )),
  RegistrationError,
);
assert.throws(
  () => validatePeerHarness(replaceExactly(
    peerHarnessSource,
    "install -o 0 -g 0 -m 0755 /usr/local/bin/python3.12 /usr/bin/python3.12",
    "ln -s /usr/local/bin/python3.12 /usr/bin/python3.12",
  )),
  RegistrationError,
);


assert.throws(
  () => validateEslintSource(replaceExactly(
    eslintSource,
    '    "infra/runtime/production-load-test-control-service.mjs",',
    '    "infra/runtime/**",',
  )),
  RegistrationError,
);

process.stdout.write("production-load-ci-registration-tests-ok\n");
