import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPLICATION_IMAGE_TARGETS,
  createApplicationBuildPlan,
  validateApplicationSourceBinding,
  validateApplicationTrackedBuildInputs,
} from "./application-image-operations.mjs";

const repository = "https://github.com/thebrownhuman/Codestead";
const revision = "a".repeat(40);
const tree = "b".repeat(40);
const contextSha256 = "c".repeat(64);

function sourceBinding(overrides = {}) {
  return validateApplicationSourceBinding({
    actualRepository: repository,
    actualRevision: revision,
    actualTree: tree,
    contextSha256,
    declaredRepositories: [repository],
    declaredRevisions: [revision],
    ...overrides,
  });
}

test("declared application source must equal independently derived origin, HEAD, tree, and archive", () => {
  assert.deepEqual(sourceBinding(), {
    repository,
    revision,
    tree,
    contextSha256,
  });
  assert.throws(() => sourceBinding({
    declaredRepositories: ["https://github.com/attacker/repository"],
  }), /declared.*repository.*origin/i);
  assert.throws(() => sourceBinding({
    declaredRevisions: ["d".repeat(40)],
  }), /declared.*revision.*HEAD/i);
  assert.throws(() => sourceBinding({ actualTree: "not-a-tree" }), /tree/i);
  assert.throws(() => sourceBinding({ contextSha256: "not-a-digest" }), /context/i);
  assert.throws(() => sourceBinding({
    declaredRepositories: [repository, `${repository}/other`],
  }), /declared.*repository.*origin/i);
});

test("the exact tracked archive rejects generated canaries and feeds all seven targets by stdin", () => {
  assert.deepEqual(
    validateApplicationTrackedBuildInputs([
      ".dockerignore",
      "Dockerfile",
      "package.json",
      "src/app/page.tsx",
    ]),
    [".dockerignore", "Dockerfile", "package.json", "src/app/page.tsx"],
  );

  for (const canary of [
    "next-env.d.ts",
    "public/monaco/canary.js",
    "dist/application-images/canary.json",
    "uploads/canary.bin",
  ]) {
    assert.throws(
      () => validateApplicationTrackedBuildInputs(["Dockerfile", canary]),
      /generated.*build context/i,
    );
  }

  const plan = createApplicationBuildPlan({
    sourceDateEpoch: "1760000000",
    sourceRepository: repository,
    sourceRevision: revision,
    sourceTree: tree,
    sourceContextSha256: contextSha256,
    registry: "ghcr.io/thebrownhuman/codestead",
    release: "reviewed-20260719",
    local: true,
  });
  assert.deepEqual(
    plan.map(({ target }) => target),
    APPLICATION_IMAGE_TARGETS.map(({ target }) => target),
  );
  for (const item of plan) {
    assert.equal(item.args.at(-1), "-", `${item.target} must consume the exact Git archive`);
    assert.ok(item.args.includes(`SOURCE_TREE=${tree}`));
    assert.ok(item.args.includes(`SOURCE_CONTEXT_SHA256=${contextSha256}`));
  }

  const dockerignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");
  for (const required of ["/next-env.d.ts", "/public/monaco", "/dist", "/uploads"]) {
    assert.ok(dockerignore.split(/\r?\n/).includes(required));
  }

  const manager = readFileSync(new URL("./manage-application-images.mjs", import.meta.url), "utf8");
  assert.match(manager, /git["'], \["archive", "--format=tar"/);
  assert.match(manager, /input:\s*context\.buildArchive/);

  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG SOURCE_TREE$/m);
  assert.match(dockerfile, /^ARG SOURCE_CONTEXT_SHA256$/m);
  assert.match(dockerfile, /io\.codestead\.application\.source-tree=/);
  assert.match(dockerfile, /io\.codestead\.application\.build-context-sha256=/);
});

test("direct Docker contexts exclude root-local tooling and scratch artifacts", () => {
  const dockerignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");
  const rules = dockerignore.split(/\r?\n/);

  for (const required of ["/.superpowers", "/.codex-*"]) {
    assert.ok(
      rules.includes(required),
      `${required} must be excluded at the repository root before COPY . .`,
    );
  }
});
