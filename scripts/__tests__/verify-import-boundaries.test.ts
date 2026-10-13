import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repository = process.cwd();
const evidencePath = "docs/evidence/architecture-import-boundaries-2026-07-12.json";
type Issue = { file: string; import: string; rule: string; chain?: string[] };

async function inspect(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codestead-import-boundaries-"));
  try {
    const existing = JSON.parse(await readFile(path.join(repository, evidencePath), "utf8")) as {
      documentedExceptions: { file: string; import: string }[];
    };
    const sources: Record<string, string> = {};
    for (const exception of existing.documentedExceptions) {
      sources[exception.file] = (sources[exception.file] ?? "") + `import ${JSON.stringify(exception.import)};\n`;
      sources[`${exception.import.replace("@/", "src/")}.ts`] ??= "export {};\n";
    }
    await mkdir(path.join(root, "docs/evidence"), { recursive: true });
    for (const [file, source] of Object.entries({ ...sources, ...files })) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    const run = spawnSync(process.execPath, [
      path.join(repository, "node_modules/tsx/dist/cli.mjs"),
      path.join(repository, "scripts/verify-import-boundaries.ts"), "--apply",
    ], { cwd: root, encoding: "utf8", timeout: 20_000 });
    if (run.error) throw run.error;
    const evidence = JSON.parse(await readFile(path.join(root, evidencePath), "utf8")) as {
      violations: Issue[]; documentedExceptions: unknown[]; staleExceptions: unknown[]; passed: boolean;
    };
    return { ...evidence, status: run.status, stderr: run.stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("import boundary checker", () => {
  it("rejects a relative database import from a client module", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport { db } from "../db/client";',
      "src/lib/db/client.ts": "export const db = 1;",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", import: "../db/client", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });

  it("detects the client directive after leading comments and whitespace", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '\n/* license */\n// client entry\n"use client";\nimport { db } from "@/lib/db/client";',
      "src/lib/db/client.ts": "export const db = 1;",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });

  it("reports a transitive server import with its full chain", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport { helper } from "./helper";',
      "src/lib/browser/helper.ts": 'import fs from "node:fs";\nexport const helper = fs;',
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
      chain: ["src/lib/browser/entry.ts", "src/lib/browser/helper.ts", "node:fs"],
    }));
    expect(result.stderr).toContain("src/lib/browser/entry.ts -> src/lib/browser/helper.ts -> node:fs");
    expect(result.status).toBe(1);
  });

  it("preserves all ten documented exceptions", async () => {
    const result = await inspect({});
    expect(result.documentedExceptions).toHaveLength(10);
    expect(result.staleExceptions).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe(0);
  });

  it("resolves alias and relative index imports across a cycle", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport "@/lib/browser/helpers";',
      "src/lib/browser/helpers/index.ts": 'import "../entry";\nexport { db } from "../../db";',
      "src/lib/db/index.ts": "export const db = 1;",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      chain: ["src/lib/browser/entry.ts", "src/lib/browser/helpers/index.ts", "src/lib/db/index.ts"],
    }));
    expect(result.status).toBe(1);
  });

  it("does not treat a directive after an ordinary statement as a client entry", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": 'const value = 1;\n"use client";\nimport fs from "node:fs";\nexport { value, fs };',
    });
    expect(result.violations).toEqual([]);
    expect(result.status).toBe(0);
  });

  it("follows JavaScript dependencies outside src and catches bare Node subpaths", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport "../../../shared/helper.mjs";',
      "shared/helper.mjs": 'export { readFile } from "fs/promises";',
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      chain: ["src/lib/browser/entry.ts", "shared/helper.mjs", "fs/promises"],
    }));
    expect(result.status).toBe(1);
  });

  it("detects a client directive in the directive prologue", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use strict";\n"use client";\nimport fs from "node:fs";',
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });

  it("does not traverse an erased type-only dependency", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport type { Helper } from "./helper";',
      "src/lib/browser/helper.ts": 'import fs from "node:fs";\nexport type Helper = typeof fs;',
    });
    expect(result.violations).toEqual([]);
    expect(result.status).toBe(0);
  });

  it("recognizes an auth directory index as a server boundary", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport "../auth";',
      "src/lib/auth/index.ts": "export {};",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });
});


