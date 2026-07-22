import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import Ajv2019 from "ajv/dist/2019.js";

const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const IN_TOTO_SPDX_PREDICATE = "https://spdx.dev/Document";
const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v0.1";
const SLSA_PROVENANCE_PREDICATES = new Set([
  "https://slsa.dev/provenance/v0.2",
  "https://slsa.dev/provenance/v1",
]);
export const LOCAL_PROVENANCE_ACCEPTANCE = "accept-unsigned-local-buildkit-provenance-v1";
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const EVIDENCE_FILE = /^[a-z0-9][a-z0-9.-]*\.json$/;
const SCANNER_ENVIRONMENT_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR",
];
const SPDX_2_3_SCHEMA = JSON.parse(
  readFileSync(new URL("./schema/spdx-2.3.schema.json", import.meta.url), "utf8"),
);
const spdxSchemaValidator = new Ajv2019({ allErrors: true, strict: false });
const validateOfficialSpdxDocument = spdxSchemaValidator.compile(SPDX_2_3_SCHEMA);

function yamlString(value) {
  return JSON.stringify(value);
}

export function createScannerControlBundle(controlDirectory) {
  if (typeof controlDirectory !== "string" || !controlDirectory || controlDirectory.includes("\0")) {
    throw new Error("Scanner control directory must be a non-empty path.");
  }
  const homeDirectory = path.join(controlDirectory, "home");
  const xdgConfigDirectory = path.join(homeDirectory, "xdg");
  const emptyIgnoreFile = path.join(controlDirectory, "empty.trivyignore");
  const trivyConfig = path.join(controlDirectory, "trivy.yaml");
  const syftConfig = path.join(controlDirectory, "syft.yaml");
  const grypeConfig = path.join(controlDirectory, "grype.yaml");
  const files = new Map([
    [emptyIgnoreFile, ""],
    [trivyConfig, [
      `ignorefile: ${yamlString(emptyIgnoreFile)}`,
      'ignore-policy: ""',
      "scan:",
      "  disable-telemetry: true",
      "  offline: true",
      "  skip-version-check: true",
      "  skip-dirs: []",
      "  skip-files: []",
      "  sbom-sources: []",
      "vulnerability:",
      "  ignore-status: []",
      "  ignore-unfixed: false",
      "  skip-vex-repo-update: true",
      "  vex: []",
      "",
    ].join("\n")],
    [syftConfig, [
      "check-for-app-update: false",
      "exclude: []",
      "enrich: []",
      "source:",
      "  image:",
      "    default-pull-source: docker",
      "golang:",
      "  search-local-mod-cache-licenses: false",
      "  search-local-vendor-licenses: false",
      "  search-remote-licenses: false",
      "  use-packages-lib: false",
      "java:",
      "  use-network: false",
      "",
    ].join("\n")],
    [grypeConfig, [
      "check-for-app-update: false",
      "only-fixed: false",
      "only-notfixed: false",
      'ignore-wontfix: ""',
      "ignore: []",
      "exclude: []",
      "external-sources:",
      "  enable: false",
      "  maven:",
      "    search-maven-upstream: false",
      "vex-documents: []",
      "vex-add: []",
      "default-image-pull-source: docker",
      "from:",
      "  - docker",
      "db:",
      "  auto-update: false",
      "  require-update-check: false",
      "",
    ].join("\n")],
  ]);
  return {
    controlDirectory,
    homeDirectory,
    xdgConfigDirectory,
    emptyIgnoreFile,
    trivyConfig,
    syftConfig,
    grypeConfig,
    files,
  };
}

export function createHermeticScannerEnvironment({
  hostEnvironment,
  homeDirectory,
  trivyCacheDirectory,
}) {
  if (!hostEnvironment || typeof hostEnvironment !== "object") {
    throw new Error("A host environment object is required for scanner isolation.");
  }
  if (typeof homeDirectory !== "string" || !homeDirectory || homeDirectory.includes("\0")) {
    throw new Error("An isolated scanner home directory is required.");
  }
  const trustedTrivyCache = trivyCacheDirectory ?? path.join(homeDirectory, "trivy-cache");
  if (typeof trustedTrivyCache !== "string" || !trustedTrivyCache || trustedTrivyCache.includes("\0")) {
    throw new Error("A trusted Trivy cache directory is required for scanner isolation.");
  }
  const environment = {};
  for (const name of SCANNER_ENVIRONMENT_ALLOWLIST) {
    if (typeof hostEnvironment[name] === "string" && hostEnvironment[name]) {
      environment[name] = hostEnvironment[name];
    }
  }
  environment.HOME = homeDirectory;
  environment.USERPROFILE = homeDirectory;
  environment.XDG_CONFIG_HOME = path.join(homeDirectory, "xdg");
  environment.TRIVY_DISABLE_TELEMETRY = "true";
  environment.TRIVY_CACHE_DIR = trustedTrivyCache;
  environment.SYFT_CHECK_FOR_APP_UPDATE = "false";
  environment.GRYPE_CHECK_FOR_APP_UPDATE = "false";
  environment.GRYPE_DB_AUTO_UPDATE = "false";
  environment.GRYPE_DB_REQUIRE_UPDATE_CHECK = "false";
  environment.GRYPE_EXTERNAL_SOURCES_ENABLE = "false";
  return environment;
}

export function resolveCommandEnvironment(hostEnvironment, options = {}) {
  if (!hostEnvironment || typeof hostEnvironment !== "object") {
    throw new Error("A host environment object is required for command execution.");
  }
  if (options.hermeticEnvironment) {
    if (!options.env || typeof options.env !== "object") {
      throw new Error("Hermetic command execution requires an explicit environment.");
    }
    return { ...options.env };
  }
  return { ...hostEnvironment, ...(options.env ?? {}) };
}

const OCI_REPOSITORY_SEGMENT = "[a-z0-9]+(?:[._-][a-z0-9]+)*";
const BARE_OCI_REPOSITORY = new RegExp(
  `^(?:${OCI_REPOSITORY_SEGMENT}(?::[1-9][0-9]{0,4})?)(?:/${OCI_REPOSITORY_SEGMENT})+$`,
);
const IMMUTABLE_RELEASE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MUTABLE_RELEASE_NAMES = new Set(["latest", "stable", "current", "main", "master"]);

export function validateRuntimeCoordinates({ repository, release }) {
  if (
    typeof repository !== "string"
    || !BARE_OCI_REPOSITORY.test(repository)
    || repository.includes("..")
  ) {
    throw new Error("RUNTIME_REPOSITORY must be a canonical bare OCI repository without a tag or digest.");
  }
  if (
    typeof release !== "string"
    || !IMMUTABLE_RELEASE_SEGMENT.test(release)
    || (release !== "local" && MUTABLE_RELEASE_NAMES.has(release))
  ) {
    throw new Error("RUNTIME_RELEASE must be a canonical immutable release segment (or local for local-only builds).");
  }
  return { repository, release };
}

export function requireSourceDateEpoch(environment) {
  const value = environment.RUNTIME_SOURCE_DATE_EPOCH;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("RUNTIME_SOURCE_DATE_EPOCH must be a canonical decimal value in runtime/images.env.");
  }
  return value;
}

export function buildxArguments({
  publish,
  archive,
  sourceDateEpoch,
  buildArguments,
  tag,
  dockerfile,
  context,
}) {
  const exportArguments = publish
    ? ["--push", "--provenance=mode=max", "--sbom=true"]
    : [
        "--output", `type=oci,dest=${archive},rewrite-timestamp=true`,
        "--provenance=false", "--sbom=false",
      ];
  const effectiveBuildArguments = publish
    ? buildArguments
    : [...buildArguments, `SOURCE_DATE_EPOCH=${sourceDateEpoch}`];
  return [
    "buildx", "build", "--platform", "linux/amd64",
    ...exportArguments,
    ...effectiveBuildArguments.flatMap((argument) => ["--build-arg", argument]),
    "--tag", tag,
    "--file", dockerfile,
    context,
  ];
}

function digestMember(digest) {
  if (!OCI_DIGEST.test(digest)) throw new Error(`Invalid OCI descriptor digest: ${digest}`);
  return `blobs/sha256/${digest.slice("sha256:".length)}`;
}

