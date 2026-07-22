import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), "utf8");
const optional = (relative) => {
  const url = new URL(relative, root);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
};

test("the application Dockerfile pins its frontend and labels every deployable target with source identity", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG SOURCE_REPOSITORY$/m);
  assert.match(dockerfile, /^ARG SOURCE_REVISION$/m);
  assert.match(dockerfile, /^ARG SOURCE_TREE$/m);
  assert.match(dockerfile, /^ARG SOURCE_CONTEXT_SHA256$/m);
  assert.match(dockerfile, /org\.opencontainers\.image\.source="?\$\{?SOURCE_REPOSITORY\}?"?/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="?\$\{?SOURCE_REVISION\}?"?/);
  assert.match(dockerfile, /io\.codestead\.application\.source-tree="?\$\{?SOURCE_TREE\}?"?/);
  assert.match(dockerfile, /io\.codestead\.application\.build-context-sha256="?\$\{?SOURCE_CONTEXT_SHA256\}?"?/);
  for (const target of [
    "runtime", "tooling", "worker", "regrade-worker",
    "project-review-correction-worker", "scanner-worker", "operations",
  ]) {
    assert.match(dockerfile, new RegExp(`^FROM [^\\n]+ AS ${target}$`, "m"));
  }
});

test("the manager exposes build, inspect, scan, and atomic record gates for exactly seven targets", () => {
  const manager = optional("scripts/app-images/manage-application-images.mjs");
  assert.match(manager, /APPLICATION_IMAGE_TARGETS/);
  assert.match(manager, /application:build|case\s+["']build["']/);
  assert.match(manager, /application:inspect|case\s+["']inspect["']/);
  assert.match(manager, /application:sign|case\s+["']sign["']/);
  assert.match(manager, /application:scan|case\s+["']scan["']/);
  assert.match(manager, /application:record|case\s+["']record["']/);
  assert.match(manager, /publishApplicationImageRecordTransaction/);
  assert.match(manager, /validateApplicationImageRecord/);
  assert.match(manager, /re-resolv|resolve.*Identity/i);
  assert.doesNotMatch(manager, /runtime-images\.(?:json|env)/);
});

test("package scripts execute application image product tests and all release phases", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["app-images:test"], "node --test scripts/app-images/*.test.mjs");
  for (const phase of ["build", "inspect", "sign", "scan", "record"]) {
    assert.equal(
      pkg.scripts[`app-images:${phase}`],
      `node scripts/app-images/manage-application-images.mjs ${phase}`,
    );
  }
});

test("CI runs and uploads the seven-image evidence as an independent fail-closed job", () => {
  const workflow = read(".github/workflows/ci.yml");
  const start = workflow.indexOf("  application-images:");
  assert.ok(start >= 0);
  const tail = workflow.slice(start);
  const end = tail.slice(1).search(/^  [a-z0-9_-]+:\s*$/m);
  const job = end >= 0 ? tail.slice(0, end + 1) : tail;
  assert.match(job, /app-images:test/);
  assert.match(job, /app-images:build/);
  assert.match(job, /app-images:inspect/);
  assert.match(job, /app-images:scan/);
  assert.match(job, /app-images:record/);
  assert.match(job, /APP_IMAGE_TRIVY_CACHE_DIR/);
  assert.doesNotMatch(job, /APP_IMAGE_LOCAL_RISK_ACCEPTANCE|accept-unsigned-local-buildkit-provenance-v1/);
  assert.match(job, /setup-trivy@3fb12ec12f41e471780db15c232d5dd185dcb514/);
  assert.match(job, /version:\s*0\.69\.3/);
  assert.match(job, /Upload application image release evidence/);
  assert.match(job, /if:\s*always\(\)/);
  assert.match(job, /dist\/application-images\/\.application-security\.failed-/);
  assert.match(job, /include-hidden-files:\s*true/);
  assert.doesNotMatch(job, /secrets\./);
});

test("production preflight verifies the canonical record against Compose and the exact source revision", () => {
  const validator = read("infra/ops/validate-runtime.sh");
  const verifier = optional("infra/ops/verify-application-image-record.mjs");
  const release = read("infra/ops/release-production.sh");
  assert.match(validator, /APPLICATION_IMAGE_RECORD_JSON/);
  assert.match(validator, /APPLICATION_IMAGE_RECORD_ENV/);
  assert.match(validator, /verify-application-image-record\.mjs/);
  assert.match(validator, /APPLICATION_EXPECTED_SOURCE_REVISION/);
  assert.match(validator, /APPLICATION_EXPECTED_SOURCE_TREE/);
  assert.match(validator, /--expected-source-tree\s+"?\$APPLICATION_EXPECTED_SOURCE_TREE"?/);
  assert.match(release, /APPLICATION_EXPECTED_SOURCE_REVISION=\$release_commit/);
  assert.match(release, /APPLICATION_EXPECTED_SOURCE_TREE=\$release_tree/);
  assert.match(verifier, /application-image-record-id=.*application-image-record-sha256=/);
  assert.match(validator, /application-image-record-sha256=/);
  assert.match(verifier, /APP_RUNTIME_IMAGE/);
  assert.match(verifier, /APP_PROJECT_REVIEW_WORKER_IMAGE/);
  assert.match(verifier, /compose.*projection|projection.*compose/is);
  assert.match(verifier, /O_NOFOLLOW/);
  assert.match(verifier, /spawnSync\(\s*"\/usr\/bin\/git"/s);
  assert.match(verifier, /HEAD\^\{tree\}/);
  assert.match(verifier, /archive", "--format=tar", "HEAD"/);
  assert.match(verifier, /contextSha256/);
});
