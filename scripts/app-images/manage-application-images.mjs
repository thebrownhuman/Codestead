#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createHermeticScannerEnvironment,
  createLocalScanPlan,
  createScannerControlBundle,
  extractAttestedSpdxFromMembers,
  ociImageIdentityFromMembers,
  resolveCommandEnvironment,
} from "../../services/runner/runtime/runtime-operations.mjs";
import {
  APPLICATION_IMAGE_TARGETS,
  createApplicationBuildPlan,
  createApplicationImageRecord,
  createApplicationLocalProvenance,
  createApplicationScannerEvidence,
  createApplicationSecurityEvidence,
  publishApplicationImageRecordTransaction,
  parseApplicationLocalRiskAcceptance,
  runApplicationRegistryPublication,
  runApplicationSecurityScan,
  validateApplicationImageRecord,
  validateApplicationSourceBinding,
  validateApplicationRegistryProvenance,
  validateApplicationSecurityEvidence,
  validateApplicationTrackedBuildInputs,
} from "./application-image-operations.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..", "..");
const outputRoot = path.join(repositoryRoot, "dist", "application-images");
const securityDirectory = path.join(outputRoot, "application-security");
const dockerfile = path.join(repositoryRoot, "Dockerfile");
const localInputFiles = ["Dockerfile", ".dockerignore", "package.json", "package-lock.json"];
const localRiskAcceptanceFile = path.join(
  repositoryRoot, "infra", "security", "application-image-local-risk-acceptance.json");
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

export function utcSecondTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runResult(command, args, options = {}) {
  const capture = options.capture === true;
  const hasInput = options.input !== undefined;
  return spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    stdio: [hasInput || capture ? "pipe" : "inherit", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    env: resolveCommandEnvironment(process.env, options),
  });
}

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    fail(`${command} exited ${result.status}${details}`);
  }
  if (!options.capture) return "";
  return options.includeStderr ? `${result.stdout}${result.stderr}` : result.stdout;
}

function runBytes(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: null,
    stdio: "pipe",
    maxBuffer: 256 * 1024 * 1024,
    env: resolveCommandEnvironment(process.env, options),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} exited ${result.status}\n${result.stderr?.toString("utf8") ?? ""}`);
  }
  return Buffer.from(result.stdout);
}

function commandAvailable(command, args = ["--version"], options = {}) {
  const result = runResult(command, args, { ...options, capture: true });
  return !result.error && result.status === 0;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function normalizeSourceRepository(value) {
  let normalized = value?.trim() ?? "";
  const scp = /^git@([^:]+):(.+)$/.exec(normalized);
  if (scp) normalized = `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(normalized);
  if (ssh) normalized = `https://${ssh[1]}/${ssh[2]}`;
  normalized = normalized.replace(/\.git$/, "").replace(/\/$/, "");
  if (
    !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/.test(normalized)
    || normalized.includes("..")
  ) {
    fail("Application provenance requires a canonical HTTPS source repository.");
  }
  return normalized;
}

function sourceContext() {
  const actualRepository = normalizeSourceRepository(
    run("git", ["config", "--get", "remote.origin.url"], { capture: true }).trim(),
  );
  const actualRevision = run(
    "git",
    ["rev-parse", "HEAD^{commit}"],
    { capture: true },
  ).trim();
  const actualTree = run(
    "git",
    ["rev-parse", "HEAD^{tree}"],
    { capture: true },
  ).trim();
  const trackedInputs = run(
    "git",
    ["ls-tree", "-r", "--name-only", "--full-tree", "HEAD"],
    { capture: true },
  ).trim().split("\n").filter(Boolean);
  validateApplicationTrackedBuildInputs(trackedInputs);
  const buildArchive = runBytes("git", ["archive", "--format=tar", "HEAD"]);
  const declaredRepositories = [];
  if (process.env.APP_IMAGE_SOURCE_REPOSITORY) {
    declaredRepositories.push(normalizeSourceRepository(process.env.APP_IMAGE_SOURCE_REPOSITORY));
  }
  if (process.env.GITHUB_REPOSITORY) {
    declaredRepositories.push(normalizeSourceRepository(
      `https://github.com/${process.env.GITHUB_REPOSITORY}`,
    ));
  }
  const declaredRevisions = [
    process.env.APP_IMAGE_SOURCE_REVISION,
    process.env.GITHUB_SHA,
  ].filter(Boolean).map((value) => value.trim());
  const source = validateApplicationSourceBinding({
    actualRepository,
    actualRevision,
    actualTree,
    contextSha256: createHash("sha256").update(buildArchive).digest("hex"),
    declaredRepositories,
    declaredRevisions,
  });
  const dirty = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { capture: true },
  ).trim().length > 0;
  return {
    sourceRepository: source.repository,
    sourceRevision: source.revision,
    sourceTree: source.tree,
    sourceContextSha256: source.contextSha256,
    buildArchive,
    dirty,
  };
}

