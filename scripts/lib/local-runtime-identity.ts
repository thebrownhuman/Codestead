import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOCAL_REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const CLASSIC_ARCHIVE_CONFIG = /^([a-f0-9]{64})\.json$/;
const OCI_ARCHIVE_CONFIG = /^blobs\/sha256\/([a-f0-9]{64})$/;
const SUPPORTED_LOCAL_RUNTIME_LANGUAGES = Object.freeze([
  "c", "cpp", "java", "javascript", "python",
] as const);

export type LocalRuntimeLanguage = typeof SUPPORTED_LOCAL_RUNTIME_LANGUAGES[number];

export const LOCAL_RUNTIME_IDENTITY_LIMITATION =
  "Archive-derived config identities plus independent Docker tag/reference descriptor resolution prove the exact exam runtime used by this local verification; production publication, scanning, signing, and source-revision provenance remain separate release gates.";

interface LocalBuildIdentityRecord {
  readonly id: LocalRuntimeLanguage;
  readonly tag: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly reference: string;
}

export interface LocalRuntimeExpectation {
  readonly language: LocalRuntimeLanguage;
  readonly tag: string;
  readonly declaredContentDigest?: string;
}

export type InspectLocalRuntimeImage = (reference: string) => unknown;
export type ResolveLocalRuntimeConfigDigest = (reference: string) => string;

export interface LocalRuntimeIdentityEvidence {
  readonly language: LocalRuntimeLanguage;
  readonly tag: string;
  readonly declaredContentDigest: string | null;
  readonly recordedLocalDigest: string;
  readonly recordedConfigDigest: string;
  readonly recordedLocalReference: string;
  readonly immutableReference: string;
  readonly actualTaggedImageId: string;
  readonly tagDescriptorDigest: string;
  readonly tagImageId: string;
  readonly exactReferenceDescriptorDigest: string;
  readonly exactReferenceImageId: string;
  readonly recordMatchesTaggedImage: true;
  readonly independentlyValidated: true;
}

export interface RuntimeIdentityReportEvidence {
  readonly tag: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly immutableReference: string;
  readonly tagDescriptorDigest: string;
  readonly tagImageId: string;
  readonly exactReferenceDescriptorDigest: string;
  readonly exactReferenceImageId: string;
  readonly independentlyValidated: true;
}

