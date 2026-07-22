import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as operations from "./application-image-operations.mjs";

const GENERATED_AT = "2026-07-19T00:00:00Z";
const SOURCE_REPOSITORY = "https://github.com/thebrownhuman/Codestead";
const SOURCE_REVISION = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);
const SOURCE_CONTEXT_SHA256 = "c".repeat(64);
const RELEASE = "20260719T000000Z-a";
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const RISK_ACCEPTANCE = operations.parseApplicationLocalRiskAcceptance({
  acceptanceText: readFileSync(
    new URL("../../infra/security/application-image-local-risk-acceptance.json", import.meta.url), "utf8",
  ),
  validatedAt: GENERATED_AT,
});

function scannerFixture() {
  const controls = [
    ["trivy-config", "application-scanner-trivy.json", "offline-scan: true\nignore-unfixed: false\n"],
    ["syft-config", "application-scanner-syft.json", "check-for-app-update: false\n"],
    ["grype-config", "application-scanner-grype.json", "db:\n  auto-update: false\n"],
    ["trivy-ignore", "application-scanner-ignore.json", ""],
  ].map(([name, file, text]) => ({ name, file, text }));
  const databases = [
    ["trivy-db", "application-trivy-db.json", {
      Version: 2,
      UpdatedAt: "2026-07-18T23:00:00Z",
      NextUpdate: "2026-07-20T00:00:00Z",
      DownloadedAt: "2026-07-18T23:30:00Z",
    }],
    ["trivy-java-db", "application-trivy-java-db.json", {
      Version: 1,
      UpdatedAt: "2026-07-18T22:00:00Z",
      NextUpdate: "2026-07-20T00:00:00Z",
      DownloadedAt: "2026-07-18T23:30:00Z",
    }],
  ].map(([name, file, value]) => ({ name, file, text: `${JSON.stringify(value)}\n` }));
  const evidence = operations.createApplicationScannerEvidence({
    generatedAt: GENERATED_AT,
    tools: [{ name: "trivy", version: "Version: 0.69.3" }],
    controls,
    databases,
  });
  return { controls, databases, evidence };
}

