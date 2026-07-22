import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  createScannerEvidence,
  validateCosignVerificationEvidence,
  validateScannerEvidence,
  validateSlsaProvenanceStatement,
  validateSpdxDocument,
} from "../../services/runner/runtime/runtime-operations.mjs";

export const APPLICATION_IMAGE_TARGETS = Object.freeze([
  Object.freeze({ target: "runtime", variable: "APP_RUNTIME_IMAGE", repository: "runtime" }),
  Object.freeze({ target: "tooling", variable: "APP_TOOLING_IMAGE", repository: "tooling" }),
  Object.freeze({ target: "worker", variable: "APP_WORKER_IMAGE", repository: "worker" }),
  Object.freeze({
    target: "regrade-worker",
    variable: "APP_REGRADE_WORKER_IMAGE",
    repository: "regrade-worker",
  }),
  Object.freeze({
    target: "project-review-correction-worker",
    variable: "APP_PROJECT_REVIEW_WORKER_IMAGE",
    repository: "project-review-worker",
  }),
  Object.freeze({
    target: "scanner-worker",
    variable: "APP_SCANNER_WORKER_IMAGE",
    repository: "scanner-worker",
  }),
  Object.freeze({ target: "operations", variable: "APP_OPERATIONS_IMAGE", repository: "operations" }),
]);

const LOCAL_RISK_MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;
const LOCAL_RISK_REASSESSMENT_TRIGGERS = Object.freeze([
  "The application becomes publicly reachable or the learner cohort expands beyond the private pilot.",
  "The Dockerfile, pinned base image, build frontend, BuildKit, Docker, or scanner toolchain changes.",
  "A HIGH or CRITICAL vulnerability, supply-chain alert, credential incident, or image-integrity incident occurs.",
  "Registry keyless signing and attestation publication becomes operational for the release path.",
  "The approval owner, threat model, deployment topology, or source repository identity changes.",
]);

const SHA256_HEX = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_REFERENCE = /^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SOURCE_TREE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const GENERATED_BUILD_CONTEXT_PATHS = Object.freeze([
  "next-env.d.ts",
  "public/monaco",
  "dist",
  "uploads",
]);
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;
const LOCAL_INPUTS = Object.freeze(["Dockerfile", ".dockerignore", "package.json", "package-lock.json"]);

