import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(?:^|\/)__tests__(?:\/|$)|\.(?:test|spec)\.[^/]+$/;

function productionSourceFiles(root: string, workspaceRoot: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    const absolute = path.join(root, entry);
    const relative = path.relative(workspaceRoot, absolute).replaceAll("\\", "/");
    if (relative === "public/monaco" || relative.startsWith("public/monaco/")) return [];
    if (TEST_FILE.test(relative)) return [];
    return statSync(absolute).isDirectory()
      ? productionSourceFiles(absolute, workspaceRoot)
      : SOURCE_EXTENSION.test(entry) ? [absolute] : [];
  });
}

function expectProductionSourceNotToMatch(
  files: readonly string[],
  workspaceRoot: string,
  pattern: RegExp,
  boundary: string,
) {
  const offender = files.find((file) => pattern.test(readFileSync(file, "utf8")));
  expect(
    offender ? path.relative(workspaceRoot, offender).replaceAll("\\", "/") : undefined,
    boundary,
  ).toBeUndefined();
}

describe("page-context browser-durability boundary", () => {
  it("does not add a PWA shell, install surface, background delivery, or authenticated Cache API", () => {
    const root = process.cwd();
    for (const relative of [
      "public/manifest.json",
      "public/manifest.webmanifest",
      "public/sw.js",
      "public/service-worker.js",
      "src/app/manifest.ts",
      "src/app/manifest.webmanifest",
    ]) expect(existsSync(path.join(root, relative)), relative).toBe(false);

    const productionSource = productionSourceFiles(path.join(root, "src"), root)
      .concat(productionSourceFiles(path.join(root, "public"), root));
    const boundaries: ReadonlyArray<readonly [RegExp, string]> = [
      [/\bnavigator\s*\.\s*serviceWorker\b/i, "navigator.serviceWorker must remain absent"],
      [/\bserviceWorker\s*\.\s*register\s*\(/i, "service-worker registration must remain absent"],
      [/rel\s*=\s*["']manifest["']/i, "manifest link surfaces must remain absent"],
      [/\bbeforeinstallprompt\b|\bappinstalled\b|navigator\s*\.\s*standalone\b/i, "install prompts must remain absent"],
      [/\bSyncManager\b|\.\s*sync\s*\.\s*register\s*\(|background\s*[- ]\s*sync/i, "background sync must remain absent"],
      [/\bCacheStorage\b|\b(?:globalThis\s*\.\s*)?caches\s*\.\s*(?:open|match|has|delete|keys)\s*\(/i, "authenticated Cache API use must remain absent"],
    ];
    for (const [pattern, boundary] of boundaries) {
      expectProductionSourceNotToMatch(productionSource, root, pattern, boundary);
    }

    const packageJson = readFileSync(path.join(root, "package.json"), "utf8");
    expect(packageJson).not.toMatch(/\bworkbox\b|\bnext-pwa\b/i);
  });
});