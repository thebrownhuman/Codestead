import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const operationsUrl = new URL("./application-image-operations.mjs", import.meta.url);
const operations = existsSync(operationsUrl) ? await import(operationsUrl) : {};

const EXPECTED_TARGETS = Object.freeze([
  { target: "runtime", variable: "APP_RUNTIME_IMAGE", repository: "runtime" },
  { target: "tooling", variable: "APP_TOOLING_IMAGE", repository: "tooling" },
  { target: "worker", variable: "APP_WORKER_IMAGE", repository: "worker" },
  { target: "regrade-worker", variable: "APP_REGRADE_WORKER_IMAGE", repository: "regrade-worker" },
  {
    target: "project-review-correction-worker",
    variable: "APP_PROJECT_REVIEW_WORKER_IMAGE",
    repository: "project-review-worker",
  },
  { target: "scanner-worker", variable: "APP_SCANNER_WORKER_IMAGE", repository: "scanner-worker" },
  { target: "operations", variable: "APP_OPERATIONS_IMAGE", repository: "operations" },
]);

const GENERATED_AT = "2026-07-19T00:00:00Z";
const SOURCE_REPOSITORY = "https://github.com/thebrownhuman/Codestead";
const SOURCE_REVISION = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);
const SOURCE_CONTEXT_SHA256 = "c".repeat(64);
const RELEASE = "20260719T000000Z-a";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => `sha256:${sha256(value)}`;
const RISK_ACCEPTANCE_TEXT = readFileSync(
  new URL("../../infra/security/application-image-local-risk-acceptance.json", import.meta.url),
  "utf8",
);
const RISK_ACCEPTANCE = operations.parseApplicationLocalRiskAcceptance({
  acceptanceText: RISK_ACCEPTANCE_TEXT, validatedAt: GENERATED_AT,
});

function identities(local = true) {
  return EXPECTED_TARGETS.map(({ target, variable, repository }) => {
    const manifestDigest = digest(`${target}:manifest`);
    return {
      target,
      variable,
      reference: `registry.example.test/codestead/${repository}@${manifestDigest}`,
      manifestDigest,
      configDigest: digest(`${target}:config`),
      rootDigest: local ? manifestDigest : digest(`${target}:root`),
      sourceRepository: SOURCE_REPOSITORY,
      sourceRevision: SOURCE_REVISION,
    };
  });
}