function parseJsonMember(readMember, member, description, expectedDigest) {
  let value;
  try {
    value = readMember(member);
  } catch (error) {
    throw new Error(`Missing ${description}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === undefined || value === null) throw new Error(`Missing ${description}.`);
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (expectedDigest) verifyDescriptor(raw, expectedDigest, description);
  try {
    return { raw, parsed: JSON.parse(raw.toString()) };
  } catch (error) {
    throw new Error(`Malformed ${description}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyDescriptor(raw, digest, description) {
  if (!OCI_DIGEST.test(digest)) throw new Error(`Invalid ${description} digest: ${digest}`);
  const actual = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  if (actual !== digest) throw new Error(`${description} digest does not match its archive content.`);
}

export function ociImageIdentityFromMembers(readMember) {
  const { parsed: index } = parseJsonMember(readMember, "index.json", "OCI index");
  const manifests = index.manifests;
  if (!Array.isArray(manifests) || manifests.length !== 1) {
    throw new Error("OCI archive must contain exactly one root image manifest.");
  }
  const descriptor = manifests[0];
  if (descriptor?.mediaType !== OCI_MANIFEST || !OCI_DIGEST.test(descriptor?.digest ?? "")) {
    throw new Error("OCI archive has an invalid root image manifest descriptor.");
  }
  if (descriptor.platform && (descriptor.platform.os !== "linux" || descriptor.platform.architecture !== "amd64")) {
    throw new Error("OCI archive root image is not linux/amd64.");
  }
  const manifestMember = digestMember(descriptor.digest);
  const { parsed: manifest } = parseJsonMember(
    readMember,
    manifestMember,
    "OCI image manifest",
    descriptor.digest,
  );
  const configDigest = manifest.config?.digest;
  if (!OCI_DIGEST.test(configDigest ?? "")) throw new Error("OCI image manifest has no valid image config identity.");
  const configMember = digestMember(configDigest);
  parseJsonMember(readMember, configMember, "OCI image config", configDigest);
  return { manifestDigest: descriptor.digest, configDigest };
}

function requireDescriptorSize(raw, descriptor, description) {
  if (!Number.isSafeInteger(descriptor?.size) || descriptor.size < 0 || raw.length !== descriptor.size) {
    throw new Error(`${description} size does not match its descriptor.`);
  }
}

export function extractAttestedSpdxFromMembers({
  readMember,
  expectedRootDigest,
  expectedChildDigest,
  expectedSourceRepository,
  expectedSourceRevision,
  requiredMaterialDigests,
}) {
  if (!OCI_DIGEST.test(expectedRootDigest ?? "") || !OCI_DIGEST.test(expectedChildDigest ?? "")) {
    throw new Error("Attested SPDX extraction requires immutable root and child manifest digests.");
  }
  const { parsed: archiveIndex } = parseJsonMember(readMember, "index.json", "OCI archive index");
  if (!Array.isArray(archiveIndex.manifests) || archiveIndex.manifests.length !== 1) {
    throw new Error("OCI archive must contain exactly one attested root index descriptor.");
  }
  const rootDescriptor = archiveIndex.manifests[0];
  if (rootDescriptor?.mediaType !== OCI_INDEX || rootDescriptor.digest !== expectedRootDigest) {
    throw new Error("OCI archive root index does not match the frozen registry identity.");
  }
  const root = parseJsonMember(
    readMember,
    digestMember(rootDescriptor.digest),
    "OCI attested image index",
    rootDescriptor.digest,
  );
  requireDescriptorSize(root.raw, rootDescriptor, "OCI attested image index");
  const imageIndex = root.parsed;
  if (imageIndex.schemaVersion !== 2 || imageIndex.mediaType !== OCI_INDEX || !Array.isArray(imageIndex.manifests)) {
    throw new Error("OCI attested image index is malformed.");
  }
  const child = imageIndex.manifests.find((descriptor) =>
    descriptor?.digest === expectedChildDigest
    && descriptor.mediaType === OCI_MANIFEST
    && descriptor.platform?.os === "linux"
    && descriptor.platform?.architecture === "amd64"
  );
  if (!child) throw new Error("Attested image index has no matching linux/amd64 child manifest.");
  const attestations = imageIndex.manifests.filter((descriptor) =>
    descriptor?.mediaType === OCI_MANIFEST
    && descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
    && descriptor.annotations?.["vnd.docker.reference.digest"] === expectedChildDigest
  );
  if (attestations.length !== 1) {
    throw new Error("Attested image index must contain exactly one attestation linked to the child manifest.");
  }
  const attestationDescriptor = attestations[0];
  const attestation = parseJsonMember(
    readMember,
    digestMember(attestationDescriptor.digest),
    "OCI attestation manifest",
    attestationDescriptor.digest,
  );
  requireDescriptorSize(attestation.raw, attestationDescriptor, "OCI attestation manifest");
  if (attestation.parsed.schemaVersion !== 2 || attestation.parsed.mediaType !== OCI_MANIFEST) {
    throw new Error("OCI attestation manifest is malformed.");
  }
  const spdxLayers = (attestation.parsed.layers ?? []).filter((layer) =>
    layer?.annotations?.["in-toto.io/predicate-type"] === IN_TOTO_SPDX_PREDICATE
  );
  if (spdxLayers.length !== 1) throw new Error("Attestation must contain exactly one SPDX predicate layer.");
  const statementLayer = spdxLayers[0];
  const statement = parseJsonMember(
    readMember,
    digestMember(statementLayer.digest),
    "in-toto SPDX statement",
    statementLayer.digest,
  );
  requireDescriptorSize(statement.raw, statementLayer, "in-toto SPDX statement");
  if (statement.parsed.predicateType !== IN_TOTO_SPDX_PREDICATE || !statement.parsed.predicate) {
    throw new Error("Attestation contains a malformed SPDX predicate.");
  }
  const childHex = expectedChildDigest.slice("sha256:".length);
  if (!(statement.parsed.subject ?? []).some((subject) => subject?.digest?.sha256 === childHex)) {
    throw new Error("Attestation in-toto subject does not match the child manifest.");
  }
  const documentText = `${JSON.stringify(statement.parsed.predicate, null, 2)}\n`;
  validateSpdxDocument(documentText);
  const provenanceLayers = (attestation.parsed.layers ?? []).filter((layer) =>
    SLSA_PROVENANCE_PREDICATES.has(layer?.annotations?.["in-toto.io/predicate-type"])
  );
  if (provenanceLayers.length !== 1) {
    throw new Error("Attestation must contain exactly one BuildKit SLSA provenance predicate layer.");
  }
  const provenanceLayer = provenanceLayers[0];
  const provenanceStatement = parseJsonMember(
    readMember,
    digestMember(provenanceLayer.digest),
    "in-toto SLSA provenance statement",
    provenanceLayer.digest,
  );
  requireDescriptorSize(provenanceStatement.raw, provenanceLayer, "in-toto SLSA provenance statement");
  const provenanceText = provenanceStatement.raw.toString("utf8");
  const provenance = validateSlsaProvenanceStatement({
    statementText: provenanceText,
    exactReference: `runtime.invalid/image@${expectedChildDigest}`,
    sourceRepository: expectedSourceRepository,
    sourceRevision: expectedSourceRevision,
    requiredMaterialDigests,
  });
  return {
    attestationManifestDigest: attestationDescriptor.digest,
    statementDigest: statementLayer.digest,
    statementText: statement.raw.toString("utf8"),
    documentText,
    provenanceStatementDigest: provenanceLayer.digest,
    provenanceText,
    provenance,
  };
}

export function localImageReference(repository, digest) {
  if (typeof repository !== "string" || !repository || /[@\s]/.test(repository)) {
    throw new Error("Invalid local image repository.");
  }
  if (!OCI_DIGEST.test(digest)) throw new Error(`Invalid local image identity: ${digest}`);
  return `${repository}@${digest}`;
}

function localBuildIdentity(value, index) {
  if (!hasExactKeys(value, ["id", "tag", "manifestDigest", "configDigest", "reference"])) {
    throw new Error(`Local build identity ${index} has an invalid shape.`);
  }
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9]*$/.test(value.id)) {
    throw new Error(`Local build identity ${index} has an invalid language.`);
  }
  if (typeof value.tag !== "string" || /[@\s]/.test(value.tag)) {
    throw new Error(`Local build identity ${value.id} has an invalid tag or reference.`);
  }
  const slash = value.tag.lastIndexOf("/");
  const colon = value.tag.lastIndexOf(":");
  const repository = colon > slash ? value.tag.slice(0, colon) : "";
  const tagName = colon > slash ? value.tag.slice(colon + 1) : "";
  if (
    !repository.endsWith(`-${value.id}`)
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tagName)
    || value.reference !== `${repository}@${value.manifestDigest}`
  ) {
    throw new Error(`Local build identity ${value.id} has an invalid tag or reference.`);
  }
  if (!OCI_DIGEST.test(value.manifestDigest ?? "") || !OCI_DIGEST.test(value.configDigest ?? "")) {
    throw new Error(`Local build identity ${value.id} has an invalid digest.`);
  }
  if (value.manifestDigest === value.configDigest) {
    throw new Error(`Local build identity ${value.id} manifest and config identities must remain distinct.`);
  }
  return {
    id: value.id,
    tag: value.tag,
    manifestDigest: value.manifestDigest,
    configDigest: value.configDigest,
    reference: value.reference,
  };
}

export function validateLocalBuildIdentityRecord(text, expected) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Local build identity record is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!hasExactKeys(parsed, ["schemaVersion", "records"]) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
    throw new Error("Local build identity record must contain only schemaVersion 1 and records.");
  }
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error("Local build identity validation requires expected languages and tags.");
  }
  const expectedLanguages = new Set();
  for (const item of expected) {
    if (!hasExactKeys(item, ["language", "tag"]) || typeof item.language !== "string" || typeof item.tag !== "string") {
      throw new Error("Local build identity expectation is malformed.");
    }
    if (expectedLanguages.has(item.language)) throw new Error(`Duplicate expected local build language ${item.language}.`);
    expectedLanguages.add(item.language);
  }
  const records = parsed.records.map(localBuildIdentity);
  if (records.length !== expected.length) {
    throw new Error(`Local build identity record has ${records.length} records; expected ${expected.length}.`);
  }
  const result = {};
  for (const item of expected) {
    const matches = records.filter((record) => record.id === item.language);
    if (matches.length !== 1 || matches[0].tag !== item.tag) {
      throw new Error(`Local build identity record must contain exactly one ${item.language} record with tag ${item.tag}.`);
    }
    result[item.language] = matches[0];
  }
  return result;
}

export function createLocalBuildIdentityRecord(identities) {
  if (!Array.isArray(identities) || identities.length === 0) {
    throw new Error("Local build identities must be a non-empty array.");
  }
  const text = `${JSON.stringify({ schemaVersion: 1, records: identities }, null, 2)}\n`;
  validateLocalBuildIdentityRecord(text, identities.map((identity) => ({
    language: identity.id,
    tag: identity.tag,
  })));
  return text;
}

