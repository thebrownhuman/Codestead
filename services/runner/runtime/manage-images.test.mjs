import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildxArguments,
  createLocalBuildIdentityRecord,
  createHermeticScannerEnvironment,
  createLocalScanPlan,
  createScannerControlBundle,
  createScannerEvidence,
  createSpdxBinding,
  localImageReference,
  ociImageIdentityFromMembers,
  resolveLocalImageIdentity,
  requireSourceDateEpoch,
  REQUIRED_RUNTIME_CONTRACTS,
  runDeterministicLocalBuild,
  validateLocalBuildIdentityRecord,
  validateSpdxDocument,
} from "./runtime-operations.mjs";
import * as runtimeOperations from "./runtime-operations.mjs";


const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const BASE_DIGEST = `sha256:${"c".repeat(64)}`;
const SOURCE_REPOSITORY = "https://github.com/thebrownhuman/Codestead";
const SOURCE_REVISION = "d".repeat(40);

function hasPair(values, first, second) {
  return values.some((value, index) => value === first && values[index + 1] === second);
}

function buildOptions(overrides = {}) {
  return {
    publish: false,
    archive: path.join("secure", "c.oci.tar"),
    sourceDateEpoch: "1784332800",
    buildArguments: [
      "HARNESS_BUILD_IMAGE=alpine@sha256:base",
      "EXPECTED_LANGUAGE=c",
    ],
    tag: "learncoding/runtime-c:local",
    dockerfile: path.join("runtime", "Dockerfile"),
    context: "runtime",
    ...overrides,
  };
}

function validSpdxDocument(reference) {
  const rootId = "SPDXRef-Package-runtime";
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: reference,
    documentNamespace: `https://codestead.invalid/spdx/${reference.slice(reference.indexOf("sha256:") + 7)}`,
    creationInfo: {
      created: "2026-07-19T00:00:00Z",
      creators: ["Tool: Trivy-0.67.2"],
    },
    packages: [{
      SPDXID: rootId,
      name: "codestead-runtime",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
    }],
    relationships: [{
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rootId,
    }],
  };
}
function scannerControls() {
  const control = createScannerControlBundle(path.join("secure", "control"));
  const environment = createHermeticScannerEnvironment({
    hostEnvironment: { PATH: "trusted-bin" },
    homeDirectory: control.homeDirectory,
  });
  return { control, environment };
}

function scannerEvidenceFixture(generatedAt = "2026-07-19T00:00:00Z") {
  const controls = [
    ["trivy-config", "scanner-control-trivy.json", "offline: true\n"],
    ["syft-config", "scanner-control-syft.json", "check-for-app-update: false\n"],
    ["grype-config", "scanner-control-grype.json", "db: offline\n"],
    ["trivy-ignore", "scanner-control-ignore.json", ""],
  ].map(([name, file, text]) => ({ name, file, text }));
  const databases = ["trivy-db", "trivy-java-db"].map((name) => ({
    name,
    file: `scanner-${name}.json`,
    text: `${JSON.stringify({
      Version: name === "trivy-db" ? 2 : 1,
      UpdatedAt: "2026-07-18T00:00:00Z",
      NextUpdate: "2026-07-20T00:00:00Z",
      DownloadedAt: "2026-07-18T12:00:00Z",
    })}\n`,
  }));
  return {
    evidence: createScannerEvidence({
      generatedAt,
      tools: [{ name: "trivy", version: "Version: 0.69.3" }],
      controls,
      databases,
    }),
    artifacts: new Map([
      ...controls.map((entry) => [entry.file, entry.text]),
      ...databases.map((entry) => [entry.file, entry.text]),
    ]),
  };
}

test("hermetic command execution uses only the reviewed scanner environment", () => {
  assert.equal(typeof runtimeOperations.resolveCommandEnvironment, "function");
  const hostEnvironment = {
    PATH: "host-bin",
    HOME: "hostile-home",
    TRIVY_IGNORE_UNFIXED: "true",
    HTTPS_PROXY: "https://hostile.invalid",
  };
  const reviewedEnvironment = { PATH: "trusted-bin", HOME: "isolated-home" };

  assert.deepEqual(
    runtimeOperations.resolveCommandEnvironment(hostEnvironment, {
      env: reviewedEnvironment,
      hermeticEnvironment: true,
    }),
    reviewedEnvironment,
  );
  assert.deepEqual(
    runtimeOperations.resolveCommandEnvironment(hostEnvironment, { env: { PATH: "override-bin" } }),
    { ...hostEnvironment, PATH: "override-bin" },
  );

  const scannerEnvironment = createHermeticScannerEnvironment({
    hostEnvironment: {
      PATH: "trusted-bin",
      TRIVY_CACHE_DIR: "hostile-cache",
    },
    homeDirectory: path.join("secure", "home"),
    trivyCacheDirectory: path.join("trusted", "trivy-cache"),
  });
  assert.equal(scannerEnvironment.TRIVY_CACHE_DIR, path.join("trusted", "trivy-cache"));
  assert.notEqual(scannerEnvironment.TRIVY_CACHE_DIR, "hostile-cache");
});

