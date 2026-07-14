import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { findSecretCanaries } from "../src/lib/security/secret-canary";
import { isGeneratedNextOutputDirectory } from "./lib/repository-scan-exclusions";

const root = process.cwd();
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

interface FileFinding {
  readonly path: string;
  readonly detector: string;
  readonly line: number;
}

async function scanDirectory(directory: string, findings: FileFinding[]) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !ignoredDirectories.has(entry.name) &&
        !isGeneratedNextOutputDirectory(path.relative(root, absolute))
      ) {
        await scanDirectory(absolute, findings);
      }
      continue;
    }
    const lowerName = entry.name.toLowerCase();
    const environmentFile = lowerName === ".env" || lowerName.startsWith(".env.");
    const localEnvironmentFile =
      environmentFile &&
      !lowerName.includes("example") &&
      !lowerName.includes("sample") &&
      !lowerName.includes("template");
    const relativePath = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (
      !entry.isFile() ||
      localEnvironmentFile ||
      relativePath.startsWith("public/monaco/") ||
      (!environmentFile && !textExtensions.has(path.extname(entry.name).toLowerCase()))
    ) continue;
    const metadata = await lstat(absolute);
    if (metadata.size > maxFileBytes) continue;
    const text = await readFile(absolute, "utf8");
    for (const finding of findSecretCanaries(text, relativePath)) {
      findings.push({
        path: relativePath,
        ...finding,
      });
    }
  }
}

async function main() {
  const findings: FileFinding[] = [];
  await scanDirectory(root, findings);
  if (findings.length > 0) {
    for (const finding of findings) {
      // Deliberately report metadata only, never the matched secret.
      console.error(`${finding.path}:${finding.line} [${finding.detector}] possible secret`);
    }
    console.error(`Secret scan failed with ${findings.length} redacted finding(s).`);
    process.exitCode = 1;
  } else {
    console.log("Secret scan passed: no recognized plaintext credential canaries found.");
  }
}

void main().catch(() => {
  console.error("Secret scan could not complete.");
  process.exitCode = 1;
});