export function resolveLocalImageIdentity({ language, tag, repository, inspectImage, expectedIdentity }) {
  if (typeof language !== "string" || !language || typeof tag !== "string" || !tag) {
    throw new Error("A local runtime language and tag are required.");
  }
  if (typeof inspectImage !== "function") {
    throw new Error("A local Docker image inspector is required.");
  }
  const tagged = inspectImage(tag);
  const manifestDigest = tagged?.Descriptor?.digest;
  if (!OCI_DIGEST.test(manifestDigest ?? "")) {
    throw new Error(`Local image ${tag} has no Docker-addressable manifest descriptor.`);
  }
  if (expectedIdentity !== undefined) {
    if (
      !hasExactKeys(expectedIdentity, ["manifestDigest", "configDigest"])
      || !OCI_DIGEST.test(expectedIdentity.manifestDigest ?? "")
      || !OCI_DIGEST.test(expectedIdentity.configDigest ?? "")
      || expectedIdentity.manifestDigest === expectedIdentity.configDigest
    ) {
      throw new Error(`Expected local identity for ${language} is invalid.`);
    }
    if (manifestDigest !== expectedIdentity.manifestDigest) {
      throw new Error(`Expected local manifest identity for ${language} does not match the tagged image.`);
    }
  }
  const dockerImageId = tagged?.Id;
  if (!OCI_DIGEST.test(dockerImageId ?? "")) {
    throw new Error(`Local image ${tag} has no valid Docker image ID.`);
  }
  const configDigest = dockerImageId === manifestDigest
    ? expectedIdentity?.configDigest
    : dockerImageId;
  if (!OCI_DIGEST.test(configDigest ?? "")) {
    throw new Error(`Local image ${tag} requires its archive-verified config identity.`);
  }
  if (manifestDigest === configDigest) {
    throw new Error(`Local image ${tag} conflates its manifest and config identities.`);
  }
  if (expectedIdentity && configDigest !== expectedIdentity.configDigest) {
    throw new Error(`Expected local config identity for ${language} does not match the tagged image.`);
  }
  const imageReference = localImageReference(repository, manifestDigest);
  const exact = inspectImage(imageReference);
  if (exact?.Descriptor?.digest !== manifestDigest) {
    throw new Error(`Exact local reference ${imageReference} does not resolve to its manifest identity.`);
  }
  if (exact?.Id !== dockerImageId) {
    throw new Error(`Exact local reference ${imageReference} does not resolve to the tagged image identity.`);
  }
  return {
    language,
    tag,
    imageReference,
    manifestDigest,
    configDigest,
    rootDigest: manifestDigest,
  };
}

export function runDeterministicLocalBuild({
  runtimes,
  temporaryPrefix,
  createTemporaryDirectory,
  removeTemporaryDirectory,
  buildArchive,
  readArchiveIdentity,
  loadArchive,
  inspectImage,
  exactReference,
}) {
  const temporary = createTemporaryDirectory(temporaryPrefix);
  const identities = [];
  try {
    for (const runtime of runtimes) {
      const archive = path.join(temporary, `${runtime.id}.oci.tar`);
      buildArchive(runtime, archive);
      const identity = readArchiveIdentity(archive);
      const manifestDigest = identity?.manifestDigest;
      const configDigest = identity?.configDigest;
      if (!OCI_DIGEST.test(manifestDigest ?? "") || !OCI_DIGEST.test(configDigest ?? "")) {
        throw new Error(`Invalid OCI archive manifest/config identity for ${runtime.id}.`);
      }
      if (manifestDigest === configDigest) {
        throw new Error(`OCI archive manifest and config identities are conflated for ${runtime.id}.`);
      }
      loadArchive(archive);
      const taggedImage = inspectImage(runtime.tag);
      if (taggedImage?.Descriptor?.digest !== manifestDigest) {
        throw new Error(`Loaded tag ${runtime.tag} does not match its OCI archive manifest identity.`);
      }
      // Docker's classic image store exposes the config digest as Id, while
      // the containerd image store exposes the selected manifest digest.
      // Descriptor.digest binds that manifest to the archive-verified config.
      if (![configDigest, manifestDigest].includes(taggedImage?.Id)) {
        throw new Error(`Loaded tag ${runtime.tag} does not match its OCI archive config identity.`);
      }
      const reference = exactReference(runtime, manifestDigest);
      const exactImage = inspectImage(reference);
      if (exactImage?.Descriptor?.digest !== manifestDigest) {
        throw new Error(`Exact local reference ${reference} does not resolve to its OCI archive manifest identity.`);
      }
      if (![configDigest, manifestDigest].includes(exactImage?.Id)) {
        throw new Error(`Exact local reference ${reference} does not resolve to its OCI archive config identity.`);
      }
      identities.push({
        id: runtime.id,
        tag: runtime.tag,
        manifestDigest,
        configDigest,
        reference,
      });
    }
    return identities;
  } finally {
    removeTemporaryDirectory(temporary);
  }
}

export function runEvidenceDirectoryTransaction({
  destination,
  failedDestination,
  createStaging,
  removeTree,
  renameTree,
  operation,
}) {
  removeTree(destination);
  removeTree(failedDestination);
  const staging = createStaging();
  try {
    const result = operation(staging);
    renameTree(staging, destination);
    return result;
  } catch (error) {
    try {
      renameTree(staging, failedDestination);
    } catch (preservationError) {
      throw new AggregateError(
        [error, preservationError],
        "Runtime scan failed and its diagnostic evidence could not be preserved.",
      );
    }
    throw error;
  }
}

function trivyOfflineArguments() {
  return [
    "image",
    "--skip-db-update",
    "--skip-java-db-update",
    "--offline-scan",
    "--skip-version-check",
    "--disable-telemetry",
    "--image-src", "docker",
  ];
}

export function validateSpdxDocument(documentText) {
  let document;
  try {
    document = JSON.parse(documentText);
  } catch (error) {
    throw new Error(`Malformed SPDX document: ${error instanceof Error ? error.message : String(error)}`);
  }

  const malformed = (reason) => {
    throw new Error(`Malformed SPDX document: ${reason}.`);
  };
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    malformed("document root must be an object");
  }
  if (!validateOfficialSpdxDocument(document)) {
    malformed(`official SPDX 2.3 JSON schema validation failed: ${spdxSchemaValidator.errorsText(validateOfficialSpdxDocument.errors)}`);
  }
  if (
    document.spdxVersion !== "SPDX-2.3"
    || document.dataLicense !== "CC0-1.0"
    || document.SPDXID !== "SPDXRef-DOCUMENT"
    || typeof document.name !== "string"
    || !document.name
  ) {
    malformed("required SPDX 2.3 document metadata is missing or invalid");
  }
  try {
    const namespace = new URL(document.documentNamespace);
    if (!namespace.protocol || !document.documentNamespace.includes(":")) {
      malformed("documentNamespace must be an absolute URI");
    }
  } catch {
    malformed("documentNamespace must be an absolute URI");
  }

  const created = document.creationInfo?.created;
  if (
    typeof created !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created)
    || Number.isNaN(Date.parse(created))
  ) {
    malformed("creationInfo.created must be a real UTC SPDX timestamp");
  }
  if (
    !Array.isArray(document.creationInfo?.creators)
    || document.creationInfo.creators.length === 0
    || document.creationInfo.creators.some(
      (creator) => typeof creator !== "string"
        || !/^(?:Tool|Person|Organization):\s+\S/.test(creator),
    )
  ) {
    malformed("creationInfo.creators is missing or invalid");
  }

  if (!Array.isArray(document.packages) || document.packages.length === 0) {
    malformed("non-scratch runtime SBOM must contain package evidence");
  }
  const elementIds = new Set(["SPDXRef-DOCUMENT"]);
  const packageIds = new Set();
  const registerElements = (entries, description, packages = false) => {
    if (entries === undefined) return;
    if (!Array.isArray(entries)) malformed(`${description} must be an array`);
    for (const entry of entries) {
      if (
        !entry
        || typeof entry !== "object"
        || !/^SPDXRef-[A-Za-z0-9.-]+$/.test(entry.SPDXID ?? "")
        || elementIds.has(entry.SPDXID)
      ) {
        malformed(`${description} has an invalid or duplicate SPDX identifier`);
      }
      elementIds.add(entry.SPDXID);
      if (packages) packageIds.add(entry.SPDXID);
    }
  };
  registerElements(document.packages, "package evidence", true);
  registerElements(document.files, "file evidence");
  registerElements(document.snippets, "snippet evidence");

  const externalDocuments = new Set();
  for (const reference of document.externalDocumentRefs ?? []) {
    const id = reference?.externalDocumentId;
    if (!/^DocumentRef-[A-Za-z0-9.-]+$/.test(id ?? "") || externalDocuments.has(id)) {
      malformed("external document reference is invalid or duplicated");
    }
    externalDocuments.add(id);
  }
  const knownElement = (id) => {
    if (elementIds.has(id)) return true;
    const external = /^(DocumentRef-[A-Za-z0-9.-]+):SPDXRef-[A-Za-z0-9.-]+$/.exec(id ?? "");
    return Boolean(external && externalDocuments.has(external[1]));
  };

  if (!Array.isArray(document.relationships) || document.relationships.length === 0) {
    malformed("document has no SPDX relationships");
  }
  let describedRoot = false;
  for (const relationship of document.relationships) {
    if (
      !relationship
      || typeof relationship !== "object"
      || !knownElement(relationship.spdxElementId)
      || !knownElement(relationship.relatedSpdxElement)
      || typeof relationship.relationshipType !== "string"
      || !relationship.relationshipType
    ) {
      malformed("relationship references an unknown or invalid SPDX element");
    }
    if (
      relationship.spdxElementId === "SPDXRef-DOCUMENT"
      && relationship.relationshipType === "DESCRIBES"
      && packageIds.has(relationship.relatedSpdxElement)
    ) {
      describedRoot = true;
    }
  }
  if (!describedRoot) malformed("document does not DESCRIBE a package root");
  return document;
}