function minimalSpdx(target) {
  return `${JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `codestead-${target}`,
    documentNamespace: `https://codestead.example/spdx/${target}/${SOURCE_REVISION}`,
    creationInfo: {
      created: GENERATED_AT,
      creators: ["Tool: trivy-0.69.3"],
    },
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

function cleanTrivy(identity) {
  return `${JSON.stringify({
    SchemaVersion: 2,
    ArtifactName: identity.reference,
    ArtifactType: "container_image",
    Metadata: {
      ImageID: identity.configDigest,
      RepoDigests: [identity.reference],
    },
    Results: [],
  })}\n`;
}

test("the application gate has one exact canonical target-to-variable map", () => {
  assert.deepEqual(operations.APPLICATION_IMAGE_TARGETS, EXPECTED_TARGETS);
});

test("one deterministic build plan covers all seven exact linux/amd64 targets", () => {
  assert.equal(typeof operations.createApplicationBuildPlan, "function");
  const plan = operations.createApplicationBuildPlan({
    sourceDateEpoch: "1784419200",
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    registry: "registry.example.test/codestead",
    release: RELEASE,
    local: true,
  });

  assert.equal(plan.length, 7);
  assert.deepEqual(plan.map((entry) => entry.target), EXPECTED_TARGETS.map((entry) => entry.target));
  for (const entry of plan) {
    assert.deepEqual(entry.args.slice(0, 4), ["buildx", "build", "--platform", "linux/amd64"]);
    assert.ok(entry.args.includes("--pull=false"));
    assert.ok(entry.args.includes("--provenance=false"));
    assert.ok(entry.args.includes("--sbom=false"));
    assert.ok(entry.args.includes("--target"));
    assert.ok(entry.args.includes(entry.target));
    assert.ok(entry.args.includes(`SOURCE_REPOSITORY=${SOURCE_REPOSITORY}`));
    assert.ok(entry.args.includes(`SOURCE_REVISION=${SOURCE_REVISION}`));
    assert.ok(entry.args.includes(`SOURCE_TREE=${SOURCE_TREE}`));
    assert.ok(entry.args.includes(`SOURCE_CONTEXT_SHA256=${SOURCE_CONTEXT_SHA256}`));
    assert.ok(entry.args.includes("SOURCE_DATE_EPOCH=1784419200"));
    assert.match(entry.output, /^type=oci,dest=.*\.oci\.tar,rewrite-timestamp=true$/);
    assert.doesNotMatch(entry.tag, /:latest(?:$|@)/);
  }
});

test("the canonical application record binds source, timestamp, seven identities, and exact env projection", () => {
  assert.equal(typeof operations.createApplicationImageRecord, "function");
  assert.equal(typeof operations.validateApplicationImageRecord, "function");
  const publication = operations.createApplicationImageRecord({
    generatedAt: GENERATED_AT,
    release: RELEASE,
    local: true,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    identities: identities(),
  });
  const validated = operations.validateApplicationImageRecord({
    jsonText: publication.jsonText,
    envText: publication.envText,
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    validatedAt: "2026-07-19T01:00:00Z",
  });

  assert.equal(validated.recordId, publication.recordId);
  assert.deepEqual(validated.records.map((entry) => entry.target), EXPECTED_TARGETS.map((entry) => entry.target));
  assert.match(publication.envText, new RegExp(`^# application-image-record-id=${publication.recordId}$`, "m"));
  for (const { variable } of EXPECTED_TARGETS) {
    assert.equal(publication.envText.match(new RegExp(`^${variable}=`, "gm"))?.length, 1);
  }
});

test("record validation rejects missing, duplicate, stale, tampered, wrong-source, and mutable identities", () => {
  assert.equal(typeof operations.createApplicationImageRecord, "function");
  assert.equal(typeof operations.validateApplicationImageRecord, "function");
  const create = (items = identities()) => operations.createApplicationImageRecord({
    generatedAt: GENERATED_AT,
    release: RELEASE,
    local: true,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    identities: items,
  });

  assert.throws(() => create(identities().slice(0, 6)), /complete|seven|target/i);
  assert.throws(() => create([...identities().slice(0, 6), identities()[0]]), /duplicate|target/i);

  const duplicateDeployable = identities();
  duplicateDeployable[1] = {
    ...duplicateDeployable[1],
    reference: duplicateDeployable[0].reference,
    manifestDigest: duplicateDeployable[0].manifestDigest,
    configDigest: duplicateDeployable[0].configDigest,
    rootDigest: duplicateDeployable[0].rootDigest,
  };
  assert.throws(() => create(duplicateDeployable), /duplicate|identity/i);

  const mutable = identities();
  mutable[0] = { ...mutable[0], reference: "registry.example.test/codestead/runtime:latest" };
  assert.throws(() => create(mutable), /immutable|reference|digest/i);

  const valid = create();
  assert.throws(() => operations.validateApplicationImageRecord({
    jsonText: valid.jsonText,
    envText: valid.envText,
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: "b".repeat(40),
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    validatedAt: "2026-07-19T01:00:00Z",
  }), /revision/i);
  assert.throws(() => operations.validateApplicationImageRecord({
    jsonText: valid.jsonText,
    envText: valid.envText,
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    validatedAt: "2026-07-21T00:00:01Z",
  }), /stale|age/i);
  assert.throws(() => operations.validateApplicationImageRecord({
    jsonText: valid.jsonText,
    envText: valid.envText.replace("APP_RUNTIME_IMAGE=", "APP_RUNTIME_IMAGE=evil"),
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedSourceTree: SOURCE_TREE,
    expectedSourceContextSha256: SOURCE_CONTEXT_SHA256,
    validatedAt: "2026-07-19T01:00:00Z",
  }), /projection|record/i);
});

test("SPDX and Trivy evidence are bound to the exact deployable identity and fail closed", () => {
  assert.equal(typeof operations.validateApplicationScanArtifacts, "function");
  const identity = identities()[0];
  const spdxText = minimalSpdx(identity.target);
  const vulnerabilityText = cleanTrivy(identity);
  const binding = operations.validateApplicationScanArtifacts({
    identity,
    spdxText,
    vulnerabilityText,
  });

  assert.equal(binding.spdx.sha256, sha256(spdxText));
  assert.equal(binding.vulnerability.sha256, sha256(vulnerabilityText));
  assert.equal(binding.vulnerability.high, 0);
  assert.equal(binding.vulnerability.critical, 0);

  const vulnerable = JSON.parse(vulnerabilityText);
  vulnerable.Results = [{
    Target: identity.reference,
    Vulnerabilities: [{ VulnerabilityID: "CVE-test", Severity: "HIGH" }],
  }];
  assert.throws(() => operations.validateApplicationScanArtifacts({
    identity,
    spdxText,
    vulnerabilityText: JSON.stringify(vulnerable),
  }), /HIGH|CRITICAL|vulnerabil/i);

  const wrongTarget = JSON.parse(vulnerabilityText);
  wrongTarget.ArtifactName = identities()[1].reference;
  assert.throws(() => operations.validateApplicationScanArtifacts({
    identity,
    spdxText,
    vulnerabilityText: JSON.stringify(wrongTarget),
  }), /target|identity|reference/i);
  assert.throws(() => operations.validateApplicationScanArtifacts({
    identity,
    spdxText: "{}",
    vulnerabilityText,
  }), /SPDX|schema|malformed/i);
});

test("local provenance is explicit, clean, source-bound, identity-bound, and tamper evident", () => {
  assert.equal(typeof operations.createApplicationLocalProvenance, "function");
  assert.equal(typeof operations.validateApplicationLocalProvenance, "function");
  const identity = identities()[0];
  const inputs = ["Dockerfile", ".dockerignore", "package.json", "package-lock.json"]
    .map((file) => ({ file, sha256: digest(file).slice("sha256:".length) }));
  const evidence = operations.createApplicationLocalProvenance({
    generatedAt: GENERATED_AT,
    riskAcceptance: RISK_ACCEPTANCE,
    identity,
    baseReference: `node:22.23.1-alpine3.23@${digest("node-base")}`,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    dirty: false,
    builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
    inputs,
  });
  assert.deepEqual(operations.validateApplicationLocalProvenance({
    evidenceText: JSON.stringify(evidence),
    identity,
  }).riskAcceptance, RISK_ACCEPTANCE);

  assert.throws(() => operations.createApplicationLocalProvenance({
    generatedAt: GENERATED_AT,
    riskAcceptance: { artifact: RISK_ACCEPTANCE.artifact, sha256: "0".repeat(64) },
    identity,
    baseReference: `node:22.23.1-alpine3.23@${digest("node-base")}`,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    dirty: false,
    builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
    inputs,
  }), /accept|risk/i);
  assert.throws(() => operations.createApplicationLocalProvenance({
    generatedAt: GENERATED_AT,
    riskAcceptance: RISK_ACCEPTANCE,
    identity,
    baseReference: `node:22.23.1-alpine3.23@${digest("node-base")}`,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    dirty: true,
    builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
    inputs,
  }), /clean|dirty/i);
  const tampered = structuredClone(evidence);
  tampered.source.revision = "b".repeat(40);
  assert.throws(() => operations.validateApplicationLocalProvenance({
    evidenceText: JSON.stringify(tampered),
    identity,
  }), /source|tamper|revision/i);
});

test("publication durably commits the env projection before the canonical JSON marker", () => {
  assert.equal(typeof operations.publishApplicationImageRecordTransaction, "function");
  assert.equal(typeof operations.createApplicationImageRecord, "function");
  const publication = operations.createApplicationImageRecord({
    generatedAt: GENERATED_AT,
    release: RELEASE,
    local: true,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    sourceContextSha256: SOURCE_CONTEXT_SHA256,
    identities: identities(),
  });
  const events = [];
  operations.publishApplicationImageRecordTransaction({
    directory: "/evidence",
    publication,
    token: "test-token",
    writeStaging: (file) => events.push(["write", file]),
    flushStaging: (file) => events.push(["flush", file]),
    renameStaging: (from, to) => events.push(["rename", from, to]),
    removeStaging: (file) => events.push(["remove", file]),
    flushDirectory: (directory) => events.push(["flush-directory", directory]),
  });
  const envRename = events.findIndex((event) => event[0] === "rename" && event[2].endsWith("application-images.env"));
  const jsonRename = events.findIndex((event) => event[0] === "rename" && event[2].endsWith("application-images.json"));
  assert.ok(envRename >= 0);
  assert.ok(jsonRename > envRename);

  const failureEvents = [];
  assert.throws(() => operations.publishApplicationImageRecordTransaction({
    directory: "/evidence",
    publication,
    token: "failure-token",
    writeStaging: (file) => failureEvents.push(["write", file]),
    flushStaging: () => { throw new Error("disk failure"); },
    renameStaging: (from, to) => failureEvents.push(["rename", from, to]),
    removeStaging: (file) => failureEvents.push(["remove", file]),
    flushDirectory: () => {},
  }), /disk failure/);
  assert.equal(failureEvents.some((event) => event[0] === "rename" && event[2]?.endsWith("application-images.json")), false);
  assert.equal(failureEvents.filter((event) => event[0] === "remove").length, 2);
});

test("the official maintained SPDX schema remains the validation source", () => {
  const provenance = JSON.parse(readFileSync(
    new URL("../../services/runner/runtime/schema/spdx-2.3.schema.provenance.json", import.meta.url),
    "utf8",
  ));
  assert.equal(provenance.commit, "6cb525045cf86fa173d093cdf0b2e7ad4faee42f");
});