test("release evidence requires current immutable identities and every runtime contract gate", () => {
  assert.equal(typeof runtimeOperations.validateRuntimeReleaseGateEvidence, "function");
  const tag = "learncoding/runtime-c:local";
  const imageReference = `learncoding/runtime-c@${DIGEST}`;
  const expected = [{
    language: "c",
    tag,
    imageReference,
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    rootDigest: DIGEST,
  }];
  const inspection = {
    generatedAt: "2026-07-19T00:00:00Z",
    images: [{ language: "c", tag, imageReference, manifestDigest: DIGEST, configDigest: OTHER_DIGEST, rootDigest: DIGEST }],
  };
  const contract = {
    generatedAt: "2026-07-19T00:01:00Z",
    images: { c: imageReference },
    results: REQUIRED_RUNTIME_CONTRACTS.map((name) => ({ name, status: "passed" })),
  };
  const executor = {
    generatedAt: "2026-07-19T00:02:00Z",
    refs: { c: imageReference },
    passed: [
      "real executor: compile/run/stdin",
      "real executor: hidden-data redaction",
      "real executor: output cap and forced cleanup",
      "real executor: cross-job source cleanup",
    ],
  };
  const validate = (overrides = {}) => runtimeOperations.validateRuntimeReleaseGateEvidence({
    inspectionText: JSON.stringify(overrides.inspection ?? inspection),
    contractText: JSON.stringify(overrides.contract ?? contract),
    executorText: JSON.stringify(overrides.executor ?? executor),
    expected,
  });
  assert.equal(validate().contract.results.length, 17);

  assert.throws(() => validate({
    inspection: {
      ...inspection,
      images: [{ ...inspection.images[0], manifestDigest: OTHER_DIGEST }],
    },
  }), /inspection.*immutable identity/i);
  assert.throws(() => validate({
    contract: {
      ...contract,
      results: contract.results.map((result, index) => (
        index === 0 ? { ...result, status: "failed" } : result
      )),
    },
  }), /contract.*(?:failed or incomplete|exact unique required)/i);
  assert.throws(() => validate({
    executor: {
      ...executor,
      refs: { c: `learncoding/runtime-c@${OTHER_DIGEST}` },
    },
  }), /executor.*immutable identity/i);
  assert.throws(() => validate({
    executor: {
      ...executor,
      passed: executor.passed.slice(0, -1),
    },
  }), /executor.*failed or incomplete/i);
  assert.throws(() => validate({
    inspection: {
      ...inspection,
      images: [{ ...inspection.images[0], configDigest: DIGEST }],
    },
  }), /inspection.*immutable identity/i);
});