function validateAttestedSpdxBinding({ exactReference, document, attestationText }) {
  const statement = requireJsonText(attestationText, "in-toto SPDX attestation");
  if (statement.predicateType !== IN_TOTO_SPDX_PREDICATE || !isDeepStrictEqual(statement.predicate, document)) {
    throw new Error("In-toto SPDX attestation predicate does not match the bound document.");
  }
  const match = /@(sha256:[a-f0-9]{64})$/.exec(exactReference);
  if (!match) throw new Error(`Invalid exact image reference for SPDX binding: ${exactReference}`);
  const expectedHex = match[1].slice("sha256:".length);
  if (!(statement.subject ?? []).some((subject) => subject?.digest?.sha256 === expectedHex)) {
    throw new Error("In-toto subject does not match the exact image digest.");
  }
  return statement;
}

function exactReferenceManifestDigest(exactReference, description) {
  const match = /@(sha256:[a-f0-9]{64})$/.exec(exactReference ?? "");
  if (!match) throw new Error(`${description} requires an immutable image reference.`);
  return match[1];
}

function requireSourceIdentity(sourceRepository, sourceRevision) {
  if (
    typeof sourceRepository !== "string"
    || !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/.test(sourceRepository)
    || sourceRepository.endsWith("/")
    || sourceRepository.includes("..")
  ) {
    throw new Error("Build provenance requires a canonical HTTPS source repository.");
  }
  if (typeof sourceRevision !== "string" || !GIT_REVISION.test(sourceRevision)) {
    throw new Error("Build provenance requires an exact Git source revision.");
  }
  return { sourceRepository, sourceRevision };
}

function normalizedMaterialDigests(materials) {
  if (!Array.isArray(materials) || materials.length === 0) {
    throw new Error("SLSA provenance requires non-empty build materials.");
  }
  const digests = new Set();
  for (const material of materials) {
    if (typeof material?.uri !== "string" || !material.uri || !material.digest || typeof material.digest !== "object") {
      throw new Error("SLSA provenance contains a malformed build material.");
    }
    for (const [algorithm, value] of Object.entries(material.digest)) {
      if (algorithm === "sha256" && typeof value === "string" && SHA256_HEX.test(value)) {
        digests.add(`sha256:${value}`);
      }
    }
  }
  if (digests.size === 0) throw new Error("SLSA provenance materials have no SHA-256 identity.");
  return [...digests].sort();
}

export function validateSlsaProvenanceStatement({
  statementText,
  exactReference,
  sourceRepository,
  sourceRevision,
  requiredMaterialDigests,
}) {
  requireSourceIdentity(sourceRepository, sourceRevision);
  const manifestDigest = exactReferenceManifestDigest(exactReference, "SLSA provenance");
  const statement = requireJsonText(statementText, "BuildKit SLSA provenance");
  if (
    statement._type !== IN_TOTO_STATEMENT_TYPE
    || !SLSA_PROVENANCE_PREDICATES.has(statement.predicateType)
    || !statement.predicate
    || typeof statement.predicate !== "object"
  ) {
    throw new Error("BuildKit SLSA provenance has an unsupported statement or predicate type.");
  }
  const subjects = statement.subject;
  if (
    !Array.isArray(subjects)
    || subjects.length !== 1
    || subjects[0]?.digest?.sha256 !== manifestDigest.slice("sha256:".length)
  ) {
    throw new Error("BuildKit SLSA provenance subject does not match the image manifest.");
  }
  const predicate = statement.predicate;
  const builderId = predicate.builder?.id;
  if (
    typeof builderId !== "string"
    || !builderId
    || typeof predicate.buildType !== "string"
    || !predicate.buildType
  ) {
    throw new Error("BuildKit SLSA provenance is missing builder or build-type identity.");
  }
  const buildArguments = predicate.invocation?.parameters?.args;
  if (
    !buildArguments
    || typeof buildArguments !== "object"
    || buildArguments["build-arg:SOURCE_REPOSITORY"] !== sourceRepository
  ) {
    throw new Error("BuildKit SLSA provenance does not match the source repository.");
  }
  if (buildArguments["build-arg:SOURCE_REVISION"] !== sourceRevision) {
    throw new Error("BuildKit SLSA provenance does not match the source revision.");
  }
  if (!Array.isArray(requiredMaterialDigests) || requiredMaterialDigests.length === 0) {
    throw new Error("BuildKit SLSA validation requires at least one pinned base material.");
  }
  const materialDigests = normalizedMaterialDigests(predicate.materials);
  for (const digest of requiredMaterialDigests) {
    if (!OCI_DIGEST.test(digest ?? "") || !materialDigests.includes(digest)) {
      throw new Error("BuildKit SLSA provenance is missing a required base material digest.");
    }
  }
  return {
    predicateType: statement.predicateType,
    builderId,
    buildType: predicate.buildType,
    sourceRepository,
    sourceRevision,
    materialDigests,
  };
}

function exactLocalInputs(inputs) {
  const expected = ["Dockerfile", "harness.c", "images.env"];
  if (!Array.isArray(inputs) || inputs.length !== expected.length) {
    throw new Error("Local provenance requires the exact reviewed build-input set.");
  }
  const byName = new Map();
  for (const input of inputs) {
    if (
      !expected.includes(input?.name)
      || byName.has(input.name)
      || input.file !== input.name
      || typeof input.sha256 !== "string"
      || !SHA256_HEX.test(input.sha256)
    ) {
      throw new Error("Local provenance contains an invalid or duplicate reviewed build input.");
    }
    byName.set(input.name, { name: input.name, file: input.file, sha256: input.sha256 });
  }
  return expected.map((name) => byName.get(name));
}

export function createLocalProvenanceEvidence({
  generatedAt,
  acceptance,
  exactReference,
  configDigest,
  rootDigest,
  baseReference,
  sourceRepository,
  sourceRevision,
  dirty,
  builder,
  inputs,
}) {
  if (!validEvidenceTimestamp(generatedAt)) throw new Error("Local provenance requires a valid generation timestamp.");
  if (acceptance !== LOCAL_PROVENANCE_ACCEPTANCE) {
    throw new Error("Release requires explicit local provenance risk acceptance.");
  }
  requireSourceIdentity(sourceRepository, sourceRevision);
  if (dirty !== false) throw new Error("Local provenance requires a clean Git worktree.");
  const manifestDigest = exactReferenceManifestDigest(exactReference, "Local provenance");
  if (!OCI_DIGEST.test(configDigest ?? "") || configDigest === manifestDigest) {
    throw new Error("Local provenance has an invalid or conflated image config digest.");
  }
  if (rootDigest !== manifestDigest) throw new Error("Local provenance root digest must equal its local image manifest digest.");
  if (
    typeof baseReference !== "string"
    || !/@sha256:[a-f0-9]{64}$/.test(baseReference)
  ) {
    throw new Error("Local provenance requires an immutable base image reference.");
  }
  if (
    !builder
    || typeof builder.docker !== "string"
    || !builder.docker.trim()
    || typeof builder.buildx !== "string"
    || !builder.buildx.trim()
  ) {
    throw new Error("Local provenance requires Docker and Buildx version evidence.");
  }
  return {
    schemaVersion: 1,
    evidenceKind: "codestead-local-build-provenance",
    generatedAt,
    riskAcceptance: acceptance,
    source: { repository: sourceRepository, revision: sourceRevision, dirty: false },
    builder: { docker: builder.docker.trim(), buildx: builder.buildx.trim() },
    inputs: exactLocalInputs(inputs),
    image: {
      reference: exactReference,
      manifestDigest,
      configDigest,
      rootDigest,
      baseReference,
    },
  };
}

export function validateLocalProvenanceEvidence({
  evidenceText,
  exactReference,
  configDigest,
  rootDigest,
}) {
  const evidence = requireJsonText(evidenceText, "Local build provenance");
  if (evidence?.image?.configDigest !== configDigest) {
    throw new Error("Local provenance image config digest does not match the runtime identity.");
  }
  const normalized = createLocalProvenanceEvidence({
    generatedAt: evidence.generatedAt,
    acceptance: evidence.riskAcceptance,
    exactReference,
    configDigest,
    rootDigest,
    baseReference: evidence.image?.baseReference,
    sourceRepository: evidence.source?.repository,
    sourceRevision: evidence.source?.revision,
    dirty: evidence.source?.dirty,
    builder: evidence.builder,
    inputs: evidence.inputs,
  });
  if (!isDeepStrictEqual(evidence, normalized)) {
    throw new Error("Local build provenance contains unreviewed, missing, or tampered fields.");
  }
  return evidence;
}

function parseCosignRecords(text, description) {
  if (typeof text !== "string" || !text.trim()) throw new Error(`${description} is empty.`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    } catch (error) {
      throw new Error(`${description} is not valid JSON output.`, { cause: error });
    }
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length !== 1 || !records[0] || typeof records[0] !== "object") {
    throw new Error(`${description} must contain exactly one verification record.`);
  }
  return records;
}

function requireCosignCertificatePolicy(record, certificateIdentity, certificateIssuer) {
  if (record.optional?.Subject !== undefined && record.optional.Subject !== certificateIdentity) {
    throw new Error("Cosign verification does not match the required certificate identity.");
  }
  if (record.optional?.Issuer !== undefined && record.optional.Issuer !== certificateIssuer) {
    throw new Error("Cosign verification does not match the required certificate issuer.");
  }
}

