import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

type Violation = { readonly file: string; readonly import: string; readonly rule: string };
type Exception = { readonly file: string; readonly import: string; readonly reason: string };

const exactExceptions = new Map<string, string>([
  ["src/app/api/admin/access-requests/route.ts\0@/components/admin/types", "Existing admin API DTO contract awaits extraction to src/lib/admin."],
  ["src/app/api/admin/dashboard/data.ts\0@/components/admin/admin-utils", "Existing pure dashboard formatter awaits extraction to src/lib/admin."],
  ["src/app/api/admin/dashboard/data.ts\0@/components/admin/types", "Existing admin dashboard DTO contract awaits extraction to src/lib/admin."],
  ["src/components/exams/timed-exam-client.tsx\0@/app/api/exams/_lib/policy", "Existing deterministic browser-safe exam policy awaits extraction to src/lib/exams."],
  ["src/lib/assessment-corrections/worker.ts\0@/app/api/exams/_lib/policy", "Existing deterministic exam policy awaits extraction to src/lib/exams."],
  ["src/lib/content/__tests__/authored-c-cpp.test.ts\0@/app/api/exams/_lib/blueprint", "Content gate currently exercises the shared deterministic form builder pending extraction."],
  ["src/lib/content/__tests__/authored-dsa.test.ts\0@/app/api/exams/_lib/blueprint", "Content gate currently exercises the shared deterministic form builder pending extraction."],
  ["src/lib/content/__tests__/authored-tranche.test.ts\0@/app/api/exams/_lib/blueprint", "Content gate currently exercises the shared deterministic form builder pending extraction."],
  ["src/lib/content/__tests__/authored-web.test.ts\0@/app/api/exams/_lib/blueprint", "Content gate currently exercises the shared deterministic form builder pending extraction."],
  ["src/lib/content/__tests__/web-executable-tranche.test.ts\0@/app/api/exams/_lib/blueprint", "Content gate currently exercises the shared deterministic form builder pending extraction."],
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  }));
  return nested.flat();
}

function normalized(file: string) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function isNodeImport(specifier: string) {
  return specifier.startsWith("node:") || ["fs", "path", "crypto", "child_process", "os", "net", "tls"].includes(specifier);
}

function boundaryRule(file: string, specifier: string, source: string): string | null {
  if (file.startsWith("src/lib/") && (specifier.startsWith("@/app/") || specifier.startsWith("@/components/"))) {
    return "library-must-not-depend-on-app-or-ui";
  }
  if (file.startsWith("src/app/api/") && specifier.startsWith("@/components/")) {
    return "api-must-not-depend-on-ui";
  }
  if (file.startsWith("src/components/") && specifier.startsWith("@/app/api/")) {
    return "ui-must-not-depend-on-api-implementation";
  }
  if (file.startsWith("src/components/") && (
    specifier.startsWith("@/lib/db") ||
    specifier === "@/lib/auth" ||
    specifier.startsWith("@/lib/security/credential-vault") ||
    specifier === "pg"
  )) return "ui-must-not-import-server-data-or-secret-boundary";
  if (file.startsWith("src/lib/domain/") && (
    specifier.startsWith("@/lib/db") ||
    specifier.startsWith("@/lib/ai") ||
    specifier.startsWith("@/lib/http") ||
    specifier.startsWith("@/app/") ||
    specifier.startsWith("@/components/")
  )) return "deterministic-domain-must-remain-infrastructure-free";
  if (source.startsWith('"use client"') || source.startsWith("'use client'")) {
    if (isNodeImport(specifier) || specifier.startsWith("@/lib/db") || specifier === "@/lib/auth") {
      return "client-module-must-not-import-server-runtime";
    }
  }
  return null;
}

async function main() {
  const files = (await sourceFiles(sourceRoot)).sort();
  const violations: Violation[] = [];
  const usedExceptions: Exception[] = [];
  let importCount = 0;
  for (const absolute of files) {
    const file = normalized(absolute);
    const source = await readFile(absolute, "utf8");
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const specifier = imported.fileName;
      importCount += 1;
      const rule = boundaryRule(file, specifier, source);
      if (!rule) continue;
      const reason = exactExceptions.get(`${file}\0${specifier}`);
      if (reason) usedExceptions.push({ file, import: specifier, reason });
      else violations.push({ file, import: specifier, rule });
    }
  }
  const staleExceptions = [...exactExceptions.entries()]
    .filter(([key]) => !usedExceptions.some((entry) => `${entry.file}\0${entry.import}` === key))
    .map(([key, reason]) => {
      const [file, specifier] = key.split("\0");
      return { file, import: specifier, reason };
    });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: "TypeScript architectural import boundaries",
    filesChecked: files.length,
    importsChecked: importCount,
    violations,
    documentedExceptions: usedExceptions,
    staleExceptions,
    passed: violations.length === 0 && staleExceptions.length === 0,
  };
  const evidenceDirectory = path.join(root, "docs", "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, "architecture-import-boundaries-2026-07-12.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Import boundaries: ${files.length} files, ${importCount} imports, ${usedExceptions.length} documented exceptions, ${violations.length} violations, ${staleExceptions.length} stale exceptions.`);
  if (!report.passed) {
    for (const issue of violations) console.error(`${issue.file}: ${issue.rule}: ${issue.import}`);
    for (const issue of staleExceptions) console.error(`${issue.file}: stale documented exception: ${issue.import}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