function fail(message) {
  throw new Error(message);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function requireSource(sourceRepository, sourceRevision) {
  let parsed;
  try {
    parsed = new URL(sourceRepository);
  } catch {
    fail("Application image source repository must be an absolute HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname === "/"
    || parsed.pathname.endsWith("/")
  ) {
    fail("Application image source repository must be a canonical absolute HTTPS URL.");
  }
  if (!SOURCE_REVISION.test(sourceRevision ?? "")) {
    fail("Application image source revision must be an exact lowercase Git commit.");
  }
  return { repository: sourceRepository, revision: sourceRevision };
}

export function validateApplicationSourceBinding({
  actualRepository,
  actualRevision,
  actualTree,
  contextSha256,
  declaredRepositories = [],
  declaredRevisions = [],
}) {
  const source = requireSource(actualRepository, actualRevision);
  if (!SOURCE_TREE.test(actualTree ?? "")) {
    fail("Application source tree must be an exact lowercase Git tree object id.");
  }
  if (!SHA256_HEX.test(contextSha256 ?? "")) {
    fail("Application build context must have an exact SHA-256 digest.");
  }
  if (!Array.isArray(declaredRepositories) || !Array.isArray(declaredRevisions)) {
    fail("Application source declarations must be explicit lists.");
  }
  for (const declared of declaredRepositories) {
    if (declared !== source.repository) {
      fail("Declared application source repository does not match the independently derived Git origin.");
    }
  }
  for (const declared of declaredRevisions) {
    if (declared !== source.revision) {
      fail("Declared application source revision does not match the independently derived Git HEAD.");
    }
  }
  return {
    repository: source.repository,
    revision: source.revision,
    tree: actualTree,
    contextSha256,
  };
}

export function validateApplicationTrackedBuildInputs(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    fail("Application tracked build context must contain files.");
  }
  const normalized = [];
  const seen = new Set();
  for (const file of paths) {
    if (
      typeof file !== "string"
      || !file
      || file.includes("\\")
      || file.includes("\0")
      || file.startsWith("/")
      || file.split("/").includes("..")
      || seen.has(file)
    ) {
      fail("Application tracked build context contains an invalid or duplicate path.");
    }
    if (GENERATED_BUILD_CONTEXT_PATHS.some((generated) => (
      file === generated || file.startsWith(`${generated}/`)
    ))) {
      fail(`Generated path ${file} must not enter the application build context.`);
    }
    seen.add(file);
    normalized.push(file);
  }
  return normalized.sort();
}
function normalizeIdentity(identity, expected, local) {
  if (!exactKeys(identity, [
    "target", "variable", "reference", "manifestDigest", "configDigest", "rootDigest",
    "sourceRepository", "sourceRevision",
  ])) {
    fail("Application image identity contains missing or unreviewed fields.");
  }
  if (identity.target !== expected.target || identity.variable !== expected.variable) {
    fail("Application image identity target-to-variable mapping is invalid or duplicated.");
  }
  if (!IMMUTABLE_REFERENCE.test(identity.reference ?? "")) {
    fail("Application image identity requires an immutable digest reference.");
  }
  if (
    !OCI_DIGEST.test(identity.manifestDigest ?? "")
    || !identity.reference.endsWith(`@${identity.manifestDigest}`)
    || !OCI_DIGEST.test(identity.configDigest ?? "")
    || identity.configDigest === identity.manifestDigest
    || !OCI_DIGEST.test(identity.rootDigest ?? "")
    || (local && identity.rootDigest !== identity.manifestDigest)
  ) {
    fail("Application image manifest, config, and root identities are invalid or conflated.");
  }
  requireSource(identity.sourceRepository, identity.sourceRevision);
  return {
    target: identity.target,
    variable: identity.variable,
    reference: identity.reference,
    manifestDigest: identity.manifestDigest,
    configDigest: identity.configDigest,
    rootDigest: identity.rootDigest,
    sourceRepository: identity.sourceRepository,
    sourceRevision: identity.sourceRevision,
  };
}

function normalizeIdentities(items, local, sourceRepository, sourceRevision) {
  if (!Array.isArray(items) || items.length !== APPLICATION_IMAGE_TARGETS.length) {
    fail("Application image record requires the complete seven-target identity set.");
  }
  const byTarget = new Map();
  const seenReferences = new Set();
  const seenManifestDigests = new Set();
  const seenConfigDigests = new Set();
  for (const item of items) {
    if (typeof item?.target !== "string" || byTarget.has(item.target)) {
      fail("Application image record contains a duplicate or invalid target.");
    }
    byTarget.set(item.target, item);
  }
  return APPLICATION_IMAGE_TARGETS.map((expected) => {
    const identity = byTarget.get(expected.target);
    if (!identity) fail(`Application image record is missing target ${expected.target}.`);
    const normalized = normalizeIdentity(identity, expected, local);
    if (
      normalized.sourceRepository !== sourceRepository
      || normalized.sourceRevision !== sourceRevision
    ) {
      fail("Application image identity source does not match the release source.");
    }
    if (
      seenReferences.has(normalized.reference)
      || seenManifestDigests.has(normalized.manifestDigest)
      || seenConfigDigests.has(normalized.configDigest)
    ) {
      fail("Application image record contains a duplicate deployable identity.");
    }
    seenReferences.add(normalized.reference);
    seenManifestDigests.add(normalized.manifestDigest);
    seenConfigDigests.add(normalized.configDigest);
    return normalized;
  });
}

export function createApplicationBuildPlan({
  sourceDateEpoch,
  sourceRepository,
  sourceRevision,
  sourceTree,
  sourceContextSha256,
  registry,
  release,
  local,
  outputDirectory = "dist/application-images/build",
}) {
  requireSource(sourceRepository, sourceRevision);
  if (!SOURCE_TREE.test(sourceTree ?? "") || !SHA256_HEX.test(sourceContextSha256 ?? "")) {
    fail("Application builds require the exact Git source tree and archive digest.");
  }
  if (!/^\d+$/.test(sourceDateEpoch ?? "") || String(BigInt(sourceDateEpoch)) !== sourceDateEpoch) {
    fail("Application builds require a canonical SOURCE_DATE_EPOCH.");
  }
  if (!RELEASE.test(release ?? "")) fail("Application build release is invalid.");
  if (
    typeof registry !== "string"
    || !/^[a-z0-9][a-z0-9./_-]{0,220}$/.test(registry)
    || registry.includes("..")
    || registry.endsWith("/")
    || registry.includes("@")
    || registry.includes(":latest")
  ) {
    fail("Application build registry coordinate is invalid or mutable.");
  }
  if (typeof local !== "boolean") fail("Application build mode must be explicit.");

  return APPLICATION_IMAGE_TARGETS.map(({ target, variable, repository }) => {
    const tag = `${registry}/${repository}:${release}`;
    const output = local
      ? `type=oci,dest=${path.posix.join(outputDirectory.replaceAll("\\", "/"), `${target}.oci.tar`)},rewrite-timestamp=true`
      : "type=image,push=true";
    const args = [
      "buildx", "build",
      "--platform", "linux/amd64",
      "--pull=false",
      local ? "--provenance=false" : "--provenance=mode=max",
      local ? "--sbom=false" : "--sbom=true",
      "--target", target,
      "--build-arg", `SOURCE_REPOSITORY=${sourceRepository}`,
      "--build-arg", `SOURCE_REVISION=${sourceRevision}`,
      "--build-arg", `SOURCE_TREE=${sourceTree}`,
      "--build-arg", `SOURCE_CONTEXT_SHA256=${sourceContextSha256}`,
      "--build-arg", `SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
      "--tag", tag,
      "--output", output,
      "-",
    ];
    return { target, variable, repository, tag, output, args };
  });
}

export function createApplicationImageRecord({
  generatedAt,
  release,
  local,
  sourceRepository,
  sourceRevision,
  sourceTree,
  sourceContextSha256,
  identities,
}) {
  if (!validTimestamp(generatedAt)) fail("Application image record requires a valid UTC timestamp.");
  if (!RELEASE.test(release ?? "") || typeof local !== "boolean") {
    fail("Application image record requires a canonical release and explicit mode.");
  }
  const source = validateApplicationSourceBinding({
    actualRepository: sourceRepository,
    actualRevision: sourceRevision,
    actualTree: sourceTree,
    contextSha256: sourceContextSha256,
  });
  const records = normalizeIdentities(identities, local, sourceRepository, sourceRevision);
  const payload = { schemaVersion: 1, generatedAt, release, local, source, records };
  const recordId = hash(JSON.stringify(payload));
  const document = { schemaVersion: 1, recordId, generatedAt, release, local, source, records };
  const envLines = [
    "# Generated by scripts/app-images/manage-application-images.mjs; do not hand-edit.",
    `# application-image-record-id=${recordId}`,
    ...records.map((record) => `${record.variable}=${record.reference}`),
  ];
  return {
    recordId,
    document,
    jsonText: `${JSON.stringify(document, null, 2)}\n`,
    envText: `${envLines.join("\n")}\n`,
  };
}

export function validateApplicationImageRecord({
  jsonText,
  envText,
  expectedSourceRepository,
  expectedSourceRevision,
  expectedSourceTree,
  expectedSourceContextSha256,
  validatedAt,
}) {
  let document;
  try {
    document = JSON.parse(jsonText);
  } catch {
    fail("Application image record JSON is malformed.");
  }
  if (!exactKeys(document, [
    "schemaVersion", "recordId", "generatedAt", "release", "local", "source", "records",
  ]) || document.schemaVersion !== 1 || !SHA256_HEX.test(document.recordId ?? "")) {
    fail("Application image record has an unsupported or non-canonical schema.");
  }
  if (!validTimestamp(validatedAt) || !validTimestamp(document.generatedAt)) {
    fail("Application image record age cannot be validated.");
  }
  const age = Date.parse(validatedAt) - Date.parse(document.generatedAt);
  if (age < 0 || age > MAX_RECORD_AGE_MS) fail("Application image record is stale or from the future.");
  if (
    document.source?.repository !== expectedSourceRepository
    || document.source?.revision !== expectedSourceRevision
    || document.source?.tree !== expectedSourceTree
    || document.source?.contextSha256 !== expectedSourceContextSha256
  ) {
    fail("Application image record source repository, revision, tree, or context does not match the release.");
  }
  const canonical = createApplicationImageRecord({
    generatedAt: document.generatedAt,
    release: document.release,
    local: document.local,
    sourceRepository: document.source.repository,
    sourceRevision: document.source.revision,
    sourceTree: document.source.tree,
    sourceContextSha256: document.source.contextSha256,
    identities: document.records,
  });
  if (canonical.recordId !== document.recordId || !isDeepStrictEqual(canonical.document, document)) {
    fail("Application image record does not match its canonical record id.");
  }
  if (envText !== canonical.envText) {
    fail("Application image environment projection does not match its canonical record id.");
  }
  return document;
}

export function validateApplicationScanArtifacts({ identity, spdxText, vulnerabilityText }) {
  const expected = APPLICATION_IMAGE_TARGETS.find((entry) => entry.target === identity?.target);
  if (!expected) fail("Application scan target is not reviewed.");
  normalizeIdentity(identity, expected, identity.rootDigest === identity.manifestDigest);
  validateSpdxDocument(spdxText);

  let report;
  try {
    report = JSON.parse(vulnerabilityText);
  } catch {
    fail("Trivy vulnerability report is malformed.");
  }
  if (
    report?.SchemaVersion !== 2
    || report.ArtifactType !== "container_image"
    || report.ArtifactName !== identity.reference
    || report.Metadata?.ImageID !== identity.configDigest
    || !Array.isArray(report.Metadata?.RepoDigests)
    || !report.Metadata.RepoDigests.includes(identity.reference)
    || !Array.isArray(report.Results)
  ) {
    fail("Trivy report target does not match the exact application image identity.");
  }
  let high = 0;
  let critical = 0;
  for (const result of report.Results) {
    for (const vulnerability of result?.Vulnerabilities ?? []) {
      if (vulnerability?.Severity === "HIGH") high += 1;
      if (vulnerability?.Severity === "CRITICAL") critical += 1;
    }
  }
  if (high > 0 || critical > 0) {
    fail(`Application image has ${high} HIGH and ${critical} CRITICAL vulnerabilities.`);
  }
  return {
    spdx: { sha256: hash(spdxText), manifestDigest: identity.manifestDigest },
    vulnerability: {
      sha256: hash(vulnerabilityText),
      manifestDigest: identity.manifestDigest,
      high,
      critical,
    },
  };
}

export function createApplicationScannerEvidence(options) {
  return createScannerEvidence(options);
}

export function validateApplicationScannerEvidence(options) {
  return validateScannerEvidence(options);
}

export function validateApplicationRegistryProvenance({
  identity,
  buildkitStatementText,
  signatureText,
  signedAttestationText,
  certificateIdentity,
  certificateIssuer,
  requiredMaterialDigests,
}) {
  const expected = APPLICATION_IMAGE_TARGETS.find((entry) => entry.target === identity?.target);
  if (!expected) fail("Application registry provenance target is not reviewed.");
  const normalizedIdentity = normalizeIdentity(identity, expected, false);
  const slsa = validateSlsaProvenanceStatement({
    statementText: buildkitStatementText,
    exactReference: normalizedIdentity.reference,
    sourceRepository: normalizedIdentity.sourceRepository,
    sourceRevision: normalizedIdentity.sourceRevision,
    requiredMaterialDigests,
  });
  const cosign = validateCosignVerificationEvidence({
    signatureText,
    attestationText: signedAttestationText,
    exactReference: normalizedIdentity.reference,
    certificateIdentity,
    certificateIssuer,
    sourceRepository: normalizedIdentity.sourceRepository,
    sourceRevision: normalizedIdentity.sourceRevision,
    requiredMaterialDigests,
  });
  return { slsa, cosign };
}
const APPLICATION_EVIDENCE_FILE = /^[a-z0-9][a-z0-9.-]*\.json$/;

function requireApplicationEvidenceFile(file, description) {
  if (
    typeof file !== "string"
    || !APPLICATION_EVIDENCE_FILE.test(file)
    || path.basename(file) !== file
  ) {
    fail(`Invalid application ${description} evidence file name.`);
  }
  return file;
}

function requireArtifactText(text, description) {
  if (typeof text !== "string" || !text.trim()) {
    fail(`Application ${description} evidence is empty.`);
  }
  return text;
}

function sameIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.target === right.target
    && left.variable === right.variable
    && left.reference === right.reference
    && left.manifestDigest === right.manifestDigest
    && left.configDigest === right.configDigest
    && left.rootDigest === right.rootDigest
    && left.sourceRepository === right.sourceRepository
    && left.sourceRevision === right.sourceRevision
  );
}

function normalizeSecurityRecords({ mode, sourceRepository, sourceRevision, records }) {
  if (!Array.isArray(records) || records.length !== APPLICATION_IMAGE_TARGETS.length) {
    fail("Application security evidence requires the complete seven-target set.");
  }
  const byTarget = new Map();
  for (const record of records) {
    if (typeof record?.identity?.target !== "string" || byTarget.has(record.identity.target)) {
      fail("Application security evidence has an invalid or duplicate target.");
    }
    byTarget.set(record.identity.target, record);
  }
  return APPLICATION_IMAGE_TARGETS.map((expected) => {
    const record = byTarget.get(expected.target);
    if (!record) fail(`Application security evidence is missing target ${expected.target}.`);
    const identity = normalizeIdentity(record.identity, expected, mode === "local");
    if (
      identity.sourceRepository !== sourceRepository
      || identity.sourceRevision !== sourceRevision
    ) {
      fail(`Application security source labels do not match ${identity.target}.`);
    }
    const spdxFile = requireApplicationEvidenceFile(record.spdxFile, "SPDX");
    const vulnerabilityFile = requireApplicationEvidenceFile(
      record.vulnerabilityFile,
      "vulnerability",
    );
    const provenanceFile = requireApplicationEvidenceFile(record.provenanceFile, "provenance");
    const spdxText = requireArtifactText(record.spdxText, "SPDX");
    const vulnerabilityText = requireArtifactText(record.vulnerabilityText, "vulnerability");
    const provenanceText = requireArtifactText(record.provenanceText, "provenance");
    const scan = validateApplicationScanArtifacts({ identity, spdxText, vulnerabilityText });
    let provenance;
    let cosign;
    if (mode === "local") {
      const localEvidence = validateApplicationLocalProvenance({ evidenceText: provenanceText, identity });
      provenance = {
        kind: "local-risk-gated",
        file: provenanceFile,
        sha256: hash(provenanceText),
        riskAcceptance: localEvidence.riskAcceptance,
        sourceRepository: localEvidence.source.repository,
        sourceRevision: localEvidence.source.revision,
        sourceTree: localEvidence.source.tree,
        sourceContextSha256: localEvidence.source.contextSha256,
      };
    } else {
      const signatureFile = requireApplicationEvidenceFile(
        record.cosignSignatureFile,
        "Cosign signature",
      );
      const attestationFile = requireApplicationEvidenceFile(
        record.cosignAttestationFile,
        "Cosign attestation",
      );
      const signatureText = requireArtifactText(record.cosignSignatureText, "Cosign signature");
      const signedAttestationText = requireArtifactText(
        record.cosignAttestationText,
        "Cosign signed attestation",
      );
      const verified = validateApplicationRegistryProvenance({
        identity,
        buildkitStatementText: provenanceText,
        signatureText,
        signedAttestationText,
        certificateIdentity: record.certificateIdentity,
        certificateIssuer: record.certificateIssuer,
        requiredMaterialDigests: record.requiredMaterialDigests,
      });
      provenance = {
        kind: "slsa-buildkit",
        file: provenanceFile,
        sha256: hash(provenanceText),
        predicateType: verified.slsa.predicateType,
        builderId: verified.slsa.builderId,
        buildType: verified.slsa.buildType,
        sourceRepository: verified.slsa.sourceRepository,
        sourceRevision: verified.slsa.sourceRevision,
        requiredMaterialDigests: [...record.requiredMaterialDigests],
        materialDigests: verified.slsa.materialDigests,
      };
      cosign = {
        certificateIdentity: verified.cosign.certificateIdentity,
        certificateIssuer: verified.cosign.certificateIssuer,
        signature: { file: signatureFile, sha256: verified.cosign.signatureSha256 },
        attestation: { file: attestationFile, sha256: verified.cosign.attestationSha256 },
        predicateType: verified.cosign.predicateType,
      };
    }
    const normalized = {
      ...identity,
      spdx: { file: spdxFile, ...scan.spdx },
      vulnerability: { scanner: "trivy", file: vulnerabilityFile, ...scan.vulnerability },
      provenance,
    };
    if (cosign) normalized.cosign = cosign;
    return normalized;
  });
}

export function createApplicationSecurityEvidence({
  release,
  mode,
  generatedAt,
  sourceRepository,
  sourceRevision,
  sourceTree,
  sourceContextSha256,
  scannerEvidence,
  records,
}) {
  if (!RELEASE.test(release ?? "") || !["local", "registry"].includes(mode)) {
    fail("Application security evidence has an invalid release or mode.");
  }
  if (!validTimestamp(generatedAt)) {
    fail("Application security evidence requires a valid UTC timestamp.");
  }
  const source = validateApplicationSourceBinding({
    actualRepository: sourceRepository,
    actualRevision: sourceRevision,
    actualTree: sourceTree,
    contextSha256: sourceContextSha256,
  });
  if (scannerEvidence?.schemaVersion !== 1 || scannerEvidence.generatedAt !== generatedAt) {
    fail("Application security evidence requires current scanner provenance.");
  }
  const normalizedRecords = normalizeSecurityRecords({
    mode,
    sourceRepository,
    sourceRevision,
    records,
  });
  return {
    schemaVersion: 1,
    evidenceKind: "codestead-application-image-security",
    complete: true,
    release,
    mode,
    generatedAt,
    source,
    expectedTargets: APPLICATION_IMAGE_TARGETS.map(({ target, variable }) => ({ target, variable })),
    scanner: scannerEvidence,
    records: normalizedRecords,
  };
}

export function validateApplicationSecurityEvidence({
  manifestText,
  release,
  mode,
  expectedSourceRepository,
  expectedSourceRevision,
  expectedSourceTree,
  expectedSourceContextSha256,
  expected,
  validatedAt,
  readArtifact,
}) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    fail("Application security manifest is malformed.");
  }
  if (
    !exactKeys(manifest, [
      "schemaVersion", "evidenceKind", "complete", "release", "mode", "generatedAt",
      "source", "expectedTargets", "scanner", "records",
    ])
    || manifest.schemaVersion !== 1
    || manifest.evidenceKind !== "codestead-application-image-security"
    || manifest.complete !== true
    || manifest.release !== release
    || manifest.mode !== mode
  ) {
    fail("Application security evidence is incomplete or has an unsupported schema.");
  }
  if (
    !exactKeys(manifest.source, ["repository", "revision", "tree", "contextSha256"])
    || manifest.source.repository !== expectedSourceRepository
    || manifest.source.revision !== expectedSourceRevision
    || manifest.source.tree !== expectedSourceTree
    || manifest.source.contextSha256 !== expectedSourceContextSha256
    || typeof readArtifact !== "function"
  ) {
    fail("Application security evidence source or artifact reader does not match the release.");
  }
  validateApplicationScannerEvidence({
    evidence: manifest.scanner,
    generatedAt: manifest.generatedAt,
    validatedAt,
    readArtifact,
  });
  const normalizedExpected = normalizeIdentities(
    expected,
    mode === "local",
    expectedSourceRepository,
    expectedSourceRevision,
  );
  if (
    !Array.isArray(manifest.expectedTargets)
    || !isDeepStrictEqual(
      manifest.expectedTargets,
      APPLICATION_IMAGE_TARGETS.map(({ target, variable }) => ({ target, variable })),
    )
    || !Array.isArray(manifest.records)
    || manifest.records.length !== APPLICATION_IMAGE_TARGETS.length
  ) {
    fail("Application security evidence target set is incomplete or non-canonical.");
  }
  const manifestByTarget = new Map(manifest.records.map((record) => [record?.target, record]));
  if (manifestByTarget.size !== APPLICATION_IMAGE_TARGETS.length) {
    fail("Application security evidence has duplicate target records.");
  }
  for (const identity of normalizedExpected) {
    const record = manifestByTarget.get(identity.target);
    if (!sameIdentity(record, identity)) {
      fail(`Application security evidence has a stale identity or digest for ${identity.target}.`);
    }
    const spdxText = readArtifact(requireApplicationEvidenceFile(record.spdx?.file, "SPDX"));
    const vulnerabilityText = readArtifact(
      requireApplicationEvidenceFile(record.vulnerability?.file, "vulnerability"),
    );
    const provenanceText = readArtifact(
      requireApplicationEvidenceFile(record.provenance?.file, "provenance"),
    );
    for (const [description, artifact, text] of [
      ["SPDX", record.spdx, spdxText],
      ["vulnerability", record.vulnerability, vulnerabilityText],
      ["provenance", record.provenance, provenanceText],
    ]) {
      if (typeof text !== "string" || hash(text) !== artifact?.sha256) {
        fail(`Application ${description} artifact checksum is invalid or tampered for ${identity.target}.`);
      }
    }
    const scan = validateApplicationScanArtifacts({ identity, spdxText, vulnerabilityText });
    if (
      record.spdx.manifestDigest !== scan.spdx.manifestDigest
      || record.vulnerability.manifestDigest !== scan.vulnerability.manifestDigest
      || record.vulnerability.high !== 0
      || record.vulnerability.critical !== 0
      || record.vulnerability.scanner !== "trivy"
    ) {
      fail(`Application scan summary is stale or invalid for ${identity.target}.`);
    }
    if (mode === "local") {
      if (record.provenance.kind !== "local-risk-gated") {
        fail(`Application local provenance kind is invalid for ${identity.target}.`);
      }
      const local = validateApplicationLocalProvenance({ evidenceText: provenanceText, identity });
      if (
        !isDeepStrictEqual(record.provenance.riskAcceptance, local.riskAcceptance)
        || record.provenance.sourceRepository !== local.source.repository
        || record.provenance.sourceRevision !== local.source.revision
        || record.provenance.sourceTree !== local.source.tree
        || record.provenance.sourceContextSha256 !== local.source.contextSha256
      ) {
        fail(`Application local provenance summary is stale for ${identity.target}.`);
      }
    } else {
      if (record.provenance.kind !== "slsa-buildkit") {
        fail(`Application registry provenance kind is invalid for ${identity.target}.`);
      }
      const signatureText = readArtifact(
        requireApplicationEvidenceFile(record.cosign?.signature?.file, "Cosign signature"),
      );
      const attestationText = readArtifact(
        requireApplicationEvidenceFile(record.cosign?.attestation?.file, "Cosign attestation"),
      );
      if (
        hash(signatureText) !== record.cosign.signature.sha256
        || hash(attestationText) !== record.cosign.attestation.sha256
      ) {
        fail(`Application Cosign evidence is tampered for ${identity.target}.`);
      }
      const verified = validateApplicationRegistryProvenance({
        identity,
        buildkitStatementText: provenanceText,
        signatureText,
        signedAttestationText: attestationText,
        certificateIdentity: record.cosign.certificateIdentity,
        certificateIssuer: record.cosign.certificateIssuer,
        requiredMaterialDigests: record.provenance.requiredMaterialDigests,
      });
      if (
        record.provenance.predicateType !== verified.slsa.predicateType
        || record.provenance.builderId !== verified.slsa.builderId
        || record.provenance.buildType !== verified.slsa.buildType
        || !isDeepStrictEqual(record.provenance.materialDigests, verified.slsa.materialDigests)
        || record.cosign.predicateType !== verified.cosign.predicateType
      ) {
        fail(`Application registry provenance summary is stale for ${identity.target}.`);
      }
    }
  }
  return manifest;
}
export function parseApplicationLocalRiskAcceptance({ acceptanceText, validatedAt }) {
  if (
    typeof acceptanceText !== "string"
    || acceptanceText.includes("\r")
    || acceptanceText.includes("\0")
    || !validTimestamp(validatedAt)
  ) {
    fail("Application local-risk acceptance requires canonical UTF-8 JSON and a validation time.");
  }
  let artifact;
  try {
    artifact = JSON.parse(acceptanceText);
  } catch {
    fail("Application local-risk acceptance artifact is malformed.");
  }
  if (
    !exactKeys(artifact, [
      "schemaVersion", "acceptanceId", "scope", "owner", "approvedBy",
      "approvedAt", "expiresAt", "rationale", "reassessmentTriggers",
    ])
    || artifact.schemaVersion !== 1
    || artifact.acceptanceId !== "codestead-unsigned-local-application-images-v1"
  ) {
    fail("Application local-risk acceptance has an unsupported schema or unreviewed fields.");
  }
  if (
    typeof artifact.scope !== "string"
    || artifact.scope.length < 80
    || typeof artifact.rationale !== "string"
    || artifact.rationale.length < 80
  ) {
    fail("Application local-risk acceptance requires a precise scope and rationale.");
  }
  const accountableIdentity = /^github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  if (
    !accountableIdentity.test(artifact.owner ?? "")
    || !accountableIdentity.test(artifact.approvedBy ?? "")
  ) {
    fail("Application local-risk acceptance requires an accountable owner and approver.");
  }
  if (!isDeepStrictEqual(artifact.reassessmentTriggers, LOCAL_RISK_REASSESSMENT_TRIGGERS)) {
    fail("Application local-risk acceptance reassessment triggers are incomplete or unreviewed.");
  }
  if (!validTimestamp(artifact.approvedAt) || !validTimestamp(artifact.expiresAt)) {
    fail("Application local-risk acceptance approval and expiry must be canonical UTC timestamps.");
  }
  const approvedAt = Date.parse(artifact.approvedAt);
  const expiresAt = Date.parse(artifact.expiresAt);
  const checkedAt = Date.parse(validatedAt);
  if (expiresAt <= approvedAt || expiresAt - approvedAt > LOCAL_RISK_MAX_VALIDITY_MS) {
    fail("Application local-risk acceptance validity may not exceed 90 days.");
  }
  if (checkedAt < approvedAt) {
    fail("Application local-risk acceptance is not active yet.");
  }
  if (checkedAt > expiresAt) {
    fail("Application local-risk acceptance has expired.");
  }
  const canonicalText = `${JSON.stringify(artifact, null, 2)}\n`;
  if (acceptanceText !== canonicalText) {
    fail("Application local-risk acceptance does not use canonical JSON bytes.");
  }
  return { artifact, sha256: hash(acceptanceText) };
}

function normalizeLocalInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== LOCAL_INPUTS.length) {
    fail("Application local provenance requires the exact reviewed input set.");
  }
  const byFile = new Map();
  for (const input of inputs) {
    if (
      !LOCAL_INPUTS.includes(input?.file)
      || byFile.has(input.file)
      || !exactKeys(input, ["file", "sha256"])
      || !SHA256_HEX.test(input.sha256 ?? "")
    ) {
      fail("Application local provenance contains an invalid or duplicate input.");
    }
    byFile.set(input.file, { file: input.file, sha256: input.sha256 });
  }
  return LOCAL_INPUTS.map((file) => byFile.get(file));
}

export function createApplicationLocalProvenance({
  generatedAt,
  riskAcceptance,
  identity,
  baseReference,
  sourceRepository,
  sourceRevision,
  sourceTree,
  sourceContextSha256,
  dirty,
  builder,
  inputs,
}) {
  if (!validTimestamp(generatedAt)) fail("Application local provenance requires a valid UTC timestamp.");
  if (
    !exactKeys(riskAcceptance, ["artifact", "sha256"])
    || !SHA256_HEX.test(riskAcceptance.sha256 ?? "")
  ) {
    fail("Application local provenance requires an accountable local-risk acceptance artifact.");
  }
  const canonicalAcceptanceText = `${JSON.stringify(riskAcceptance.artifact, null, 2)}\n`;
  const canonicalRiskAcceptance = parseApplicationLocalRiskAcceptance({
    acceptanceText: canonicalAcceptanceText,
    validatedAt: generatedAt,
  });
  if (!isDeepStrictEqual(riskAcceptance, canonicalRiskAcceptance)) {
    fail("Application local provenance risk acceptance is stale, tampered, or non-canonical.");
  }
  if (dirty !== false) fail("Application local provenance requires a clean source tree.");
  const expected = APPLICATION_IMAGE_TARGETS.find((entry) => entry.target === identity?.target);
  if (!expected) fail("Application local provenance target is not reviewed.");
  const normalizedIdentity = normalizeIdentity(identity, expected, true);
  if (
    normalizedIdentity.sourceRepository !== sourceRepository
    || normalizedIdentity.sourceRevision !== sourceRevision
  ) {
    fail("Application local provenance source does not match the image labels.");
  }
  const source = validateApplicationSourceBinding({
    actualRepository: sourceRepository,
    actualRevision: sourceRevision,
    actualTree: sourceTree,
    contextSha256: sourceContextSha256,
  });
  if (typeof baseReference !== "string" || !/@sha256:[a-f0-9]{64}$/.test(baseReference)) {
    fail("Application local provenance requires an immutable base reference.");
  }
  if (
    !exactKeys(builder, ["docker", "buildx"])
    || typeof builder.docker !== "string"
    || !builder.docker.trim()
    || typeof builder.buildx !== "string"
    || !builder.buildx.trim()
  ) {
    fail("Application local provenance requires Docker and Buildx versions.");
  }
  return {
    schemaVersion: 1,
    evidenceKind: "codestead-application-local-build-provenance",
    generatedAt,
    riskAcceptance: canonicalRiskAcceptance,
    source: { ...source, dirty: false },
    builder: { docker: builder.docker.trim(), buildx: builder.buildx.trim() },
    inputs: normalizeLocalInputs(inputs),
    baseReference,
    image: normalizedIdentity,
  };
}