export function validateCosignVerificationEvidence({
  signatureText,
  attestationText,
  exactReference,
  certificateIdentity,
  certificateIssuer,
  sourceRepository,
  sourceRevision,
  requiredMaterialDigests,
}) {
  if (typeof certificateIdentity !== "string" || !certificateIdentity || typeof certificateIssuer !== "string" || !certificateIssuer) {
    throw new Error("Cosign verification requires an exact certificate identity and issuer policy.");
  }
  const manifestDigest = exactReferenceManifestDigest(exactReference, "Cosign verification");
  const repository = exactReference.slice(0, exactReference.lastIndexOf("@"));
  const signatures = parseCosignRecords(signatureText, "Cosign signature verification evidence");
  const signature = signatures[0];
  if (signature.critical?.image?.["docker-manifest-digest"] !== manifestDigest) {
    throw new Error("Cosign signature digest does not match the runtime manifest.");
  }
  if (signature.critical?.identity?.["docker-reference"] !== repository) {
    throw new Error("Cosign signature repository does not match the runtime reference.");
  }
  requireCosignCertificatePolicy(signature, certificateIdentity, certificateIssuer);

  const attestations = parseCosignRecords(attestationText, "Cosign signed SLSA attestation evidence");
  const attestation = attestations[0];
  requireCosignCertificatePolicy(attestation, certificateIdentity, certificateIssuer);
  if (typeof attestation.payload !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(attestation.payload) || attestation.payload.length % 4 !== 0) {
    throw new Error("Cosign signed SLSA attestation payload is malformed.");
  }
  let statementText;
  try {
    statementText = Buffer.from(attestation.payload, "base64").toString("utf8");
    JSON.parse(statementText);
  } catch (error) {
    throw new Error("Cosign signed SLSA attestation payload is malformed.", { cause: error });
  }
  const provenance = validateSlsaProvenanceStatement({
    statementText,
    exactReference,
    sourceRepository,
    sourceRevision,
    requiredMaterialDigests,
  });
  return {
    certificateIdentity,
    certificateIssuer,
    signatureSha256: evidenceHash(signatureText),
    attestationSha256: evidenceHash(attestationText),
    predicateType: provenance.predicateType,
  };
}

export function createSpdxBinding({
  exactReference,
  documentText,
  targetProof = "scanner-target",
  attestationText,
}) {
  const document = validateSpdxDocument(documentText);
  const match = /@(sha256:[a-f0-9]{64})$/.exec(exactReference);
  if (!match) throw new Error(`Invalid exact image reference for SPDX binding: ${exactReference}`);
  let attestationSha256;
  if (targetProof === "scanner-target") {
    // The hermetic scanner invocation consumes this exact Docker reference.
    // Tool-specific document names (for example Syft's "sbom") are not target identities.
  } else if (targetProof === "in-toto-subject") {
    if (typeof attestationText !== "string" || !attestationText.trim()) {
      throw new Error("In-toto subject proof requires the attestation statement bytes.");
    }
    validateAttestedSpdxBinding({ exactReference, document, attestationText });
    attestationSha256 = createHash("sha256").update(attestationText).digest("hex");
  } else {
    throw new Error(`Unsupported SPDX target proof: ${targetProof}`);
  }
  const binding = {
    schemaVersion: 1,
    targetProof,
    imageReference: exactReference,
    manifestDigest: match[1],
    spdxSha256: createHash("sha256").update(documentText).digest("hex"),
  };
  if (attestationSha256) binding.attestationSha256 = attestationSha256;
  return binding;
}

function evidenceHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const REQUIRED_SCANNER_CONTROLS = new Set([
  "trivy-config", "syft-config", "grype-config", "trivy-ignore",
]);
const REQUIRED_TRIVY_DATABASES = new Set(["trivy-db", "trivy-java-db"]);
const REQUIRED_TRIVY_VERSION = "0.69.3";
const REQUIRED_TRIVY_DATABASE_VERSIONS = Object.freeze({
  "trivy-db": 2,
  "trivy-java-db": 1,
});

function validEvidenceTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requireExactNamedArtifacts(entries, required, description) {
  if (!Array.isArray(entries) || entries.length !== required.size) {
    throw new Error(`Scanner ${description} evidence is not complete.`);
  }
  const names = new Set();
  for (const entry of entries) {
    if (!required.has(entry?.name) || names.has(entry.name)) {
      throw new Error(`Scanner ${description} evidence has an unexpected or duplicate name.`);
    }
    names.add(entry.name);
  }
  return entries;
}

function parseTrivyDatabaseMetadata(text, generatedAt, name, validatedAt = generatedAt) {
  const metadata = requireJsonText(text, `${name} metadata`);
  const updatedAt = metadata.UpdatedAt ?? metadata.updatedAt;
  const nextUpdate = metadata.NextUpdate ?? metadata.nextUpdate;
  const downloadedAt = metadata.DownloadedAt ?? metadata.downloadedAt;
  if (
    !validEvidenceTimestamp(generatedAt)
    || !validEvidenceTimestamp(validatedAt)
    || !validEvidenceTimestamp(updatedAt)
    || !validEvidenceTimestamp(nextUpdate)
    || !validEvidenceTimestamp(downloadedAt)
  ) {
    throw new Error(`${name} metadata is missing its freshness timestamps.`);
  }
  const generated = Date.parse(generatedAt);
  const validated = Date.parse(validatedAt);
  const updated = Date.parse(updatedAt);
  const downloaded = Date.parse(downloadedAt);
  const next = Date.parse(nextUpdate);
  if (
    validated < generated - 300_000
    || updated > generated + 300_000
    || downloaded > generated + 300_000
    || downloaded < updated
    || next <= validated
  ) {
    throw new Error(`${name} database evidence is expired, stale, or from the future.`);
  }
  const version = metadata.Version ?? metadata.version;
  if (version !== REQUIRED_TRIVY_DATABASE_VERSIONS[name]) {
    throw new Error(`${name} metadata has an unsupported database schema version.`);
  }
  return { version, updatedAt, nextUpdate, downloadedAt };
}

function normalizeScannerTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("Scanner binary/version evidence is missing.");
  }
  const toolNames = new Set();
  const normalized = tools.map((tool) => {
    if (
      !["trivy", "syft", "grype"].includes(tool?.name)
      || toolNames.has(tool.name)
      || typeof tool.version !== "string"
      || !tool.version.trim()
    ) {
      throw new Error("Scanner binary/version evidence is invalid or duplicated.");
    }
    toolNames.add(tool.name);
    const version = tool.version.trim();
    if (tool.name === "trivy" && !new RegExp(`^Version:\\s*${REQUIRED_TRIVY_VERSION.replaceAll(".", "\\.")}\\s*$`, "m").test(version)) {
      throw new Error(`Trivy scanner version must be exactly ${REQUIRED_TRIVY_VERSION}.`);
    }
    return { name: tool.name, version };
  });
  if (!toolNames.has("trivy")) {
    throw new Error("Trivy binary/version evidence is required for the release gate.");
  }
  return normalized;
}

export function createScannerEvidence({ generatedAt, tools, controls, databases }) {
  if (!validEvidenceTimestamp(generatedAt)) {
    throw new Error("Scanner evidence requires a valid generation timestamp.");
  }
  const normalizedTools = normalizeScannerTools(tools);

  const normalizeArtifact = (entry, description) => {
    const file = requireEvidenceFile(entry?.file, description);
    if (typeof entry?.text !== "string") throw new Error(`${description} artifact is missing.`);
    return { name: entry.name, file, sha256: evidenceHash(entry.text) };
  };
  const normalizedControls = requireExactNamedArtifacts(
    controls, REQUIRED_SCANNER_CONTROLS, "control",
  ).map((entry) => normalizeArtifact(entry, "scanner control"));
  const normalizedDatabases = requireExactNamedArtifacts(
    databases, REQUIRED_TRIVY_DATABASES, "database",
  ).map((entry) => ({
    ...normalizeArtifact(entry, "scanner database"),
    ...parseTrivyDatabaseMetadata(entry.text, generatedAt, entry.name),
  }));
  return {
    schemaVersion: 1,
    generatedAt,
    tools: normalizedTools,
    controls: normalizedControls,
    databases: normalizedDatabases,
  };
}

export function validateScannerEvidence({ evidence, generatedAt, validatedAt = generatedAt, readArtifact }) {
  if (
    evidence?.schemaVersion !== 1
    || evidence.generatedAt !== generatedAt
    || typeof readArtifact !== "function"
  ) {
    throw new Error("Scanner evidence is missing or has an unsupported schema.");
  }
  const normalizedTools = normalizeScannerTools(evidence.tools);
  if (!isDeepStrictEqual(normalizedTools, evidence.tools)) {
    throw new Error("Scanner binary/version evidence is not canonical.");
  }
  const validateArtifacts = (entries, required, description, database = false) => {
    requireExactNamedArtifacts(entries, required, description);
    for (const entry of entries) {
      const file = requireEvidenceFile(entry.file, `scanner ${description}`);
      const text = readArtifact(file);
      if (typeof text !== "string" || evidenceHash(text) !== entry.sha256) {
        throw new Error(`Scanner ${description} artifact checksum is invalid or tampered: ${entry.name}.`);
      }
      if (database) {
        const metadata = parseTrivyDatabaseMetadata(text, generatedAt, entry.name, validatedAt);
        if (!isDeepStrictEqual(metadata, {
          version: entry.version,
          updatedAt: entry.updatedAt,
          nextUpdate: entry.nextUpdate,
          downloadedAt: entry.downloadedAt,
        })) {
          throw new Error(`Scanner ${entry.name} metadata does not match its recorded freshness evidence.`);
        }
      }
    }
  };
  validateArtifacts(evidence.controls, REQUIRED_SCANNER_CONTROLS, "control");
  validateArtifacts(evidence.databases, REQUIRED_TRIVY_DATABASES, "database", true);
  return evidence;
}

function requireEvidenceFile(file, description) {
  if (typeof file !== "string" || !EVIDENCE_FILE.test(file) || path.basename(file) !== file) {
    throw new Error(`Invalid ${description} evidence file name.`);
  }
  return file;
}

