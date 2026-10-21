import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder, promisify } from "node:util";

import { DSA_PARITY_LANGUAGES } from "../../src/lib/content/dsa-parity";

export type EvidenceIntegrityIssueKind =
  | "BROKEN_LINK"
  | "INVALID_EVIDENCE_PATH"
  | "INVALID_JSON"
  | "MISSING_EVIDENCE_PATH"
  | "STALE_HASH"
  | "INVALID_SOURCE_DECLARATION"
  | "INVALID_RUNTIME_DECLARATION"
  | "STALE_RUNTIME_DIGEST"
  | "INVALID_SOURCE_COMMIT"
  | "UNANCHORED_SOURCE_PIN"
  | "SOURCE_COMMIT_UNAVAILABLE"
  | "SOURCE_COMMIT_NOT_ANCESTOR";

export type EvidenceIntegrityIssue = Readonly<{
  kind: EvidenceIntegrityIssueKind;
  source: string;
  detail: string;
}>;

export type EvidenceIntegrityReport = Readonly<{
  issues: readonly EvidenceIntegrityIssue[];
  markdown: Readonly<{ files: number; links: number }>;
  evidence: Readonly<{ files: number; paths: number; hashes: number }>;
}>;

export type EvidenceIntegrityOptions = Readonly<{
  root: string;
  evidenceRoot?: string;
  markdownRoots?: readonly string[];
}>;

const defaultMarkdownRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs",
  path.join("services", "runner", "README.md"),
  path.join("infra", "secrets", "README.md"),
] as const;

const repositoryPathPrefixes = [
  ".github/",
  "content/",
  "docs/",
  "drizzle/",
  "e2e/",
  "evals/",
  "infra/",
  "integration/",
  "scripts/",
  "services/",
  "src/",
] as const;

const repositoryRootFiles = new Set([
  "compose.yaml",
  "Dockerfile",
  "package-lock.json",
  "package.json",
  "playwright.config.ts",
  "vitest.integration.config.ts",
]);

const sha256Pattern = /^[0-9a-f]{64}$/i;
const runtimeDigestPattern = /^sha256:[0-9a-f]{64}$/;
const dsaDeclarationPath = "docs/evidence/dsa-parity-declaration-2026-07-12.json";
const authRecoveryPath = "docs/evidence/auth-recovery-verification-2026-07-12.json";
const apiAuthorizationPath = "docs/evidence/api-authorization-matrix-2026-07-12.json";
const outboxWorkerPath = "scripts/process-outbox.ts";
const runtimePinsPath = "scripts/curriculum-runtime-pins.json";

// Release artifacts continue to bind their current bytes, even in an anchored
// record. Everything else in the repository allowlist is a source pin.
const immutableArtifactPrefixes = ["docs/evidence/"] as const;

function isImmutableArtifact(candidate: string) {
  return immutableArtifactPrefixes.some((prefix) => candidate.startsWith(prefix));
}

// These named pairs describe metadata, not repository file pins. Keep this
// distinction explicit: an arbitrary unrecognized input is never metadata.
function isNonPinPair(source: string, key: string, candidate: string) {
  return (key === "generatedAtSha256" && /^\d{4}-\d{2}-\d{2}T/.test(candidate))
    || (key === "externalReportSha256" && /^https?:\/\//.test(candidate))
    || (source === "docs/evidence/backup-status-outbox-2026-07-12.json"
      && key === "localLogSha256" && path.win32.isAbsolute(candidate) && candidate.endsWith(".log"));
}

const byteExactExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sh",
  ".sql",
  ".webp",
  ".woff",
  ".woff2",
  ".yaml",
  ".yml",
]);

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function isByteExactPath(target: string) {
  return path.basename(target) === "Dockerfile"
    || byteExactExtensions.has(path.extname(target).toLowerCase());
}

function canonicalCrLfDigest(target: string, bytes: Buffer): string | null {
  if (isByteExactPath(target)) return null;
  let sawCrLf = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    if (value === 0) return null;
    if (value === 13) {
      if (bytes[index + 1] !== 10) return null;
      sawCrLf = true;
      index += 1;
    } else if (value === 10) {
      return null;
    }
  }
  if (!sawCrLf) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return sha256(Buffer.from(text.replaceAll("\r\n", "\n"), "utf8"));
}