function spdx(target) {
  return `${JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `codestead-${target}`,
    documentNamespace: `https://codestead.example/spdx/${target}/${SOURCE_REVISION}`,
    creationInfo: { created: GENERATED_AT, creators: ["Tool: trivy-0.69.3"] },
    packages: [{
      SPDXID: "SPDXRef-RootPackage",
      name: `codestead-${target}`,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      copyrightText: "NOASSERTION",
    }],
    relationships: [{
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-RootPackage",
    }],
  })}\n`;
}

function fixture() {
  const scanner = scannerFixture();
  const artifacts = new Map([
    ...scanner.controls.map((entry) => [entry.file, entry.text]),
    ...scanner.databases.map((entry) => [entry.file, entry.text]),
  ]);
  const identities = operations.APPLICATION_IMAGE_TARGETS.map(({ target, variable, repository }) => {
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
  const records = identities.map((identity) => {
    const spdxText = spdx(identity.target);
    const vulnerabilityText = `${JSON.stringify({
      SchemaVersion: 2,
      ArtifactName: identity.reference,
      ArtifactType: "container_image",
      Metadata: { ImageID: identity.configDigest, RepoDigests: [identity.reference] },
      Results: [],
    })}\n`;
    const provenance = operations.createApplicationLocalProvenance({
      generatedAt: GENERATED_AT,
      riskAcceptance: RISK_ACCEPTANCE,
      identity,
      baseReference: `node:22.23.1-alpine3.23@${digest("base")}`,
      sourceRepository: SOURCE_REPOSITORY,
      sourceRevision: SOURCE_REVISION,
      sourceTree: SOURCE_TREE,
      sourceContextSha256: SOURCE_CONTEXT_SHA256,
      dirty: false,
      builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
      inputs: ["Dockerfile", ".dockerignore", "package.json", "package-lock.json"]
        .map((file) => ({ file, sha256: digest(file).slice(7) })),
    });
    const spdxFile = `${identity.target}.spdx.json`;
    const vulnerabilityFile = `${identity.target}.trivy.json`;
    const provenanceFile = `${identity.target}.local-provenance.json`;
    const provenanceText = `${JSON.stringify(provenance)}\n`;
    artifacts.set(spdxFile, spdxText);
    artifacts.set(vulnerabilityFile, vulnerabilityText);
    artifacts.set(provenanceFile, provenanceText);
    return {
      identity,
      spdxFile,
      spdxText,
      vulnerabilityFile,
      vulnerabilityText,
      provenanceFile,
      provenanceText,
    };
  });
  return { scanner, identities, records, artifacts };
}

test("a security manifest is complete only after all seven exact local targets pass", () => {
  assert.equal(typeof operations.createApplicationSecurityEvidence, "function");
  const value = fixture();
  const manifest = operations.createApplicationSecurityEvidence({
    release: RELEASE,
    mode: "local",
    generatedAt: GENERATED_AT,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    scannerEvidence: value.scanner.evidence,
    records: value.records,
  });
  assert.equal(manifest.complete, true);
  assert.equal(manifest.evidenceKind, "codestead-application-image-security");
  assert.deepEqual(manifest.records.map((record) => record.target),
    operations.APPLICATION_IMAGE_TARGETS.map((record) => record.target));
  assert.throws(() => operations.createApplicationSecurityEvidence({
    release: RELEASE,
    mode: "local",
    generatedAt: GENERATED_AT,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    scannerEvidence: value.scanner.evidence,
    records: value.records.slice(0, 6),
  }), /complete|seven|target/i);
});

test("record-time validation rejects stale identity, tampered artifacts, and expired scanner evidence", () => {
  assert.equal(typeof operations.validateApplicationSecurityEvidence, "function");
  const value = fixture();
  const manifest = operations.createApplicationSecurityEvidence({
    release: RELEASE,
    mode: "local",
    generatedAt: GENERATED_AT,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    scannerEvidence: value.scanner.evidence,
    records: value.records,
  });
  const manifestText = `${JSON.stringify(manifest)}\n`;
  assert.equal(operations.validateApplicationSecurityEvidence({
    manifestText,
    release: RELEASE,
    mode: "local",
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    expected: value.identities,
    validatedAt: "2026-07-19T12:00:00Z",
    readArtifact: (file) => value.artifacts.get(file),
  }).complete, true);

  const stale = structuredClone(value.identities);
  stale[0].manifestDigest = digest("changed");
  stale[0].rootDigest = stale[0].manifestDigest;
  stale[0].reference = `registry.example.test/codestead/runtime@${stale[0].manifestDigest}`;
  assert.throws(() => operations.validateApplicationSecurityEvidence({
    manifestText,
    release: RELEASE,
    mode: "local",
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    expected: stale,
    validatedAt: "2026-07-19T12:00:00Z",
    readArtifact: (file) => value.artifacts.get(file),
  }), /stale|identity|digest/i);

  value.artifacts.set("runtime.spdx.json", "{}\n");
  assert.throws(() => operations.validateApplicationSecurityEvidence({
    manifestText,
    release: RELEASE,
    mode: "local",
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    expected: value.identities,
    validatedAt: "2026-07-19T12:00:00Z",
    readArtifact: (file) => value.artifacts.get(file),
  }), /checksum|tamper|SPDX/i);

  const fresh = fixture();
  assert.throws(() => operations.validateApplicationSecurityEvidence({
    manifestText,
    release: RELEASE,
    mode: "local",
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    expected: fresh.identities,
    validatedAt: "2026-07-20T00:00:01Z",
    readArtifact: (file) => fresh.artifacts.get(file),
  }), /database.*expired|stale/i);
});