describe("runtime dependency guard", () => {
  const manifest = JSON.stringify({ dependencies: { zod: "1" }, devDependencies: { typescript: "1", "@scope/tool": "1" } });
  it("rejects a production entry importing a devDependency with its chain", async () => {
    const result = await inspect({ "package.json": manifest, "src/app/page.ts": 'import ts from "typescript";' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/app/page.ts -> typescript (devDependency)");
  });
  it("allows erased type imports and unrelated test/build imports", async () => {
    const result = await inspect({ "package.json": manifest,
      "src/app/page.ts": 'import type { Node } from "typescript"; export { type Node } from "typescript";',
      "src/lib/__tests__/helper.test.ts": 'import ts from "typescript";',
      "scripts/build-helper.ts": 'import ts from "typescript";',
    });
    expect(result.status).toBe(0);
  });
  it("rejects a transitive runtime import through an alias and relative re-export", async () => {
    const result = await inspect({ "package.json": manifest,
      "src/app/page.ts": 'import "@/lib/entry";',
      "src/lib/entry.ts": 'export * from "./helper";',
      "src/lib/helper.ts": 'const ts = require("typescript");',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/app/page.ts -> src/lib/entry.ts -> src/lib/helper.ts -> typescript (devDependency)");
  });
  it("normalizes scoped packages and package subpaths", async () => {
    const result = await inspect({ "package.json": manifest,
      "src/app/page.ts": 'import "@scope/tool/subpath"; import("typescript/lib/typescript.js"); import "zod/subpath"; import "fs/promises";',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@scope/tool/subpath (devDependency)");
    expect(result.stderr).toContain("typescript/lib/typescript.js (devDependency)");
    expect(result.stderr).not.toContain("zod/subpath (");
    expect(result.stderr).not.toContain("fs/promises (");
  });
  it("discovers worker entries from package scripts and deployment inputs", async () => {
    const result = await inspect({
      "package.json": JSON.stringify({ devDependencies: { typescript: "1" }, scripts: { "worker:sample": "tsx scripts/worker.ts" } }),
      "Dockerfile": 'COPY scripts/docker-worker.ts ./scripts/docker-worker.ts',
      "compose.yaml": 'command: ["node", "/app/scripts/compose-worker.mjs"]',
      "scripts/worker.ts": 'import "typescript";',
      "scripts/docker-worker.ts": 'import "typescript";',
      "scripts/compose-worker.mjs": 'import "typescript";',
    });
    expect(result.status).toBe(1);
    for (const entry of ["worker.ts", "docker-worker.ts", "compose-worker.mjs"]) {
      expect(result.stderr).toContain(`scripts/${entry} -> typescript (devDependency)`);
    }
  });
  it("uses the runner manifest instead of root production dependencies", async () => {
    const result = await inspect({
      "package.json": JSON.stringify({ dependencies: { typescript: "1" } }),
      "services/runner/package.json": JSON.stringify({ devDependencies: { typescript: "1" }, dependencies: { ajv: "1" } }),
      "services/runner/src/index.ts": 'import "./worker"; import "ajv/dist/core";',
      "services/runner/src/worker.ts": 'import "typescript";',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("services/runner/src/index.ts -> services/runner/src/worker.ts -> typescript (devDependency)");
    expect(result.stderr).not.toContain("ajv/dist/core (");
  });
  it("rejects undeclared packages while allowing a package in both dependency lists", async () => {
    const result = await inspect({
      "package.json": JSON.stringify({ dependencies: { typescript: "1" }, devDependencies: { typescript: "1" } }),
      "src/app/page.ts": 'import "typescript"; import "unknown-package/subpath";',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown-package/subpath (undeclared dependency)");
    expect(result.stderr).not.toContain("typescript (devDependency)");
  });
  it("ignores test and build configuration files in the app tree", async () => {
    const result = await inspect({ "package.json": manifest,
      "src/app/page.ts": 'export {};',
      "src/app/__tests__/page.test.ts": 'import "typescript";',
      "src/app/build.config.ts": 'import "typescript";',
    });
    expect(result.status).toBe(0);
  });

});
