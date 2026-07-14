import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type EvidenceIntegrityIssueKind =
  | "BROKEN_LINK"
  | "INVALID_EVIDENCE_PATH"
  | "INVALID_JSON"
  | "MISSING_EVIDENCE_PATH"
  | "STALE_HASH";

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
]);

const sha256Pattern = /^[0-9a-f]{64}$/i;

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

async function digest(target: string) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
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

async function verifyEvidence(
  root: string,
  evidenceRoot: string,
  issues: EvidenceIntegrityIssue[],
) {
  const files = await filesUnder(root, evidenceRoot, ".json");
  const checkedPaths = new Set<string>();
  const checkedHashes = new Set<string>();
  const invalidPaths = new Set<string>();

  function rejectTraversal(source: string, value: string) {
    if (!hasTraversal(value)) return false;
    const key = `${source}\0${value}`;
    if (!invalidPaths.has(key)) {
      invalidPaths.add(key);
      issues.push({ kind: "INVALID_EVIDENCE_PATH", source, detail: value });
    }
    return true;
  }

  async function checkPath(source: string, value: string) {
    if (rejectTraversal(source, value)) return;
    const candidate = repositoryPath(root, value);
    if (!candidate) return;
    const key = `${source}\0${candidate}`;
    if (checkedPaths.has(key)) return;
    checkedPaths.add(key);
    if (!await exists(path.join(root, candidate))) {
      issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: candidate });
    }
  }

  async function checkHash(source: string, value: string, expected: string) {
    if (rejectTraversal(source, value)) return;
    const candidate = repositoryPath(root, value);
    if (!candidate || !sha256Pattern.test(expected)) return;
    const key = `${source}\0${candidate}\0${expected.toLowerCase()}`;
    if (checkedHashes.has(key)) return;
    checkedHashes.add(key);
    const target = path.join(root, candidate);
    if (!await exists(target)) {
      issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: candidate });
      return;
    }
    const actual = await digest(target);
    if (actual !== expected.toLowerCase()) {
      issues.push({
        kind: "STALE_HASH",
        source,
        detail: `${candidate} expected=${expected.toLowerCase()} actual=${actual}`,
      });
    }
  }

  async function walk(source: string, value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      for (const item of value) await walk(source, item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") {
      await checkPath(source, record.path);
      if (typeof record.sha256 === "string") await checkHash(source, record.path, record.sha256);
    }
    for (const [key, expected] of Object.entries(record)) {
      if (!key.endsWith("Sha256") || typeof expected !== "string") continue;
      const candidate = record[key.slice(0, -"Sha256".length)];
      if (typeof candidate === "string") await checkHash(source, candidate, expected);
    }
    for (const key of ["report", "inventory"] as const) {
      if (typeof record[key] === "string") await checkPath(source, record[key]);
    }
    for (const key of ["artifactSha256", "sha256"] as const) {
      const hashes = record[key];
      if (hashes && typeof hashes === "object" && !Array.isArray(hashes)) {
        for (const [candidate, expected] of Object.entries(hashes as Record<string, unknown>)) {
          if (typeof expected === "string") await checkHash(source, candidate, expected);
        }
      }
    }
    for (const child of Object.values(record)) await walk(source, child);
  }

  for (const file of files) {
    const source = relative(root, file);
    try {
      await walk(source, JSON.parse(await readFile(file, "utf8")) as unknown);
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
