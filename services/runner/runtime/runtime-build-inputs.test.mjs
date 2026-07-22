import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateRuntimeCoordinates } from "./runtime-operations.mjs";

function readEnvironment(text) {
  return Object.fromEntries(text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

test("Dockerfile syntax frontend is immutable, recorded, and runtime context is deny-by-default", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
  const environment = readEnvironment(readFileSync(new URL("./images.env", import.meta.url), "utf8"));
  const dockerignore = readFileSync(new URL("./.dockerignore", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter(Boolean);

  assert.match(dockerfile.split(/\r?\n/, 1)[0], /^# syntax=docker\/dockerfile:1\.7@sha256:[a-f0-9]{64}$/);
  assert.equal(dockerfile.split(/\r?\n/, 1)[0].slice("# syntax=".length), environment.DOCKERFILE_FRONTEND);
  assert.deepEqual(dockerignore, ["**", "!Dockerfile", "!harness.c"]);
  assert.doesNotMatch(dockerfile, /SOURCE_REPOSITORY/);
  assert.doesNotMatch(dockerfile, /org\.opencontainers\.image\.source=/);
  assert.doesNotMatch(dockerfile, /SOURCE_REVISION/);
  assert.doesNotMatch(dockerfile, /org\.opencontainers\.image\.revision=/);
  assert.doesNotMatch(dockerfile, /\$\{SOURCE_REVISION\}/);
});

test("runtime repository and release coordinates reject tags, digests, traversal, and mutable release names", () => {
  assert.deepEqual(validateRuntimeCoordinates({
    repository: "ghcr.io/thebrownhuman/codestead-runtime",
    release: "2026.07.19-1",
  }), {
    repository: "ghcr.io/thebrownhuman/codestead-runtime",
    release: "2026.07.19-1",
  });
  assert.deepEqual(validateRuntimeCoordinates({ repository: "learncoding/runtime", release: "local" }), {
    repository: "learncoding/runtime",
    release: "local",
  });
  for (const repository of [
    "learncoding/runtime:latest",
    "learncoding/runtime@sha256:" + "a".repeat(64),
    "../runtime",
    "UPPER/runtime",
    "learncoding//runtime",
    " learncoding/runtime",
  ]) {
    assert.throws(() => validateRuntimeCoordinates({ repository, release: "2026.07.19-1" }), /repository/i);
  }
  for (const release of ["latest", "stable", "release/tag", "release:tag", "release@digest", " release", ""] ) {
    assert.throws(() => validateRuntimeCoordinates({ repository: "learncoding/runtime", release }), /release/i);
  }
});