function requireJsonText(text, description) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`${description} evidence is empty.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${description} evidence is not valid JSON.`, { cause: error });
  }
}

export function createRuntimeSecurityEvidence({
  release,
  mode,
  generatedAt,
  expectedLanguages,
  scannerEvidence,
  records,
}) {
  if (typeof release !== "string" || !release || !["local", "registry"].includes(mode)) {
    throw new Error("Runtime security evidence has an invalid release or mode.");
  }
  if (
    typeof generatedAt !== "string"
    || Number.isNaN(Date.parse(generatedAt))
  ) {
    throw new Error("Runtime security evidence requires a valid generation timestamp.");
  }
  if (!Array.isArray(expectedLanguages) || expectedLanguages.length === 0) {
    throw new Error("Runtime security evidence requires an expected language set.");
  }
  if (scannerEvidence?.schemaVersion !== 1 || scannerEvidence.generatedAt !== generatedAt) {
    throw new Error("Runtime security evidence requires current scanner provenance.");
  }
  const expectedSet = new Set(expectedLanguages);
  if (!Array.isArray(records) || expectedSet.size !== expectedLanguages.length || records.length !== expectedSet.size) {
    throw new Error("Runtime security evidence is incomplete or has duplicate languages.");
  }
  const seen = new Set();
  const normalized = records.map((record) => {
    if (!expectedSet.has(record.language) || seen.has(record.language)) {
      throw new Error(`Runtime security evidence has an unexpected or duplicate language: ${record.language}.`);
    }
    seen.add(record.language);
    if (
      !OCI_DIGEST.test(record.manifestDigest ?? "")
      || !OCI_DIGEST.test(record.configDigest ?? "")
      || record.manifestDigest === record.configDigest
      || !OCI_DIGEST.test(record.rootDigest ?? "")
      || !record.imageReference?.endsWith(`@${record.manifestDigest}`)
      || (mode === "local" && record.rootDigest !== record.manifestDigest)
    ) {
      throw new Error(`Runtime security evidence for ${record.language} has an invalid immutable identity.`);
    }
    const spdxFile = requireEvidenceFile(record.spdxFile, "SPDX");
    const bindingFile = requireEvidenceFile(record.bindingFile, "SPDX binding");
    const vulnerabilityFile = requireEvidenceFile(record.vulnerabilityFile, "vulnerability");
    const targetProof = record.targetProof ?? "scanner-target";
    if (
      (mode === "local" && targetProof !== "scanner-target")
      || (mode === "registry" && targetProof !== "in-toto-subject")
    ) {
      throw new Error(`Runtime security evidence for ${record.language} has an invalid SPDX target proof.`);
    }
    let attestation;
    let attestationText;
    if (targetProof === "in-toto-subject") {
      const attestationFile = requireEvidenceFile(record.attestationFile, "attestation");
      attestationText = record.attestationText;
      requireJsonText(attestationText, "in-toto SPDX attestation");
      attestation = { file: attestationFile, sha256: evidenceHash(attestationText) };
    }
    const provenanceFile = requireEvidenceFile(record.provenanceFile, "build provenance");
    const provenanceText = record.provenanceText;
    let provenance;
    let cosign;
    if (mode === "local") {
      const localProvenance = validateLocalProvenanceEvidence({
        evidenceText: provenanceText,
        exactReference: record.imageReference,
        configDigest: record.configDigest,
        rootDigest: record.rootDigest,
      });
      provenance = {
        kind: "local-risk-gated",
        file: provenanceFile,
        sha256: evidenceHash(provenanceText),
        riskAcceptance: localProvenance.riskAcceptance,
        sourceRepository: localProvenance.source.repository,
        sourceRevision: localProvenance.source.revision,
      };
    } else {
      const slsa = validateSlsaProvenanceStatement({
        statementText: provenanceText,
        exactReference: record.imageReference,
        sourceRepository: record.sourceRepository,
        sourceRevision: record.sourceRevision,
        requiredMaterialDigests: record.requiredMaterialDigests,
      });
      provenance = {
        kind: "slsa-buildkit",
        file: provenanceFile,
        sha256: evidenceHash(provenanceText),
        predicateType: slsa.predicateType,
        builderId: slsa.builderId,
        buildType: slsa.buildType,
        sourceRepository: slsa.sourceRepository,
        sourceRevision: slsa.sourceRevision,
        requiredMaterialDigests: [...record.requiredMaterialDigests],
        materialDigests: slsa.materialDigests,
      };
      const signatureFile = requireEvidenceFile(record.cosignSignatureFile, "cosign signature");
      const signedAttestationFile = requireEvidenceFile(record.cosignAttestationFile, "cosign SLSA attestation");
      const cosignResult = validateCosignVerificationEvidence({
        signatureText: record.cosignSignatureText,
        attestationText: record.cosignAttestationText,
        exactReference: record.imageReference,
        certificateIdentity: record.certificateIdentity,
        certificateIssuer: record.certificateIssuer,
        sourceRepository: record.sourceRepository,
        sourceRevision: record.sourceRevision,
        requiredMaterialDigests: record.requiredMaterialDigests,
      });
      cosign = {
        certificateIdentity: cosignResult.certificateIdentity,
        certificateIssuer: cosignResult.certificateIssuer,
        signature: { file: signatureFile, sha256: cosignResult.signatureSha256 },
        attestation: { file: signedAttestationFile, sha256: cosignResult.attestationSha256 },
        predicateType: cosignResult.predicateType,
      };
    }
    const expectedBinding = createSpdxBinding({
      exactReference: record.imageReference,
      documentText: record.spdxText,
      targetProof,
      attestationText,
    });
    const binding = requireJsonText(record.bindingText, "SPDX binding");
    if (!isDeepStrictEqual(binding, expectedBinding)) {
      throw new Error(`SPDX binding evidence for ${record.language} does not match the immutable image.`);
    }
    requireJsonText(record.vulnerabilityText, "Vulnerability scan");
    if (!["trivy", "grype"].includes(record.vulnerabilityScanner)) {
      throw new Error(`Runtime security evidence for ${record.language} has an invalid vulnerability scanner.`);
    }
    const normalizedRecord = {
      language: record.language,
      tag: record.tag,
      imageReference: record.imageReference,
      manifestDigest: record.manifestDigest,
      configDigest: record.configDigest,
      rootDigest: record.rootDigest,
      targetProof,
      spdx: { file: spdxFile, sha256: evidenceHash(record.spdxText) },
      binding: { file: bindingFile, sha256: evidenceHash(record.bindingText) },
      vulnerability: {
        scanner: record.vulnerabilityScanner,
        file: vulnerabilityFile,
        sha256: evidenceHash(record.vulnerabilityText),
      },
      provenance,
    };
    if (attestation) normalizedRecord.attestation = attestation;
    if (cosign) normalizedRecord.cosign = cosign;
    return normalizedRecord;
  });
  return {
    schemaVersion: 2,
    evidenceKind: "codestead-runtime-security",
    complete: true,
    release,
    mode,
    generatedAt,
    expectedLanguages: [...expectedLanguages],
    scanner: scannerEvidence,
    records: normalized,
  };
}

