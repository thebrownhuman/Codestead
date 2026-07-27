#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), "utf8");

function jobBlock(workflow, jobName) {
  const match = workflow.match(
    new RegExp(
      `^  ${jobName}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`,
      "mu",
    ),
  );
  assert.ok(match, `${jobName} job is missing`);
  return match[0];
}

function assertNoJobPreludeRunnerContext(workflow) {
  const jobsIndex = workflow.indexOf("\njobs:\n");
  assert.ok(jobsIndex >= 0, "workflow must declare jobs");
  const runnerContext = /\$\{\{\s*runner\b/u;
  assert.doesNotMatch(
    workflow.slice(0, jobsIndex),
    runnerContext,
    "workflow-level configuration cannot use the runner context",
  );
  const jobs = workflow.slice(jobsIndex + 1);
  const headers = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):\n/gmu)];
  for (const [index, header] of headers.entries()) {
    const block = jobs.slice(
      header.index,
      headers[index + 1]?.index ?? jobs.length,
    );
    let insideSteps = false;
    let sawSteps = false;
    for (const line of block.split("\n")) {
      if (line === "    steps:") {
        insideSteps = true;
        sawSteps = true;
        continue;
      }
      if (/^    \S[^:]*:/u.test(line)) insideSteps = false;
      if (runnerContext.test(line)) {
        assert.ok(
          insideSteps,
          `${header[1]} job-level configuration cannot use the runner context`,
        );
      }
    }
    assert.ok(sawSteps, `${header[1]} job must declare steps`);
  }
}

function assertCacheInitialization({ workflow, jobName, variable, suffix }) {
  const job = jobBlock(workflow, jobName);
  const checkoutIndex = job.indexOf("actions/checkout@");
  const initialization = [
    "      - name: Initialize the runner-local cache path",
    "        run: |",
    "          set -Eeuo pipefail",
    `          printf '${variable}=%s/${suffix}\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"`,
  ].join("\n");
  const initializationIndex = job.indexOf(initialization);
  const consumers = [
    ...job.matchAll(
      new RegExp(`\\$(?:\\{${variable}\\}|${variable}\\b)`, "gu"),
    ),
  ];

  assert.ok(checkoutIndex >= 0, `${jobName} must check out the repository`);
  assert.ok(
    initializationIndex > checkoutIndex,
    `${jobName} must initialize ${variable} after checkout from RUNNER_TEMP`,
  );
  assert.ok(
    consumers.length > 0 &&
      consumers.every((consumer) => consumer.index > initializationIndex),
    `${jobName} must initialize ${variable} through GITHUB_ENV before every consumer`,
  );
  assert.equal(
    (job.match(new RegExp(`${variable}=`, "gu"))?.length ?? 0) +
      (job.match(new RegExp(`^\\s+${variable}:`, "gmu"))?.length ?? 0),
    1,
    `${jobName} must assign ${variable} exactly once`,
  );
  assert.doesNotMatch(
    job,
    new RegExp(`^      ${variable}:`, "mu"),
    `${jobName} must not initialize ${variable} in job-level env`,
  );
  assert.doesNotMatch(
    job,
    /\/home\/runner|[A-Za-z]:\\actions-runner/iu,
    `${jobName} must not hardcode a runner filesystem path`,
  );
}