function releaseContext() {
  const source = sourceContext();
  const release = (process.env.APP_IMAGE_RELEASE ?? `local-${source.sourceRevision.slice(0, 12)}`).trim();
  const registry = (process.env.APP_IMAGE_REGISTRY ?? "codestead/application").trim();
  const mode = process.env.APP_IMAGE_PUSH === "1" ? "registry" : "local";
  const actualSourceDateEpoch = run(
    "git",
    ["show", "-s", "--format=%ct", source.sourceRevision],
    { capture: true },
  ).trim();
  if (
    process.env.APP_IMAGE_SOURCE_DATE_EPOCH
    && process.env.APP_IMAGE_SOURCE_DATE_EPOCH.trim() !== actualSourceDateEpoch
  ) {
    fail("Declared SOURCE_DATE_EPOCH does not match the independently derived Git commit time.");
  }
  const sourceDateEpoch = actualSourceDateEpoch;
  // createApplicationBuildPlan applies the canonical coordinate and epoch validation.
  createApplicationBuildPlan({
    sourceDateEpoch,
    sourceRepository: source.sourceRepository,
    sourceRevision: source.sourceRevision,
    sourceTree: source.sourceTree,
    sourceContextSha256: source.sourceContextSha256,
    registry,
    release,
    local: mode === "local",
  });
  return { ...source, release, registry, mode, sourceDateEpoch };
}

function imageTag(target, context) {
  return `${context.registry}/${target.repository}:${context.release}`;
}

