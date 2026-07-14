import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    const absolute = path.join(root, entry);
    return statSync(absolute).isDirectory()
      ? sourceFiles(absolute)
      : /\.(?:ts|tsx|js|jsx)$/.test(entry) ? [absolute] : [];
  });
}

describe("non-installable warm-session draft boundary", () => {
  it("does not register a service worker, manifest, workbox, or install surface", () => {
    const root = process.cwd();
    for (const relative of [
      "public/manifest.json",
      "public/manifest.webmanifest",
      "public/sw.js",
      "public/service-worker.js",
      "src/app/manifest.ts",
      "src/app/manifest.webmanifest",
    ]) expect(existsSync(path.join(root, relative)), relative).toBe(false);

    const applicationSource = sourceFiles(path.join(root, "src", "app"))
      .concat(sourceFiles(path.join(root, "src", "components")))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(applicationSource).not.toContain("serviceWorker.register");
    expect(applicationSource).not.toMatch(/rel=["']manifest["']/i);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).not.toMatch(/workbox|next-pwa/i);
  });
});
