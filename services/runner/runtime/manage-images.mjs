import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildxArguments,
  createHermeticScannerEnvironment,
  createLocalBuildIdentityRecord,
  createLocalScanPlan,
  createLocalProvenanceEvidence,
  createRuntimeImageRecord,
  createScannerControlBundle,
  createScannerEvidence,
  createSpdxBinding,
  extractAttestedSpdxFromMembers,
  localImageReference,
  ociImageIdentityFromMembers,
  publishRuntimeImageRecordTransaction,
  requireSourceDateEpoch,
  resolveLocalImageIdentity,
  resolveCommandEnvironment,
  runDeterministicLocalBuild,
  runRuntimeSecurityScan,
  validateLocalBuildIdentityRecord,
  validateRuntimeReleaseGateEvidence,
  validateRuntimeSecurityEvidence,
  validateRuntimeCoordinates,
  validateRuntimeImageRecord,
} from "./runtime-operations.mjs";

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.dirname(runtimeRoot);
const { release, repository } = validateRuntimeCoordinates({
  release: process.env.RUNTIME_RELEASE ?? "local",
  repository: process.env.RUNTIME_REPOSITORY ?? "learncoding/runtime",
});

function readEnvironment(file) {
  const result = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid environment line: ${rawLine}`);
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

const pinned = readEnvironment(path.join(runtimeRoot, "images.env"));
const languages = [
  { id: "c", env: "C", expectedVersion: "14.2.0", tool: ["/usr/local/bin/gcc", "--version"] },
  { id: "cpp", env: "CPP", expectedVersion: "14.2.0", tool: ["/usr/local/bin/g++", "--version"] },
  { id: "java", env: "JAVA", expectedVersion: "21.0.11", tool: ["/opt/java/openjdk/bin/java", "-version"] },
  { id: "python", env: "PYTHON", expectedVersion: "3.14.6", tool: ["/usr/local/bin/python3", "--version"] },
  { id: "javascript", env: "JAVASCRIPT", expectedVersion: "22.23.1", tool: ["/usr/local/bin/node", "--version"] },
];
const localBuildIdentityPath = path.join(runnerRoot, "dist", "runtime-local-build-identities.json");
let localBuildIdentities;
function normalizeSourceRepository(value) {
  let repositoryValue = value?.trim() ?? "";
  const scp = /^git@([^:]+):(.+)$/.exec(repositoryValue);
  if (scp) repositoryValue = `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(repositoryValue);
  if (ssh) repositoryValue = `https://${ssh[1]}/${ssh[2]}`;
  repositoryValue = repositoryValue.replace(/\.git$/, "").replace(/\/$/, "");
  if (
    !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/.test(repositoryValue)
    || repositoryValue.includes("..")
  ) {
    throw new Error("Runtime provenance requires a canonical HTTPS source repository.");
  }
  return repositoryValue;
}

function sourceContext() {
  const sourceRepository = normalizeSourceRepository(
    process.env.RUNTIME_SOURCE_REPOSITORY
      ?? (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : undefined)
      ?? run("git", ["config", "--get", "remote.origin.url"], { capture: true }).trim(),
  );
  const sourceRevision = (
    process.env.RUNTIME_SOURCE_REVISION
      ?? process.env.GITHUB_SHA
      ?? run("git", ["rev-parse", "HEAD"], { capture: true }).trim()
  ).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision)) {
    throw new Error("Runtime provenance requires an exact Git source revision.");
  }
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=normal"], { capture: true }).trim().length > 0;
  return { sourceRepository, sourceRevision, dirty };
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function baseMaterialDigests(language) {
  const references = [pinned.HARNESS_BUILD_IMAGE, pinned[`RUNTIME_BASE_${language.env}`]];
  const digests = new Set(references.map((reference) => /@(sha256:[a-f0-9]{64})$/.exec(reference ?? "")?.[1]));
  if (digests.has(undefined)) throw new Error(`Runtime ${language.id} has an invalid pinned base material.`);
  return [...digests].sort();
}

