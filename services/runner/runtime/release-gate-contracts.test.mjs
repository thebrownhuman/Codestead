import assert from "node:assert/strict";
import test from "node:test";

import { validateRuntimeReleaseGateEvidence } from "./runtime-operations.mjs";

const LANGUAGES = ["c", "cpp", "java", "python", "javascript"];
const REQUIRED_CONTRACTS = [
  "c: compile and run",
  "c: compile error",
  "cpp: compile and run",
  "cpp: compile error",
  "java: compile and run",
  "java: compile error",
  "python: compile and run",
  "python: compile error",
  "javascript: compile and run",
  "javascript: compile error",
  "python: read-only root and writable ephemeral work",
  "python: network egress blocked",
  "python: hidden environment absent",
  "python: cross-job work cleanup",
  "python: wall timeout",
  "python: combined output cap",
  "python: process limit",
];

const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const expected = LANGUAGES.map((language, index) => {
    const manifestDigest = digest(String(index + 1));
    const configDigest = digest(String.fromCharCode(97 + index));
    return {
      language,
      tag: `learncoding/runtime-${language}:local`,
      imageReference: `learncoding/runtime-${language}@${manifestDigest}`,
      manifestDigest,
      configDigest,
      rootDigest: manifestDigest,
    };
  });
  const refs = Object.fromEntries(expected.map((identity) => [identity.language, identity.imageReference]));
  return {
    expected,
    inspection: {
      generatedAt: "2026-07-19T00:00:00Z",
      images: expected.map((identity) => ({ ...identity })),
    },
    contract: {
      generatedAt: "2026-07-19T00:01:00Z",
      images: refs,
      results: REQUIRED_CONTRACTS.map((name) => ({ name, status: "passed" })),
    },
    executor: {
      generatedAt: "2026-07-19T00:02:00Z",
      refs,
      passed: [
        "real executor: compile/run/stdin",
        "real executor: hidden-data redaction",
        "real executor: output cap and forced cleanup",
        "real executor: cross-job source cleanup",
      ],
    },
  };
}

function validate(value) {
  return validateRuntimeReleaseGateEvidence({
    inspectionText: JSON.stringify(value.inspection),
    contractText: JSON.stringify(value.contract),
    executorText: JSON.stringify(value.executor),
    expected: value.expected,
  });
}

test("release gate requires the exact unique complete 17-contract runtime suite", () => {
  const complete = fixture();
  assert.equal(validate(complete).contract.results.length, 17);

  const missing = structuredClone(complete);
  missing.contract.results.pop();
  assert.throws(() => validate(missing), /contract.*exact|required.*contract|failed or incomplete/i);

  const duplicate = structuredClone(complete);
  duplicate.contract.results[16] = { ...duplicate.contract.results[0] };
  assert.throws(() => validate(duplicate), /contract.*exact|required.*contract|failed or incomplete/i);

  const extra = structuredClone(complete);
  extra.contract.results.push({ name: "python: unreviewed extra", status: "passed" });
  assert.throws(() => validate(extra), /contract.*exact|required.*contract|failed or incomplete/i);
});

test("release gate rejects missing, extra, conflated, or mismatched identity fields", () => {
  const mutations = [
    (value) => { delete value.expected[0].manifestDigest; },
    (value) => { value.expected[0].unexpectedDigest = digest("f"); },
    (value) => { value.expected[0].configDigest = value.expected[0].manifestDigest; },
    (value) => { value.expected[0].rootDigest = digest("e"); },
    (value) => { value.inspection.images[0].configDigest = digest("f"); },
    (value) => { value.inspection.images[0].manifestDigest = digest("f"); },
  ];
  for (const mutate of mutations) {
    const candidate = fixture();
    mutate(candidate);
    assert.throws(() => validate(candidate), /identity|inspection/i);
  }
});
