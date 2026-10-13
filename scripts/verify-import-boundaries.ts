import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { createImportResolver, runtimeImports } from "./lib/import-analysis";
import { verifyRuntimeDependencies } from "./lib/runtime-dependencies";

import { verifyOrApplyDeterministicEvidence } from "./lib/deterministic-evidence";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

type Violation = { readonly file: string; readonly import: string; readonly rule: string; readonly chain?: readonly string[] };
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
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

const resolveImport = createImportResolver(root);

function isModulePath(target: string, module: string) {
  return target === module || target.startsWith(`${module}/`)
    || (target.startsWith(module) && /^\.[cm]?[jt]sx?$/.test(target.slice(module.length)));
}

function hasClientDirective(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function isServerRuntime(target: string) {
  return isNodeImport(target) || target === "pg" || target === "server-only"
    || isModulePath(target, "src/lib/db") || isModulePath(target, "src/lib/auth")
    || isModulePath(target, "src/lib/security/credential-vault");
}

function boundaryRule(file: string, target: string, client: boolean): string | null {
  if (file.startsWith("src/lib/") && (target.startsWith("src/app/") || target.startsWith("src/components/"))) {
    return "library-must-not-depend-on-app-or-ui";
  }
  if (file.startsWith("src/app/api/") && target.startsWith("src/components/")) {
    return "api-must-not-depend-on-ui";
  }
  if (file.startsWith("src/components/") && target.startsWith("src/app/api/")) {
    return "ui-must-not-depend-on-api-implementation";
  }
  if (file.startsWith("src/components/") && (
    isModulePath(target, "src/lib/db") ||
    isModulePath(target, "src/lib/auth") ||
    isModulePath(target, "src/lib/security/credential-vault") ||
    target === "pg"
  )) return "ui-must-not-import-server-data-or-secret-boundary";
  if (file.startsWith("src/lib/domain/") && (
    isModulePath(target, "src/lib/db") ||
    isModulePath(target, "src/lib/ai") ||
    isModulePath(target, "src/lib/http") ||
    target.startsWith("src/app/") ||
    target.startsWith("src/components/")
  )) return "deterministic-domain-must-remain-infrastructure-free";
  if (client) {
    if (isServerRuntime(target)) {
      return "client-module-must-not-import-server-runtime";
    }
  }
  return null;
}

async function main() {
  const runtime = await verifyRuntimeDependencies(root);
  for (const issue of runtime.violations) console.error(`${issue.chain.join(" -> ")} (${issue.kind})`);
  if (runtime.violations.length > 0) process.exitCode = 1;
  console.log(`Runtime dependencies: ${runtime.entries.length} entries, ${runtime.files} reachable files, ${runtime.violations.length} violations.`);
  const files = (await sourceFiles(sourceRoot)).sort();
  const violations: Violation[] = [];
  const usedExceptions: Exception[] = [];
  const modules = new Map<string, { client: boolean; imports: { specifier: string; target: string; runtime: boolean }[] }>();
  const canonicalExceptions = new Map([...exactExceptions.entries()].map(([key, reason]) => {
    const [file, specifier] = key.split("\0");
    return [`${file}\0${resolveImport(file, specifier)}`, reason];
  }));
  let importCount = 0;
  for (const absolute of files) {
    const file = normalized(absolute);
    const source = await readFile(absolute, "utf8");
    const syntax = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
    const client = hasClientDirective(syntax);
    const runtime = runtimeImports(syntax);
    const imports = ts.preProcessFile(source, true, true).importedFiles.map((imported) => ({
      specifier: imported.fileName,
      target: resolveImport(file, imported.fileName),
      runtime: runtime.has(imported.fileName),
    }));
    modules.set(file, { client, imports });
    for (const { specifier, target } of imports) {
      importCount += 1;
      const rule = boundaryRule(file, target, client);
      if (!rule) continue;
      const reason = canonicalExceptions.get(`${file}\0${target}`);
      if (reason) usedExceptions.push({ file, import: specifier, reason });
      else violations.push({ file, import: specifier, rule });
    }
  }
  for (const [entry, module] of modules) {
    if (!module.client) continue;
    const visited = new Set<string>();
    async function walk(file: string, chain: readonly string[]): Promise<void> {
      if (visited.has(file)) return;
      visited.add(file);
      // Resolved local dependencies may be JavaScript or live outside src.
      // Follow them too, without scanning unrelated repository files.
      if (!modules.has(file) && !file.startsWith("../") && /\.(?:[cm]?[jt]sx?)$/.test(file) && ts.sys.fileExists(path.join(root, file))) {
        const source = await readFile(path.join(root, file), "utf8");
        const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        modules.set(file, {
          client: hasClientDirective(syntax),
          imports: [...runtimeImports(syntax)].map((specifier) => ({
            specifier, target: resolveImport(file, specifier), runtime: true,
          })),
        });
      }
      for (const imported of modules.get(file)?.imports ?? []) {
        if (!imported.runtime) continue;
        const nextChain = [...chain, imported.target];
        if (isServerRuntime(imported.target)) {
          // Direct imports already have a diagnostic from the architectural rules.
          if (file !== entry) violations.push({
            file: entry, import: imported.specifier, rule: "client-module-must-not-import-server-runtime", chain: nextChain,
          });
        } else {
          await walk(imported.target, nextChain);
        }
      }
    }
    await walk(entry, [entry]);
  }
  const staleExceptions = [...exactExceptions.entries()]
    .filter(([key]) => {
      const [file, specifier] = key.split("\0");
      return !usedExceptions.some((entry) => entry.file === file
        && resolveImport(entry.file, entry.import) === resolveImport(file, specifier));
    })
    .map(([key, reason]) => {
      const [file, specifier] = key.split("\0");
      return { file, import: specifier, reason };
    });
  const passed = violations.length === 0 && staleExceptions.length === 0;
  const buildEvidence = () => ({
    schemaVersion: 1,
    scope: "TypeScript architectural import boundaries",
    violations,
    documentedExceptions: usedExceptions,
    staleExceptions,
    passed,
  });
  console.log(`Import boundaries: ${files.length} files, ${importCount} imports, ${usedExceptions.length} documented exceptions, ${violations.length} violations, ${staleExceptions.length} stale exceptions.`);
  if (!passed) {
    for (const issue of violations) console.error(`${issue.file}: ${issue.rule}: ${issue.import}${issue.chain ? ` (${issue.chain.join(" -> ")})` : ""}`);
    for (const issue of staleExceptions) console.error(`${issue.file}: stale documented exception: ${issue.import}`);
    process.exitCode = 1;
  }
  await verifyOrApplyDeterministicEvidence({
    argv: process.argv.slice(2),
    root,
    trustedDirectory: "exclusive-writer",
    relativePath: path.join("docs", "evidence", "architecture-import-boundaries-2026-07-12.json"),
    buildEvidence,
    applyCommand: "npm run architecture:apply",
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