export function validateApplicationLocalProvenance({ evidenceText, identity }) {
  let evidence;
  try {
    evidence = JSON.parse(evidenceText);
  } catch {
    fail("Application local provenance is malformed.");
  }
  const normalized = createApplicationLocalProvenance({
    generatedAt: evidence.generatedAt,
    riskAcceptance: evidence.riskAcceptance,
    identity,
    baseReference: evidence.baseReference,
    sourceRepository: evidence.source?.repository,
    sourceRevision: evidence.source?.revision,
    sourceTree: evidence.source?.tree,
    sourceContextSha256: evidence.source?.contextSha256,
    dirty: evidence.source?.dirty,
    builder: evidence.builder,
    inputs: evidence.inputs,
  });
  if (!isDeepStrictEqual(evidence, normalized)) {
    fail("Application local provenance has been tampered or contains unreviewed fields.");
  }
  return evidence;
}

export function runApplicationRegistryPublication({
  targets,
  resolveIdentity,
  preparePredicate,
  signIdentity,
  attestIdentity,
  verifyIdentity,
  recheckIdentity,
  finalize,
}) {
  if (
    !isDeepStrictEqual(targets, APPLICATION_IMAGE_TARGETS)
    || [
      resolveIdentity, preparePredicate, signIdentity, attestIdentity,
      verifyIdentity, recheckIdentity, finalize,
    ].some((operation) => typeof operation !== "function")
  ) {
    fail("Application registry publication requires the canonical targets and complete operations.");
  }
  const identities = APPLICATION_IMAGE_TARGETS.map((expected) => {
    const identity = resolveIdentity(expected.target);
    return normalizeIdentity(identity, expected, false);
  });
  const records = identities.map((identity) => {
    const prepared = preparePredicate(identity);
    if (
      !exactKeys(prepared, ["predicateText", "buildkitStatementText"])
      || typeof prepared.predicateText !== "string"
      || !prepared.predicateText.trim()
      || typeof prepared.buildkitStatementText !== "string"
      || !prepared.buildkitStatementText.trim()
    ) {
      fail(`Application registry predicate is incomplete for ${identity.target}.`);
    }
    signIdentity({ identity });
    attestIdentity({ identity, predicateText: prepared.predicateText });
    const verification = verifyIdentity({
      identity,
      buildkitStatementText: prepared.buildkitStatementText,
    });
    if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
      fail(`Application registry verification evidence is incomplete for ${identity.target}.`);
    }
    return { identity, predicateText: prepared.predicateText, verification };
  });
  for (const identity of identities) {
    const expected = APPLICATION_IMAGE_TARGETS.find((target) => target.target === identity.target);
    const current = recheckIdentity(identity);
    if (!sameIdentity(identity, current)) {
      fail(`Application image ${identity.target} changed after registry signing.`);
    }
    normalizeIdentity(current, expected, false);
  }
  return finalize({ identities, records });
}

