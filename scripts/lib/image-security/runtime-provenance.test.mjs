import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LOCAL_PROVENANCE_ACCEPTANCE,
  createLocalProvenanceEvidence,
  validateCosignVerificationEvidence,
  validateLocalProvenanceEvidence,
  validateSlsaProvenanceStatement,
} from "./runtime-operations.mjs";

const MANIFEST = `sha256:${"1".repeat(64)}`;
const CONFIG = `sha256:${"2".repeat(64)}`;
const BASE = `sha256:${"3".repeat(64)}`;
const REFERENCE = `registry.example/codestead/runtime-c@${MANIFEST}`;
const SOURCE = "https://github.com/thebrownhuman/Codestead";
const REVISION = "4".repeat(40);
const IDENTITY = "https://github.com/thebrownhuman/Codestead/.github/workflows/release.yml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";

function slsaStatement(overrides = {}) {
  return {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: "runtime-c", digest: { sha256: MANIFEST.slice(7) } }],
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
        uri: `pkg:docker/alpine@3.23.3?platform=linux%2Famd64`,
        digest: { sha256: BASE.slice(7) },
      }],
    },
    ...overrides,
  };
}

test("accepts BuildKit SLSA provenance bound to source, revision, subject, and base material", () => {
  const statementText = `${JSON.stringify(slsaStatement())}\n`;
  const result = validateSlsaProvenanceStatement({
    statementText,
    exactReference: REFERENCE,
    sourceRepository: SOURCE,
    sourceRevision: REVISION,
    requiredMaterialDigests: [BASE],
  });

  assert.equal(result.predicateType, "https://slsa.dev/provenance/v0.2");
  assert.equal(result.builderId, "https://mobyproject.org/buildkit@v1");
  assert.deepEqual(result.materialDigests, [BASE]);
});

test("rejects SLSA provenance with a wrong revision, subject, or missing material", () => {
  const validate = (statement, requiredMaterialDigests = [BASE]) => validateSlsaProvenanceStatement({
    statementText: JSON.stringify(statement),
    exactReference: REFERENCE,
    sourceRepository: SOURCE,
    sourceRevision: REVISION,
    requiredMaterialDigests,
  });
  const wrongSubject = slsaStatement();
  wrongSubject.subject[0].digest.sha256 = CONFIG.slice(7);
  assert.throws(() => validate(wrongSubject), /subject.*manifest/i);

  const wrongRevision = slsaStatement();
  wrongRevision.predicate.invocation.parameters.args["build-arg:SOURCE_REVISION"] = "5".repeat(40);
  assert.throws(() => validate(wrongRevision), /source revision/i);

  assert.throws(() => validate(slsaStatement(), [CONFIG]), /required base material/i);
});

function localInput(name, fill) {
  return { name, file: name, sha256: fill.repeat(64) };
}

test("creates and revalidates a clean, explicit local residual-risk provenance record", () => {
  const evidence = createLocalProvenanceEvidence({
    generatedAt: "2026-07-19T00:00:00Z",
    acceptance: LOCAL_PROVENANCE_ACCEPTANCE,
    exactReference: REFERENCE,
    configDigest: CONFIG,
    rootDigest: MANIFEST,
    baseReference: `docker.io/library/alpine@${BASE}`,
    sourceRepository: SOURCE,
    sourceRevision: REVISION,
    dirty: false,
    builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
    inputs: [
      localInput("Dockerfile", "a"),
      localInput("harness.c", "b"),
      localInput("images.env", "c"),
    ],
  });
  const text = `${JSON.stringify(evidence)}\n`;

  assert.deepEqual(validateLocalProvenanceEvidence({
    evidenceText: text,
    exactReference: REFERENCE,
    configDigest: CONFIG,
    rootDigest: MANIFEST,
  }), evidence);
});