interface DockerInspection {
  readonly id: string;
  readonly descriptorDigest: string;
  readonly repoTags: readonly string[];
  readonly repoDigests: readonly string[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !OCI_DIGEST.test(value)) {
    throw new Error(`${label} must be an OCI sha256 digest.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value as string[];
}

function localRepository(tag: string, language: string): string {
  if (!tag.endsWith(":local")) throw new Error(`Expected tag for ${language} must end in :local.`);
  const repository = tag.slice(0, -":local".length);
  if (!LOCAL_REPOSITORY.test(repository)) throw new Error(`Expected tag for ${language} has an unsafe local repository.`);
  return repository;
}

function runtimeRecord(value: unknown, index: number): LocalBuildIdentityRecord {
  const candidate = object(value, `Local build identity ${index}`);
  if (Object.keys(candidate).sort().join(",") !== "configDigest,id,manifestDigest,reference,tag") {
    throw new Error(`Local build identity ${index} must contain exactly configDigest, id, manifestDigest, reference, and tag.`);
  }
  if (typeof candidate.id !== "string" || !SUPPORTED_LOCAL_RUNTIME_LANGUAGES.includes(candidate.id as LocalRuntimeLanguage)) {
    throw new Error(`Local build identity ${index} has an unsupported language id.`);
  }
  if (typeof candidate.tag !== "string" || typeof candidate.reference !== "string") {
    throw new Error(`Local build identity ${index} has invalid tag/reference fields.`);
  }
  const manifestDigest = digest(candidate.manifestDigest, `Manifest digest for ${candidate.id}`);
  const configDigest = digest(candidate.configDigest, `Config digest for ${candidate.id}`);
  if (manifestDigest === configDigest) throw new Error(`Manifest and config digests for ${candidate.id} must be distinct.`);
  return {
    id: candidate.id as LocalRuntimeLanguage,
    tag: candidate.tag,
    manifestDigest,
    configDigest,
    reference: candidate.reference,
  };
}

function dockerInspection(value: unknown, label: string): DockerInspection {
  const candidate = object(value, label);
  const descriptor = object(candidate.Descriptor, `${label} Descriptor`);
  return {
    id: digest(candidate.Id, `${label} Id`),
    descriptorDigest: digest(descriptor.digest, `${label} Descriptor.digest`),
    repoTags: stringArray(candidate.RepoTags, `${label} RepoTags`),
    repoDigests: stringArray(candidate.RepoDigests, `${label} RepoDigests`),
  };
}

function assertDockerBinding(
  inspection: DockerInspection,
  record: LocalBuildIdentityRecord,
  kind: "tag" | "exact reference",
): void {
  if (inspection.descriptorDigest !== record.manifestDigest) {
    throw new Error(`${kind === "tag" ? "Tag" : "Exact reference"} descriptor for ${record.id} does not match the recorded manifest digest.`);
  }
  if (kind === "tag" && !inspection.repoTags.includes(record.tag)) {
    throw new Error(`Tag inspection for ${record.id} is not bound to ${record.tag}.`);
  }
  if (kind === "exact reference" && !inspection.repoDigests.includes(record.reference)) {
    throw new Error(`Exact reference inspection for ${record.id} is not bound to ${record.reference}.`);
  }
}

function assertDockerStoreIdentity(
  inspection: DockerInspection,
  record: LocalBuildIdentityRecord,
  archiveConfigDigest: string,
  kind: "tag" | "exact reference",
): void {
  if (inspection.id === record.manifestDigest) return;
  if (inspection.id === archiveConfigDigest) return;
  throw new Error(`${kind === "tag" ? "Tag" : "Exact reference"} image ID for ${record.id} matches neither the independently validated manifest nor config digest derived from the archive.`);
}

function archiveConfigHash(configPath: string): string | null {
  return CLASSIC_ARCHIVE_CONFIG.exec(configPath)?.[1]
    ?? OCI_ARCHIVE_CONFIG.exec(configPath)?.[1]
    ?? null;
}

export function parseDockerArchiveConfigPath(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Docker archive manifest must contain exactly one image entry.");
  }
  const entry = object(value[0], "Docker archive image entry");
  if (typeof entry.Config !== "string" || archiveConfigHash(entry.Config) === null) {
    throw new Error("Docker archive Config must be a safe sha256 config filename.");
  }
  return entry.Config;
}

export function verifyDockerArchiveConfigBytes(
  configPath: string,
  bytes: Uint8Array,
): string {
  const expected = archiveConfigHash(configPath);
  if (expected === null) throw new Error("Docker archive Config must be a safe sha256 config filename.");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error("Docker archive config bytes do not match the sha256 encoded in the config filename.");
  }
  return `sha256:${actual}`;
}

function runCommand(command: string, args: readonly string[], label: string): void {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.error?.message ?? result.stderr.trim()) || `exit ${String(result.status)}`;
    throw new Error(`${label}: ${detail}`);
  }
}

export function resolveLocalDockerConfigDigest(reference: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codestead-runtime-config-"));
  const archive = path.join(directory, "image.tar");
  try {
    runCommand(
      "docker",
      ["image", "save", "--platform", "linux/amd64", "--output", archive, reference],
      `Failed to export exact Docker reference ${reference}`,
    );
    runCommand(
      "tar",
      ["-xf", archive, "-C", directory, "manifest.json"],
      "Failed to extract Docker archive manifest",
    );
    const archiveManifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as unknown;
    const configPath = parseDockerArchiveConfigPath(archiveManifest);
    runCommand(
      "tar",
      ["-xf", archive, "-C", directory, configPath],
      "Failed to extract Docker archive config",
    );
    const configFile = path.resolve(directory, ...configPath.split("/"));
    if (!configFile.startsWith(`${path.resolve(directory)}${path.sep}`)) {
      throw new Error("Docker archive config resolved outside the secure temporary directory.");
    }
    return verifyDockerArchiveConfigBytes(configPath, readFileSync(configFile));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function inspectLocalDockerImage(reference: string): unknown {
  const result = spawnSync(
    "docker",
    ["image", "inspect", "--platform", "linux/amd64", reference, "--format", "{{json .}}"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    const detail = (result.error?.message ?? result.stderr.trim()) || `exit ${String(result.status)}`;
    throw new Error(detail);
  }
  return JSON.parse(result.stdout) as unknown;
}

export function validateLocalRuntimeIdentity(input: {
  readonly manifest: unknown;
  readonly expectations: readonly LocalRuntimeExpectation[];
  readonly inspectImage?: InspectLocalRuntimeImage;
  readonly resolveConfigDigest?: ResolveLocalRuntimeConfigDigest;
}): Readonly<Record<string, LocalRuntimeIdentityEvidence>> {
  const manifest = object(input.manifest, "Local build identity record");
  if (Object.keys(manifest).sort().join(",") !== "records,schemaVersion") {
    throw new Error("Local build identity record must contain exactly records and schemaVersion.");
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.records)) {
    throw new Error("Local build identity record schemaVersion must be 1 and records must be an array.");
  }

  const records = manifest.records.map(runtimeRecord);
  for (const language of SUPPORTED_LOCAL_RUNTIME_LANGUAGES) {
    const count = records.filter((record) => record.id === language).length;
    if (count !== 1) throw new Error(`Expected exactly one local build identity for ${language}; found ${count}.`);
  }
  if (records.length !== SUPPORTED_LOCAL_RUNTIME_LANGUAGES.length) {
    throw new Error(`Expected exactly ${SUPPORTED_LOCAL_RUNTIME_LANGUAGES.length} local build identities; found ${records.length}.`);
  }

  const inspectImage = input.inspectImage ?? inspectLocalDockerImage;
  const resolveConfigDigest = input.resolveConfigDigest ?? resolveLocalDockerConfigDigest;
  const evidence: Record<string, LocalRuntimeIdentityEvidence> = {};
  const expectedLanguages = new Set<LocalRuntimeLanguage>();
  for (const expectation of input.expectations) {
    if (expectedLanguages.has(expectation.language)) {
      throw new Error(`Expected local runtime language '${expectation.language}' must be unique.`);
    }
    expectedLanguages.add(expectation.language);
    const declaredContentDigest = expectation.declaredContentDigest === undefined
      ? null
      : digest(expectation.declaredContentDigest, `Declared content digest for ${expectation.language}`);

    const record = records.find((candidate) => candidate.id === expectation.language)!;
    if (record.tag !== expectation.tag) throw new Error(`Tag for ${expectation.language} must be exactly ${expectation.tag}.`);
    const expectedReference = `${localRepository(expectation.tag, expectation.language)}@${record.manifestDigest}`;
    if (record.reference !== expectedReference) throw new Error(`Reference for ${expectation.language} must be exactly ${expectedReference}.`);
    if (declaredContentDigest !== null && record.manifestDigest !== declaredContentDigest) {
      throw new Error(`Declared content digest for ${expectation.language} does not match the archive-verified local manifest digest.`);
    }

    const inspect = (reference: string, label: string): DockerInspection => {
      try {
        return dockerInspection(inspectImage(reference), label);
      } catch (error) {
        throw new Error(`Failed to inspect ${reference === record.tag ? "current Docker tag" : "exact Docker reference"} ${reference}.`, { cause: error });
      }
    };
    const initialTag = inspect(record.tag, `Docker tag inspection for ${record.id}`);
    const initialExact = inspect(record.reference, `Docker exact reference inspection for ${record.id}`);
    assertDockerBinding(initialTag, record, "tag");
    assertDockerBinding(initialExact, record, "exact reference");

    let archiveConfigDigest: string;
    try {
      archiveConfigDigest = digest(
        resolveConfigDigest(record.reference),
        `Archive-derived config digest for ${record.id}`,
      );
    } catch (error) {
      throw new Error(`Failed to derive Docker archive config digest for ${record.reference}.`, { cause: error });
    }
    if (archiveConfigDigest !== record.configDigest) {
      throw new Error(`Archive-derived config digest for ${record.id} does not match the recorded config digest.`);
    }

    const finalTag = inspect(record.tag, `Final Docker tag inspection for ${record.id}`);
    const finalExact = inspect(record.reference, `Final Docker exact reference inspection for ${record.id}`);
    assertDockerBinding(finalTag, record, "tag");
    assertDockerBinding(finalExact, record, "exact reference");
    assertDockerStoreIdentity(finalTag, record, archiveConfigDigest, "tag");
    assertDockerStoreIdentity(finalExact, record, archiveConfigDigest, "exact reference");

    evidence[expectation.language] = {
      language: expectation.language,
      tag: expectation.tag,
      declaredContentDigest,
      recordedLocalDigest: record.manifestDigest,
      recordedConfigDigest: archiveConfigDigest,
      recordedLocalReference: record.reference,
      immutableReference: record.reference,
      actualTaggedImageId: finalTag.id,
      tagDescriptorDigest: finalTag.descriptorDigest,
      tagImageId: finalTag.id,
      exactReferenceDescriptorDigest: finalExact.descriptorDigest,
      exactReferenceImageId: finalExact.id,
      recordMatchesTaggedImage: true,
      independentlyValidated: true,
    };
  }
  return evidence;
}

export function projectRuntimeIdentityEvidence(
  evidence: LocalRuntimeIdentityEvidence,
): RuntimeIdentityReportEvidence {
  return {
    tag: evidence.tag,
    manifestDigest: evidence.recordedLocalDigest,
    configDigest: evidence.recordedConfigDigest,
    immutableReference: evidence.immutableReference,
    tagDescriptorDigest: evidence.tagDescriptorDigest,
    tagImageId: evidence.tagImageId,
    exactReferenceDescriptorDigest: evidence.exactReferenceDescriptorDigest,
    exactReferenceImageId: evidence.exactReferenceImageId,
    independentlyValidated: true,
  };
}
