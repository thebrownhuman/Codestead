import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createImportResolver, runtimeImports } from "./import-analysis";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("runtime import syntax", () => {
  it("retains executable imports while erasing type-only imports and exports", () => {
    const source = ts.createSourceFile("entry.ts", `
      import "side-effect";
      import value from "default";
      import * as ns from "namespace";
      import { type T, value as v } from "mixed";
      import {} from "empty";
      import type { T } from "types";
      import { type T } from "named-types";
      export * from "star";
      export { value } from "values";
      export { type T, value } from "mixed-export";
      export {} from "empty-export";
      export type { T } from "export-types";
      export { type T } from "named-export-types";
      import legacy = require("legacy");
      import type erased = require("erased");
      import internal = ns.member;
      require("required"); import("dynamic");
      require(variable); import(variable); require(); obj.require("method");
      export { value };
    `, ts.ScriptTarget.Latest, true);
    expect([...runtimeImports(source)].sort()).toEqual([
      "default", "dynamic", "empty", "empty-export", "legacy", "mixed", "mixed-export",
      "namespace", "required", "side-effect", "star", "values",
    ].sort());
  });

  it("resolves local aliases, JavaScript and directory indexes, preserving bare packages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "import-resolver-")); roots.push(root);
    await mkdir(path.join(root, "src/helpers"), { recursive: true });
    await writeFile(path.join(root, "src/helpers/index.ts"), "export {};");
    await writeFile(path.join(root, "src/helper.mjs"), "export {};");
    const resolve = createImportResolver(root);
    expect(resolve("src/entry.ts", "@/helpers")).toBe("src/helpers/index.ts");
    expect(resolve("src/entry.ts", "./helper.mjs")).toBe("src/helper.mjs");
    expect(resolve("src/entry.ts", "@/missing")).toBe("src/missing");
    expect(resolve("src/entry.ts", "../missing.ts")).toBe("missing.ts");
    expect(resolve("src/entry.ts", "unknown/subpath")).toBe("unknown/subpath");
  });
});
