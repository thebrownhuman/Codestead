import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const reviewedBundle = path.join(
  repositoryRoot,
  "infra/runtime/production-load-fixture-runtime.mjs",
);

test("disposable fixture bundle exactly matches its current source graph", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codestead-fixture-bundle-"));
  const candidates = ["candidate-a.mjs", "candidate-b.mjs"].map((name) =>
    path.join(temporary, name));
  try {
    const buildCandidate = (outfile) => build({
      absWorkingDir: repositoryRoot,
      entryPoints: ["scripts/start-production-load-fixture-runtime.ts"],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "bundle",
      charset: "ascii",
      legalComments: "none",
      sourcemap: false,
      minify: false,
      treeShaking: true,
      logLevel: "silent",
    });
    await Promise.all(candidates.map(buildCandidate));
    const [expected, first, second] = await Promise.all([
      readFile(reviewedBundle),
      ...candidates.map((candidate) => readFile(candidate)),
    ]);
    assert.ok(expected.byteLength >= 1_024 && expected.byteLength <= 1024 * 1024);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, first);
    assert.doesNotMatch(expected.toString("utf8"), /sourceMappingURL=|node_modules[\\/]+tsx/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