async function filesUnder(root: string, target: string, extension?: string): Promise<string[]> {
  const absolute = path.resolve(root, target);
  const metadata = await stat(absolute);
  if (metadata.isFile()) return !extension || absolute.endsWith(extension) ? [absolute] : [];
  const result: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      result.push(...await filesUnder(root, path.relative(root, child), extension));
    } else if (!extension || child.endsWith(extension)) {
      result.push(child);
    }
  }
  return result;
}

function relative(root: string, file: string) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function isInside(root: string, target: string) {
  const inside = path.relative(root, target);
  return inside === "" || (
    inside !== ".." &&
    !inside.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(inside)
  );
}

function hasTraversal(value: string) {
  return value.replaceAll("\\", "/").split("/").includes("..");
}

function repositoryPath(root: string, value: string): string | null {
  const slashNormalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(slashNormalized) ||
    path.win32.isAbsolute(value) ||
    hasTraversal(value) ||
    slashNormalized.includes("://")
  ) return null;
  const normalized = path.posix.normalize(slashNormalized.replace(/^\.\//, ""));
  if (
    (!repositoryRootFiles.has(normalized) &&
      !repositoryPathPrefixes.some((prefix) => normalized.startsWith(prefix))) ||
    !isInside(root, path.resolve(root, normalized))
  ) return null;
  return normalized;
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function digests(target: string) {
  return digestsOf(target, await readFile(target));
}

function digestsOf(target: string, bytes: Buffer) {
  const raw = sha256(bytes);
  const canonical = canonicalCrLfDigest(target, bytes);
  return {
    accepted: canonical ? new Set([raw, canonical]) : new Set([raw]),
    reported: canonical ?? raw,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function verifyDsaRuntimeDigests(
  root: string,
  declaration: unknown,
  issues: EvidenceIntegrityIssue[],
) {
  const invalid = (detail: string) => issues.push({
    kind: "INVALID_RUNTIME_DECLARATION", source: dsaDeclarationPath, detail,
  });
  const value = object(declaration);
  const declared = object(value?.runtimeDigests);
  const expectedLanguages = [...DSA_PARITY_LANGUAGES].sort();
  if (!value || value.courseId !== "dsa" || !declared
    || !Array.isArray(value.languages)
    || JSON.stringify([...value.languages].sort()) !== JSON.stringify(expectedLanguages)
    || JSON.stringify(Object.keys(declared).sort()) !== JSON.stringify(expectedLanguages)
    || DSA_PARITY_LANGUAGES.some((language) =>
      typeof declared[language] !== "string" || !runtimeDigestPattern.test(declared[language]))
  ) {
    invalid("DSA declaration must contain exactly C, C++, Java, and Python languages and valid sha256 runtime digests.");
    return;
  }

  let pins: Record<string, unknown> | null;
  try {
    pins = object(JSON.parse(await readFile(path.join(root, runtimePinsPath), "utf8")));
  } catch {
    invalid(`${runtimePinsPath} could not be read as JSON.`);
    return;
  }
  if (!pins || pins.schemaVersion !== 1 || !Array.isArray(pins.records)) {
    invalid(`${runtimePinsPath} must contain a version-1 records array.`);
    return;
  }
  const expected = new Map<string, string>();
  for (const language of DSA_PARITY_LANGUAGES) {
    const records = pins.records.map(object).filter((record) => record?.language === language);
    const digest = records[0]?.digest;
    if (records.length !== 1 || typeof digest !== "string" || !runtimeDigestPattern.test(digest)) {
      invalid(`${runtimePinsPath} must contain exactly one valid sha256 pin for ${language}.`);
      return;
    }
    expected.set(language, digest);
  }
  for (const language of DSA_PARITY_LANGUAGES) {
    const pinned = expected.get(language)!;
    if (declared[language] !== pinned) issues.push({
      kind: "STALE_RUNTIME_DIGEST", source: dsaDeclarationPath,
      detail: `${language} declared=${declared[language]} pinned=${pinned} (${runtimePinsPath}); regenerate with npm run dsa:parity:generate`,
    });
  }
}

async function verifyMarkdown(
  root: string,
  markdownRoots: readonly string[],
  issues: EvidenceIntegrityIssue[],
) {
  const files = (await Promise.all(markdownRoots.map(async (target) => {
    try {
      return await filesUnder(root, target, ".md");
    } catch {
      return [];
    }
  }))).flat();
  let checked = 0;
  const localLink = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  for (const file of files) {
    const document = await readFile(file, "utf8");
    for (const match of document.matchAll(localLink)) {
      const raw = match[1]!.split("#")[0]!.trim().replace(/^<|>$/g, "");
      if (!raw) continue;
      checked += 1;
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        issues.push({ kind: "BROKEN_LINK", source: relative(root, file), detail: `Invalid encoded path: ${raw}` });
        continue;
      }
      const target = path.resolve(path.dirname(file), decoded);
      if (!isInside(root, target) || !await exists(target)) {
        issues.push({ kind: "BROKEN_LINK", source: relative(root, file), detail: raw });
      }
    }
  }
  return { files: files.length, links: checked };
}

const execFileAsync = promisify(execFile);
const sourceCommitPattern = /^[0-9a-f]{40}$/;

// A historical record may declare `sourceCommit`, the commit its proof ran
// against. Its path pins are then checked against that commit's blobs instead
// of the working tree, so later edits to the pinned files do not make the
// record stale. The commit must exist locally and be an ancestor of HEAD;
// anything else fails closed.
async function git(root: string, args: readonly string[]) {
  return execFileAsync("git", ["-C", root, ...args], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

async function gitSucceeds(root: string, args: readonly string[]) {
  try {
    await git(root, args);
    return true;
  } catch {
    return false;
  }
}

async function isRepositoryRoot(root: string) {
  try {
    const { stdout } = await git(root, ["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.toString("utf8").trim()) === path.resolve(root);
  } catch {
    return false;
  }
}

async function verifyEvidence(
  root: string,
  evidenceRoot: string,
  issues: EvidenceIntegrityIssue[],
) {
  const files = await filesUnder(root, evidenceRoot, ".json");
  const checkedPaths = new Set<string>();
  const checkedHashes = new Set<string>();
  const invalidPaths = new Set<string>();
  const unanchoredPins = new Set<string>();

  function rejectTraversal(source: string, value: string) {
    if (!hasTraversal(value)) return false;
    const key = `${source}\0${value}`;
    if (!invalidPaths.has(key)) {
      invalidPaths.add(key);
      issues.push({ kind: "INVALID_EVIDENCE_PATH", source, detail: value });
    }
    return true;
  }

  function pinPath(source: string, value: string) {
    if (rejectTraversal(source, value)) return null;
    const candidate = repositoryPath(root, value);
    if (!candidate) {
      const key = `${source}\0${value}`;
      if (!invalidPaths.has(key)) {
        invalidPaths.add(key);
        issues.push({ kind: "INVALID_EVIDENCE_PATH", source, detail: value });
      }
    }
    return candidate;
  }

  const sourceCommitStatus = new Map<string, Promise<EvidenceIntegrityIssueKind | null>>();
  let repositoryRoot: Promise<boolean> | undefined;

  function resolveSourceCommit(commit: string) {
    let status = sourceCommitStatus.get(commit);
    if (!status) {
      status = (async (): Promise<EvidenceIntegrityIssueKind | null> => {
        repositoryRoot ??= isRepositoryRoot(root);
        if (!await repositoryRoot) return "SOURCE_COMMIT_UNAVAILABLE";
        if (!await gitSucceeds(root, ["cat-file", "-e", `${commit}^{commit}`])) return "SOURCE_COMMIT_UNAVAILABLE";
        if (!await gitSucceeds(root, ["merge-base", "--is-ancestor", commit, "HEAD"])) return "SOURCE_COMMIT_NOT_ANCESTOR";
        return null;
      })();
      sourceCommitStatus.set(commit, status);
    }
    return status;
  }

  // undefined: the record declares an unusable anchor and an issue was reported.
  async function sourceCommitOf(source: string, value: unknown): Promise<string | null | undefined> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "sourceCommit")) {
      return null;
    }
    const commit = (value as Record<string, unknown>).sourceCommit;
    if (typeof commit !== "string" || !sourceCommitPattern.test(commit)) {
      issues.push({ kind: "INVALID_SOURCE_COMMIT", source, detail: "sourceCommit must be a full lowercase 40-hex commit id" });
      return undefined;
    }
    const failure = await resolveSourceCommit(commit);
    if (failure === "SOURCE_COMMIT_UNAVAILABLE") {
      issues.push({ kind: failure, source, detail: `${commit} is not available; fetch full history (fetch-depth: 0)` });
      return undefined;
    }
    if (failure) {
      issues.push({ kind: failure, source, detail: `${commit} is not an ancestor of HEAD` });
      return undefined;
    }
    return commit;
  }

  // One `ls-tree` per anchor commit instead of a `cat-file -e` spawn per pin:
  // records carry dozens of pins, and per-pin process spawns made verification
  // take seconds per record on Windows.
  const commitTrees = new Map<string, Promise<Map<string, { type: string; oid: string }>>>();
  const blobs = new Map<string, Promise<Buffer>>();

  function treeOf(commit: string) {
    let tree = commitTrees.get(commit);
    if (!tree) {
      tree = git(root, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit]).then(({ stdout }) => {
        const entries = new Map<string, { type: string; oid: string }>();
        for (const line of stdout.toString("utf8").split(" ")) {
          const tab = line.indexOf("	");
          if (tab < 0) continue;
          const [, type, oid] = line.slice(0, tab).split(" ");
          entries.set(line.slice(tab + 1), { type: type!, oid: oid! });
        }
        return entries;
      });
      commitTrees.set(commit, tree);
    }
    return tree;
  }

  // Only plain blobs and trees are answered from the listing. Anything else
  // (a gitlink) takes the original per-path `cat-file` route so its result is
  // unchanged; a tree still makes `cat-file blob` fail where bytes are required.
  async function anchoredPresent(commit: string, candidate: string) {
    const entry = (await treeOf(commit)).get(candidate.replace(/\/+$/, ""));
    if (entry?.type === "blob" || entry?.type === "tree") return true;
    return gitSucceeds(root, ["cat-file", "-e", `${commit}:${candidate}`]);
  }

  async function anchoredBlob(commit: string, candidate: string) {
    const entry = (await treeOf(commit)).get(candidate.replace(/\/+$/, ""));
    if (entry?.type !== "blob") {
      if (!await gitSucceeds(root, ["cat-file", "-e", `${commit}:${candidate}`])) return null;
      return (await git(root, ["cat-file", "blob", `${commit}:${candidate}`])).stdout;
    }
    let blob = blobs.get(entry.oid);
    if (!blob) {
      blob = git(root, ["cat-file", "blob", entry.oid]).then(({ stdout }) => stdout);
      blobs.set(entry.oid, blob);
    }
    return blob;
  }

  async function checkPath(source: string, value: string, commit: string | null) {
    if (rejectTraversal(source, value)) return;
    const candidate = repositoryPath(root, value);
    if (!candidate) return;
    const key = `${source}\0${candidate}`;
    if (checkedPaths.has(key)) return;
    checkedPaths.add(key);
    const present = commit
      ? await anchoredPresent(commit, candidate)
      : await exists(path.join(root, candidate));
    if (!present) {
      issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: commit ? `${candidate}@${commit}` : candidate });
    }
    if (commit && isImmutableArtifact(candidate) && !await exists(path.join(root, candidate))) {
      issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: candidate });
    }
  }

  async function checkHash(source: string, value: string, expected: unknown, commit: string | null, currentProjection = false) {
    const candidate = pinPath(source, value);
    if (!candidate) return;
    if (typeof expected !== "string" || !sha256Pattern.test(expected)) {
      issues.push({ kind: "INVALID_SOURCE_DECLARATION", source, detail: `${candidate} must declare a valid SHA-256 hash` });
      return;
    }
    const liveWorker = source === authRecoveryPath && candidate === outboxWorkerPath;
    if (liveWorker || currentProjection) commit = null;
    const key = `${source}\0${candidate}\0${expected.toLowerCase()}\0${commit ?? ""}`;
    if (checkedHashes.has(key)) return;
    checkedHashes.add(key);
    if (!commit && !isImmutableArtifact(candidate) && !liveWorker && !currentProjection) {
      const pin = `${source}\0${candidate}`;
      if (!unanchoredPins.has(pin)) {
        unanchoredPins.add(pin);
        issues.push({ kind: "UNANCHORED_SOURCE_PIN", source, detail: `${candidate} requires sourceCommit` });
      }
    }
    const target = path.join(root, candidate);
    const label = commit ? `${candidate}@${commit}` : candidate;
    let actual: ReturnType<typeof digestsOf>;
    if (commit) {
      const blob = await anchoredBlob(commit, candidate);
      if (!blob) {
        issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: label });
        return;
      }
      actual = digestsOf(target, blob);
    } else {
      if (!await exists(target)) {
        issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: label });
        return;
      }
      actual = await digests(target);
    }
    if (!actual.accepted.has(expected.toLowerCase())) {
      issues.push({
        kind: "STALE_HASH",
        source,
        detail: `${label} expected=${expected.toLowerCase()} actual=${actual.reported}`,
      });
    }
    // Preserve the original anchored check and additionally require immutable
    // release artifacts to match their live bytes. Neither binding can bypass
    // a failure in the other.
    if (commit && isImmutableArtifact(candidate)) {
      if (!await exists(target)) {
        issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: candidate });
      } else {
        const current = await digests(target);
        if (!current.accepted.has(expected.toLowerCase())) {
          issues.push({ kind: "STALE_HASH", source, detail: `${candidate} expected=${expected.toLowerCase()} actual=${current.reported}` });
        }
      }
    }
  }

  async function walk(source: string, value: unknown, commit: string | null, currentProjection = false): Promise<void> {
    if (Array.isArray(value)) {
      for (const item of value) await walk(source, item, commit, currentProjection);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") {
      await checkPath(source, record.path, commit);
      if (Object.hasOwn(record, "sha256")) await checkHash(source, record.path, record.sha256, commit);
    }
    for (const [key, expected] of Object.entries(record)) {
      if (!key.endsWith("Sha256")) continue;
      const candidate = record[key.slice(0, -"Sha256".length)];
      if (typeof candidate === "string" && !isNonPinPair(source, key, candidate)) {
        await checkHash(source, candidate, expected, commit);
      }
    }
    for (const key of ["report", "inventory"] as const) {
      if (typeof record[key] === "string") await checkPath(source, record[key], commit);
    }
    for (const key of ["artifactSha256", "sha256", "sourceSha256"] as const) {
      if (!Object.hasOwn(record, key)) continue;
      const hashes = record[key];
      if (object(hashes)) {
        for (const [candidate, expected] of Object.entries(hashes as Record<string, unknown>)) {
          await checkHash(source, candidate, expected, commit);
        }
      } else if (key === "sourceSha256" && typeof record.file === "string") {
        // This scalar shape is emitted by the deterministic authorization
        // generator. Its exact --check projection must remain current; the
        // exception applies only to that existing record, not new records.
        await checkHash(source, record.file, hashes, commit, currentProjection);
      } else if (Object.hasOwn(record, key) && (key !== "sha256" || typeof record.path !== "string")) {
        issues.push({ kind: "INVALID_SOURCE_DECLARATION", source, detail: `${key} must be a path-to-SHA-256 map` });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      await walk(source, child, commit, source === apiAuthorizationPath && key === "supportingOwnershipProofs");
    }
  }

  for (const file of files) {
    const source = relative(root, file);
    try {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (source === dsaDeclarationPath) await verifyDsaRuntimeDigests(root, value, issues);
      if (source === authRecoveryPath) {
        const pinned = object(object(value)?.sourceSha256)?.[outboxWorkerPath];
        if (typeof pinned !== "string" || !sha256Pattern.test(pinned)) {
          issues.push({
            kind: "INVALID_SOURCE_DECLARATION", source,
            detail: `Auth recovery evidence must pin ${outboxWorkerPath} in sourceSha256 with a valid sha256 hash.`,
          });
        } else {
          // This gate always binds the live worker, even if the record is anchored.
          await checkHash(source, outboxWorkerPath, pinned, null);
        }
      }
      const commit = await sourceCommitOf(source, value);
      if (commit !== undefined) await walk(source, value, commit);
    } catch (error) {
      issues.push({
        kind: "INVALID_JSON",
        source,
        detail: error instanceof Error ? error.message : "JSON could not be parsed",
      });
    }
  }
  return { files: files.length, paths: checkedPaths.size, hashes: checkedHashes.size };
}

export async function verifyEvidenceIntegrity(
  options: EvidenceIntegrityOptions,
): Promise<EvidenceIntegrityReport> {
  const root = path.resolve(options.root);
  const issues: EvidenceIntegrityIssue[] = [];
  const [markdown, evidence] = await Promise.all([
    verifyMarkdown(root, options.markdownRoots ?? defaultMarkdownRoots, issues),
    verifyEvidence(root, options.evidenceRoot ?? path.join("docs", "evidence"), issues),
  ]);
  issues.sort((left, right) =>
    left.kind.localeCompare(right.kind) ||
    left.source.localeCompare(right.source) ||
    left.detail.localeCompare(right.detail));
  return { issues, markdown, evidence };
}
