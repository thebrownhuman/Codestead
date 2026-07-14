import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { isGeneratedNextOutputDirectory } from "./lib/repository-scan-exclusions";

const ROOT = process.cwd();
const INCLUDED_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".cjs", ".sql", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git", "coverage", "node_modules", "playwright-report", "test-results",
]);
const MOJIBAKE = /\uFFFD|\u00C2[\u0080-\u00BF]|\u00C3[\u0080-\u00BF]|\u00E2(?:\u20AC|[\u0080-\u00BF])/u;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (
      EXCLUDED_DIRECTORIES.has(entry.name) ||
      isGeneratedNextOutputDirectory(path.relative(ROOT, absolute))
    ) return [];
    if (entry.isDirectory()) return files(absolute);
    return entry.isFile() && INCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? [absolute] : [];
  }));
  return nested.flat();
}

async function main() {
  const failures: string[] = [];
  for (const absolute of await files(ROOT)) {
    const content = await readFile(absolute, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (MOJIBAKE.test(lines[index]!)) failures.push(`${path.relative(ROOT, absolute)}:${index + 1}`);
    }
  }

  if (failures.length > 0) {
    console.error(`Mojibake/replacement characters found in ${failures.length} location(s):`);
    for (const failure of failures.slice(0, 100)) console.error(`- ${failure}`);
    if (failures.length > 100) console.error(`- …and ${failures.length - 100} more`);
    process.exitCode = 1;
  } else {
    console.log("Repository encoding scan passed: no common UTF-8 mojibake or replacement characters found.");
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Repository encoding scan failed.");
  process.exitCode = 1;
});
