import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPLICATION_IMAGE_TARGETS,
  runApplicationRegistryPublication,
} from "./application-image-operations.mjs";

const sourceRepository = "https://github.com/thebrownhuman/Codestead";
const sourceRevision = "a".repeat(40);
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function identities() {
  return APPLICATION_IMAGE_TARGETS.map(({ target, variable, repository }) => {
    const manifestDigest = digest(`${target}:manifest`);
    return {
      target,
      variable,
      reference: `ghcr.io/thebrownhuman/codestead/${repository}@${manifestDigest}`,
      manifestDigest,
      configDigest: digest(`${target}:config`),
      rootDigest: digest(`${target}:root`),
      sourceRepository,
      sourceRevision,
    };
  });
}

test("registry publication signs and attests all seven frozen digests before re-resolution and completion", () => {
  const frozen = identities();
  const events = [];
  const result = runApplicationRegistryPublication({
    targets: APPLICATION_IMAGE_TARGETS,
    resolveIdentity: (target) => structuredClone(frozen.find((item) => item.target === target)),
    preparePredicate: (identity) => {
      events.push(["predicate", identity.target, identity.reference]);
      return {
        predicateText: `{"target":"${identity.target}"}\n`,
        buildkitStatementText: `{"target":"${identity.target}"}\n`,
      };
    },
    signIdentity: ({ identity }) => events.push(["sign", identity.target, identity.reference]),
    attestIdentity: ({ identity, predicateText }) => {
      events.push(["attest", identity.target, identity.reference, predicateText]);
    },
    verifyIdentity: ({ identity }) => {
      events.push(["verify", identity.target, identity.reference]);
      return { target: identity.target, verified: true };
    },
    recheckIdentity: (identity) => {
      events.push(["recheck", identity.target, identity.reference]);
      return structuredClone(identity);
    },
    finalize: ({ identities: published, records }) => {
      events.push(["finalize", published.length, records.length]);
      return { complete: true, records };
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.records.length, 7);
  for (const identity of frozen) {
    const sequence = events
      .filter((event) => event[1] === identity.target)
      .map((event) => event[0]);
    assert.deepEqual(sequence, ["predicate", "sign", "attest", "verify", "recheck"]);
    assert.ok(events
      .filter((event) => event[1] === identity.target)
      .every((event) => !event[2] || event[2] === identity.reference));
  }
  assert.deepEqual(events.at(-1), ["finalize", 7, 7]);
});

test("registry publication never finalizes when a tag moves after signing", () => {
  const frozen = identities();
  let finalized = false;
  assert.throws(() => runApplicationRegistryPublication({
    targets: APPLICATION_IMAGE_TARGETS,
    resolveIdentity: (target) => structuredClone(frozen.find((item) => item.target === target)),
    preparePredicate: () => ({ predicateText: "{}\n", buildkitStatementText: "{}\n" }),
    signIdentity: () => {},
    attestIdentity: () => {},
    verifyIdentity: ({ identity }) => ({ target: identity.target, verified: true }),
    recheckIdentity: (identity) => identity.target === "runtime"
      ? { ...identity, manifestDigest: digest("moved") }
      : structuredClone(identity),
    finalize: () => {
      finalized = true;
      return { complete: true };
    },
  }), /changed|moved|runtime/i);
  assert.equal(finalized, false);
});

test("manager, package scripts, workflow, and runbook expose the digest-frozen sign/attest phase", () => {
  const manager = readFileSync(new URL("./manage-application-images.mjs", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const workflow = readFileSync(
    new URL("../../.github/workflows/application-image-registry-release.yml", import.meta.url),
    "utf8",
  );
  const runbook = readFileSync(
    new URL("../../docs/runbooks/application-image-registry-release.md", import.meta.url),
    "utf8",
  );

  assert.match(manager, /"sign", "--yes"/);
  assert.match(manager, /"attest", "--yes", "--type", "slsaprovenance02", "--predicate"/);
  assert.match(manager, /runApplicationRegistryPublication/);
  assert.equal(pkg.scripts["app-images:sign"], "node scripts/app-images/manage-application-images.mjs sign");
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /npm run app-images:build[\s\S]*npm run app-images:inspect[\s\S]*npm run app-images:sign[\s\S]*npm run app-images:scan[\s\S]*npm run app-images:record/);
  assert.match(runbook, /npm run app-images:sign/);
  assert.match(runbook, /APP_IMAGE_COSIGN_CERTIFICATE_IDENTITY/);
});
