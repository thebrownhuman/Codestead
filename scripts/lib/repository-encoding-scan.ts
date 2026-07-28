import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  isGitMetadataPath,
  normalizeRepositoryPath,
  repositoryFindingPath,
  repositoryPathIdentityKey,
  resolveTrackedRegularRepositoryFile,
  tryListGitTrackedRepositoryPaths,
  visitDecodedTextLines,
} from "./repository-git-files";
import {
  isGeneratedNextOutputDirectory,
  isGeneratedRepositoryArtifactDirectory,
} from "./repository-scan-exclusions";

const includedExtensions = new Set([
  "",
  ".bash",
  ".c",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".cts",
  ".env",
  ".fish",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".properties",
  ".py",
  ".service",
  ".sh",
  ".sql",
  ".tf",
  ".tfvars",
  ".timer",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const excludedDirectories = new Set(["coverage", "dist", "node_modules"]);
const mojibake =
  /\uFFFD|\u00C2[\u0080-\u00BF]|\u00C3[\u0080-\u00BF]|\u00E2(?:\u20AC|[\u0080-\u00BF])|\u00E2\u201A\u00AC|\u00F0(?:\u0178\u02DC\u20AC|\u009F[\u0080-\u00BF]{2})/u;

function isTextCandidate(name: string): boolean {
  const lowerName = name.toLowerCase();
  const environmentFile = lowerName === ".env" || lowerName.startsWith(".env.");
  return environmentFile || includedExtensions.has(path.extname(lowerName));
}

async function scanFile(
  absolute: string,
  relativePath: string,
  failures: string[],
) {
  if (isGitMetadataPath(relativePath) || !isTextCandidate(path.basename(absolute))) return;
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    throw new Error(
      `Refusing to scan a symbolic link: ${repositoryFindingPath(relativePath)}`,
    );
  }
  if (!metadata.isFile()) return;

  const safePath = repositoryFindingPath(relativePath);
  await visitDecodedTextLines(absolute, relativePath, (line, lineNumber) => {
    if (mojibake.test(line)) failures.push(`${safePath}:${lineNumber}`);
  });
}

async function scanDirectory(
  root: string,
  directory: string,
  trackedPaths: ReadonlySet<string> | null,
  scannedKeys: Set<string>,
  failures: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relativePath = normalizeRepositoryPath(path.relative(root, absolute));
    if (isGitMetadataPath(relativePath)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        !excludedDirectories.has(entry.name.toLowerCase()) &&
        !isGeneratedRepositoryArtifactDirectory(relativePath) &&
        !isGeneratedNextOutputDirectory(relativePath)
      ) {
        await scanDirectory(root, absolute, trackedPaths, scannedKeys, failures);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const identity = repositoryPathIdentityKey(relativePath);
    if (scannedKeys.has(identity)) continue;
    scannedKeys.add(identity);
    await scanFile(absolute, relativePath, failures);
  }
}

async function scanTrackedFiles(
  root: string,
  trackedPaths: ReadonlySet<string>,
  scannedKeys: Set<string>,
  failures: string[],
) {
  for (const relativePath of trackedPaths) {
    if (isGitMetadataPath(relativePath)) continue;
    const identity = repositoryPathIdentityKey(relativePath);
    if (scannedKeys.has(identity)) continue;
    const absolute = await resolveTrackedRegularRepositoryFile(root, relativePath);
    await scanFile(absolute, relativePath, failures);
    scannedKeys.add(identity);
  }
}

export async function scanRepositoryForMojibake(root: string): Promise<string[]> {
  const failures: string[] = [];
  const trackedPaths = await tryListGitTrackedRepositoryPaths(root);
  const scannedKeys = new Set<string>();
  if (trackedPaths !== null) {
    await scanTrackedFiles(root, trackedPaths, scannedKeys, failures);
  }
  await scanDirectory(root, root, trackedPaths, scannedKeys, failures);
  return failures.sort();
}