function pinnedPackages(name, { required = false } = {}) {
  const raw = pinned[name]?.trim() ?? "";
  if (required && !raw) throw new Error(`Missing pinned package set: ${name}.`);
  for (const specification of raw ? raw.split(/\s+/) : []) {
    if (!/^[a-z0-9][a-z0-9+_.-]*=[a-z0-9][a-z0-9+_.:~-]*$/i.test(specification)) {
      throw new Error(`Package must use an exact Alpine version in ${name}: ${specification}`);
    }
  }
  return raw;
}

function imageTag(language) {
  return `${repository}-${language.id}:${release}`;
}

function runResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? runnerRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 32 * 1024 * 1024,
    env: resolveCommandEnvironment(process.env, options),
  });
}

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited ${result.status}${details}`);
  }
  if (!options.capture) return "";
  return options.includeStderr ? `${result.stdout}${result.stderr}` : result.stdout;
}

function commandAvailable(command, args = ["--version"], options = {}) {
  const result = runResult(command, args, { ...options, capture: true });
  return !result.error && result.status === 0;
}

function createScannerRuntimeControl() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "learncoding-runtime-scan-control-"));
  const control = createScannerControlBundle(directory);
  mkdirSync(control.homeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(control.xdgConfigDirectory, { recursive: true, mode: 0o700 });
  for (const [file, contents] of control.files) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
  }
  const environment = createHermeticScannerEnvironment({
    hostEnvironment: process.env,
    homeDirectory: control.homeDirectory,
    trivyCacheDirectory: process.env.RUNTIME_TRIVY_CACHE_DIR,
  });
  mkdirSync(environment.TRIVY_CACHE_DIR, { recursive: true, mode: 0o700 });
  return { directory, control, environment };
}

function inspectImage(reference) {
  const images = JSON.parse(run("docker", [
    "image", "inspect", "--platform", "linux/amd64", reference,
  ], { capture: true }));
  if (!Array.isArray(images) || images.length !== 1 || !images[0] || typeof images[0] !== "object") {
    throw new Error(`Docker returned an invalid image inspection for ${reference}.`);
  }
  return images[0];
}

function expectedLocalBuildIdentityRecords() {
  return languages.map((language) => ({ language: language.id, tag: imageTag(language) }));
}

function loadLocalBuildIdentities() {
  if (!localBuildIdentities) {
    localBuildIdentities = validateLocalBuildIdentityRecord(
      readFileSync(localBuildIdentityPath, "utf8"),
      expectedLocalBuildIdentityRecords(),
    );
  }
  return localBuildIdentities;
}

function publishLocalBuildIdentities(identities) {
  const directory = path.dirname(localBuildIdentityPath);
  const staging = `${localBuildIdentityPath}.staging-${process.pid}-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(staging, createLocalBuildIdentityRecord(identities), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    flushFile(staging);
    renameSync(staging, localBuildIdentityPath);
    flushDirectory(directory);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  localBuildIdentities = validateLocalBuildIdentityRecord(
    readFileSync(localBuildIdentityPath, "utf8"),
    expectedLocalBuildIdentityRecords(),
  );
}

function resolveLocalIdentity(language) {
  const tag = imageTag(language);
  const expectedIdentity = loadLocalBuildIdentities()[language.id];
  return resolveLocalImageIdentity({
    language: language.id,
    tag,
    repository: `${repository}-${language.id}`,
    inspectImage,
    expectedIdentity: {
      manifestDigest: expectedIdentity.manifestDigest,
      configDigest: expectedIdentity.configDigest,
    },
  });
}

