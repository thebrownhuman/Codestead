import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const CONTENT_ROOT = path.join(ROOT, "content");
const CONTENT_SEED_ROOT = path.join(ROOT, "scripts", "content-seeds");
const LEGACY_BRAND = "LearnCoding";
const CURRENT_BRAND = "Codestead";
const SCAN_ROOTS = [
  { directory: CONTENT_ROOT, extensions: new Set([".json"]) },
  { directory: CONTENT_SEED_ROOT, extensions: new Set([".ts"]) },
] as const;

type Finding = {
  readonly absolutePath: string;
  readonly line: number;
  readonly column: number;
};

async function files(directory: string, extensions: ReadonlySet<string>): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return files(absolutePath, extensions);
      return entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())
        ? [absolutePath]
        : [];
    }),
  );
  return nested.flat().sort();
}

function locations(absolutePath: string, content: string): Finding[] {
  const findings: Finding[] = [];
  for (const [lineIndex, line] of content.split(/\r?\n/u).entries()) {
    let columnIndex = line.indexOf(LEGACY_BRAND);
    while (columnIndex !== -1) {
      findings.push({
        absolutePath,
        line: lineIndex + 1,
        column: columnIndex + 1,
      });
      columnIndex = line.indexOf(LEGACY_BRAND, columnIndex + LEGACY_BRAND.length);
    }
  }
  return findings;
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const findings: Finding[] = [];
  const changedFiles: string[] = [];

  const scannedFiles = (
    await Promise.all(SCAN_ROOTS.map(({ directory, extensions }) => files(directory, extensions)))
  ).flat().sort();

  for (const absolutePath of scannedFiles) {
    const content = await readFile(absolutePath, "utf8");
    const fileFindings = locations(absolutePath, content);
    findings.push(...fileFindings);
    if (apply && fileFindings.length > 0) {
      await writeFile(absolutePath, content.replaceAll(LEGACY_BRAND, CURRENT_BRAND), "utf8");
      changedFiles.push(absolutePath);
    }
  }

  if (findings.length === 0) {
    console.log(
      `Content brand check passed: no ${LEGACY_BRAND} references found in content JSON or generator seeds.`,
    );
    return;
  }

  if (apply) {
    console.log(
      `Replaced ${findings.length} ${LEGACY_BRAND} reference(s) with ${CURRENT_BRAND} in ${changedFiles.length} content artifact(s).`,
    );
    return;
  }

  console.error(
    `Content brand check failed: found ${findings.length} ${LEGACY_BRAND} reference(s) in content JSON or generator seeds:`,
  );
  for (const finding of findings) {
    console.error(
      `- ${path.relative(ROOT, finding.absolutePath)}:${finding.line}:${finding.column}`,
    );
  }
  console.error("Run `npm run content:brand:apply` to replace the legacy public brand.");
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Content brand check failed.");
  process.exitCode = 1;
});
