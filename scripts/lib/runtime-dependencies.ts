import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { createImportResolver, runtimeImports } from "./import-analysis";

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
type RuntimeViolation = {
  file: string;
  import: string;
  package: string;
  kind: "devDependency" | "undeclared dependency";
  chain: string[];
};

const sourceExtension = /\.[cm]?[jt]sx?$/;
const excluded = /(?:^|\/)(?:__tests__|integration|e2e|node_modules)(?:\/|$)|\.(?:test|spec|config)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

export function packageName(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

async function optionalText(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Production roots come from deployment inputs, never every authoring script. */
export async function productionEntries(root: string, manifest: Manifest): Promise<string[]> {
  const entries = new Set<string>();
  async function collect(directory: string) {
    if (!ts.sys.directoryExists(path.join(root, directory))) return;
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (excluded.test(file)) continue;
      if (entry.isDirectory()) await collect(file);
      else if (sourceExtension.test(file)) entries.add(file);
    }
  }
  await collect("src/app");
  for (const file of ["src/instrumentation.ts", "src/instrumentation-client.ts", "src/proxy.ts", "services/runner/src/index.ts"]) {
    if (ts.sys.fileExists(path.join(root, file))) entries.add(file);
  }
  // Include packaged operations and health scripts as well as CMD/command roots.
  // COPY paths cover tooling invoked by operators and child processes that are
  // not represented by a static JavaScript import.
  for (const file of ["Dockerfile", "compose.yaml"]) {
    const contents = await optionalText(path.join(root, file)) ?? "";
    for (const line of contents.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      for (const match of line.matchAll(/(?:\/app\/)?((?:scripts|infra\/runner-gateway)\/[\w./-]+\.[cm]?[jt]sx?)/g)) entries.add(match[1]);
      for (const match of line.matchAll(/(?:\/app\/)?(src\/[\w./-]+\.mjs)/g)) entries.add(match[1]);
    }
  }
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!name.startsWith("worker:")) continue;
    for (const match of command.matchAll(/scripts\/[\w./-]+\.[cm]?[jt]sx?/g)) entries.add(match[0]);
  }
  return [...entries].filter((file) => !excluded.test(file)).sort();
}

export async function verifyRuntimeDependencies(root: string) {
  const manifestSource = await optionalText(path.join(root, "package.json"));
  const manifest: Manifest = manifestSource ? JSON.parse(manifestSource) : {};
  const entries = await productionEntries(root, manifest);
  const runnerSource = await optionalText(path.join(root, "services/runner/package.json"));
  const runner: Manifest = runnerSource ? JSON.parse(runnerSource) : {};
  const resolve = createImportResolver(root);
  const visited = new Set<string>();
  const violations: RuntimeViolation[] = [];
  async function walk(file: string, chain: string[]): Promise<void> {
    if (visited.has(file) || excluded.test(file)) return;
    if (file.startsWith("../") || path.isAbsolute(file)) throw new Error(`Runtime import escapes repository: ${chain.join(" -> ")}`);
    visited.add(file);
    const source = await readFile(path.join(root, file), "utf8");
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const specifier of runtimeImports(syntax)) {
      if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
      if (specifier.startsWith(".") || specifier.startsWith("@/") || path.isAbsolute(specifier)) {
        const target = resolve(file, specifier);
        if (sourceExtension.test(target)) await walk(target, [...chain, target]);
        continue;
      }
      const name = packageName(specifier);
      const owner = file.startsWith("services/runner/") ? runner : manifest;
      if (Object.hasOwn(owner.dependencies ?? {}, name)) continue;
      violations.push({ file, import: specifier, package: name,
        kind: Object.hasOwn(owner.devDependencies ?? {}, name) ? "devDependency" : "undeclared dependency",
        chain: [...chain, specifier],
      });
    }
  }
  for (const entry of entries) await walk(entry, [entry]);
  return { entries, files: visited.size, violations };
}
