import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import * as operations from "./application-image-operations.mjs";

const SOURCE_REPOSITORY = "https://github.com/thebrownhuman/Codestead";
const SOURCE_REVISION = "a".repeat(40);
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function identities() {
  return operations.APPLICATION_IMAGE_TARGETS.map(({ target, variable, repository }) => {
    const manifestDigest = digest(`${target}:manifest`);
    return {
      target,
      variable,
      reference: `registry.example.test/codestead/${repository}@${manifestDigest}`,
      manifestDigest,
      configDigest: digest(`${target}:config`),
      rootDigest: manifestDigest,
      sourceRepository: SOURCE_REPOSITORY,
      sourceRevision: SOURCE_REVISION,
    };
  });
}

test("the scan transaction publishes only after every target is scanned and re-resolved unchanged", () => {
  assert.equal(typeof operations.runApplicationSecurityScan, "function");
  const frozen = identities();
  const events = [];
  const result = operations.runApplicationSecurityScan({
    targets: operations.APPLICATION_IMAGE_TARGETS,
    destination: "/evidence/application-security",
    failedDestination: "/evidence/.application-security.failed-test",
    createStaging: () => "/evidence/.application-security.staging-test",
    removeTree: (value) => events.push(["remove", value]),
    renameTree: (from, to) => events.push(["rename", from, to]),
    resolveIdentity: (target) => frozen.find((identity) => identity.target === target),
    scanIdentity: ({ identity }) => ({ target: identity.target }),
    recheckIdentity: (identity) => structuredClone(identity),
    finalize: ({ identities: resolved, records }) => {
      events.push(["finalize", resolved.length, records.length]);
      return { complete: true };
    },
  });
  assert.equal(result.complete, true);
  assert.deepEqual(events.at(-1), [
    "rename",
    "/evidence/.application-security.staging-test",
    "/evidence/application-security",
  ]);
  assert.deepEqual(events.find((entry) => entry[0] === "finalize"), ["finalize", 7, 7]);
});

test("a moved target preserves failed diagnostics and never publishes stale success", () => {
  assert.equal(typeof operations.runApplicationSecurityScan, "function");
  const frozen = identities();
  const events = [];
  assert.throws(() => operations.runApplicationSecurityScan({
    targets: operations.APPLICATION_IMAGE_TARGETS,
    destination: "/evidence/application-security",
    failedDestination: "/evidence/.application-security.failed-test",
    createStaging: () => "/evidence/.application-security.staging-test",
    removeTree: (value) => events.push(["remove", value]),
    renameTree: (from, to) => events.push(["rename", from, to]),
    resolveIdentity: (target) => frozen.find((identity) => identity.target === target),
    scanIdentity: ({ identity }) => ({ target: identity.target }),
    recheckIdentity: (identity) => identity.target === "runtime"
      ? { ...identity, manifestDigest: digest("moved") }
      : structuredClone(identity),
    finalize: () => ({ complete: true }),
  }), /changed|moved|runtime/i);
  assert.equal(events.some((event) => event[0] === "rename"
    && event[2] === "/evidence/application-security"), false);
  assert.deepEqual(events.at(-1), [
    "rename",
    "/evidence/.application-security.staging-test",
    "/evidence/.application-security.failed-test",
  ]);
});