export function validateRuntimeSecurityEvidence({
  manifestText,
  release,
  mode,
  expected,
  readArtifact,
  validatedAt,
}) {
  const manifest = requireJsonText(manifestText, "Runtime security manifest");
  if (
    manifest.schemaVersion !== 2
    || manifest.evidenceKind !== "codestead-runtime-security"
    || manifest.complete !== true
  ) {
    throw new Error("Runtime security evidence is incomplete or has an unsupported schema.");
  }
  if (manifest.release !== release || manifest.mode !== mode) {
    throw new Error("Runtime security evidence release mode does not match the record request.");
  }
  if (
    typeof manifest.generatedAt !== "string"
    || Number.isNaN(Date.parse(manifest.generatedAt))
  ) {
    throw new Error("Runtime security evidence requires a valid generation timestamp.");
  }
  validateScannerEvidence({
    evidence: manifest.scanner,
    generatedAt: manifest.generatedAt,
    validatedAt: validatedAt ?? manifest.generatedAt,
    readArtifact,
  });
  if (!Array.isArray(expected) || expected.length === 0 || manifest.records?.length !== expected.length) {
    throw new Error("Runtime security evidence is incomplete for the expected language set.");
  }
  const expectedByLanguage = new Map(expected.map((entry) => [entry.language, entry]));
  if (
    expectedByLanguage.size !== expected.length
    || expected.some((entry) => (
      typeof entry.language !== "string"
      || typeof entry.tag !== "string"
      || !OCI_DIGEST.test(entry.manifestDigest ?? "")
      || !OCI_DIGEST.test(entry.configDigest ?? "")
      || entry.manifestDigest === entry.configDigest
      || !OCI_DIGEST.test(entry.rootDigest ?? "")
      || typeof entry.imageReference !== "string"
      || !entry.imageReference.endsWith(`@${entry.manifestDigest}`)
      || (mode === "local" && entry.rootDigest !== entry.manifestDigest)
    ))
  ) {
    throw new Error("Runtime record request contains invalid or duplicate immutable identities.");
  }
  if (
    !Array.isArray(manifest.expectedLanguages)
    || manifest.expectedLanguages.length !== expected.length
    || manifest.expectedLanguages.some((language) => !expectedByLanguage.has(language))
  ) {
    throw new Error("Runtime security evidence expected-language set does not match the record request.");
  }
  const seen = new Set();
  for (const record of manifest.records) {
    const current = expectedByLanguage.get(record.language);
    if (!current || seen.has(record.language)) {
      throw new Error("Runtime security evidence has an unexpected or duplicate language record.");
    }
    seen.add(record.language);
    if (
      record.tag !== current.tag
      || record.manifestDigest !== current.manifestDigest
      || record.configDigest !== current.configDigest
    ) {
      throw new Error(`Runtime security evidence for ${record.language} has a stale digest or tag.`);
    }
    if (record.imageReference !== current.imageReference) {
      throw new Error(`Runtime security evidence for ${record.language} has a stale immutable reference.`);
    }
    if (record.rootDigest !== current.rootDigest || !OCI_DIGEST.test(record.rootDigest ?? "")) {
      throw new Error(`Runtime security evidence for ${record.language} has a stale root digest.`);
    }
    if (
      !OCI_DIGEST.test(record.manifestDigest ?? "")
      || !OCI_DIGEST.test(record.configDigest ?? "")
      || record.manifestDigest === record.configDigest
      || !record.imageReference?.endsWith(`@${record.manifestDigest}`)
      || (mode === "local" && record.rootDigest !== record.manifestDigest)
    ) {
      throw new Error(`Runtime security evidence for ${record.language} has an invalid immutable reference.`);
    }
    const targetProof = record.targetProof ?? "scanner-target";
    if (
      (mode === "local" && targetProof !== "scanner-target")
      || (mode === "registry" && targetProof !== "in-toto-subject")
    ) {
      throw new Error(`Runtime security evidence for ${record.language} has an invalid SPDX target proof.`);
    }
    const artifacts = [
      ["SPDX", record.spdx],
      ["SPDX binding", record.binding],
      ["vulnerability", record.vulnerability],
      ["build provenance", record.provenance],
    ];
    if (targetProof === "in-toto-subject") {
      artifacts.push(["attestation", record.attestation]);
      artifacts.push(["cosign signature", record.cosign?.signature]);
      artifacts.push(["cosign SLSA attestation", record.cosign?.attestation]);
    }
    for (const [description, artifact] of artifacts) {
      const file = requireEvidenceFile(artifact?.file, description);
      const text = readArtifact(file);
      if (typeof text !== "string" || evidenceHash(text) !== artifact.sha256) {
        throw new Error(`${description} artifact checksum does not match for ${record.language}.`);
      }
    }
    const spdxText = readArtifact(record.spdx.file);
    const attestationText = targetProof === "in-toto-subject"
      ? readArtifact(record.attestation.file)
      : undefined;
    const expectedBinding = createSpdxBinding({
      exactReference: record.imageReference,
      documentText: spdxText,
      targetProof,
      attestationText,
    });
    const actualBinding = requireJsonText(readArtifact(record.binding.file), "SPDX binding");
    if (!isDeepStrictEqual(actualBinding, expectedBinding)) {
      throw new Error(`SPDX binding evidence does not match ${record.language}.`);
    }
    requireJsonText(readArtifact(record.vulnerability.file), "Vulnerability scan");
    const provenanceText = readArtifact(record.provenance.file);
    if (mode === "local") {
      if (record.provenance.kind !== "local-risk-gated") {
        throw new Error(`Runtime security evidence for ${record.language} has an invalid local provenance kind.`);
      }
      const localProvenance = validateLocalProvenanceEvidence({
        evidenceText: provenanceText,
        exactReference: record.imageReference,
        configDigest: record.configDigest,
        rootDigest: record.rootDigest,
      });
      if (
        record.provenance.riskAcceptance !== localProvenance.riskAcceptance
        || record.provenance.sourceRepository !== localProvenance.source.repository
        || record.provenance.sourceRevision !== localProvenance.source.revision
      ) {
        throw new Error(`Local provenance summary does not match ${record.language}.`);
      }
    } else {
      if (record.provenance.kind !== "slsa-buildkit") {
        throw new Error(`Runtime security evidence for ${record.language} has an invalid registry provenance kind.`);
      }
      const slsa = validateSlsaProvenanceStatement({
        statementText: provenanceText,
        exactReference: record.imageReference,
        sourceRepository: record.provenance.sourceRepository,
        sourceRevision: record.provenance.sourceRevision,
        requiredMaterialDigests: record.provenance.requiredMaterialDigests,
      });
      if (
        record.provenance.predicateType !== slsa.predicateType
        || record.provenance.builderId !== slsa.builderId
        || record.provenance.buildType !== slsa.buildType
        || !isDeepStrictEqual(record.provenance.materialDigests, slsa.materialDigests)
      ) {
        throw new Error(`BuildKit SLSA provenance summary does not match ${record.language}.`);
      }
      const cosignResult = validateCosignVerificationEvidence({
        signatureText: readArtifact(record.cosign.signature.file),
        attestationText: readArtifact(record.cosign.attestation.file),
        exactReference: record.imageReference,
        certificateIdentity: record.cosign.certificateIdentity,
        certificateIssuer: record.cosign.certificateIssuer,
        sourceRepository: record.provenance.sourceRepository,
        sourceRevision: record.provenance.sourceRevision,
        requiredMaterialDigests: record.provenance.requiredMaterialDigests,
      });
      if (record.cosign.predicateType !== cosignResult.predicateType) {
        throw new Error(`Cosign SLSA attestation summary does not match ${record.language}.`);
      }
    }
    if (!["trivy", "grype"].includes(record.vulnerability?.scanner)) {
      throw new Error(`Runtime security evidence for ${record.language} has an invalid vulnerability scanner.`);
    }
  }
  return manifest;
}

const RUNTIME_RECORD_LANGUAGES = Object.freeze(["c", "cpp", "java", "python", "javascript"]);

function runtimeEnvironmentKey(language) {
  return `RUNNER_IMAGE_${language.toUpperCase()}`;
}

function normalizeRuntimeRecordIdentities(identities, local) {
  if (!Array.isArray(identities) || identities.length !== RUNTIME_RECORD_LANGUAGES.length) {
    throw new Error("Runtime image record requires the exact five-language set.");
  }
  const byLanguage = new Map();
  for (const identity of identities) {
    if (
      !RUNTIME_RECORD_LANGUAGES.includes(identity?.language)
      || byLanguage.has(identity.language)
      || typeof identity.imageReference !== "string"
      || !identity.imageReference.endsWith(`@${identity.manifestDigest}`)
      || !OCI_DIGEST.test(identity.manifestDigest ?? "")
      || !OCI_DIGEST.test(identity.configDigest ?? "")
      || identity.configDigest === identity.manifestDigest
      || !OCI_DIGEST.test(identity.rootDigest ?? "")
      || (local && identity.rootDigest !== identity.manifestDigest)
    ) {
      throw new Error("Runtime image record has a duplicate language, invalid immutable reference, or conflated config digest.");
    }
    byLanguage.set(identity.language, {
      language: identity.language,
      reference: identity.imageReference,
      manifestDigest: identity.manifestDigest,
      configDigest: identity.configDigest,
      rootDigest: identity.rootDigest,
    });
  }
  return RUNTIME_RECORD_LANGUAGES.map((language) => {
    const record = byLanguage.get(language);
    if (!record) throw new Error("Runtime image record language set is incomplete.");
    return record;
  });
}

export function createRuntimeImageRecord({ release, local, identities }) {
  if (typeof release !== "string" || !release || typeof local !== "boolean") {
    throw new Error("Runtime image record requires a release and local-mode decision.");
  }
  const records = normalizeRuntimeRecordIdentities(identities, local);
  const payload = { schemaVersion: 1, release, local, records };
  const recordId = evidenceHash(JSON.stringify(payload));
  const document = { schemaVersion: 1, recordId, release, local, records };
  const envLines = [
    "# Generated by runtime/manage-images.mjs record; do not hand-edit.",
    `# runtime-record-id=${recordId}`,
    ...records.map((record) => `${runtimeEnvironmentKey(record.language)}=${record.reference}`),
  ];
  return {
    recordId,
    envText: `${envLines.join("\n")}\n`,
    jsonText: `${JSON.stringify(document, null, 2)}\n`,
    document,
  };
}

export function validateRuntimeImageRecord({ envText, jsonText, expectedLanguages = RUNTIME_RECORD_LANGUAGES }) {
  if (
    !Array.isArray(expectedLanguages)
    || expectedLanguages.length !== RUNTIME_RECORD_LANGUAGES.length
    || expectedLanguages.some((language, index) => language !== RUNTIME_RECORD_LANGUAGES[index])
  ) {
    throw new Error("Runtime image record validation requires the canonical language order.");
  }
  const document = requireJsonText(jsonText, "Runtime image record");
  if (!hasExactKeys(document, ["schemaVersion", "recordId", "release", "local", "records"]) || document.schemaVersion !== 1) {
    throw new Error("Runtime image record has an unsupported or non-canonical schema.");
  }
  if (typeof document.recordId !== "string" || !SHA256_HEX.test(document.recordId)) {
    throw new Error("Runtime image record has an invalid record id.");
  }
  const identities = (document.records ?? []).map((record) => {
    if (!hasExactKeys(record, ["language", "reference", "manifestDigest", "configDigest", "rootDigest"])) {
      throw new Error("Runtime image record contains non-canonical record fields.");
    }
    return { ...record, imageReference: record.reference };
  });
  const canonical = createRuntimeImageRecord({
    release: document.release,
    local: document.local,
    identities,
  });
  if (canonical.recordId !== document.recordId || !isDeepStrictEqual(canonical.document, document)) {
    throw new Error("Runtime image record does not match its canonical record id.");
  }
  if (typeof envText !== "string" || envText !== canonical.envText) {
    throw new Error("Runtime image environment projection does not match its canonical record id.");
  }
  return document;
}

