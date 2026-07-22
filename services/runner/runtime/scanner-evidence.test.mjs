import assert from "node:assert/strict";
import test from "node:test";

import {
  createScannerEvidence,
  validateScannerEvidence,
} from "./runtime-operations.mjs";

const GENERATED_AT = "2026-07-19T00:00:00Z";

function fixture() {
  const controls = [
    ["trivy-config", "scanner-control-trivy.json", "offline: true\nignore-unfixed: false\n"],
    ["syft-config", "scanner-control-syft.json", "check-for-app-update: false\n"],
    ["grype-config", "scanner-control-grype.json", "db:\n  auto-update: false\n"],
    ["trivy-ignore", "scanner-control-ignore.json", ""],
  ].map(([name, file, text]) => ({ name, file, text }));
  const databases = [
    ["trivy-db", "scanner-trivy-db.json", {
      Version: 2,
      UpdatedAt: "2026-07-18T23:00:00Z",
      NextUpdate: "2026-07-20T00:00:00Z",
      DownloadedAt: "2026-07-18T23:30:00Z",
    }],
    ["trivy-java-db", "scanner-trivy-java-db.json", {
      Version: 1,
      UpdatedAt: "2026-07-18T22:00:00Z",
      NextUpdate: "2026-07-20T00:00:00Z",
      DownloadedAt: "2026-07-18T23:30:00Z",
    }],
  ].map(([name, file, metadata]) => ({
    name,
    file,
    text: `${JSON.stringify(metadata)}\n`,
  }));
  const evidence = createScannerEvidence({
    generatedAt: GENERATED_AT,
    tools: [{ name: "trivy", version: "Version: 0.69.3" }],
    controls,
    databases,
  });
  const artifacts = new Map([
    ...controls.map((entry) => [entry.file, entry.text]),
    ...databases.map((entry) => [entry.file, entry.text]),
  ]);
  return { evidence, artifacts };
}

test("scanner evidence binds exact binary versions, controls, and fresh Trivy databases", () => {
  const { evidence, artifacts } = fixture();
  const validated = validateScannerEvidence({
    evidence,
    generatedAt: GENERATED_AT,
    readArtifact: (file) => artifacts.get(file),
  });
  assert.equal(validated.tools[0].version, "Version: 0.69.3");
  assert.deepEqual(validated.controls.map((entry) => entry.name).sort(), [
    "grype-config", "syft-config", "trivy-config", "trivy-ignore",
  ]);
  assert.deepEqual(validated.databases.map((entry) => entry.name).sort(), [
    "trivy-db", "trivy-java-db",
  ]);
});

test("scanner evidence fails closed on missing, stale, or tampered inputs", () => {
  const missing = fixture();
  missing.evidence.databases.pop();
  assert.throws(() => validateScannerEvidence({
    evidence: missing.evidence,
    generatedAt: GENERATED_AT,
    readArtifact: (file) => missing.artifacts.get(file),
  }), /database.*complete|trivy-java-db/i);

  const stale = fixture();
  const staleRecord = stale.evidence.databases.find((entry) => entry.name === "trivy-db");
  stale.artifacts.set(staleRecord.file, JSON.stringify({
    Version: 2,
    UpdatedAt: "2026-07-01T00:00:00Z",
    NextUpdate: "2026-07-02T00:00:00Z",
    DownloadedAt: "2026-07-01T00:00:00Z",
  }));
  assert.throws(() => validateScannerEvidence({
    evidence: stale.evidence,
    generatedAt: GENERATED_AT,
    readArtifact: (file) => stale.artifacts.get(file),
  }), /checksum|stale/i);

  const tampered = fixture();
  tampered.artifacts.set("scanner-control-trivy.json", "offline: false\n");
  assert.throws(() => validateScannerEvidence({
    evidence: tampered.evidence,
    generatedAt: GENERATED_AT,
    readArtifact: (file) => tampered.artifacts.get(file),
  }), /checksum|tampered/i);

  const wrongVersion = fixture();
  wrongVersion.evidence.tools[0].version = "Version: 0.70.0";
  assert.throws(() => validateScannerEvidence({
    evidence: wrongVersion.evidence,
    generatedAt: GENERATED_AT,
    readArtifact: (file) => wrongVersion.artifacts.get(file),
  }), /Trivy.*version/i);

  const expiredAtRecord = fixture();
  assert.throws(() => validateScannerEvidence({
    evidence: expiredAtRecord.evidence,
    generatedAt: GENERATED_AT,
    validatedAt: "2026-07-20T00:00:00Z",
    readArtifact: (file) => expiredAtRecord.artifacts.get(file),
  }), /database.*expired|stale/i);
});
