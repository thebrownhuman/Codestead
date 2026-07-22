#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const TARGETS = Object.freeze([
  Object.freeze({ target: "runtime", variable: "APP_RUNTIME_IMAGE" }),
  Object.freeze({ target: "tooling", variable: "APP_TOOLING_IMAGE" }),
  Object.freeze({ target: "worker", variable: "APP_WORKER_IMAGE" }),
  Object.freeze({ target: "regrade-worker", variable: "APP_REGRADE_WORKER_IMAGE" }),
  Object.freeze({
    target: "project-review-correction-worker",
    variable: "APP_PROJECT_REVIEW_WORKER_IMAGE",
  }),
  Object.freeze({ target: "scanner-worker", variable: "APP_SCANNER_WORKER_IMAGE" }),
  Object.freeze({ target: "operations", variable: "APP_OPERATIONS_IMAGE" }),
]);

const TARGET_VARIABLES = new Set(TARGETS.map(({ variable }) => variable));
const SHA256_HEX = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_REFERENCE = /^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SOURCE_TREE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/;
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(message) {
  throw new Error(message);
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

function requireSource(repository, revision) {
  let parsed;
  try {
    parsed = new URL(repository);
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
    || parsed.href !== repository
  ) {
    fail("Application image source repository must be a canonical absolute HTTPS URL.");
  }
  if (!SOURCE_REVISION.test(revision ?? "")) {
    fail("Application image source revision must be an exact lowercase Git commit.");
  }
  return { repository, revision };
}

function normalizeSourceRepository(value) {
  let normalized = typeof value === "string" ? value.trim() : "";
  const scp = /^git@([^:]+):(.+)$/.exec(normalized);
  if (scp) normalized = `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(normalized);
  if (ssh) normalized = `https://${ssh[1]}/${ssh[2]}`;
  normalized = normalized.replace(/\.git$/, "").replace(/\/$/, "");
  requireSource(normalized, "0".repeat(40));
  return normalized;
}

function runTrustedGit(args, { binary = false } = {}) {
  const result = spawnSync(
    "/usr/bin/git",
    ["-c", `safe.directory=${repositoryRoot}`, "-C", repositoryRoot, ...args],
    {
      encoding: binary ? null : "utf8",
      stdio: "pipe",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  if (result.error || result.status !== 0) {
    fail(`Trusted Git failed while deriving release source: ${
      result.error?.message ?? result.stderr?.toString("utf8") ?? result.status
    }`);
  }
  return binary ? Buffer.from(result.stdout) : result.stdout.trim();
}

export function deriveRepositorySourceBinding(runGit = runTrustedGit) {
  const repository = normalizeSourceRepository(
    runGit(["config", "--get", "remote.origin.url"]),
  );
  const revision = runGit(["rev-parse", "HEAD^{commit}"]);
  const tree = runGit(["rev-parse", "HEAD^{tree}"]);
  if (!SOURCE_REVISION.test(revision) || !SOURCE_TREE.test(tree)) {
    fail("Trusted Git returned a non-canonical commit or tree identity.");
  }
  const tracked = runGit(["ls-tree", "-r", "--name-only", "--full-tree", "HEAD"])
    .split("\n").filter(Boolean);
  for (const file of tracked) {
    if (
      file === "next-env.d.ts"
      || file === "public/monaco"
      || file.startsWith("public/monaco/")
      || file === "dist"
      || file.startsWith("dist/")
      || file === "uploads"
      || file.startsWith("uploads/")
    ) {
      fail(`Generated path ${file} must not enter the application release source.`);
    }
  }
  const archive = runGit(["archive", "--format=tar", "HEAD"], { binary: true });
  return {
    repository,
    revision,
    tree,
    contextSha256: createHash("sha256").update(archive).digest("hex"),
  };
}

function parseEnvironment(text, { recordOnly }) {
  if (typeof text !== "string" || text.includes("\r") || text.includes("\0")) {
    fail("Application image environment projection is not canonical UTF-8 text.");
  }
  const values = Object.create(null);
  const comments = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      comments.push(line);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) fail("Application image environment projection contains a malformed line.");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!ENVIRONMENT_KEY.test(key)) fail("Application image environment key is invalid.");
    if (Object.hasOwn(values, key)) fail(`Application image environment contains duplicate ${key}.`);
    if (recordOnly && !TARGET_VARIABLES.has(key)) {
      fail(`Application image environment contains unreviewed key ${key}.`);
    }
    if (!recordOnly && /^APP_[A-Z0-9_]*_IMAGE$/.test(key) && !TARGET_VARIABLES.has(key)) {
      fail(`Compose contains unreviewed application image key ${key}.`);
    }
    values[key] = value;
  }
  return { values, comments };
}

