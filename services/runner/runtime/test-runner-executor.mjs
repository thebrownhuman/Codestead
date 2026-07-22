import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../dist/config.js";
import { DockerJobExecutor } from "../dist/docker-executor.js";
import { NodeProcessExecutor } from "../dist/process-executor.js";
import { validateJobRequest } from "../dist/validation.js";
import { resolveLocalImageIdentity, validateLocalBuildIdentityRecord } from "./runtime-operations.mjs";

const repository = process.env.RUNTIME_REPOSITORY ?? "learncoding/runtime";
const release = process.env.RUNTIME_RELEASE ?? "local";
const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const passedChecks = [];
const languages = ["c", "cpp", "java", "python", "javascript"];
const localBuildIdentities = validateLocalBuildIdentityRecord(
  readFileSync(path.join(path.dirname(runtimeRoot), "dist", "runtime-local-build-identities.json"), "utf8"),
  languages.map((language) => ({
    language,
    tag: `${repository}-${language}:${release}`,
  })),
);

function inspectImage(reference) {
  const inspected = spawnSync("docker", [
    "image", "inspect", "--platform", "linux/amd64", reference,
  ], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) {
    throw new Error(`Local runtime image is missing: ${reference}`);
  }
  const images = JSON.parse(inspected.stdout);
  if (!Array.isArray(images) || images.length !== 1 || !images[0] || typeof images[0] !== "object") {
    throw new Error(`Docker returned an invalid image inspection: ${reference}`);
  }
  return images[0];
}

function immutableLocalReference(language) {
  const repositoryName = `${repository}-${language}`;
  const tag = `${repositoryName}:${release}`;
  return resolveLocalImageIdentity({
    language,
    tag,
    repository: repositoryName,
    inspectImage,
    expectedIdentity: {
      manifestDigest: localBuildIdentities[language].manifestDigest,
      configDigest: localBuildIdentities[language].configDigest,
    },
  }).imageReference;
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "lc-real-executor-"));
const refs = Object.fromEntries(languages.map((language) => [language, immutableLocalReference(language)]));
const config = loadConfig({
  RUNNER_SHARED_SECRET: "real-contract-secret-is-at-least-32-bytes",
  RUNNER_MAX_CONCURRENCY: "2",
  RUNNER_TEMP_ROOT: tempRoot,
  RUNNER_IMAGE_C: refs.c,
  RUNNER_IMAGE_CPP: refs.cpp,
  RUNNER_IMAGE_JAVA: refs.java,
  RUNNER_IMAGE_PYTHON: refs.python,
  RUNNER_IMAGE_JAVASCRIPT: refs.javascript,
});
const executor = new DockerJobExecutor(config, new NodeProcessExecutor());

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function passed(name) {
  passedChecks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

function request(overrides = {}) {
  return {
    submissionId: "real-submission-001",
    correlationId: "real-correlation-001",
    language: "python",
    runtimeVersion: "Python 3.14",
    mode: "RUN",
    sourceFiles: [{ path: "main.py", content: "print('ok:' + input())\n" }],
    entrypoint: "main.py",
    stdin: "buddy\n",
    limits: {
      wallTimeMs: 5_000,
      memoryMb: 128,
      cpuCount: 0.5,
      pids: 32,
      outputBytes: 65_536,
      fileBytes: 16_777_216,
    },
    ...overrides,
  };
}

try {
  const normal = await executor.execute(
    validateJobRequest(request(), config),
    "1".repeat(64),
  );
  check(normal.status === "ACCEPTED", `real executor run failed: ${normal.status}`);
  check(normal.run?.stdout.trim() === "ok:buddy", "real executor did not forward stdin");
  passed("real executor: compile/run/stdin");

  const hiddenMarker = "HIDDEN_EXPECTED_MUST_NOT_ESCAPE_4af9";
  const hidden = await executor.execute(
    validateJobRequest(request({
      submissionId: "real-submission-002",
      correlationId: "real-correlation-002",
      mode: "TEST",
      stdin: undefined,
      sourceFiles: [{ path: "main.py", content: "print('public')\n" }],
      testBundleVersion: "real-bundle-1",
      tests: [
        { id: "visible", visibility: "VISIBLE", category: "example", stdin: "", expectedStdout: "public\n", comparison: "EXACT" },
        { id: "hidden", visibility: "HIDDEN", category: "edge", stdin: "", expectedStdout: hiddenMarker, comparison: "EXACT" },
      ],
    }), config),
    "2".repeat(64),
  );
  check(hidden.status === "WRONG_ANSWER", `hidden test fixture status mismatch: ${hidden.status}`);
  check(!JSON.stringify(hidden).includes(hiddenMarker), "hidden expected output escaped the real executor");
  check(!Object.hasOwn(hidden.tests[1], "actualStdout"), "hidden actual output escaped the real executor");
  passed("real executor: hidden-data redaction");

  const bounded = await executor.execute(
    validateJobRequest(request({
      submissionId: "real-submission-003",
      correlationId: "real-correlation-003",
      sourceFiles: [{ path: "main.py", content: "while True: print('x'*1024, flush=True)\n" }],
      stdin: "",
      limits: { wallTimeMs: 4_000, memoryMb: 128, cpuCount: 0.5, pids: 32, outputBytes: 8_192, fileBytes: 16_777_216 },
    }), config),
    "3".repeat(64),
  );
  check(bounded.status === "OUTPUT_LIMIT", `real executor output cap failed: ${bounded.status}`);
  passed("real executor: output cap and forced cleanup");

  check(readdirSync(tempRoot).length === 0, "real executor left a job source directory behind");
  passed("real executor: cross-job source cleanup");
} finally {
  const reportDirectory = path.join(path.dirname(runtimeRoot), "dist");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(
    path.join(reportDirectory, "runtime-executor-report.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), refs, passed: passedChecks }, null, 2)}\n`,
  );
  rmSync(tempRoot, { recursive: true, force: true });
}