function resolveRegistryIdentity(language) {
  const tag = imageTag(language);
  const description = run("docker", ["buildx", "imagetools", "inspect", tag], { capture: true });
  const rootMatch = /^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(description);
  if (!rootMatch) throw new Error(`Could not resolve immutable registry root digest for ${tag}.`);
  const rootDigest = rootMatch[1];
  const raw = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", tag, "--raw"], { capture: true }));
  let childManifest = raw;
  let manifestDigest = rootDigest;
  if (Array.isArray(raw.manifests)) {
    const candidates = raw.manifests.filter((entry) => (
      entry?.platform?.os === "linux"
      && entry.platform.architecture === "amd64"
      && entry.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest"
    ));
    if (candidates.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(candidates[0]?.digest ?? "")) {
      throw new Error(`${tag} must have exactly one linux/amd64 runtime child manifest.`);
    }
    manifestDigest = candidates[0].digest;
    childManifest = JSON.parse(run("docker", [
      "buildx", "imagetools", "inspect", `${tag}@${manifestDigest}`, "--raw",
    ], { capture: true }));
  }
  const configDigest = childManifest?.config?.digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(manifestDigest) || !/^sha256:[a-f0-9]{64}$/.test(configDigest ?? "")) {
    throw new Error(`Could not resolve immutable registry manifest/config digests for ${tag}.`);
  }
  return {
    language: language.id,
    tag,
    imageReference: `${repositoryWithoutTag(tag)}@${manifestDigest}`,
    manifestDigest,
    configDigest,
    rootDigest,
  };
}

function resolveRuntimeIdentity(language, mode) {
  return mode === "registry" ? resolveRegistryIdentity(language) : resolveLocalIdentity(language);
}

