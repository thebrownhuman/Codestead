import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import test from "node:test";

const operationsUrl = new URL("./application-image-operations.mjs", import.meta.url);
const operations = existsSync(operationsUrl) ? await import(operationsUrl) : {};

const SOURCE = "https://github.com/thebrownhuman/Codestead";
const REVISION = "4".repeat(40);
const MANIFEST = `sha256:${"1".repeat(64)}`;
const CONFIG = `sha256:${"2".repeat(64)}`;
const BASE = `sha256:${"3".repeat(64)}`;
const REFERENCE = `registry.example/codestead/runtime@${MANIFEST}`;
const CERTIFICATE_IDENTITY =
  "https://github.com/thebrownhuman/Codestead/.github/workflows/release.yml@refs/heads/main";
const CERTIFICATE_ISSUER = "https://token.actions.githubusercontent.com";

function slsaStatement() {
  return {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: "runtime", digest: { sha256: MANIFEST.slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v0.2",
    predicate: {
      builder: { id: "https://mobyproject.org/buildkit@v1" },
      buildType: "https://mobyproject.org/buildkit@v1",
      invocation: {
        parameters: {
          args: {
            "build-arg:SOURCE_REPOSITORY": SOURCE,
            "build-arg:SOURCE_REVISION": REVISION,
          },
        },
      },
      materials: [{
        uri: "pkg:docker/node@22.23.1-alpine3.23?platform=linux%2Famd64",
        digest: { sha256: BASE.slice(7) },
      }],
    },
  };
}

function scannerFixture() {
  const generatedAt = "2026-07-19T00:00:00Z";
  const controls = [
    ["trivy-config", "application-scanner-trivy.json", "offline-scan: true\nignore-unfixed: false\n"],
    ["syft-config", "application-scanner-syft.json", "check-for-app-update: false\n"],
    ["grype-config", "application-scanner-grype.json", "db:\n  auto-update: false\n"],
    ["trivy-ignore", "application-scanner-empty.json", ""],
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
  const artifacts = new Map([
    ...controls.map((entry) => [entry.file, entry.text]),
    ...databases.map((entry) => [entry.file, entry.text]),
  ]);
  return { generatedAt, controls, databases, artifacts };
}

test("application scanner provenance requires exact Trivy 0.69.3 and both fresh database identities", () => {
  assert.equal(typeof operations.createApplicationScannerEvidence, "function");
  assert.equal(typeof operations.validateApplicationScannerEvidence, "function");
  const fixture = scannerFixture();
  const evidence = operations.createApplicationScannerEvidence({
    generatedAt: fixture.generatedAt,
    tools: [{ name: "trivy", version: "Version: 0.69.3" }],
    controls: fixture.controls,
    databases: fixture.databases,
  });
  const validated = operations.validateApplicationScannerEvidence({
    evidence,
    generatedAt: fixture.generatedAt,
    validatedAt: "2026-07-19T12:00:00Z",
    readArtifact: (file) => fixture.artifacts.get(file),
  });
  assert.deepEqual(validated.databases.map((entry) => entry.name).sort(), ["trivy-db", "trivy-java-db"]);

  evidence.tools[0].version = "Version: 0.70.0";
  assert.throws(() => operations.validateApplicationScannerEvidence({
    evidence,
    generatedAt: fixture.generatedAt,
    validatedAt: "2026-07-19T12:00:00Z",
    readArtifact: (file) => fixture.artifacts.get(file),
  }), /Trivy.*0\.69\.3|version/i);
});

test("registry publication requires BuildKit subject/material proof plus exact-policy Cosign evidence", () => {
  assert.equal(typeof operations.validateApplicationRegistryProvenance, "function");
  const signature = [{
    critical: {
      identity: { "docker-reference": "registry.example/codestead/runtime" },
      image: { "docker-manifest-digest": MANIFEST },
      type: "cosign container image signature",
    },
    optional: { Issuer: CERTIFICATE_ISSUER, Subject: CERTIFICATE_IDENTITY },
  }];
  const signedAttestation = [{
    payload: Buffer.from(JSON.stringify(slsaStatement())).toString("base64"),
    optional: { Issuer: CERTIFICATE_ISSUER, Subject: CERTIFICATE_IDENTITY },
  }];
  const result = operations.validateApplicationRegistryProvenance({
    identity: {
      target: "runtime",
      variable: "APP_RUNTIME_IMAGE",
      reference: REFERENCE,
      manifestDigest: MANIFEST,
      configDigest: CONFIG,
      rootDigest: MANIFEST,
      sourceRepository: SOURCE,
      sourceRevision: REVISION,
    },
    buildkitStatementText: JSON.stringify(slsaStatement()),
    signatureText: JSON.stringify(signature),
    signedAttestationText: JSON.stringify(signedAttestation),
    certificateIdentity: CERTIFICATE_IDENTITY,
    certificateIssuer: CERTIFICATE_ISSUER,
    requiredMaterialDigests: [BASE],
  });
  assert.equal(result.slsa.sourceRevision, REVISION);
  assert.equal(result.cosign.certificateIdentity, CERTIFICATE_IDENTITY);

  const wrongRevision = slsaStatement();
  wrongRevision.predicate.invocation.parameters.args["build-arg:SOURCE_REVISION"] = "5".repeat(40);
  assert.throws(() => operations.validateApplicationRegistryProvenance({
    identity: {
      target: "runtime",
      variable: "APP_RUNTIME_IMAGE",
      reference: REFERENCE,
      manifestDigest: MANIFEST,
      configDigest: CONFIG,
      rootDigest: MANIFEST,
      sourceRepository: SOURCE,
      sourceRevision: REVISION,
    },
    buildkitStatementText: JSON.stringify(wrongRevision),
    signatureText: JSON.stringify(signature),
    signedAttestationText: JSON.stringify(signedAttestation),
    certificateIdentity: CERTIFICATE_IDENTITY,
    certificateIssuer: CERTIFICATE_ISSUER,
    requiredMaterialDigests: [BASE],
  }), /revision/i);
});
