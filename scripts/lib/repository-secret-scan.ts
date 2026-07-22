import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { findSecretCanaries } from "../../src/lib/security/secret-canary";
import { isGeneratedNextOutputDirectory } from "./repository-scan-exclusions";

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "node_modules",
  "test-results",
  "dist",
]);
const textExtensions = new Set([
  "",
  ".c",
  ".conf",
  ".cpp",
  ".css",
  ".env",
  ".example",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".pem",
  ".key",
  ".properties",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const maxFileBytes = 2 * 1024 * 1024;

export interface RepositorySecretFinding {
  readonly path: string;
  readonly detector: string;
  readonly line: number;
}

function normalizeRepositoryPath(value: string) {
  return value.replaceAll("\\", "/");
}

async function trackedPaths(root: string) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "ls-files", "--cached", "-z"],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
  );
  return new Set(
    stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(normalizeRepositoryPath),
  );
}

function isLocalEnvironmentFile(name: string) {
  const lowerName = name.toLowerCase();
  const environmentFile = lowerName === ".env" || lowerName.startsWith(".env.");
  return (
    environmentFile &&
    !lowerName.includes("example") &&
    !lowerName.includes("sample") &&
    !lowerName.includes("template")
  );
}

async function scanDirectory(
  root: string,
  directory: string,
  gitTrackedPaths: ReadonlySet<string>,
  findings: RepositorySecretFinding[],
) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    const relativePath = normalizeRepositoryPath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      if (
        !ignoredDirectories.has(entry.name) &&
        !isGeneratedNextOutputDirectory(relativePath)
      ) {
        await scanDirectory(root, absolute, gitTrackedPaths, findings);
      }
      continue;
    }

    const lowerName = entry.name.toLowerCase();
    const environmentFile = lowerName === ".env" || lowerName.startsWith(".env.");
    if (
      !entry.isFile() ||
      (isLocalEnvironmentFile(entry.name) && !gitTrackedPaths.has(relativePath)) ||
      relativePath.startsWith("public/monaco/") ||
      (!environmentFile && !textExtensions.has(path.extname(entry.name).toLowerCase()))
    ) {
      continue;
    }

    const metadata = await lstat(absolute);
    if (metadata.size > maxFileBytes) continue;
    const text = await readFile(absolute, "utf8");
    for (const finding of findSecretCanaries(text, relativePath)) {
      findings.push({ path: relativePath, ...finding });
    }
  }
}

export async function scanRepositoryForSecrets(root: string) {
  const findings: RepositorySecretFinding[] = [];
  await scanDirectory(root, root, await trackedPaths(root), findings);
  return findings;
}
