import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createApplicationLocalProvenance,
  parseApplicationLocalRiskAcceptance,
  validateApplicationLocalProvenance,
} from "./application-image-operations.mjs";

const acceptanceText = readFileSync(
  new URL("../../infra/security/application-image-local-risk-acceptance.json", import.meta.url),
  "utf8",
);
const sourceRepository = "https://github.com/thebrownhuman/Codestead";
const sourceRevision = "a".repeat(40);
const sourceTree = "b".repeat(40);
const sourceContextSha256 = "c".repeat(64);
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function identity() {
  const manifestDigest = digest("runtime-manifest");
  return {
    target: "runtime",
    variable: "APP_RUNTIME_IMAGE",
    reference: `registry.example.test/codestead/runtime@${manifestDigest}`,
    manifestDigest,
    configDigest: digest("runtime-config"),
    rootDigest: manifestDigest,
    sourceRepository,
    sourceRevision,
  };
}

function inputs() {
  return ["Dockerfile", ".dockerignore", "package.json", "package-lock.json"]
    .map((file) => ({ file, sha256: digest(file).slice(7) }));
}

test("unsigned local images require one canonical accountable unexpired acceptance artifact", () => {
  const acceptance = parseApplicationLocalRiskAcceptance({
    acceptanceText,
    validatedAt: "2026-07-19T12:00:00Z",
  });
  assert.equal(acceptance.artifact.schemaVersion, 1);
  assert.match(acceptance.artifact.owner, /thebrownhuman/);
  assert.match(acceptance.artifact.approvedBy, /thebrownhuman/);
  assert.ok(acceptance.artifact.rationale.length >= 80);
  assert.equal(acceptance.artifact.reassessmentTriggers.length, 5);
  assert.equal(acceptance.sha256, createHash("sha256").update(acceptanceText).digest("hex"));

  const evidence = createApplicationLocalProvenance({
    generatedAt: "2026-07-19T12:00:00Z",
    riskAcceptance: acceptance,
    identity: identity(),
    baseReference: `node:22.23.1-alpine3.23@${digest("base")}`,
    sourceRepository,
    sourceRevision,
    sourceTree,
    sourceContextSha256,
    dirty: false,
    builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
    inputs: inputs(),
  });
  const validated = validateApplicationLocalProvenance({
    evidenceText: `${JSON.stringify(evidence, null, 2)}\n`,
    identity: identity(),
  });
  assert.equal(validated.riskAcceptance.sha256, acceptance.sha256);
  assert.equal(validated.source.tree, sourceTree);
  assert.equal(validated.source.contextSha256, sourceContextSha256);
});

test("risk acceptance rejects expiry, noncanonical bytes, unknown fields, and missing reassessment ownership", () => {
  assert.throws(() => parseApplicationLocalRiskAcceptance({
    acceptanceText,
    validatedAt: "2026-10-17T00:00:01Z",
  }), /expired/i);
  assert.throws(() => parseApplicationLocalRiskAcceptance({
    acceptanceText: JSON.stringify(JSON.parse(acceptanceText)),
    validatedAt: "2026-07-19T12:00:00Z",
  }), /canonical/i);

  const unknown = JSON.parse(acceptanceText);
  unknown.unreviewed = true;
  assert.throws(() => parseApplicationLocalRiskAcceptance({
    acceptanceText: `${JSON.stringify(unknown, null, 2)}\n`,
    validatedAt: "2026-07-19T12:00:00Z",
  }), /schema|unreviewed/i);

  const ownerless = JSON.parse(acceptanceText);
  ownerless.owner = "";
  assert.throws(() => parseApplicationLocalRiskAcceptance({
    acceptanceText: `${JSON.stringify(ownerless, null, 2)}\n`,
    validatedAt: "2026-07-19T12:00:00Z",
  }), /owner/i);
});