export function publishRuntimeImageRecordTransaction({
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
    || !publication?.envText
    || !publication?.jsonText
    || [writeStaging, flushStaging, renameStaging, removeStaging, flushDirectory]
      .some((operation) => typeof operation !== "function")
  ) {
    throw new Error("Runtime image record publication requires safe paths and durable file operations.");
  }
  const envDestination = path.join(directory, "runtime-images.env");
  const jsonDestination = path.join(directory, "runtime-images.json");
  const envStaging = path.join(directory, `.runtime-images.env.staging-${token}`);
  const jsonStaging = path.join(directory, `.runtime-images.json.staging-${token}`);
  try {
    writeStaging(envStaging, publication.envText);
    flushStaging(envStaging);
    writeStaging(jsonStaging, publication.jsonText);
    flushStaging(jsonStaging);
    renameStaging(envStaging, envDestination);
    flushDirectory(directory);
    // JSON is the canonical commit marker. It is renamed only after the env projection is durable.
    renameStaging(jsonStaging, jsonDestination);
    flushDirectory(directory);
  } catch (error) {
    removeStaging(envStaging);
    removeStaging(jsonStaging);
    throw error;
  }
  return { recordId: publication.recordId, envDestination, jsonDestination };
}

export const REQUIRED_RUNTIME_CONTRACTS = Object.freeze([
  "c: compile and run",
  "c: compile error",
  "cpp: compile and run",
  "cpp: compile error",
  "java: compile and run",
  "java: compile error",
  "python: compile and run",
  "python: compile error",
  "javascript: compile and run",
  "javascript: compile error",
  "python: read-only root and writable ephemeral work",
  "python: network egress blocked",
  "python: hidden environment absent",
  "python: cross-job work cleanup",
  "python: wall timeout",
  "python: combined output cap",
  "python: process limit",
]);

const REQUIRED_EXECUTOR_CHECKS = [
  "real executor: compile/run/stdin",
  "real executor: hidden-data redaction",
  "real executor: output cap and forced cleanup",
  "real executor: cross-job source cleanup",
];

function hasExactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function requireEvidenceTimestamp(report, description) {
  if (typeof report.generatedAt !== "string" || Number.isNaN(Date.parse(report.generatedAt))) {
    throw new Error(`${description} evidence requires a valid generation timestamp.`);
  }
}

export function validateRuntimeReleaseGateEvidence({
  inspectionText,
  contractText,
  executorText,
  expected,
}) {
  const inspection = requireJsonText(inspectionText, "Runtime inspection");
  const contract = requireJsonText(contractText, "Runtime contract");
  const executor = requireJsonText(executorText, "Runtime executor");
  requireEvidenceTimestamp(inspection, "Runtime inspection");
  requireEvidenceTimestamp(contract, "Runtime contract");
  requireEvidenceTimestamp(executor, "Runtime executor");
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error("Runtime release evidence requires an expected language set.");
  }
  const expectedByLanguage = new Map(expected.map((entry) => [entry.language, entry]));
  if (
    expectedByLanguage.size !== expected.length
    || expected.some((entry) => (
      !hasExactKeys(entry, [
        "language", "tag", "imageReference", "manifestDigest", "configDigest", "rootDigest",
      ])
      || typeof entry.language !== "string"
      || typeof entry.tag !== "string"
      || typeof entry.imageReference !== "string"
      || !OCI_DIGEST.test(entry.manifestDigest ?? "")
      || !OCI_DIGEST.test(entry.configDigest ?? "")
      || entry.manifestDigest === entry.configDigest
      || !OCI_DIGEST.test(entry.rootDigest ?? "")
      || !entry.imageReference.endsWith(`@${entry.manifestDigest}`)
    ))
  ) {
    throw new Error("Runtime release evidence has an invalid expected identity set.");
  }

  if (!Array.isArray(inspection.images) || inspection.images.length !== expected.length) {
    throw new Error("Runtime inspection evidence has a failed or incomplete language set.");
  }
  const inspected = new Set();
  for (const image of inspection.images) {
    const identity = expectedByLanguage.get(image.language);
    if (
      !identity
      || inspected.has(image.language)
      || image.tag !== identity.tag
      || image.imageReference !== identity.imageReference
      || image.manifestDigest !== identity.manifestDigest
      || image.configDigest !== identity.configDigest
      || image.rootDigest !== identity.rootDigest
    ) {
      throw new Error("Runtime inspection evidence does not match the immutable identity set.");
    }
    inspected.add(image.language);
  }

  const contractImages = contract.images;
  if (
    !contractImages
    || typeof contractImages !== "object"
    || Array.isArray(contractImages)
    || Object.keys(contractImages).length !== expected.length
    || expected.some((identity) => contractImages[identity.language] !== identity.imageReference)
  ) {
    throw new Error("Runtime contract evidence does not match the immutable identity set.");
  }
  if (!Array.isArray(contract.results) || contract.results.length !== REQUIRED_RUNTIME_CONTRACTS.length) {
    throw new Error("Runtime contract evidence must contain the exact required 17-contract suite.");
  }
  const requiredContracts = new Set(REQUIRED_RUNTIME_CONTRACTS);
  const passedContracts = new Set();
  for (const result of contract.results) {
    if (
      !hasExactKeys(result, ["name", "status"])
      || result.status !== "passed"
      || typeof result.name !== "string"
      || !requiredContracts.has(result.name)
      || passedContracts.has(result.name)
    ) {
      throw new Error("Runtime contract evidence must contain the exact unique required 17-contract suite.");
    }
    passedContracts.add(result.name);
  }

  const executorRefs = executor.refs;
  if (
    !executorRefs
    || typeof executorRefs !== "object"
    || Array.isArray(executorRefs)
    || Object.keys(executorRefs).length !== expected.length
    || expected.some((identity) => executorRefs[identity.language] !== identity.imageReference)
  ) {
    throw new Error("Runtime executor evidence does not match the immutable identity set.");
  }
  if (
    !Array.isArray(executor.passed)
    || REQUIRED_EXECUTOR_CHECKS.some((check) => !executor.passed.includes(check))
  ) {
    throw new Error("Runtime executor evidence is failed or incomplete.");
  }
  return { inspection, contract, executor };
}

function sameRuntimeIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.language === right.language
    && left.tag === right.tag
    && left.imageReference === right.imageReference
    && left.manifestDigest === right.manifestDigest
    && left.configDigest === right.configDigest
    && left.rootDigest === right.rootDigest
  );
}

export function runRuntimeSecurityScan({
  release,
  mode,
  languages,
  destination,
  failedDestination,
  createStaging,
  removeTree,
  renameTree,
  resolveIdentity,
  scanIdentity,
  recheckIdentity,
  createScannerEvidenceForStaging,
  generatedAt,
  writeManifest,
}) {
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error("Runtime security scan requires a language set.");
  }
  return runEvidenceDirectoryTransaction({
    destination,
    failedDestination,
    createStaging,
    removeTree,
    renameTree,
    operation(staging) {
      if (typeof createScannerEvidenceForStaging !== "function") {
        throw new Error("Runtime security scan requires scanner provenance evidence.");
      }
      const scannerEvidence = createScannerEvidenceForStaging(staging, generatedAt);
      const identities = languages.map((language) => resolveIdentity(language));
      const records = identities.map((identity) => scanIdentity({ staging, identity }));
      for (const identity of identities) {
        const current = recheckIdentity(identity);
        if (!sameRuntimeIdentity(identity, current)) {
          throw new Error(`Runtime image ${identity.language} changed during the runtime security gate.`);
        }
      }
      const manifest = createRuntimeSecurityEvidence({
        release,
        mode,
        generatedAt,
        expectedLanguages: [...languages],
        scannerEvidence,
        records,
      });
      writeManifest(staging, "runtime-security-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
      return { identities, manifest };
    },
  });
}

export function createLocalScanPlan({ exactReference, stem, tools, control, environment }) {
  if (!/@sha256:[a-f0-9]{64}$/.test(exactReference)) {
    throw new Error(`Local scan target is not an exact image identity: ${exactReference}`);
  }
  if (!tools.trivy && !tools.syft) {
    throw new Error("Install Trivy or Syft to generate an offline SPDX SBOM for the exact local runtime image.");
  }
  if (!tools.trivy && !tools.grype) {
    throw new Error("Install Trivy or Grype with a locally cached database to enforce the HIGH/CRITICAL vulnerability gate.");
  }
  if (!control?.trivyConfig || !control?.syftConfig || !control?.grypeConfig || !control?.emptyIgnoreFile) {
    throw new Error("A reviewed scanner control bundle is required.");
  }
  if (!environment || typeof environment !== "object") {
    throw new Error("A hermetic scanner environment is required.");
  }
  const spdxOutput = `${stem}.spdx.json`;
  const sbom = tools.trivy
    ? {
        command: "trivy",
        args: [
          "--config", control.trivyConfig,
          ...trivyOfflineArguments(),
          "--ignorefile", control.emptyIgnoreFile,
          "--format", "spdx-json",
          "--output", spdxOutput,
          exactReference,
        ],
        env: environment,
        hermeticEnvironment: true,
      }
    : {
        command: "syft",
        args: ["scan", `docker:${exactReference}`, "--config", control.syftConfig, "--output", `spdx-json=${spdxOutput}`],
        env: environment,
        hermeticEnvironment: true,
      };
  const vulnerability = tools.trivy
    ? {
        command: "trivy",
        args: [
          "--config", control.trivyConfig,
          ...trivyOfflineArguments(),
          "--ignorefile", control.emptyIgnoreFile,
          "--scanners", "vuln",
          "--severity", "HIGH,CRITICAL",
          "--exit-code", "1",
          "--format", "json",
          "--output", `${stem}.trivy.json`,
          exactReference,
        ],
        env: environment,
        hermeticEnvironment: true,
      }
    : {
        command: "grype",
        args: [`docker:${exactReference}`, "--config", control.grypeConfig, "--fail-on", "high", "-o", "json"],
        env: environment,
        hermeticEnvironment: true,
      };
  return { sbom, vulnerability };
}