function repositoryWithoutTag(reference) {
  const withoutDigest = reference.split("@", 1)[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function readArchiveIdentity(archive) {
  let metadata;
  try {
    metadata = statSync(archive);
  } catch (error) {
    throw new Error(`Deterministic OCI archive is missing: ${archive}`, { cause: error });
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Deterministic OCI archive is invalid or empty: ${archive}`);
  }
  return ociImageIdentityFromMembers((member) =>
    run("tar", ["-xOf", archive, member], { capture: true }),
  );
}

function build() {
  const publish = process.env.RUNTIME_PUSH === "1";
  if (publish && release === "local") throw new Error("RUNTIME_RELEASE must be immutable when pushing images.");
  const harnessPackages = pinnedPackages("HARNESS_BUILD_PACKAGES", { required: true });
  const sourceDateEpoch = publish ? undefined : requireSourceDateEpoch(pinned);
  const source = sourceContext();
  if (publish && source.dirty) throw new Error("Registry runtime publication requires a clean Git worktree.");
  const runtimes = languages.map((language) => {
    const runtimeImage = pinned[`RUNTIME_BASE_${language.env}`];
    if (!runtimeImage?.includes("@sha256:")) throw new Error(`Missing pinned base for ${language.id}.`);
    const runtimePackages = pinnedPackages(`RUNTIME_PACKAGES_${language.env}`);
    return {
      ...language,
      tag: imageTag(language),
      buildArguments: [
        `HARNESS_BUILD_IMAGE=${pinned.HARNESS_BUILD_IMAGE}`,
        `HARNESS_BUILD_PACKAGES=${harnessPackages}`,
        `RUNTIME_IMAGE=${runtimeImage}`,
        `BASE_IMAGE_REFERENCE=${runtimeImage}`,
        `RUNTIME_PACKAGES=${runtimePackages}`,
        `EXPECTED_LANGUAGE=${language.id}`,
        `EXPECTED_TOOL_VERSION=${language.expectedVersion}`,
        `SOURCE_REPOSITORY=${source.sourceRepository}`,
        `SOURCE_REVISION=${source.sourceRevision}`,
      ],
    };
  });
  const buildArgumentsFor = (runtime, archive) => buildxArguments({
    publish,
    archive,
    sourceDateEpoch,
    buildArguments: runtime.buildArguments,
    tag: runtime.tag,
    dockerfile: path.join(runtimeRoot, "Dockerfile"),
    context: runtimeRoot,
  });
  if (publish) {
    for (const runtime of runtimes) run("docker", buildArgumentsFor(runtime));
    return;
  }
  mkdirSync(path.dirname(localBuildIdentityPath), { recursive: true });
  rmSync(localBuildIdentityPath, { force: true });
  localBuildIdentities = undefined;
  const identities = runDeterministicLocalBuild({
    runtimes,
    temporaryPrefix: path.join(os.tmpdir(), "learncoding-runtime-build-"),
    createTemporaryDirectory: (prefix) => mkdtempSync(prefix),
    removeTemporaryDirectory: (directory) => rmSync(directory, { recursive: true, force: true }),
    buildArchive: (runtime, archive) => run("docker", buildArgumentsFor(runtime, archive)),
    readArchiveIdentity,
    loadArchive: (archive) => run("docker", ["load", "--input", archive]),
    inspectImage,
    exactReference: (runtime, digest) => localImageReference(`${repository}-${runtime.id}`, digest),
  });
  publishLocalBuildIdentities(identities);
}

function inspectOne(language) {
  const tag = imageTag(language);
  const identity = resolveLocalIdentity(language);
  const raw = inspectImage(tag);
  if (raw.Config?.User !== "65532:65532") throw new Error(`${tag} does not default to UID/GID 65532.`);
  if ((raw.Config?.Entrypoint ?? []).length !== 0) throw new Error(`${tag} has a base-image entrypoint.`);
  if (raw.Config?.Labels?.["io.learncoding.runner.language"] !== language.id) {
    throw new Error(`${tag} has the wrong language label.`);
  }
  const labels = raw.Config?.Labels ?? {};
  if (
    Object.hasOwn(labels, "org.opencontainers.image.source")
    || Object.hasOwn(labels, "org.opencontainers.image.revision")
  ) {
    throw new Error(`${tag} must keep source repository and commit identity in external provenance only.`);
  }
  if (raw.Config?.Labels?.["io.learncoding.runner.packages"] !== pinnedPackages(`RUNTIME_PACKAGES_${language.env}`)) {
    throw new Error(`${tag} has the wrong pinned package label.`);
  }
  const description = JSON.parse(run("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", tag, "/opt/runner/execute", "--describe",
  ], { capture: true }));
  if (description.protocolVersion !== 1 || description.language !== language.id || description.shell !== false) {
    throw new Error(`${tag} returned an invalid harness description.`);
  }
  const version = run("docker", ["run", "--rm", "--network", "none", "--read-only", tag, ...language.tool], { capture: true, includeStderr: true }).trim();
  return {
    language: language.id,
    tag,
    imageReference: identity.imageReference,
    manifestDigest: identity.manifestDigest,
    configDigest: identity.configDigest,
    rootDigest: identity.rootDigest,
    base: raw.Config.Labels["io.learncoding.runner.base"],
    harness: description,
    version: version.split(/\r?\n/)[0],
  };
}

function inspect() {
  const source = sourceContext();
  if (source.dirty) throw new Error("Runtime inspection evidence requires a clean Git worktree.");
  const report = languages.map((language) => inspectOne(language));
  const output = path.join(runnerRoot, "dist", "runtime-inspection.json");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), images: report }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function readRequiredEvidence(file, description) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Missing ${description} evidence: ${file}`, { cause: error });
  }
}

function cleanupRuntimeRecordStaging(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (/^\.runtime-images\.(?:env|json)\.staging-[A-Za-z0-9._-]+$/.test(entry.name)) {
      rmSync(path.join(directory, entry.name), { force: true, recursive: false });
    }
  }
}