function runnerContextFixture({ workflowPrelude = "", jobPrelude = "", step = "" }) {
  return [
    "name: Fixture",
    workflowPrelude,
    "jobs:",
    "  fixture:",
    "    runs-on: ubuntu-24.04",
    jobPrelude,
    "    steps:",
    "      - run: echo fixture",
    step,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function cacheInitializationFixture({
  beforeInitialization = "",
  afterInitialization = '      - run: printf "%s\\n" "$CACHE_PATH"',
}) {
  return [
    "name: Fixture",
    "jobs:",
    "  fixture:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: actions/checkout@example",
    beforeInitialization,
    "      - name: Initialize the runner-local cache path",
    "        run: |",
    "          set -Eeuo pipefail",
    "          printf 'CACHE_PATH=%s/cache\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"",
    afterInitialization,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

test("runner contexts are rejected outside steps regardless of property syntax", () => {
  for (const [label, workflow] of [
    [
      "workflow dotted property",
      runnerContextFixture({ workflowPrelude: "concurrency: ${{ runner.arch }}" }),
    ],
    [
      "workflow bracket property",
      runnerContextFixture({ workflowPrelude: "concurrency: ${{ runner['temp'] }}" }),
    ],
    [
      "job dotted property",
      runnerContextFixture({ jobPrelude: "    concurrency: ${{ runner.os }}" }),
    ],
    [
      "job bracket property",
      runnerContextFixture({ jobPrelude: '    concurrency: ${{ runner["temp"] }}' }),
    ],
  ]) {
    assert.throws(() => assertNoJobPreludeRunnerContext(workflow), undefined, label);
  }

  assert.doesNotThrow(() =>
    assertNoJobPreludeRunnerContext(
      runnerContextFixture({ step: "      - run: echo '${{ runner.temp }}'" }),
    ),
  );
});

test("cache initialization precedes every shell consumer and is the sole assignment", () => {
  assert.throws(() =>
    assertCacheInitialization({
      workflow: cacheInitializationFixture({
        beforeInitialization: '      - run: printf "%s\\n" "${CACHE_PATH}/before"',
      }),
      jobName: "fixture",
      variable: "CACHE_PATH",
      suffix: "cache",
    }),
  );
  assert.throws(() =>
    assertCacheInitialization({
      workflow: cacheInitializationFixture({
        afterInitialization: [
          "      - run: printf '%s\\n' \"$CACHE_PATH\"",
          "        env:",
          "          CACHE_PATH: /tmp/second-assignment",
        ].join("\n"),
      }),
      jobName: "fixture",
      variable: "CACHE_PATH",
      suffix: "cache",
    }),
  );
});
test("workflow jobs initialize runner-local paths only at step runtime", () => {
  const ci = read(".github/workflows/ci.yml");
  const registry = read(".github/workflows/application-image-registry-release.yml");

  assertNoJobPreludeRunnerContext(ci);
  assertNoJobPreludeRunnerContext(registry);

  const topologyJob = jobBlock(ci, "production-topology");
  assert.doesNotMatch(topologyJob, /^      RUNNER_ENVIRONMENT:/mu);
  assert.match(
    topologyJob,
    /CODESTEAD_DISPOSABLE_HOST=1 bash infra\/tests\/production-topology\.test\.sh/u,
  );

  for (const contract of [
    {
      workflow: ci,
      jobName: "application-images",
      variable: "APP_IMAGE_TRIVY_CACHE_DIR",
      suffix: "application-image-trivy-cache",
    },
    {
      workflow: ci,
      jobName: "runner",
      variable: "RUNTIME_TRIVY_CACHE_DIR",
      suffix: "trivy-cache",
    },
    {
      workflow: ci,
      jobName: "curriculum-runtime",
      variable: "RUNTIME_TRIVY_CACHE_DIR",
      suffix: "trivy-cache",
    },
    {
      workflow: registry,
      jobName: "publish",
      variable: "APP_IMAGE_TRIVY_CACHE_DIR",
      suffix: "application-image-trivy-cache",
    },
  ]) {
    assertCacheInitialization(contract);
  }
});

test("runner-context regression is reachable before CI workflow execution", () => {
  const ci = read(".github/workflows/ci.yml");
  const packageManifest = JSON.parse(read("package.json"));
  const scriptName = "test:github-runner-context:registration";
  const command = `npm run ${scriptName}`;

  assert.equal(
    packageManifest.scripts[scriptName],
    "node --test infra/tests/github-runner-context-registration.test.mjs",
  );
  assert.equal(packageManifest.scripts.check.split(command).length - 1, 1);
  assert.equal(ci.split(`      - run: ${command}`).length - 1, 1);
});