test("real runtime reports preserve the immutable references exercised by both contract layers", () => {
  const contractSource = readFileSync(new URL("./test-runtime-images.mjs", import.meta.url), "utf8");
  const executorSource = readFileSync(new URL("./test-runner-executor.mjs", import.meta.url), "utf8");
  assert.match(contractSource, /function immutableLocalReference\(/);
  assert.match(contractSource, /const images = Object\.fromEntries\(/);
  assert.match(contractSource, /resolveLocalImageIdentity\(/);
  assert.match(contractSource, /validateLocalBuildIdentityRecord\(/);
  assert.match(contractSource, /runtime-local-build-identities\.json/);
  assert.match(
    contractSource,
    /\[\s*"image",\s*"inspect",\s*"--platform",\s*"linux\/amd64",\s*reference,?\s*\]/,
  );
  assert.match(executorSource, /resolveLocalImageIdentity\(/);
  assert.match(executorSource, /validateLocalBuildIdentityRecord\(/);
  assert.match(executorSource, /runtime-local-build-identities\.json/);
  assert.match(
    executorSource,
    /\[\s*"image",\s*"inspect",\s*"--platform",\s*"linux\/amd64",\s*reference,?\s*\]/,
  );
  assert.doesNotMatch(contractSource, /exactReference\s*=\s*`[^`]*\$\{configDigest\}/);
  assert.doesNotMatch(executorSource, /`[^`]*@\$\{id\}`/);
  assert.match(
    contractSource,
    /JSON\.stringify\(\{ generatedAt: new Date\(\)\.toISOString\(\), images, results \}/,
  );
  assert.match(
    executorSource,
    /JSON\.stringify\(\{ generatedAt: new Date\(\)\.toISOString\(\), refs, passed: passedChecks \}/,
  );
});

test("the runtime manager routes scan and record through the reviewed atomic evidence gates", () => {
  const managerSource = readFileSync(new URL("./manage-images.mjs", import.meta.url), "utf8");
  for (const requiredCall of [
    "createScannerControlBundle",
    "createHermeticScannerEnvironment",
    "createLocalBuildIdentityRecord",
    "validateLocalBuildIdentityRecord",
    "createLocalProvenanceEvidence",
    "createRuntimeImageRecord",
    "extractAttestedSpdxFromMembers",
    "publishRuntimeImageRecordTransaction",
    "resolveCommandEnvironment",
    "runRuntimeSecurityScan",
    "validateRuntimeImageRecord",
    "validateRuntimeSecurityEvidence",
    "validateRuntimeReleaseGateEvidence",
  ]) {
    assert.match(managerSource, new RegExp(`\\b${requiredCall}\\b`), `${requiredCall} is not wired into manage-images`);
  }
  assert.match(managerSource, /runtime-local-build-identities\.json/);
  assert.match(managerSource, /const identities = runDeterministicLocalBuild\(/);
  assert.match(
    managerSource,
    /imageReference:\s*`\$\{repositoryWithoutTag\(tag\)\}@\$\{manifestDigest\}`/,
  );
  assert.match(
    managerSource,
    /\[\s*"image",\s*"inspect",\s*"--platform",\s*"linux\/amd64",\s*reference,?\s*\]/,
  );
  assert.doesNotMatch(managerSource, /function extractAttestedSbom\(/);
  assert.match(managerSource, /validatedAt:\s*new Date\(\)\.toISOString\(\)/);
  assert.match(managerSource, /RUNTIME_COSIGN_CERTIFICATE_IDENTITY/);
  assert.match(managerSource, /RUNTIME_COSIGN_CERTIFICATE_OIDC_ISSUER/);
  assert.match(managerSource, /Object\.hasOwn\(labels, "org\.opencontainers\.image\.source"\)/);
  assert.match(managerSource, /Object\.hasOwn\(labels, "org\.opencontainers\.image\.revision"\)/);
});

test("the runner package test gate executes the runtime manager product tests", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /node --test runtime\/manage-images\.test\.mjs/);
});

function localSecurityRecord(identity) {
  const spdxText = `${JSON.stringify(validSpdxDocument(identity.imageReference))}\n`;
  const provenanceText = `${JSON.stringify(runtimeOperations.createLocalProvenanceEvidence({
    generatedAt: "2026-07-19T00:00:00Z",
    acceptance: runtimeOperations.LOCAL_PROVENANCE_ACCEPTANCE,
    exactReference: identity.imageReference,
    configDigest: identity.configDigest,
    rootDigest: identity.rootDigest,
    baseReference: `docker.io/library/alpine@${BASE_DIGEST}`,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    dirty: false,
    builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
    inputs: [
      { name: "Dockerfile", file: "Dockerfile", sha256: "1".repeat(64) },
      { name: "harness.c", file: "harness.c", sha256: "2".repeat(64) },
      { name: "images.env", file: "images.env", sha256: "3".repeat(64) },
    ],
  }))}\n`;
  const bindingText = `${JSON.stringify(createSpdxBinding({
    exactReference: identity.imageReference,
    documentText: spdxText,
  }))}\n`;
  return {
    language: identity.language,
    tag: identity.tag,
    imageReference: identity.imageReference,
    manifestDigest: identity.manifestDigest,
    configDigest: identity.configDigest,
    rootDigest: identity.rootDigest,
    spdxFile: `${identity.language}.spdx.json`,
    spdxText,
    bindingFile: `${identity.language}.spdx.target.json`,
    bindingText,
    vulnerabilityScanner: "trivy",
    vulnerabilityFile: `${identity.language}.trivy.json`,
    vulnerabilityText: '{"Results":[]}\n',
    provenanceFile: `${identity.language}.local-provenance.json`,
    provenanceText,
  };
}

test("runtime scan freezes identities, publishes one complete manifest, and rechecks tags before success", () => {
  assert.equal(typeof runtimeOperations.runRuntimeSecurityScan, "function");
  const events = [];
  const identity = {
    language: "c",
    tag: "learncoding/runtime-c:local",
    imageReference: `learncoding/runtime-c@${DIGEST}`,
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    rootDigest: DIGEST,
  };
  let manifestText;
  const result = runtimeOperations.runRuntimeSecurityScan({
    release: "local",
    mode: "local",
    languages: ["c"],
    destination: "runtime-security",
    failedDestination: "runtime-security.failed",
    createStaging: () => "runtime-security.staging",
    removeTree: (target) => events.push(["remove", target]),
    renameTree: (from, to) => events.push(["rename", from, to]),
    resolveIdentity: (language) => {
      events.push(["freeze", language]);
      return identity;
    },
    scanIdentity: ({ staging, identity: frozen }) => {
      events.push(["scan", staging, frozen.manifestDigest]);
      return localSecurityRecord(frozen);
    },
    createScannerEvidenceForStaging: () => scannerEvidenceFixture().evidence,
    recheckIdentity: (frozen) => {
      events.push(["recheck", frozen.language]);
      return { ...identity };
    },
    generatedAt: "2026-07-19T00:00:00Z",
    writeManifest: (staging, file, text) => {
      events.push(["manifest", staging, file]);
      manifestText = text;
    },
  });

  const manifest = JSON.parse(manifestText);
  assert.equal(result.manifest.complete, true);
  assert.equal(manifest.records[0].manifestDigest, DIGEST);
  assert.equal(manifest.records[0].rootDigest, DIGEST);
  assert.ok(events.findIndex((event) => event[0] === "freeze") < events.findIndex((event) => event[0] === "scan"));
  assert.ok(events.findIndex((event) => event[0] === "scan") < events.findIndex((event) => event[0] === "recheck"));
  assert.deepEqual(events.at(-1), ["rename", "runtime-security.staging", "runtime-security"]);
});

test("runtime scan rejects a moved tag and preserves only failed diagnostics", () => {
  assert.equal(typeof runtimeOperations.runRuntimeSecurityScan, "function");
  const events = [];
  const identity = {
    language: "c",
    tag: "learncoding/runtime-c:local",
    imageReference: `learncoding/runtime-c@${DIGEST}`,
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    rootDigest: DIGEST,
  };
  assert.throws(() => runtimeOperations.runRuntimeSecurityScan({
    release: "local",
    mode: "local",
    languages: ["c"],
    destination: "runtime-security",
    failedDestination: "runtime-security.failed",
    createStaging: () => "runtime-security.staging",
    removeTree: (target) => events.push(["remove", target]),
    renameTree: (from, to) => events.push(["rename", from, to]),
    resolveIdentity: () => identity,
    scanIdentity: ({ identity: frozen }) => localSecurityRecord(frozen),
    createScannerEvidenceForStaging: () => scannerEvidenceFixture().evidence,
    recheckIdentity: () => ({
      ...identity,
      manifestDigest: OTHER_DIGEST,
      imageReference: `learncoding/runtime-c@${OTHER_DIGEST}`,
    }),
    generatedAt: "2026-07-19T00:00:00Z",
    writeManifest: () => events.push(["manifest"]),
  }), /changed during the runtime security gate/i);
  assert.ok(!events.some((event) => event[0] === "manifest"));
  assert.deepEqual(events.at(-1), ["rename", "runtime-security.staging", "runtime-security.failed"]);
  assert.ok(!events.some((event) => event[0] === "rename" && event[2] === "runtime-security"));
});

test("requires a canonical decimal runtime source date epoch", () => {
  assert.equal(
    requireSourceDateEpoch({ RUNTIME_SOURCE_DATE_EPOCH: "1784332800" }),
    "1784332800",
  );
  assert.equal(requireSourceDateEpoch({ RUNTIME_SOURCE_DATE_EPOCH: "0" }), "0");

  for (const value of [undefined, "", " 1784332800", "1784332800 ", "01", "-1", "1.5", "1e9", "+1"]) {
    assert.throws(
      () => requireSourceDateEpoch(value === undefined ? {} : { RUNTIME_SOURCE_DATE_EPOCH: value }),
      /RUNTIME_SOURCE_DATE_EPOCH.*canonical decimal/i,
    );
  }
});

test("constructs a deterministic local OCI export without embedded attestations", () => {
  const args = buildxArguments(buildOptions());

  assert.ok(hasPair(args, "--platform", "linux/amd64"));
  assert.ok(hasPair(args, "--output", `type=oci,dest=${path.join("secure", "c.oci.tar")},rewrite-timestamp=true`));
  assert.ok(hasPair(args, "--build-arg", "SOURCE_DATE_EPOCH=1784332800"));
  assert.ok(args.includes("--provenance=false"));
  assert.ok(args.includes("--sbom=false"));
  assert.ok(!args.includes("--load"));
  assert.ok(!args.includes("--push"));
  assert.ok(!args.includes("--provenance=mode=max"));
  assert.ok(!args.includes("--sbom=true"));
});

test("preserves immutable attested registry push construction", () => {
  const args = buildxArguments(buildOptions({
    publish: true,
    archive: undefined,
    sourceDateEpoch: undefined,
    tag: "registry.example/learncoding/runtime-c:2026-07-19.1",
  }));

  assert.ok(args.includes("--push"));
  assert.ok(args.includes("--provenance=mode=max"));
  assert.ok(args.includes("--sbom=true"));
  assert.ok(!args.includes("--load"));
  assert.ok(!args.includes("--provenance=false"));
  assert.ok(!args.includes("--sbom=false"));
  assert.ok(!args.some((value) => value.startsWith("SOURCE_DATE_EPOCH=")));
  assert.ok(!args.includes("--output"));
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validOciMembers() {
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux" }));
  const configDigest = sha256(config);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: config.length,
    },
    layers: [],
  }));
  const manifestDigest = sha256(manifest);
  const index = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: manifestDigest,
      size: manifest.length,
      platform: { os: "linux", architecture: "amd64" },
    }],
  }));
  return {
    configDigest,
    manifestDigest,
    members: new Map([
      ["index.json", index],
      [`blobs/sha256/${manifestDigest.slice(7)}`, manifest],
      [`blobs/sha256/${configDigest.slice(7)}`, config],
    ]),
  };
}

function attestedSpdxMembers({ subjectDigest = DIGEST } = {}) {
  const document = validSpdxDocument("buildkit-generated-runtime-sbom");
  const statement = Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: "runtime", digest: { sha256: subjectDigest.slice("sha256:".length) } }],
    predicateType: "https://spdx.dev/Document",
    predicate: document,
  }));
  const statementDigest = sha256(statement);
  const provenanceStatement = Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: "runtime", digest: { sha256: subjectDigest.slice("sha256:".length) } }],
    predicateType: "https://slsa.dev/provenance/v0.2",
    predicate: {
      builder: { id: "https://mobyproject.org/buildkit@v1" },
      buildType: "https://mobyproject.org/buildkit@v1",
      invocation: { parameters: { args: {
        "build-arg:SOURCE_REPOSITORY": SOURCE_REPOSITORY,
        "build-arg:SOURCE_REVISION": SOURCE_REVISION,
      } } },
      materials: [{
        uri: "pkg:docker/alpine@3.23.3",
        digest: { sha256: BASE_DIGEST.slice(7) },
      }],
    },
  }));
  const provenanceStatementDigest = sha256(provenanceStatement);
  const matchingAttestation = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: OTHER_DIGEST, size: 2 },
    layers: [{
      mediaType: "application/vnd.in-toto+json",
      digest: statementDigest,
      size: statement.length,
      annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
    }, {
      mediaType: "application/vnd.in-toto+json",
      digest: provenanceStatementDigest,
      size: provenanceStatement.length,
      annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v0.2" },
    }],
  }));
  const matchingAttestationDigest = sha256(matchingAttestation);
  const wrongStatement = Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: "wrong", digest: { sha256: OTHER_DIGEST.slice(7) } }],
    predicateType: "https://spdx.dev/Document",
    predicate: document,
  }));
  const wrongStatementDigest = sha256(wrongStatement);
  const wrongAttestation = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: OTHER_DIGEST, size: 2 },
    layers: [{
      mediaType: "application/vnd.in-toto+json",
      digest: wrongStatementDigest,
      size: wrongStatement.length,
      annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
    }],
  }));
  const wrongAttestationDigest = sha256(wrongAttestation);
  const imageIndex = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: DIGEST,
        size: 123,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: wrongAttestationDigest,
        size: wrongAttestation.length,
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": OTHER_DIGEST,
        },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: matchingAttestationDigest,
        size: matchingAttestation.length,
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": DIGEST,
        },
      },
    ],
  }));
  const rootDigest = sha256(imageIndex);
  const archiveIndex = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: rootDigest,
      size: imageIndex.length,
    }],
  }));
  return {
    rootDigest,
    matchingAttestationDigest,
    statementDigest,
    provenanceStatementDigest,
    members: new Map([
      ["index.json", archiveIndex],
      [`blobs/sha256/${rootDigest.slice(7)}`, imageIndex],
      [`blobs/sha256/${matchingAttestationDigest.slice(7)}`, matchingAttestation],
      [`blobs/sha256/${wrongAttestationDigest.slice(7)}`, wrongAttestation],
      [`blobs/sha256/${statementDigest.slice(7)}`, statement],
      [`blobs/sha256/${provenanceStatementDigest.slice(7)}`, provenanceStatement],
      [`blobs/sha256/${wrongStatementDigest.slice(7)}`, wrongStatement],
    ]),
  };
}

test("selects the pushed SPDX attestation linked to the linux/amd64 child and verifies its subject", () => {
  assert.equal(typeof runtimeOperations.extractAttestedSpdxFromMembers, "function");
  const fixture = attestedSpdxMembers();
  const actual = runtimeOperations.extractAttestedSpdxFromMembers({
    readMember: (member) => fixture.members.get(member),
    expectedRootDigest: fixture.rootDigest,
    expectedChildDigest: DIGEST,
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    requiredMaterialDigests: [BASE_DIGEST],
  });
  assert.equal(actual.attestationManifestDigest, fixture.matchingAttestationDigest);
  assert.equal(actual.statementDigest, fixture.statementDigest);
  assert.equal(actual.provenanceStatementDigest, fixture.provenanceStatementDigest);
  assert.equal(actual.provenance.sourceRevision, SOURCE_REVISION);
  assert.equal(
    actual.statementText,
    fixture.members.get(`blobs/sha256/${fixture.statementDigest.slice(7)}`).toString("utf8"),
  );
  assert.equal(JSON.parse(actual.documentText).name, "buildkit-generated-runtime-sbom");
  assert.equal(JSON.parse(actual.statementText).subject[0].digest.sha256, DIGEST.slice(7));
});

test("rejects a pushed SPDX attestation whose in-toto subject does not match the child", () => {
  const fixture = attestedSpdxMembers({ subjectDigest: OTHER_DIGEST });
  assert.throws(() => runtimeOperations.extractAttestedSpdxFromMembers({
    readMember: (member) => fixture.members.get(member),
    expectedRootDigest: fixture.rootDigest,
    expectedChildDigest: DIGEST,
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    requiredMaterialDigests: [BASE_DIGEST],
  }), /in-toto subject.*child manifest/i);
});

test("binds registry SPDX bytes only through a verified in-toto subject", () => {
  const fixture = attestedSpdxMembers();
  const extracted = runtimeOperations.extractAttestedSpdxFromMembers({
    readMember: (member) => fixture.members.get(member),
    expectedRootDigest: fixture.rootDigest,
    expectedChildDigest: DIGEST,
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    requiredMaterialDigests: [BASE_DIGEST],
  });
  const reference = `registry.example/runtime-c@${DIGEST}`;
  const binding = createSpdxBinding({
    exactReference: reference,
    documentText: extracted.documentText,
    targetProof: "in-toto-subject",
    attestationText: extracted.statementText,
  });
  assert.equal(binding.targetProof, "in-toto-subject");
  assert.equal(binding.manifestDigest, DIGEST);
  assert.equal(binding.attestationSha256, createHash("sha256").update(extracted.statementText).digest("hex"));

  const wrongStatement = JSON.parse(extracted.statementText);
  wrongStatement.subject[0].digest.sha256 = OTHER_DIGEST.slice(7);
  assert.throws(() => createSpdxBinding({
    exactReference: reference,
    documentText: extracted.documentText,
    targetProof: "in-toto-subject",
    attestationText: JSON.stringify(wrongStatement),
  }), /in-toto subject.*image digest/i);
});

test("persists and revalidates registry attestation bytes with the immutable runtime identity", () => {
  assert.equal(typeof runtimeOperations.createRuntimeSecurityEvidence, "function");
  assert.equal(typeof runtimeOperations.validateRuntimeSecurityEvidence, "function");
  const fixture = attestedSpdxMembers();
  const extracted = runtimeOperations.extractAttestedSpdxFromMembers({
    readMember: (member) => fixture.members.get(member),
    expectedRootDigest: fixture.rootDigest,
    expectedChildDigest: DIGEST,
    expectedSourceRepository: SOURCE_REPOSITORY,
    expectedSourceRevision: SOURCE_REVISION,
    requiredMaterialDigests: [BASE_DIGEST],
  });
  const tag = "registry.example/runtime-c:release";
  const imageReference = `registry.example/runtime-c@${DIGEST}`;
  const bindingText = `${JSON.stringify(createSpdxBinding({
    exactReference: imageReference,
    documentText: extracted.documentText,
    targetProof: "in-toto-subject",
    attestationText: extracted.statementText,
  }))}\n`;
  const certificateIdentity = "https://github.com/thebrownhuman/Codestead/.github/workflows/release.yml@refs/heads/main";
  const certificateIssuer = "https://token.actions.githubusercontent.com";
  const cosignSignatureText = JSON.stringify([{
    critical: {
      identity: { "docker-reference": "registry.example/runtime-c" },
      image: { "docker-manifest-digest": DIGEST },
      type: "cosign container image signature",
    },
    optional: { Issuer: certificateIssuer, Subject: certificateIdentity },
  }]);
  const cosignAttestationText = JSON.stringify([{
    payload: Buffer.from(extracted.provenanceText).toString("base64"),
    optional: { Issuer: certificateIssuer, Subject: certificateIdentity },
  }]);
  const record = {
    language: "c",
    tag,
    imageReference,
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    rootDigest: fixture.rootDigest,
    targetProof: "in-toto-subject",
    spdxFile: "c.spdx.json",
    spdxText: extracted.documentText,
    bindingFile: "c.spdx.target.json",
    bindingText,
    attestationFile: "c.spdx.attestation.json",
    attestationText: extracted.statementText,
    provenanceFile: "c.slsa-provenance.json",
    provenanceText: extracted.provenanceText,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    requiredMaterialDigests: [BASE_DIGEST],
    cosignSignatureFile: "c.cosign-signature.json",
    cosignSignatureText,
    cosignAttestationFile: "c.cosign-slsa-attestation.json",
    cosignAttestationText,
    certificateIdentity,
    certificateIssuer,
    vulnerabilityScanner: "trivy",
    vulnerabilityFile: "c.trivy.json",
    vulnerabilityText: '{"Results":[]}\n',
  };
  const scanner = scannerEvidenceFixture();
  const manifest = runtimeOperations.createRuntimeSecurityEvidence({
    release: "release",
    mode: "registry",
    generatedAt: "2026-07-19T00:00:00Z",
    expectedLanguages: ["c"],
    scannerEvidence: scanner.evidence,
    records: [record],
  });
  assert.equal(manifest.records[0].targetProof, "in-toto-subject");
  assert.deepEqual(manifest.records[0].attestation, {
    file: record.attestationFile,
    sha256: createHash("sha256").update(record.attestationText).digest("hex"),
  });  assert.equal(manifest.records[0].provenance.kind, "slsa-buildkit");
  assert.equal(manifest.records[0].cosign.certificateIdentity, certificateIdentity);

  const artifacts = new Map([
    ...scanner.artifacts,
    [record.spdxFile, record.spdxText],
    [record.bindingFile, record.bindingText],
    [record.attestationFile, record.attestationText],
    [record.provenanceFile, record.provenanceText],
    [record.cosignSignatureFile, record.cosignSignatureText],
    [record.cosignAttestationFile, record.cosignAttestationText],
    [record.vulnerabilityFile, record.vulnerabilityText],
  ]);
  const expected = [{
    language: "c",
    tag,
    imageReference,
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    rootDigest: fixture.rootDigest,
  }];
  const validate = (manifestValue = manifest, expectedValue = expected) => (
    runtimeOperations.validateRuntimeSecurityEvidence({
    manifestText: `${JSON.stringify(manifestValue)}\n`,
    release: "release",
    mode: "registry",
    expected: expectedValue,
    readArtifact: (file) => artifacts.get(file),
  }));
  assert.equal(validate().records[0].manifestDigest, DIGEST);
  assert.throws(
    () => validate(manifest, [{
      ...expected[0],
      imageReference: `registry.example/other-runtime-c@${DIGEST}`,
    }]),
    /stale.*reference|immutable.*reference/i,
  );
  assert.throws(
    () => validate({ ...manifest, generatedAt: "not-a-timestamp" }),
    /generation timestamp/i,
  );

  const tamperedStatement = JSON.parse(record.attestationText);
  tamperedStatement.subject[0].digest.sha256 = OTHER_DIGEST.slice(7);
  artifacts.set(record.attestationFile, JSON.stringify(tamperedStatement));
  assert.throws(validate, /attestation artifact checksum does not match/i);
});

test("keeps the Docker-addressable manifest digest distinct from the OCI config digest", () => {
  const fixture = validOciMembers();
  const actual = ociImageIdentityFromMembers((member) => {
    const value = fixture.members.get(member);
    if (!value) throw new Error(`missing ${member}`);
    return value;
  });

  assert.deepEqual(actual, {
    manifestDigest: fixture.manifestDigest,
    configDigest: fixture.configDigest,
  });
  assert.notEqual(actual.manifestDigest, actual.configDigest);
});

test("fails closed when an OCI descriptor is missing or does not match its content", () => {
  const missing = validOciMembers();
  missing.members.delete(`blobs/sha256/${missing.configDigest.slice(7)}`);
  assert.throws(
    () => ociImageIdentityFromMembers((member) => {
      const value = missing.members.get(member);
      if (!value) throw new Error(`missing ${member}`);
      return value;
    }),
    /missing.*OCI image config/i,
  );

  const corrupt = validOciMembers();
  corrupt.members.set(`blobs/sha256/${corrupt.configDigest.slice(7)}`, Buffer.from("corrupt"));
  assert.throws(
    () => ociImageIdentityFromMembers((member) => corrupt.members.get(member)),
    /OCI image config digest does not match/i,
  );
});

function localBuildHarness(overrides = {}) {
  const events = [];
  const options = {
    runtimes: [{ id: "c", tag: "learncoding/runtime-c:local" }],
    temporaryPrefix: path.join("tmp", "learncoding-runtime-build-"),
    createTemporaryDirectory(prefix) {
      events.push(["create", prefix]);
      return path.join("tmp", "learncoding-runtime-build-secure");
    },
    removeTemporaryDirectory(directory) {
      events.push(["remove", directory]);
    },
    buildArchive(runtime, archive) {
      events.push(["build", runtime.id, archive]);
    },
    readArchiveIdentity(archive) {
      events.push(["identity", archive]);
      return { manifestDigest: DIGEST, configDigest: OTHER_DIGEST };
    },
    loadArchive(archive) {
      events.push(["load", archive]);
    },
    inspectImage(reference) {
      events.push(["inspect", reference]);
      return {
        Id: OTHER_DIGEST,
        Descriptor: { digest: DIGEST },
      };
    },
    exactReference(runtime, digest) {
      return localImageReference(`learncoding/runtime-${runtime.id}`, digest);
    },
    ...overrides,
  };
  return { events, options };
}

test("loads an OCI archive and binds the expected tag to its exact image identity", () => {
  const harness = localBuildHarness();
  const identities = runDeterministicLocalBuild(harness.options);

  assert.deepEqual(identities, [{
    id: "c",
    tag: "learncoding/runtime-c:local",
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    reference: `learncoding/runtime-c@${DIGEST}`,
  }]);
  assert.ok(harness.events.some((event) => event[0] === "inspect" && event[1] === "learncoding/runtime-c:local"));
  assert.ok(harness.events.some((event) => event[0] === "inspect" && event[1] === `learncoding/runtime-c@${DIGEST}`));
  assert.equal(harness.events.at(-1)[0], "remove");
});

test("loads an OCI archive when Docker's containerd image store exposes the manifest as Id", () => {
  const harness = localBuildHarness({
    inspectImage() {
      return {
        Id: DIGEST,
        Descriptor: { digest: DIGEST },
      };
    },
  });

  assert.deepEqual(runDeterministicLocalBuild(harness.options), [{
    id: "c",
    tag: "learncoding/runtime-c:local",
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    reference: `learncoding/runtime-c@${DIGEST}`,
  }]);
  assert.equal(harness.events.at(-1)[0], "remove");
});

test("removes the secure temporary directory after build failure", () => {
  const harness = localBuildHarness({
    buildArchive() {
      throw new Error("build failed");
    },
  });

  assert.throws(() => runDeterministicLocalBuild(harness.options), /build failed/);
  assert.equal(harness.events.at(-1)[0], "remove");
});

test("removes the secure temporary directory after load failure", () => {
  const harness = localBuildHarness({
    loadArchive() {
      throw new Error("load failed");
    },
  });

  assert.throws(() => runDeterministicLocalBuild(harness.options), /load failed/);
  assert.equal(harness.events.at(-1)[0], "remove");
});

test("fails closed and cleans up when the loaded tag differs from the archive identity", () => {
  const harness = localBuildHarness({
    inspectImage(reference) {
      return {
        Id: OTHER_DIGEST,
        Descriptor: { digest: reference.includes(":local") ? OTHER_DIGEST : DIGEST },
      };
    },
  });

  assert.throws(
    () => runDeterministicLocalBuild(harness.options),
    /loaded tag.*does not match.*OCI archive manifest identity/i,
  );
  assert.equal(harness.events.at(-1)[0], "remove");
});

test("round-trips the exact five-language local build identity handoff", () => {
  const languages = ["c", "cpp", "java", "python", "javascript"];
  const identities = languages.map((language, index) => ({
    id: language,
    tag: `learncoding/runtime-${language}:local`,
    manifestDigest: `sha256:${String(index + 1).repeat(64)}`,
    configDigest: `sha256:${"6789a"[index].repeat(64)}`,
    reference: `learncoding/runtime-${language}@sha256:${String(index + 1).repeat(64)}`,
  }));
  const text = createLocalBuildIdentityRecord(identities);
  const record = validateLocalBuildIdentityRecord(text, languages.map((language) => ({
    language,
    tag: `learncoding/runtime-${language}:local`,
  })));

  assert.deepEqual(Object.values(record), identities);
  assert.throws(
    () => validateLocalBuildIdentityRecord(text.replace(identities[0].configDigest, identities[0].manifestDigest), languages.map((language) => ({ language, tag: `learncoding/runtime-${language}:local` }))),
    /manifest and config identities.*distinct/i,
  );
});

test("local build identity records support configured runtime repositories", () => {
  const identities = ["c", "cpp", "java", "python", "javascript"].map((language, index) => ({
    id: language,
    tag: `registry.example.test/codestead/runtime-${language}:local`,
    manifestDigest: `sha256:${"abcde"[index].repeat(64)}`,
    configDigest: `sha256:${"56789"[index].repeat(64)}`,
    reference: `registry.example.test/codestead/runtime-${language}@sha256:${"abcde"[index].repeat(64)}`,
  }));

  const record = validateLocalBuildIdentityRecord(
    createLocalBuildIdentityRecord(identities),
    identities.map((identity) => ({ language: identity.id, tag: identity.tag })),
  );

  assert.equal(record.javascript.reference, identities[4].reference);
});

test("resolves a containerd-backed local identity using the archive-verified config handoff", () => {
  const identity = resolveLocalImageIdentity({
    language: "c",
    tag: "learncoding/runtime-c:local",
    repository: "learncoding/runtime-c",
    expectedIdentity: { manifestDigest: DIGEST, configDigest: OTHER_DIGEST },
    inspectImage: () => ({ Id: DIGEST, Descriptor: { digest: DIGEST } }),
  });

  assert.deepEqual(identity, {
    language: "c",
    tag: "learncoding/runtime-c:local",
    imageReference: `learncoding/runtime-c@${DIGEST}`,
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    rootDigest: DIGEST,
  });
  assert.throws(() => resolveLocalImageIdentity({
    language: "c",
    tag: "learncoding/runtime-c:local",
    repository: "learncoding/runtime-c",
    expectedIdentity: { manifestDigest: OTHER_DIGEST, configDigest: BASE_DIGEST },
    inspectImage: () => ({ Id: DIGEST, Descriptor: { digest: DIGEST } }),
  }), /expected local manifest identity/i);
});

test("resolves a Docker-local manifest reference without conflating it with the image config ID", () => {
  const references = [];
  const identity = resolveLocalImageIdentity({
    language: "c",
    tag: "learncoding/runtime-c:local",
    repository: "learncoding/runtime-c",
    inspectImage(reference) {
      references.push(reference);
      return { Id: OTHER_DIGEST, Descriptor: { digest: DIGEST } };
    },
  });
  assert.deepEqual(identity, {
    language: "c",
    tag: "learncoding/runtime-c:local",
    imageReference: `learncoding/runtime-c@${DIGEST}`,
    manifestDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    rootDigest: DIGEST,
  });
  assert.deepEqual(references, ["learncoding/runtime-c:local", `learncoding/runtime-c@${DIGEST}`]);
  assert.throws(() => resolveLocalImageIdentity({
    language: "c",
    tag: "learncoding/runtime-c:local",
    repository: "learncoding/runtime-c",
    inspectImage: (reference) => ({
      Id: OTHER_DIGEST,
      Descriptor: { digest: reference.includes(":local") ? DIGEST : OTHER_DIGEST },
    }),
  }), /exact local reference.*manifest/i);
});

test("rejects invalid archive identity before loading it", () => {
  let loaded = false;
  const harness = localBuildHarness({
    readArchiveIdentity() {
      return { manifestDigest: "sha256:invalid", configDigest: OTHER_DIGEST };
    },
    loadArchive() {
      loaded = true;
    },
  });

  assert.throws(() => runDeterministicLocalBuild(harness.options), /invalid OCI archive manifest\/config identity/i);
  assert.equal(loaded, false);
  assert.equal(harness.events.at(-1)[0], "remove");
});

test("local scan requires approved offline SPDX and vulnerability scanners", () => {
  assert.throws(
    () => createLocalScanPlan({
      exactReference: `learncoding/runtime-c@${DIGEST}`,
      stem: path.join("dist", "c"),
      tools: { trivy: false, syft: false, grype: true },
    }),
    /Trivy or Syft.*SPDX/i,
  );
  assert.throws(
    () => createLocalScanPlan({
      exactReference: `learncoding/runtime-c@${DIGEST}`,
      stem: path.join("dist", "c"),
      tools: { trivy: false, syft: true, grype: false },
    }),
    /Trivy or Grype.*HIGH\/CRITICAL/i,
  );
});

test("Trivy scan plan generates SPDX and checks HIGH/CRITICAL against the exact local digest", () => {
  const reference = `learncoding/runtime-c@${DIGEST}`;
  const { control, environment } = scannerControls();
  const plan = createLocalScanPlan({
    exactReference: reference,
    stem: path.join("dist", "c"),
    tools: { trivy: true, syft: false, grype: false },
    control,
    environment,
  });

  assert.equal(plan.sbom.command, "trivy");
  assert.ok(hasPair(plan.sbom.args, "--format", "spdx-json"));
  assert.ok(hasPair(plan.sbom.args, "--image-src", "docker"));
  assert.ok(plan.sbom.args.includes("--disable-telemetry"));
  assert.equal(plan.sbom.args.at(-1), reference);
  assert.equal(plan.vulnerability.command, "trivy");
  assert.ok(hasPair(plan.vulnerability.args, "--severity", "HIGH,CRITICAL"));
  assert.ok(hasPair(plan.vulnerability.args, "--exit-code", "1"));
  assert.ok(hasPair(plan.vulnerability.args, "--image-src", "docker"));
  assert.equal(plan.vulnerability.args.at(-1), reference);
});

test("Syft and Grype scan plan stays local and digest-bound", () => {
  const reference = `learncoding/runtime-c@${DIGEST}`;
  const { control, environment } = scannerControls();
  const plan = createLocalScanPlan({
    exactReference: reference,
    stem: path.join("dist", "c"),
    tools: { trivy: false, syft: true, grype: true },
    control,
    environment,
  });

  assert.deepEqual(plan.sbom.args, [
    "scan",
    `docker:${reference}`,
    "--config",
    control.syftConfig,
    "--output",
    `spdx-json=${path.join("dist", "c.spdx.json")}`,
  ]);
  assert.equal(plan.sbom.env.SYFT_CHECK_FOR_APP_UPDATE, "false");
  assert.equal(plan.vulnerability.args[0], `docker:${reference}`);
  assert.ok(plan.vulnerability.args.includes("high"));
  assert.equal(plan.vulnerability.env.GRYPE_DB_AUTO_UPDATE, "false");
  assert.equal(plan.vulnerability.env.GRYPE_CHECK_FOR_APP_UPDATE, "false");
});

test("validates a coherent SPDX 2.3 document and binds its exact bytes to the local image digest", () => {
  const reference = `learncoding/runtime-c@${DIGEST}`;
  const documentText = `${JSON.stringify(validSpdxDocument(reference))}\n`;

  assert.equal(validateSpdxDocument(documentText).name, reference);
  assert.deepEqual(createSpdxBinding({ exactReference: reference, documentText }), {
    schemaVersion: 1,
    targetProof: "scanner-target",
    imageReference: reference,
    manifestDigest: DIGEST,
    spdxSha256: createHash("sha256").update(documentText).digest("hex"),
  });
});

test("rejects SPDX documents that are incomplete, incoherent, or target a different image", () => {
  const reference = `learncoding/runtime-c@${DIGEST}`;
  const invalidDocuments = [];

  const missingCreated = validSpdxDocument(reference);
  delete missingCreated.creationInfo.created;
  invalidDocuments.push(missingCreated);

  const invalidCreated = validSpdxDocument(reference);
  invalidCreated.creationInfo.created = "2026-07-19 00:00:00";
  invalidDocuments.push(invalidCreated);

  const unsupportedVersion = validSpdxDocument(reference);
  unsupportedVersion.spdxVersion = "SPDX-2.2";
  invalidDocuments.push(unsupportedVersion);

  const nonUriNamespace = validSpdxDocument(reference);
  nonUriNamespace.documentNamespace = "not a URI";
  invalidDocuments.push(nonUriNamespace);

  const emptyPackages = validSpdxDocument(reference);
  emptyPackages.packages = [];
  invalidDocuments.push(emptyPackages);

  const noDescribes = validSpdxDocument(reference);
  noDescribes.relationships = [];
  invalidDocuments.push(noDescribes);

  const unknownDescribedElement = validSpdxDocument(reference);
  unknownDescribedElement.relationships[0].relatedSpdxElement = "SPDXRef-Missing";
  invalidDocuments.push(unknownDescribedElement);
  const forbiddenDocumentProperty = validSpdxDocument(reference);
  forbiddenDocumentProperty.unexpectedTopLevelField = true;
  invalidDocuments.push(forbiddenDocumentProperty);

  const forbiddenPackageProperty = validSpdxDocument(reference);
  forbiddenPackageProperty.packages[0].unexpectedPackageField = true;
  invalidDocuments.push(forbiddenPackageProperty);

  for (const document of invalidDocuments) {
    assert.throws(
      () => validateSpdxDocument(JSON.stringify(document)),
      /malformed SPDX document/i,
    );
  }

  assert.throws(() => validateSpdxDocument("not json"), /malformed SPDX document/i);
  const scannerBound = createSpdxBinding({
    exactReference: `learncoding/runtime-c@${OTHER_DIGEST}`,
    documentText: JSON.stringify(validSpdxDocument(reference)),
  });
  assert.equal(scannerBound.manifestDigest, OTHER_DIGEST);
});

test("local immutable references reject malformed image identities", () => {
  assert.equal(localImageReference("learncoding/runtime-c", DIGEST), `learncoding/runtime-c@${DIGEST}`);
  assert.throws(() => localImageReference("learncoding/runtime-c", "sha256:invalid"), /invalid local image identity/i);
});