function repositoryWithoutTag(reference) {
  const withoutDigest = reference.split("@", 1)[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function parseNodeBaseReference() {
  const match = /^ARG NODE_IMAGE=([^\s]+@sha256:[a-f0-9]{64})$/m.exec(readFileSync(dockerfile, "utf8"));
  if (!match) fail("Application Dockerfile has no immutable NODE_IMAGE base material.");
  return match[1];
}

function buildInputs() {
  return localInputFiles.map((file) => ({
    file,
    sha256: sha256File(path.join(repositoryRoot, file)),
  }));
}

function inspectDockerImage(reference) {
  const parsed = JSON.parse(run("docker", [
    "image", "inspect", "--platform", "linux/amd64", reference,
  ], { capture: true }));
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object") {
    fail(`Docker returned invalid inspection evidence for ${reference}.`);
  }
  return parsed[0];
}

function verifySourceLabels(labels, context, target) {
  if (
    labels?.["org.opencontainers.image.source"] !== context.sourceRepository
    || labels?.["org.opencontainers.image.revision"] !== context.sourceRevision
    || labels?.["io.codestead.application.source-tree"] !== context.sourceTree
    || labels?.["io.codestead.application.build-context-sha256"] !== context.sourceContextSha256
    || labels?.["io.codestead.application.platform"] !== "linux/amd64"
  ) {
    fail(`Application image ${target} has stale or missing source/tree/context/platform labels.`);
  }
}

function resolveLocalIdentity(target, context) {
  const tag = imageTag(target, context);
  const tagged = inspectDockerImage(tag);
  const manifestDigest = tagged?.Descriptor?.digest;
  const configDigest = tagged?.Id;
  if (!OCI_DIGEST.test(manifestDigest ?? "") || !OCI_DIGEST.test(configDigest ?? "")) {
    fail(`Application image ${target.target} has no exact manifest/config identity.`);
  }
  if (manifestDigest === configDigest) {
    fail(`Application image ${target.target} conflates manifest and config identities.`);
  }
  verifySourceLabels(tagged.Config?.Labels, context, target.target);
  const reference = `${repositoryWithoutTag(tag)}@${manifestDigest}`;
  const exact = inspectDockerImage(reference);
  if (exact?.Descriptor?.digest !== manifestDigest || exact?.Id !== configDigest) {
    fail(`Exact application reference changed for ${target.target}.`);
  }
  return {
    target: target.target,
    variable: target.variable,
    reference,
    manifestDigest,
    configDigest,
    rootDigest: manifestDigest,
    sourceRepository: context.sourceRepository,
    sourceRevision: context.sourceRevision,
  };
}

function resolveRegistryIdentity(target, context) {
  const tag = imageTag(target, context);
  const description = run("docker", ["buildx", "imagetools", "inspect", tag], { capture: true });
  const rootDigest = /^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(description)?.[1];
  if (!rootDigest) fail(`Could not resolve registry root identity for ${target.target}.`);
  const raw = JSON.parse(run(
    "docker",
    ["buildx", "imagetools", "inspect", tag, "--raw"],
    { capture: true },
  ));
  let manifestDigest = rootDigest;
  let manifest = raw;
  if (Array.isArray(raw.manifests)) {
    const children = raw.manifests.filter((entry) => (
      entry?.platform?.os === "linux"
      && entry.platform.architecture === "amd64"
      && entry.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest"
    ));
    if (children.length !== 1 || !OCI_DIGEST.test(children[0]?.digest ?? "")) {
      fail(`Application image ${target.target} must have one linux/amd64 child manifest.`);
    }
    manifestDigest = children[0].digest;
    manifest = JSON.parse(run(
      "docker",
      ["buildx", "imagetools", "inspect", `${tag}@${manifestDigest}`, "--raw"],
      { capture: true },
    ));
  }
  const configDigest = manifest?.config?.digest;
  if (!OCI_DIGEST.test(manifestDigest) || !OCI_DIGEST.test(configDigest ?? "")) {
    fail(`Application registry identity is incomplete for ${target.target}.`);
  }
  const reference = `${repositoryWithoutTag(tag)}@${manifestDigest}`;
  if (!commandAvailable("oras", ["version"])) {
    fail("ORAS is required to verify application registry config labels.");
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "codestead-app-config-"));
  try {
    const configFile = path.join(temporary, "config.json");
    run("oras", ["blob", "fetch", "--output", configFile, `${repositoryWithoutTag(tag)}@${configDigest}`]);
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    verifySourceLabels(config?.config?.Labels, context, target.target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return {
    target: target.target,
    variable: target.variable,
    reference,
    manifestDigest,
    configDigest,
    rootDigest,
    sourceRepository: context.sourceRepository,
    sourceRevision: context.sourceRevision,
  };
}

function resolveApplicationIdentity(targetName, context) {
  const target = APPLICATION_IMAGE_TARGETS.find((entry) => entry.target === targetName);
  if (!target) fail(`Unknown application image target: ${targetName}.`);
  return context.mode === "registry"
    ? resolveRegistryIdentity(target, context)
    : resolveLocalIdentity(target, context);
}

function readArchiveIdentity(archive) {
  const metadata = statSync(archive);
  if (!metadata.isFile() || metadata.size < 1) fail(`OCI archive is empty: ${archive}.`);
  return ociImageIdentityFromMembers((member) => run(
    "tar",
    ["-xOf", archive, member],
    { capture: true },
  ));
}

function builderVersions() {
  return {
    docker: run("docker", ["--version"], { capture: true }).trim(),
    buildx: run("docker", ["buildx", "version"], { capture: true }).trim(),
  };
}

function build() {
  const context = releaseContext();
  if (context.dirty) fail("Application image builds require a clean Git worktree.");
  builderVersions();
  const temporary = context.mode === "local"
    ? mkdtempSync(path.join(os.tmpdir(), "codestead-application-build-"))
    : undefined;
  try {
    const plan = createApplicationBuildPlan({
      sourceDateEpoch: context.sourceDateEpoch,
      sourceRepository: context.sourceRepository,
      sourceRevision: context.sourceRevision,
      sourceTree: context.sourceTree,
      sourceContextSha256: context.sourceContextSha256,
      registry: context.registry,
      release: context.release,
      local: context.mode === "local",
      outputDirectory: temporary ?? "dist/application-images/registry",
    });
    for (const item of plan) {
      run("docker", item.args, { input: context.buildArchive });
      if (context.mode === "local") {
        const outputArgument = item.args[item.args.indexOf("--output") + 1];
        const archive = /^type=oci,dest=(.+),rewrite-timestamp=true$/.exec(outputArgument)?.[1];
        if (!archive) fail(`Application build output is invalid for ${item.target}.`);
        const archiveIdentity = readArchiveIdentity(archive);
        run("docker", ["load", "--input", archive]);
        const target = APPLICATION_IMAGE_TARGETS.find((entry) => entry.target === item.target);
        const loaded = resolveLocalIdentity(target, context);
        if (
          loaded.manifestDigest !== archiveIdentity.manifestDigest
          || loaded.configDigest !== archiveIdentity.configDigest
        ) {
          fail(`Loaded application identity differs from deterministic OCI archive for ${item.target}.`);
        }
      }
    }
    for (const target of APPLICATION_IMAGE_TARGETS) {
      resolveApplicationIdentity(target.target, context);
    }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

function inspectionReport(context, identities) {
  return {
    schemaVersion: 1,
    evidenceKind: "codestead-application-image-inspection",
    generatedAt: utcSecondTimestamp(),
    release: context.release,
    mode: context.mode,
    platform: "linux/amd64",
    source: {
      repository: context.sourceRepository,
      revision: context.sourceRevision,
      tree: context.sourceTree,
      contextSha256: context.sourceContextSha256,
      dirty: false,
    },
    builder: builderVersions(),
    inputs: buildInputs(),
    records: identities,
  };
}

function inspect() {
  const context = releaseContext();
  if (context.dirty) fail("Application inspection evidence requires a clean Git worktree.");
  const identities = APPLICATION_IMAGE_TARGETS.map((target) => (
    resolveApplicationIdentity(target.target, context)
  ));
  const report = inspectionReport(context, identities);
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(
    path.join(outputRoot, "application-inspection.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(report.records, null, 2)}\n`);
}

function createScannerRuntime() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codestead-application-scan-control-"));
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
    trivyCacheDirectory: process.env.APP_IMAGE_TRIVY_CACHE_DIR,
  });
  mkdirSync(environment.TRIVY_CACHE_DIR, { recursive: true, mode: 0o700 });
  return { directory, control, environment };
}

function readEvidence(file, description = path.basename(file)) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Missing application ${description} evidence: ${file}`, { cause: error });
  }
}

function runScannerStep(step, outputFile) {
  const result = runResult(step.command, step.args, {
    capture: true,
    env: step.env,
    hermeticEnvironment: step.hermeticEnvironment,
  });
  if (step.command === "grype" && typeof result.stdout === "string") {
    writeFileSync(outputFile, result.stdout, { mode: 0o600 });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${step.command} exited ${result.status}\n${result.stderr || result.stdout || ""}`);
  }
}