test("local provenance fails closed for implicit acceptance, dirty source, tampering, or missing inputs", () => {
  const create = (overrides = {}) => createLocalProvenanceEvidence({
    generatedAt: "2026-07-19T00:00:00Z",
    acceptance: LOCAL_PROVENANCE_ACCEPTANCE,
    exactReference: REFERENCE,
    configDigest: CONFIG,
    rootDigest: MANIFEST,
    baseReference: `docker.io/library/alpine@${BASE}`,
    sourceRepository: SOURCE,
    sourceRevision: REVISION,
    dirty: false,
    builder: { docker: "Docker version 29.6.1", buildx: "github.com/docker/buildx v0.30.1" },
    inputs: [localInput("Dockerfile", "a"), localInput("harness.c", "b"), localInput("images.env", "c")],
    ...overrides,
  });
  assert.throws(() => create({ acceptance: undefined }), /explicit local provenance risk acceptance/i);
  assert.throws(() => create({ dirty: true }), /clean Git worktree/i);
  assert.throws(() => create({ inputs: [localInput("Dockerfile", "a")] }), /exact reviewed build-input set/i);

  const evidence = create();
  evidence.image.configDigest = MANIFEST;
  assert.throws(() => validateLocalProvenanceEvidence({
    evidenceText: JSON.stringify(evidence),
    exactReference: REFERENCE,
    configDigest: CONFIG,
    rootDigest: MANIFEST,
  }), /config digest/i);
});

function cosignSignature() {
  return [{
    critical: {
      identity: { "docker-reference": "registry.example/codestead/runtime-c" },
      image: { "docker-manifest-digest": MANIFEST },
      type: "cosign container image signature",
    },
    optional: { Issuer: ISSUER, Subject: IDENTITY },
  }];
}

function cosignAttestation() {
  const payload = Buffer.from(JSON.stringify(slsaStatement())).toString("base64");
  return [{ payload, optional: { Issuer: ISSUER, Subject: IDENTITY } }];
}

test("validates captured cosign signature and signed SLSA attestation output", () => {
  const signatureText = JSON.stringify(cosignSignature());
  const attestationText = JSON.stringify(cosignAttestation());
  const result = validateCosignVerificationEvidence({
    signatureText,
    attestationText,
    exactReference: REFERENCE,
    certificateIdentity: IDENTITY,
    certificateIssuer: ISSUER,
    sourceRepository: SOURCE,
    sourceRevision: REVISION,
    requiredMaterialDigests: [BASE],
  });

  assert.equal(result.signatureSha256, createHash("sha256").update(signatureText).digest("hex"));
  assert.equal(result.attestationSha256, createHash("sha256").update(attestationText).digest("hex"));
});

test("cosign evidence rejects wrong digest, certificate policy, or malformed signed payload", () => {
  const options = {
    signatureText: JSON.stringify(cosignSignature()),
    attestationText: JSON.stringify(cosignAttestation()),
    exactReference: REFERENCE,
    certificateIdentity: IDENTITY,
    certificateIssuer: ISSUER,
    sourceRepository: SOURCE,
    sourceRevision: REVISION,
    requiredMaterialDigests: [BASE],
  };
  const wrongDigest = cosignSignature();
  wrongDigest[0].critical.image["docker-manifest-digest"] = CONFIG;
  assert.throws(() => validateCosignVerificationEvidence({
    ...options,
    signatureText: JSON.stringify(wrongDigest),
  }), /signature.*digest/i);

  const wrongIdentity = cosignSignature();
  wrongIdentity[0].optional.Subject = "someone-else";
  assert.throws(() => validateCosignVerificationEvidence({
    ...options,
    signatureText: JSON.stringify(wrongIdentity),
  }), /certificate identity/i);

  assert.throws(() => validateCosignVerificationEvidence({
    ...options,
    attestationText: JSON.stringify([{ payload: "not-base64", optional: { Issuer: ISSUER, Subject: IDENTITY } }]),
  }), /signed SLSA attestation/i);
});
