import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageName, productionEntries, verifyRuntimeDependencies } from "./runtime-dependencies";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-dependencies-")); roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  return root;
}

describe("production dependency traversal", () => {
  it("normalizes scoped and unscoped package subpaths", () => {
    expect(packageName("@scope/package/deep")).toBe("@scope/package");
    expect(packageName("package/deep")).toBe("package");
  });

  it("discovers deployment and worker roots and excludes authoring/test inputs", async () => {
    const root = await fixture({
      "src/app/nested/page.tsx": "export {};", "src/app/asset.css": "",
      "src/app/__tests__/test.ts": "", "src/app/page.test.ts": "", "src/app/build.config.ts": "",
      "src/app/types.d.ts": "", "src/instrumentation.ts": "", "src/instrumentation-client.ts": "",
      "src/proxy.ts": "", "services/runner/src/index.ts": "",
      "Dockerfile": "# COPY scripts/ignored.ts ./\nCOPY scripts/ops.ts ./\nCOPY src/task.mjs ./",
      "compose.yaml": 'command: ["node", "/app/infra/runner-gateway/entry.mjs"]',
    });
    expect(await productionEntries(root, { scripts: {
      "worker:task": "tsx scripts/task.ts", build: "tsx scripts/build.ts", "worker:test": "tsx scripts/task.test.ts",
    } })).toEqual([
      "infra/runner-gateway/entry.mjs", "scripts/ops.ts", "scripts/task.ts", "services/runner/src/index.ts",
      "src/app/nested/page.tsx", "src/instrumentation-client.ts", "src/instrumentation.ts", "src/proxy.ts", "src/task.mjs",
    ]);
  });

  it("follows cycles once and reports exact transitive dev and undeclared dependencies", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { zod: "1" }, devDependencies: { typescript: "1" } }),
      "src/app/page.ts": 'import "@/lib/helper"; import "node:fs"; import "fs/promises"; import "zod/subpath";',
      "src/lib/helper.ts": 'import "../app/page"; export * from "./nested"; import "./styles.css";',
      "src/lib/nested.ts": 'import type { T } from "erased"; require("typescript"); import("missing/subpath");',
    });
    const result = await verifyRuntimeDependencies(root);
    expect(result.files).toBe(3);
    expect(result.violations).toEqual([
      { file: "src/lib/nested.ts", import: "typescript", package: "typescript", kind: "devDependency",
        chain: ["src/app/page.ts", "src/lib/helper.ts", "src/lib/nested.ts", "typescript"] },
      { file: "src/lib/nested.ts", import: "missing/subpath", package: "missing", kind: "undeclared dependency",
        chain: ["src/app/page.ts", "src/lib/helper.ts", "src/lib/nested.ts", "missing/subpath"] },
    ]);
  });

  it("checks runner dependencies against its own manifest", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { typescript: "1" } }),
      "services/runner/package.json": JSON.stringify({ dependencies: { ajv: "1" }, devDependencies: { typescript: "1" } }),
      "services/runner/src/index.ts": 'import "ajv/dist/core"; import "typescript";',
    });
    expect((await verifyRuntimeDependencies(root)).violations).toEqual([
      { file: "services/runner/src/index.ts", import: "typescript", package: "typescript", kind: "devDependency",
        chain: ["services/runner/src/index.ts", "typescript"] },
    ]);
  });

  it("handles absent manifests and empty repositories without suppressing missing source errors", async () => {
    const root = await fixture({});
    expect(await verifyRuntimeDependencies(root)).toEqual({ entries: [], files: 0, violations: [] });
    await mkdir(path.join(root, "src/app"), { recursive: true });
    await writeFile(path.join(root, "src/app/page.ts"), 'import "missing";');
    expect((await verifyRuntimeDependencies(root)).violations[0].kind).toBe("undeclared dependency");
    await writeFile(path.join(root, "Dockerfile"), "COPY scripts/missing.ts ./");
    await expect(verifyRuntimeDependencies(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates malformed/unreadable manifest errors", async () => {
    const root = await fixture({ "package.json": "{" });
    await expect(verifyRuntimeDependencies(root)).rejects.toBeInstanceOf(SyntaxError);
    await rm(path.join(root, "package.json"));
    await mkdir(path.join(root, "package.json"));
    await expect(verifyRuntimeDependencies(root)).rejects.toBeDefined();
  });

  it("rejects imports escaping the repository", async () => {
    const root = await fixture({ "src/app/page.ts": 'import "../../../outside.ts";' });
    await expect(verifyRuntimeDependencies(root)).rejects.toThrow("Runtime import escapes repository");
  });

  it("allows a production dependency also present in devDependencies and skips test dependencies", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { tool: "1" }, devDependencies: { tool: "1" } }),
      "src/app/page.ts": 'import "tool"; import "../lib/helper.test";',
      "src/lib/helper.test.ts": 'import "missing";',
    });
    expect((await verifyRuntimeDependencies(root)).violations).toEqual([]);
  });
});