export function runApplicationSecurityScan({
  targets,
  destination,
  failedDestination,
  createStaging,
  removeTree,
  renameTree,
  resolveIdentity,
  scanIdentity,
  recheckIdentity,
  finalize,
}) {
  if (
    !isDeepStrictEqual(targets, APPLICATION_IMAGE_TARGETS)
    || typeof destination !== "string"
    || !destination
    || typeof failedDestination !== "string"
    || !failedDestination
    || [
      createStaging, removeTree, renameTree, resolveIdentity,
      scanIdentity, recheckIdentity, finalize,
    ].some((operation) => typeof operation !== "function")
  ) {
    fail("Application security scan requires the canonical targets and complete transaction operations.");
  }
  removeTree(destination);
  removeTree(failedDestination);
  const staging = createStaging();
  try {
    const identities = APPLICATION_IMAGE_TARGETS.map((target) => {
      const identity = resolveIdentity(target.target);
      if (identity?.target !== target.target || identity.variable !== target.variable) {
        fail(`Application image resolver returned the wrong target for ${target.target}.`);
      }
      return identity;
    });
    const records = identities.map((identity) => scanIdentity({ staging, identity }));
    for (const identity of identities) {
      const current = recheckIdentity(identity);
      if (!sameIdentity(identity, current)) {
        fail(`Application image ${identity.target} changed during the security gate.`);
      }
    }
    const result = finalize({ staging, identities, records });
    renameTree(staging, destination);
    return result;
  } catch (error) {
    try {
      renameTree(staging, failedDestination);
    } catch (preservationError) {
      throw new AggregateError(
        [error, preservationError],
        "Application scan failed and its diagnostic evidence could not be preserved.",
      );
    }
    throw error;
  }
}
export function publishApplicationImageRecordTransaction({
  directory,
  publication,
  token,
  writeStaging,
  flushStaging,
  renameStaging,
  removeStaging,
  flushDirectory,
}) {
  if (
    typeof directory !== "string"
    || !directory
    || typeof token !== "string"
    || !/^[A-Za-z0-9._-]+$/.test(token)
    || !publication?.jsonText
    || !publication?.envText
    || [writeStaging, flushStaging, renameStaging, removeStaging, flushDirectory]
      .some((operation) => typeof operation !== "function")
  ) {
    fail("Application image record publication requires safe paths and durable operations.");
  }
  const envDestination = path.join(directory, "application-images.env");
  const jsonDestination = path.join(directory, "application-images.json");
  const envStaging = path.join(directory, `.application-images.env.staging-${token}`);
  const jsonStaging = path.join(directory, `.application-images.json.staging-${token}`);
  try {
    writeStaging(envStaging, publication.envText);
    flushStaging(envStaging);
    writeStaging(jsonStaging, publication.jsonText);
    flushStaging(jsonStaging);
    renameStaging(envStaging, envDestination);
    flushDirectory(directory);
    // JSON is the canonical commit marker and is published only after the env projection is durable.
    renameStaging(jsonStaging, jsonDestination);
    flushDirectory(directory);
  } catch (error) {
    removeStaging(envStaging);
    removeStaging(jsonStaging);
    throw error;
  }
  return { recordId: publication.recordId, envDestination, jsonDestination };
}