function ociMember(digest) {
  if (!OCI_DIGEST.test(digest)) fail(`Invalid OCI digest: ${digest}.`);
  return `blobs/sha256/${digest.slice(7)}`;
}

function extractRegistryAttestation(identity, context, requiredMaterialDigests) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "codestead-application-attestation-"));
  try {
    const rootFile = path.join(temporary, "root-index.json");
    const tagTarget = imageTag(
      APPLICATION_IMAGE_TARGETS.find((entry) => entry.target === identity.target),
      context,
    );
    run("oras", ["manifest", "fetch", "--output", rootFile, tagTarget]);
    const rootRaw = readFileSync(rootFile);
    const root = JSON.parse(rootRaw.toString("utf8"));
    const attestations = (root.manifests ?? []).filter((descriptor) => (
      descriptor?.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
      && descriptor.annotations["vnd.docker.reference.digest"] === identity.manifestDigest
    ));
    if (attestations.length !== 1) {
      fail(`Application target ${identity.target} must have one linked BuildKit attestation.`);
    }
    const repository = repositoryWithoutTag(tagTarget);
    const descriptor = attestations[0];
    const attestationFile = path.join(temporary, "attestation.json");
    run("oras", [
      "manifest", "fetch", "--output", attestationFile,
      `${repository}@${descriptor.digest}`,
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
      fail(`Application target ${identity.target} requires one SPDX and one SLSA layer.`);
    }
    const spdxFile = path.join(temporary, "spdx.json");
    const provenanceFile = path.join(temporary, "provenance.json");
    run("oras", ["blob", "fetch", "--output", spdxFile, `${repository}@${spdxLayers[0].digest}`]);
    run("oras", [
      "blob", "fetch", "--output", provenanceFile,
      `${repository}@${provenanceLayers[0].digest}`,
    ]);
    const spdxRaw = readFileSync(spdxFile);
    const provenanceRaw = readFileSync(provenanceFile);
    const archiveIndex = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      manifests: [{ mediaType: root.mediaType, digest: identity.rootDigest, size: rootRaw.length }],
    }));
    const members = new Map([
      ["index.json", archiveIndex],
      [ociMember(identity.rootDigest), rootRaw],
      [ociMember(descriptor.digest), attestationRaw],
      [ociMember(spdxLayers[0].digest), spdxRaw],
      [ociMember(provenanceLayers[0].digest), provenanceRaw],
    ]);
    return extractAttestedSpdxFromMembers({
      readMember: (member) => members.get(member),
      expectedRootDigest: identity.rootDigest,
      expectedChildDigest: identity.manifestDigest,
      expectedSourceRepository: context.sourceRepository,
      expectedSourceRevision: context.sourceRevision,
      requiredMaterialDigests,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function scannerEvidenceInputs(scannerRuntime, generatedAt, scannerOptions) {
  const tools = ["trivy", "syft", "grype"]
    .filter((tool) => commandAvailable(tool, ["--version"], scannerOptions))
    .map((name) => ({
      name,
      version: run(name, ["--version"], { ...scannerOptions, capture: true }).trim(),
    }));
  if (!tools.some((entry) => entry.name === "trivy")) {
    fail("Trivy 0.69.3 is required for application image release evidence.");
  }
  const controls = [
    ["trivy-config", "application-scanner-trivy.json", scannerRuntime.control.trivyConfig],
    ["syft-config", "application-scanner-syft.json", scannerRuntime.control.syftConfig],
    ["grype-config", "application-scanner-grype.json", scannerRuntime.control.grypeConfig],
    ["trivy-ignore", "application-scanner-ignore.json", scannerRuntime.control.emptyIgnoreFile],
  ].map(([name, file, source]) => ({ name, file, text: readEvidence(source, `${name} control`) }));
  const databases = [
    [
      "trivy-db",
      "application-trivy-db.json",
      path.join(scannerRuntime.environment.TRIVY_CACHE_DIR, "db", "metadata.json"),
    ],
    [
      "trivy-java-db",
      "application-trivy-java-db.json",
      path.join(scannerRuntime.environment.TRIVY_CACHE_DIR, "java-db", "metadata.json"),
    ],
  ].map(([name, file, source]) => ({ name, file, text: readEvidence(source, `${name} metadata`) }));
  const evidence = createApplicationScannerEvidence({ generatedAt, tools, controls, databases });
  return { tools, controls, databases, evidence };
}

function removeStaleSecurityEvidence() {
  rmSync(securityDirectory, { recursive: true, force: true });
  if (!existsSync(outputRoot)) return;
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.application-security\.(?:failed|staging)-/.test(entry.name)) {
      rmSync(path.join(outputRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function scan() {
  const context = releaseContext();
  if (context.dirty) fail("Application security evidence requires a clean Git worktree.");
  mkdirSync(outputRoot, { recursive: true });
  removeStaleSecurityEvidence();
  const failedDirectory = path.join(
    outputRoot,
    `.application-security.failed-${process.pid}-${randomUUID()}`,
  );
  let scannerRuntime;
  try {
    scannerRuntime = createScannerRuntime();
    const scannerOptions = {
      cwd: scannerRuntime.control.controlDirectory,
      env: scannerRuntime.environment,
      hermeticEnvironment: true,
    };
    const generatedAt = utcSecondTimestamp();
    const riskAcceptance = context.mode === "local"
      ? parseApplicationLocalRiskAcceptance({
        acceptanceText: readEvidence(localRiskAcceptanceFile, "local-risk acceptance"),
        validatedAt: generatedAt,
      })
      : undefined;
    const scanner = scannerEvidenceInputs(scannerRuntime, generatedAt, scannerOptions);
    const availableTools = Object.fromEntries(scanner.tools.map((entry) => [entry.name, true]));
    const builder = builderVersions();
    const inputs = buildInputs();
    const baseReference = parseNodeBaseReference();
    const baseDigest = /@(sha256:[a-f0-9]{64})$/.exec(baseReference)?.[1];
    if (!baseDigest) fail("Application base material digest is invalid.");
    const certificateIdentity = process.env.APP_IMAGE_COSIGN_CERTIFICATE_IDENTITY?.trim();
    const certificateIssuer = process.env.APP_IMAGE_COSIGN_CERTIFICATE_OIDC_ISSUER?.trim();
    if (context.mode === "registry") {
      if (!commandAvailable("oras", ["version"]) || !commandAvailable("cosign", ["version"])) {
        fail("Registry application evidence requires ORAS and Cosign.");
      }
      if (!certificateIdentity || !certificateIssuer) {
        fail("Registry application evidence requires exact Cosign certificate identity and issuer.");
      }
    }
    const result = runApplicationSecurityScan({
      targets: APPLICATION_IMAGE_TARGETS,
      destination: securityDirectory,
      failedDestination: failedDirectory,
      createStaging: () => mkdtempSync(path.join(outputRoot, ".application-security.staging-")),
      removeTree: (target) => rmSync(target, { recursive: true, force: true }),
      renameTree: (from, to) => renameSync(from, to),
      resolveIdentity: (target) => resolveApplicationIdentity(target, context),
      scanIdentity: ({ staging, identity }) => {
        const stem = path.join(staging, identity.target);
        const plan = createLocalScanPlan({
          exactReference: identity.reference,
          stem,
          tools: availableTools,
          control: scannerRuntime.control,
          environment: scannerRuntime.environment,
        });
        const spdxFile = `${identity.target}.spdx.json`;
        const vulnerabilityFile = `${identity.target}.trivy.json`;
        const provenanceFile = context.mode === "local"
          ? `${identity.target}.local-provenance.json`
          : `${identity.target}.slsa-provenance.json`;
        let spdxText;
        let provenanceText;
        let registryEvidence;
        if (context.mode === "local") {
          runScannerStep(plan.sbom, path.join(staging, spdxFile));
          provenanceText = `${JSON.stringify(createApplicationLocalProvenance({
            generatedAt,
            riskAcceptance,
            identity,
            baseReference,
            sourceRepository: context.sourceRepository,
            sourceRevision: context.sourceRevision,
            sourceTree: context.sourceTree,
            sourceContextSha256: context.sourceContextSha256,
            dirty: context.dirty,
            builder,
            inputs,
          }), null, 2)}\n`;
        } else {
          registryEvidence = extractRegistryAttestation(identity, context, [baseDigest]);
          spdxText = registryEvidence.documentText;
          provenanceText = registryEvidence.provenanceText;
          writeFileSync(path.join(staging, spdxFile), spdxText, { mode: 0o600 });
        }
        writeFileSync(path.join(staging, provenanceFile), provenanceText, { mode: 0o600 });
        runScannerStep(plan.vulnerability, path.join(staging, vulnerabilityFile));
        spdxText ??= readEvidence(path.join(staging, spdxFile), spdxFile);
        const vulnerabilityText = readEvidence(
          path.join(staging, vulnerabilityFile),
          vulnerabilityFile,
        );
        const record = {
          identity,
          spdxFile,
          spdxText,
          vulnerabilityFile,
          vulnerabilityText,
          provenanceFile,
          provenanceText,
        };
        if (context.mode === "registry") {
          const policy = [
            "--certificate-identity", certificateIdentity,
            "--certificate-oidc-issuer", certificateIssuer,
          ];
          record.requiredMaterialDigests = [baseDigest];
          record.certificateIdentity = certificateIdentity;
          record.certificateIssuer = certificateIssuer;
          record.cosignSignatureFile = `${identity.target}.cosign-signature.json`;
          record.cosignSignatureText = run("cosign", [
            "verify", ...policy, "--output", "json", identity.reference,
          ], { capture: true });
          writeFileSync(
            path.join(staging, record.cosignSignatureFile),
            record.cosignSignatureText,
            { mode: 0o600 },
          );
          record.cosignAttestationFile = `${identity.target}.cosign-slsa-attestation.json`;
          record.cosignAttestationText = run("cosign", [
            "verify-attestation", ...policy, "--type", "slsaprovenance02",
            "--output", "json", identity.reference,
          ], { capture: true });
          writeFileSync(
            path.join(staging, record.cosignAttestationFile),
            record.cosignAttestationText,
            { mode: 0o600 },
          );
        }
        return record;
      },
      // Re-resolve after every target has been scanned so tag movement cannot publish stale success.
      recheckIdentity: (identity) => resolveApplicationIdentity(identity.target, context),
      finalize: ({ staging, identities, records }) => {
        for (const artifact of [...scanner.controls, ...scanner.databases]) {
          writeFileSync(path.join(staging, artifact.file), artifact.text, { mode: 0o600 });
        }
        const manifest = createApplicationSecurityEvidence({
          release: context.release,
          mode: context.mode,
          generatedAt,
          sourceRepository: context.sourceRepository,
          sourceRevision: context.sourceRevision,
          sourceTree: context.sourceTree,
          sourceContextSha256: context.sourceContextSha256,
          scannerEvidence: scanner.evidence,
          records,
        });
        writeFileSync(
          path.join(staging, "application-security-manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 },
        );
        return { identities, manifest };
      },
    });
    return result;
  } catch (error) {
    if (!existsSync(failedDirectory)) {
      mkdirSync(failedDirectory, { recursive: true, mode: 0o700 });
    }
    writeFileSync(path.join(failedDirectory, "failure.json"), `${JSON.stringify({
      generatedAt: utcSecondTimestamp(),
      message: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, { mode: 0o600 });
    throw error;
  } finally {
    if (scannerRuntime) rmSync(scannerRuntime.directory, { recursive: true, force: true });
  }
}

function readInspection(context) {
  let report;
  try {
    report = JSON.parse(readEvidence(
      path.join(outputRoot, "application-inspection.json"),
      "application inspection",
    ));
  } catch (error) {
    throw new Error("Application inspection evidence is malformed or missing.", { cause: error });
  }
  if (
    report?.schemaVersion !== 1
    || report.evidenceKind !== "codestead-application-image-inspection"
    || report.release !== context.release
    || report.mode !== context.mode
    || report.platform !== "linux/amd64"
    || report.source?.repository !== context.sourceRepository
    || report.source?.revision !== context.sourceRevision
    || report.source?.tree !== context.sourceTree
    || report.source?.contextSha256 !== context.sourceContextSha256
    || report.source?.dirty !== false
    || !Array.isArray(report.records)
    || report.records.length !== APPLICATION_IMAGE_TARGETS.length
  ) {
    fail("Application inspection evidence is stale, incomplete, or for another source.");
  }
  return report;
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

function sign() {
  const context = releaseContext();
  if (context.mode !== "registry") {
    fail("Application registry signing requires APP_IMAGE_PUSH=1.");
  }
  if (context.dirty) fail("Application registry signing requires a clean Git worktree.");
  if (!commandAvailable("oras", ["version"]) || !commandAvailable("cosign", ["version"])) {
    fail("Application registry signing requires ORAS and Cosign.");
  }
  const certificateIdentity = process.env.APP_IMAGE_COSIGN_CERTIFICATE_IDENTITY?.trim();
  const certificateIssuer = process.env.APP_IMAGE_COSIGN_CERTIFICATE_OIDC_ISSUER?.trim();
  if (!certificateIdentity || !certificateIssuer) {
    fail("Application registry signing requires exact Cosign certificate identity and issuer.");
  }
  const inspection = readInspection(context);
  const identities = APPLICATION_IMAGE_TARGETS.map((target) => (
    resolveApplicationIdentity(target.target, context)
  ));
  for (const identity of identities) {
    const inspected = inspection.records.find((entry) => entry.target === identity.target);
    if (!sameIdentity(identity, inspected)) {
      fail(`Application inspection identity is stale for ${identity.target}.`);
    }
  }
  const baseReference = parseNodeBaseReference();
  const baseDigest = /@(sha256:[a-f0-9]{64})$/.exec(baseReference)?.[1];
  if (!baseDigest) fail("Application base material digest is invalid.");
  const policy = [
    "--certificate-identity", certificateIdentity,
    "--certificate-oidc-issuer", certificateIssuer,
  ];
  const temporary = mkdtempSync(path.join(os.tmpdir(), "codestead-application-signing-"));
  const signingOutput = path.join(outputRoot, "application-signing.json");
  mkdirSync(outputRoot, { recursive: true });
  rmSync(signingOutput, { force: true });
  try {
    const result = runApplicationRegistryPublication({
      targets: APPLICATION_IMAGE_TARGETS,
      resolveIdentity: (target) => {
        const identity = identities.find((entry) => entry.target === target);
        if (!identity) fail(`Application signing identity is missing for ${target}.`);
        return identity;
      },
      preparePredicate: (identity) => {
        const extracted = extractRegistryAttestation(identity, context, [baseDigest]);
        let statement;
        try {
          statement = JSON.parse(extracted.provenanceText);
        } catch {
          fail(`Application BuildKit provenance is malformed for ${identity.target}.`);
        }
        if (
          statement?.predicateType !== "https://slsa.dev/provenance/v0.2"
          || !statement.predicate
          || typeof statement.predicate !== "object"
          || Array.isArray(statement.predicate)
        ) {
          fail(`Application BuildKit provenance cannot produce a SLSA v0.2 predicate for ${identity.target}.`);
        }
        return {
          predicateText: `${JSON.stringify(statement.predicate, null, 2)}\n`,
          buildkitStatementText: extracted.provenanceText,
        };
      },
      signIdentity: ({ identity }) => {
        run("cosign", ["sign", "--yes", identity.reference]);
      },
      attestIdentity: ({ identity, predicateText }) => {
        const predicateFile = path.join(temporary, `${identity.target}.slsa-predicate.json`);
        writeFileSync(predicateFile, predicateText, { encoding: "utf8", flag: "wx", mode: 0o600 });
        run("cosign", [
          "attest", "--yes", "--type", "slsaprovenance02", "--predicate",
          predicateFile, identity.reference,
        ]);
      },
      verifyIdentity: ({ identity, buildkitStatementText }) => {
        const signatureText = run("cosign", [
          "verify", ...policy, "--output", "json", identity.reference,
        ], { capture: true });
        const signedAttestationText = run("cosign", [
          "verify-attestation", ...policy, "--type", "slsaprovenance02",
          "--output", "json", identity.reference,
        ], { capture: true });
        const verified = validateApplicationRegistryProvenance({
          identity,
          buildkitStatementText,
          signatureText,
          signedAttestationText,
          certificateIdentity,
          certificateIssuer,
          requiredMaterialDigests: [baseDigest],
        });
        return {
          target: identity.target,
          buildkitProvenanceSha256: createHash("sha256").update(buildkitStatementText).digest("hex"),
          signatureSha256: verified.cosign.signatureSha256,
          attestationSha256: verified.cosign.attestationSha256,
          predicateType: verified.cosign.predicateType,
        };
      },
      recheckIdentity: (identity) => resolveApplicationIdentity(identity.target, context),
      finalize: ({ records }) => ({
        schemaVersion: 1,
        evidenceKind: "codestead-application-image-signing",
        complete: true,
        generatedAt: utcSecondTimestamp(),
        release: context.release,
        source: {
          repository: context.sourceRepository,
          revision: context.sourceRevision,
          tree: context.sourceTree,
          contextSha256: context.sourceContextSha256,
        },
        policy: { certificateIdentity, certificateIssuer },
        records: records.map(({ identity, verification }) => ({ identity, ...verification })),
      }),
    });
    writeFileSync(signingOutput, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(result.records, null, 2)}\n`);
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function flushFile(file) {
  const descriptor = openSync(file, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function flushDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupRecordStaging() {
  if (!existsSync(outputRoot)) return;
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (/^\.application-images\.(?:env|json)\.staging-[A-Za-z0-9._-]+$/.test(entry.name)) {
      rmSync(path.join(outputRoot, entry.name), { force: true });
    }
  }
}

function record() {
  const context = releaseContext();
  if (context.dirty) fail("Application image record requires a clean Git worktree.");
  const inspection = readInspection(context);
  const identities = APPLICATION_IMAGE_TARGETS.map((target) => (
    resolveApplicationIdentity(target.target, context)
  ));
  for (const identity of identities) {
    const inspected = inspection.records.find((entry) => entry.target === identity.target);
    if (!sameIdentity(identity, inspected)) {
      fail(`Application inspection identity is stale for ${identity.target}.`);
    }
  }
  validateApplicationSecurityEvidence({
    manifestText: readEvidence(
      path.join(securityDirectory, "application-security-manifest.json"),
      "application security manifest",
    ),
    release: context.release,
    mode: context.mode,
    expectedSourceRepository: context.sourceRepository,
    expectedSourceRevision: context.sourceRevision,
    expectedSourceTree: context.sourceTree,
    expectedSourceContextSha256: context.sourceContextSha256,
    expected: identities,
    validatedAt: utcSecondTimestamp(),
    readArtifact: (file) => readEvidence(path.join(securityDirectory, file), file),
  });
  // Re-resolve again after all evidence validation and before publishing the commit marker.
  for (const identity of identities) {
    const current = resolveApplicationIdentity(identity.target, context);
    if (!sameIdentity(identity, current)) {
      fail(`Application image ${identity.target} changed before record publication.`);
    }
  }
  mkdirSync(outputRoot, { recursive: true });
  cleanupRecordStaging();
  const publication = createApplicationImageRecord({
    generatedAt: utcSecondTimestamp(),
    release: context.release,
    local: context.mode === "local",
    sourceRepository: context.sourceRepository,
    sourceRevision: context.sourceRevision,
    sourceTree: context.sourceTree,
    sourceContextSha256: context.sourceContextSha256,
    identities,
  });
  validateApplicationImageRecord({
    jsonText: publication.jsonText,
    envText: publication.envText,
    expectedSourceRepository: context.sourceRepository,
    expectedSourceRevision: context.sourceRevision,
    expectedSourceTree: context.sourceTree,
    expectedSourceContextSha256: context.sourceContextSha256,
    validatedAt: utcSecondTimestamp(),
  });
  publishApplicationImageRecordTransaction({
    directory: outputRoot,
    publication,
    token: `${process.pid}-${randomUUID()}`,
    writeStaging: (file, contents) => writeFileSync(file, contents, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    }),
    flushStaging: flushFile,
    renameStaging: (from, to) => renameSync(from, to),
    removeStaging: (file) => rmSync(file, { force: true }),
    flushDirectory,
  });
  process.stdout.write(publication.envText);
}

export function main(command = process.argv[2]) {
  if (command === "build" || command === "application:build") build();
  else if (command === "inspect" || command === "application:inspect") inspect();
  else if (command === "sign" || command === "application:sign") sign();
  else if (command === "scan" || command === "application:scan") scan();
  else if (command === "record" || command === "application:record") record();
  else fail("Usage: node scripts/app-images/manage-application-images.mjs <build|inspect|sign|scan|record>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