export function parseExactEnvironmentProjection(text) {
  const { values, comments } = parseEnvironment(text, { recordOnly: true });
  if (Object.keys(values).length !== TARGETS.length) {
    fail("Application image environment projection requires exactly seven reviewed keys.");
  }
  for (const { variable } of TARGETS) {
    if (!Object.hasOwn(values, variable)) {
      fail(`Application image environment projection is missing ${variable}.`);
    }
    if (!IMMUTABLE_REFERENCE.test(values[variable])) {
      fail(`${variable} must be an immutable digest reference without interpolation.`);
    }
  }
  return { values, comments };
}

function normalizeRecords(records, local, sourceRepository, sourceRevision) {
  if (!Array.isArray(records) || records.length !== TARGETS.length) {
    fail("Application image record requires the complete seven-target identity set.");
  }
  const byTarget = new Map();
  for (const record of records) {
    if (typeof record?.target !== "string" || byTarget.has(record.target)) {
      fail("Application image record contains a duplicate or invalid target.");
    }
    byTarget.set(record.target, record);
  }
  const seenReferences = new Set();
  const seenManifestDigests = new Set();
  const seenConfigDigests = new Set();
  return TARGETS.map((expected) => {
    const record = byTarget.get(expected.target);
    if (!record) fail(`Application image record is missing target ${expected.target}.`);
    if (!exactKeys(record, [
      "target", "variable", "reference", "manifestDigest", "configDigest", "rootDigest",
      "sourceRepository", "sourceRevision",
    ])) {
      fail("Application image identity contains missing or unreviewed fields.");
    }
    if (record.variable !== expected.variable) {
      fail("Application image identity target-to-variable mapping is invalid or duplicated.");
    }
    if (!IMMUTABLE_REFERENCE.test(record.reference ?? "")) {
      fail("Application image identity requires an immutable digest reference.");
    }
    if (
      !OCI_DIGEST.test(record.manifestDigest ?? "")
      || !record.reference.endsWith(`@${record.manifestDigest}`)
      || !OCI_DIGEST.test(record.configDigest ?? "")
      || record.configDigest === record.manifestDigest
      || !OCI_DIGEST.test(record.rootDigest ?? "")
      || (local && record.rootDigest !== record.manifestDigest)
    ) {
      fail("Application image manifest, config, and root identities are invalid or conflated.");
    }
    if (
      record.sourceRepository !== sourceRepository
      || record.sourceRevision !== sourceRevision
    ) {
      fail("Application image identity source does not match the release source.");
    }
    requireSource(record.sourceRepository, record.sourceRevision);
    if (
      seenReferences.has(record.reference)
      || seenManifestDigests.has(record.manifestDigest)
      || seenConfigDigests.has(record.configDigest)
    ) {
      fail("Application image record contains a duplicate deployable identity.");
    }
    seenReferences.add(record.reference);
    seenManifestDigests.add(record.manifestDigest);
    seenConfigDigests.add(record.configDigest);
    return { ...record };
  });
}

export function verifyApplicationImageRecordProjection({
  jsonText,
  envText,
  composeText,
  expectedSourceRepository,
  expectedSourceRevision,
  expectedSourceTree,
  expectedSourceContextSha256,
  validatedAt,
}) {
  requireSource(expectedSourceRepository, expectedSourceRevision);
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
  if (
    !validTimestamp(validatedAt)
    || !validTimestamp(document.generatedAt)
    || !RELEASE.test(document.release ?? "")
    || typeof document.local !== "boolean"
    || !exactKeys(document.source, ["repository", "revision", "tree", "contextSha256"])
    || !SOURCE_TREE.test(expectedSourceTree ?? "")
    || !SHA256_HEX.test(expectedSourceContextSha256 ?? "")
  ) {
    fail("Application image record metadata is not canonical.");
  }
  const age = Date.parse(validatedAt) - Date.parse(document.generatedAt);
  if (age < 0 || age > MAX_RECORD_AGE_MS) {
    fail("Application image record is stale or from the future.");
  }
  if (
    document.source.repository !== expectedSourceRepository
    || document.source.revision !== expectedSourceRevision
    || document.source.tree !== expectedSourceTree
    || document.source.contextSha256 !== expectedSourceContextSha256
  ) {
    fail("Application image record source repository, revision, tree, or context does not match the release source.");
  }
  const records = normalizeRecords(
    document.records,
    document.local,
    document.source.repository,
    document.source.revision,
  );
  const payload = {
    schemaVersion: 1,
    generatedAt: document.generatedAt,
    release: document.release,
    local: document.local,
    source: { ...document.source },
    records,
  };
  const recordId = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const canonical = { schemaVersion: 1, recordId, ...payload };
  if (recordId !== document.recordId || !isDeepStrictEqual(canonical, document)) {
    fail("Application image record does not match its canonical record id.");
  }
  const canonicalJsonText = `${JSON.stringify(canonical, null, 2)}\n`;
  if (jsonText !== canonicalJsonText) {
    fail("Application image record does not use the canonical JSON bytes.");
  }
  const recordSha256 = createHash("sha256").update(canonicalJsonText).digest("hex");

  const expectedEnvText = [
    "# Generated by scripts/app-images/manage-application-images.mjs; do not hand-edit.",
    `# application-image-record-id=${recordId}`,
    ...records.map(({ variable, reference }) => `${variable}=${reference}`),
    "",
  ].join("\n");
  const recordProjection = parseExactEnvironmentProjection(envText);
  if (
    envText !== expectedEnvText
    || !isDeepStrictEqual(recordProjection.comments, [
      "# Generated by scripts/app-images/manage-application-images.mjs; do not hand-edit.",
      `# application-image-record-id=${recordId}`,
    ])
  ) {
    fail("Application image environment projection does not match its canonical record id.");
  }

  const composeProjection = parseEnvironment(composeText, { recordOnly: false }).values;
  if (composeProjection.SOURCE_CODE_URL !== expectedSourceRepository) {
    fail("Compose source projection does not match the reviewed application source.");
  }
  for (const { variable } of TARGETS) {
    if (composeProjection[variable] !== recordProjection.values[variable]) {
      fail(`Compose application image projection does not match ${variable}.`);
    }
  }
  return { recordId, recordSha256, projection: { ...recordProjection.values }, document };
}