function flushFile(file) {
  const descriptor = openSync(file, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function flushDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function record() {
  const local = process.env.RUNTIME_RECORD_LOCAL === "1" || release === "local";
  const mode = local ? "local" : "registry";
  const identities = languages.map((language) => resolveRuntimeIdentity(language, mode));
  const directory = path.join(runnerRoot, "dist");
  const securityDirectory = path.join(directory, "runtime-security");
  validateRuntimeSecurityEvidence({
    manifestText: readRequiredEvidence(
      path.join(securityDirectory, "runtime-security-manifest.json"),
      "runtime security manifest",
    ),
    release,
    mode,
    validatedAt: new Date().toISOString(),
    expected: identities.map((identity) => ({
      language: identity.language,
      tag: identity.tag,
      imageReference: identity.imageReference,
      manifestDigest: identity.manifestDigest,
      configDigest: identity.configDigest,
      rootDigest: identity.rootDigest,
    })),
    readArtifact: (file) => readRequiredEvidence(path.join(securityDirectory, file), file),
  });
  validateRuntimeReleaseGateEvidence({
    inspectionText: readRequiredEvidence(path.join(directory, "runtime-inspection.json"), "runtime inspection"),
    contractText: readRequiredEvidence(path.join(directory, "runtime-contract-report.json"), "runtime contract"),
    executorText: readRequiredEvidence(path.join(directory, "runtime-executor-report.json"), "runtime executor"),
    expected: identities.map((identity) => ({
      language: identity.language,
      tag: identity.tag,
      imageReference: identity.imageReference,
      manifestDigest: identity.manifestDigest,
      configDigest: identity.configDigest,
      rootDigest: identity.rootDigest,
    })),
  });

  for (const identity of identities) {
    run("docker", [
      "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
      identity.imageReference, "/opt/runner/execute", "--describe",
    ], { capture: true });
  }
  mkdirSync(directory, { recursive: true });
  cleanupRuntimeRecordStaging(directory);
  const publication = createRuntimeImageRecord({ release, local, identities });
  validateRuntimeImageRecord({
    envText: publication.envText,
    jsonText: publication.jsonText,
    expectedLanguages: languages.map((language) => language.id),
  });
  publishRuntimeImageRecordTransaction({
    directory,
    publication,
    token: `${process.pid}-${randomUUID()}`,
    writeStaging: (file, contents) => writeFileSync(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    flushStaging: flushFile,
    renameStaging: (from, to) => renameSync(from, to),
    removeStaging: (file) => rmSync(file, { force: true }),
    flushDirectory,
  });
  process.stdout.write(publication.envText);
}
function ociMember(digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid OCI digest: ${digest}.`);
  return `blobs/sha256/${digest.slice("sha256:".length)}`;
}

function extractRegistryAttestedSpdx(identity, source, requiredMaterialDigests) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "learncoding-registry-sbom-"));
  try {
    const rootFile = path.join(temporary, "root-index.json");
    run("oras", ["manifest", "fetch", "--output", rootFile, identity.tag]);
    const rootRaw = readFileSync(rootFile);
    const root = JSON.parse(rootRaw.toString("utf8"));
    const linkedAttestations = (root.manifests ?? []).filter((descriptor) => (
      descriptor?.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
      && descriptor.annotations["vnd.docker.reference.digest"] === identity.manifestDigest
    ));
    if (linkedAttestations.length !== 1) {
      throw new Error(`${identity.tag} must have exactly one attestation linked to its linux/amd64 child.`);
    }
    const repositoryName = repositoryWithoutTag(identity.tag);
    const attestationDescriptor = linkedAttestations[0];
    const attestationFile = path.join(temporary, "attestation-manifest.json");
    run("oras", [
      "manifest", "fetch", "--output", attestationFile,
      `${repositoryName}@${attestationDescriptor.digest}`,
    ]);
    const attestationRaw = readFileSync(attestationFile);
    const attestation = JSON.parse(attestationRaw.toString("utf8"));
    const spdxLayers = (attestation.layers ?? []).filter((layer) => (
      layer?.annotations?.["in-toto.io/predicate-type"] === "https://spdx.dev/Document"
    ));
    const provenanceLayers = (attestation.layers ?? []).filter((layer) => (
      ["https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"]
        .includes(layer?.annotations?.["in-toto.io/predicate-type"])
    ));
    if (spdxLayers.length !== 1 || provenanceLayers.length !== 1) {
      throw new Error(`${identity.tag} attestation must contain exactly one SPDX and one BuildKit SLSA statement.`);
    }
    const statementFile = path.join(temporary, "spdx-statement.json");
    const provenanceFile = path.join(temporary, "slsa-provenance.json");
    run("oras", [
      "blob", "fetch", "--output", statementFile,
      `${repositoryName}@${spdxLayers[0].digest}`,
    ]);
    run("oras", [
      "blob", "fetch", "--output", provenanceFile,
      `${repositoryName}@${provenanceLayers[0].digest}`,
    ]);
    const statementRaw = readFileSync(statementFile);
    const provenanceRaw = readFileSync(provenanceFile);
    const archiveIndex = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      manifests: [{
        mediaType: root.mediaType,
        digest: identity.rootDigest,
        size: rootRaw.length,
      }],
    }));
    const members = new Map([
      ["index.json", archiveIndex],
      [ociMember(identity.rootDigest), rootRaw],
      [ociMember(attestationDescriptor.digest), attestationRaw],
      [ociMember(spdxLayers[0].digest), statementRaw],
      [ociMember(provenanceLayers[0].digest), provenanceRaw],
    ]);
    return extractAttestedSpdxFromMembers({
      readMember: (member) => members.get(member),
      expectedRootDigest: identity.rootDigest,
      expectedChildDigest: identity.manifestDigest,
      expectedSourceRepository: source.sourceRepository,
      expectedSourceRevision: source.sourceRevision,
      requiredMaterialDigests,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runScannerStep(step, evidenceFile) {
  const result = runResult(step.command, step.args, {
    capture: true,
    env: step.env,
    hermeticEnvironment: step.hermeticEnvironment,
  });
  if (step.command === "grype" && typeof result.stdout === "string") {
    writeFileSync(evidenceFile, result.stdout);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${step.command} exited ${result.status}\n${result.stderr || result.stdout || ""}`);
  }
}

function scan() {
  const directory = path.join(runnerRoot, "dist", "runtime-security");
  const failedDirectory = `${directory}.failed`;
  const parent = path.dirname(directory);
  const mode = process.env.RUNTIME_PUSH === "1" ? "registry" : "local";
  let scannerRuntime;
  rmSync(directory, { recursive: true, force: true });
  rmSync(failedDirectory, { recursive: true, force: true });
  mkdirSync(parent, { recursive: true });
  try {
    scannerRuntime = createScannerRuntimeControl();
    const scannerOptions = {
      cwd: scannerRuntime.control.controlDirectory,
      env: scannerRuntime.environment,
      hermeticEnvironment: true,
    };
    const tools = {
      trivy: commandAvailable("trivy", ["--version"], scannerOptions),
      syft: commandAvailable("syft", ["--version"], scannerOptions),
      grype: commandAvailable("grype", ["--version"], scannerOptions),
    };
    if (!tools.trivy) {
      throw new Error("Trivy is required to capture release scanner and database provenance.");
    }
    const generatedAt = new Date().toISOString();
    const source = sourceContext();
    if (source.dirty) throw new Error("Runtime security evidence requires a clean Git worktree.");
    const builder = {
      docker: run("docker", ["--version"], { capture: true }).trim(),
      buildx: run("docker", ["buildx", "version"], { capture: true }).trim(),
    };
    const buildInputs = ["Dockerfile", "harness.c", "images.env"].map((file) => ({
      name: file,
      file,
      sha256: sha256File(path.join(runtimeRoot, file)),
    }));
    const scannerTools = Object.entries(tools)
      .filter(([, available]) => available)
      .map(([name]) => ({
        name,
        version: run(name, ["--version"], { ...scannerOptions, capture: true }).trim(),
      }));
    const scannerControls = [
      ["trivy-config", "scanner-control-trivy.json", scannerRuntime.control.trivyConfig],
      ["syft-config", "scanner-control-syft.json", scannerRuntime.control.syftConfig],
      ["grype-config", "scanner-control-grype.json", scannerRuntime.control.grypeConfig],
      ["trivy-ignore", "scanner-control-ignore.json", scannerRuntime.control.emptyIgnoreFile],
    ].map(([name, file, source]) => ({
      name,
      file,
      text: readRequiredEvidence(source, `${name} control`),
    }));
    const scannerDatabases = [
      ["trivy-db", "scanner-trivy-db.json", path.join(scannerRuntime.environment.TRIVY_CACHE_DIR, "db", "metadata.json")],
      ["trivy-java-db", "scanner-trivy-java-db.json", path.join(scannerRuntime.environment.TRIVY_CACHE_DIR, "java-db", "metadata.json")],
    ].map(([name, file, source]) => ({
      name,
      file,
      text: readRequiredEvidence(source, `${name} metadata`),
    }));
    const result = runRuntimeSecurityScan({
      release,
      mode,
      languages: languages.map((language) => language.id),
      destination: directory,
      failedDestination: failedDirectory,
      createStaging: () => mkdtempSync(path.join(parent, ".runtime-security.staging-")),
      removeTree: (target) => rmSync(target, { recursive: true, force: true }),
      renameTree: (from, to) => renameSync(from, to),
      resolveIdentity: (languageId) => {
        const language = languages.find((candidate) => candidate.id === languageId);
        if (!language) throw new Error(`Unknown runtime language: ${languageId}.`);
        return resolveRuntimeIdentity(language, mode);
      },
      scanIdentity: ({ staging, identity }) => {
        const stem = path.join(staging, identity.language);
        const spdxFile = `${identity.language}.spdx.json`;
        const bindingFile = `${identity.language}.spdx.target.json`;
        const plan = createLocalScanPlan({
          exactReference: identity.imageReference,
          stem,
          tools,
          control: scannerRuntime.control,
          environment: scannerRuntime.environment,
        });
        let targetProof = "scanner-target";
        let attestationFile;
        let attestationText;
        let provenanceFile;
        let provenanceText;
        let sourceRepository;
        let sourceRevision;
        let requiredMaterialDigests;
        let cosignSignatureFile;
        let cosignSignatureText;
        let cosignAttestationFile;
        let cosignAttestationText;
        let certificateIdentity;
        let certificateIssuer;
        if (mode === "registry") {
          if (!commandAvailable("oras", ["version"])) {
            throw new Error("ORAS is required to verify pushed registry attestation bytes.");
          }
          if (!commandAvailable("cosign", ["version"])) {
            throw new Error("Cosign is required to verify registry signatures and signed SLSA attestations.");
          }
          certificateIdentity = process.env.RUNTIME_COSIGN_CERTIFICATE_IDENTITY?.trim();
          certificateIssuer = process.env.RUNTIME_COSIGN_CERTIFICATE_OIDC_ISSUER?.trim();
          if (!certificateIdentity || !certificateIssuer) {
            throw new Error("Registry verification requires exact Cosign certificate identity and OIDC issuer policy.");
          }
          requiredMaterialDigests = baseMaterialDigests(
            languages.find((candidate) => candidate.id === identity.language),
          );
          const extracted = extractRegistryAttestedSpdx(identity, source, requiredMaterialDigests);
          writeFileSync(path.join(staging, spdxFile), extracted.documentText);
          targetProof = "in-toto-subject";
          attestationFile = `${identity.language}.spdx.attestation.json`;
          attestationText = extracted.statementText;
          writeFileSync(path.join(staging, attestationFile), attestationText);
          provenanceFile = `${identity.language}.slsa-provenance.json`;
          provenanceText = extracted.provenanceText;
          writeFileSync(path.join(staging, provenanceFile), provenanceText);
          const cosignPolicyArguments = [
            "--certificate-identity", certificateIdentity,
            "--certificate-oidc-issuer", certificateIssuer,
          ];
          cosignSignatureFile = `${identity.language}.cosign-signature.json`;
          cosignSignatureText = run("cosign", [
            "verify", ...cosignPolicyArguments, "--output", "json", identity.imageReference,
          ], { capture: true });
          writeFileSync(path.join(staging, cosignSignatureFile), cosignSignatureText);
          cosignAttestationFile = `${identity.language}.cosign-slsa-attestation.json`;
          cosignAttestationText = run("cosign", [
            "verify-attestation", ...cosignPolicyArguments,
            "--type", "slsaprovenance02", "--output", "json", identity.imageReference,
          ], { capture: true });
          writeFileSync(path.join(staging, cosignAttestationFile), cosignAttestationText);
          sourceRepository = source.sourceRepository;
          sourceRevision = source.sourceRevision;
        } else {
          runScannerStep(plan.sbom, path.join(staging, spdxFile));
          provenanceFile = `${identity.language}.local-provenance.json`;
          provenanceText = `${JSON.stringify(createLocalProvenanceEvidence({
            generatedAt,
            acceptance: process.env.RUNTIME_LOCAL_RISK_ACCEPTANCE,
            exactReference: identity.imageReference,
            configDigest: identity.configDigest,
            rootDigest: identity.rootDigest,
            baseReference: pinned[`RUNTIME_BASE_${languages.find((candidate) => candidate.id === identity.language).env}`],
            sourceRepository: source.sourceRepository,
            sourceRevision: source.sourceRevision,
            dirty: source.dirty,
            builder,
            inputs: buildInputs,
          }), null, 2)}\n`;
          writeFileSync(path.join(staging, provenanceFile), provenanceText);
        }
        const spdxText = readRequiredEvidence(path.join(staging, spdxFile), spdxFile);
        const binding = createSpdxBinding({
          exactReference: identity.imageReference,
          documentText: spdxText,
          targetProof,
          attestationText,
        });
        const bindingText = `${JSON.stringify(binding, null, 2)}\n`;
        writeFileSync(path.join(staging, bindingFile), bindingText);
        const vulnerabilityFile = plan.vulnerability.command === "grype"
          ? `${identity.language}.grype.json`
          : `${identity.language}.trivy.json`;
        runScannerStep(plan.vulnerability, path.join(staging, vulnerabilityFile));
        const vulnerabilityText = readRequiredEvidence(
          path.join(staging, vulnerabilityFile),
          vulnerabilityFile,
        );
        return {
          ...identity,
          targetProof,
          spdxFile,
          spdxText,
          bindingFile,
          bindingText,
          attestationFile,
          attestationText,
          provenanceFile,
          provenanceText,
          sourceRepository,
          sourceRevision,
          requiredMaterialDigests,
          cosignSignatureFile,
          cosignSignatureText,
          cosignAttestationFile,
          cosignAttestationText,
          certificateIdentity,
          certificateIssuer,
          vulnerabilityScanner: plan.vulnerability.command,
          vulnerabilityFile,
          vulnerabilityText,
        };
      },
      recheckIdentity: (identity) => {
        const language = languages.find((candidate) => candidate.id === identity.language);
        return resolveRuntimeIdentity(language, mode);
      },
      createScannerEvidenceForStaging: (staging) => {
        for (const artifact of [...scannerControls, ...scannerDatabases]) {
          writeFileSync(path.join(staging, artifact.file), artifact.text);
        }
        return createScannerEvidence({
          generatedAt,
          tools: scannerTools,
          controls: scannerControls,
          databases: scannerDatabases,
        });
      },
      generatedAt,
      writeManifest: (staging, file, text) => writeFileSync(path.join(staging, file), text),
    });
    return result;
  } catch (error) {
    mkdirSync(failedDirectory, { recursive: true });
    writeFileSync(path.join(failedDirectory, "failure.json"), `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    throw error;
  } finally {
    if (scannerRuntime) rmSync(scannerRuntime.directory, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === "build") build();
else if (command === "inspect") inspect();
else if (command === "record") record();
else if (command === "scan") scan();
else throw new Error("Usage: node runtime/manage-images.mjs <build|inspect|record|scan>");
