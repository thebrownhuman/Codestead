import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { assertSupportedMonacoAmdVersion } from "../src/lib/editor/monaco-assets-policy";

async function main() {
  const workspaceRoot = resolve(process.cwd());
  const source = resolve(workspaceRoot, "node_modules", "monaco-editor", "min", "vs");
  const publicRoot = resolve(workspaceRoot, "public", "monaco");
  const target = resolve(publicRoot, "vs");
  const marker = resolve(publicRoot, ".version");

  const relativeTarget = relative(publicRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error("Refusing to synchronize Monaco outside public/monaco/vs.");
  }

  const packageMetadata = JSON.parse(
    await readFile(resolve(workspaceRoot, "node_modules", "monaco-editor", "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageMetadata.version !== "string" || !packageMetadata.version) {
    throw new Error("The installed Monaco package does not expose a valid version.");
  }
  assertSupportedMonacoAmdVersion(packageMetadata.version);

  try {
    const [currentVersion] = await Promise.all([
      readFile(marker, "utf8"),
      access(resolve(target, "loader.js")),
    ]);
    if (currentVersion.trim() === packageMetadata.version) {
      console.log(`Monaco ${packageMetadata.version} browser assets are current.`);
      return;
    }
  } catch {
    // Missing or stale generated assets are replaced below.
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  await writeFile(marker, `${packageMetadata.version}\n`, "utf8");
  console.log(`Synchronized Monaco ${packageMetadata.version} to public/monaco/vs.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