function securelyReadEvidence(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
    fail(`${label} path must be absolute and NUL-free.`);
  }
  const absolute = path.resolve(file);
  if (absolute !== file) fail(`${label} path must be canonical.`);
  let canonical;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    fail(`${label} is missing or inaccessible.`);
  }
  if (canonical !== absolute) fail(`${label} path contains a symlink or is non-canonical.`);
  const link = lstatSync(absolute);
  if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) {
    fail(`${label} must be one regular, non-linked file.`);
  }
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size < 1
      || before.size > MAX_EVIDENCE_BYTES
      || (process.platform === "linux" && (before.uid !== 0 || before.gid !== 0))
      || (before.mode & 0o022) !== 0
    ) {
      fail(`${label} ownership, link count, size, or mode is unsafe.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.length !== before.size
    ) {
      fail(`${label} changed while it was being verified.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail(`${label} is not valid UTF-8.`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function currentUtcSecond() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseMainArguments(argv) {
  const [jsonFile, envFile, composeFile, expectedRepository, expectedRevision, ...options] = argv;
  if (!jsonFile || !envFile || !composeFile || !expectedRepository || !expectedRevision) {
    fail("Usage: verify-application-image-record.mjs JSON ENV COMPOSE_ENV SOURCE_REPOSITORY SOURCE_REVISION --expected-source-tree TREE [--validated-at UTC_TIMESTAMP]");
  }
  let expectedTree;
  let timestamp;
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (!value) fail(`Application image verifier option ${flag ?? "<missing>"} requires a value.`);
    if (flag === "--expected-source-tree" && expectedTree === undefined) {
      expectedTree = value;
    } else if (flag === "--validated-at" && timestamp === undefined) {
      timestamp = value;
    } else {
      fail(`Application image verifier option ${flag} is unknown or duplicated.`);
    }
  }
  if (!SOURCE_TREE.test(expectedTree ?? "")) {
    fail("--expected-source-tree must be an exact lowercase Git tree object id.");
  }
  if (timestamp !== undefined && !validTimestamp(timestamp)) {
    fail("--validated-at must be a canonical UTC timestamp.");
  }
  return {
    jsonFile,
    envFile,
    composeFile,
    expectedRepository,
    expectedRevision,
    expectedTree,
    timestamp: timestamp ?? currentUtcSecond(),
  };
}

function main() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    fail("Application image record verification requires real Linux root.");
  }
  const args = parseMainArguments(process.argv.slice(2));
  const sourceBefore = deriveRepositorySourceBinding();
  if (
    sourceBefore.repository !== args.expectedRepository
    || sourceBefore.revision !== args.expectedRevision
    || sourceBefore.tree !== args.expectedTree
  ) {
    fail("Independently derived repository origin, commit, or tree does not match the release declaration.");
  }
  const jsonText = securelyReadEvidence(args.jsonFile, "application image JSON record");
  const envText = securelyReadEvidence(args.envFile, "application image env record");
  const composeText = securelyReadEvidence(args.composeFile, "Compose environment");
  const result = verifyApplicationImageRecordProjection({
    jsonText,
    envText,
    composeText,
    expectedSourceRepository: sourceBefore.repository,
    expectedSourceRevision: sourceBefore.revision,
    expectedSourceTree: sourceBefore.tree,
    expectedSourceContextSha256: sourceBefore.contextSha256,
    validatedAt: args.timestamp,
  });
  if (
    securelyReadEvidence(args.jsonFile, "application image JSON record") !== jsonText
    || securelyReadEvidence(args.envFile, "application image env record") !== envText
    || securelyReadEvidence(args.composeFile, "Compose environment") !== composeText
  ) {
    fail("Application image record or Compose projection changed during verification.");
  }
  const sourceAfter = deriveRepositorySourceBinding();
  if (!isDeepStrictEqual(sourceAfter, sourceBefore)) {
    fail("Application release source changed during record verification.");
  }
  process.stdout.write(
    `application-image-record-id=${result.recordId} application-image-record-sha256=${result.recordSha256}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
