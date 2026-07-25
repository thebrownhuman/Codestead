#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(
    new URL("../ops/mail-authority-recovery-baseline.json", import.meta.url),
    "utf8",
  ),
);

const runGit = (args, { allowStatusOne = false } = {}) => {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status === 0) {
    return {
      ok: true,
      stdout: result.stdout.trim(),
    };
  }
  if (allowStatusOne && result.status === 1) {
    return {
      ok: false,
      stdout: result.stdout.trim(),
    };
  }

  throw new Error(
    [
      `git ${args.join(" ")} failed with status ${String(result.status)}`,
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
};

const git = (...args) => runGit(args).stdout;
const isAncestor = (ancestor, descendant) =>
  runGit(["merge-base", "--is-ancestor", ancestor, descendant], {
    allowStatusOne: true,
  }).ok;
const lines = (value) =>
  value.length === 0 ? [] : value.split(/\r?\n/u).filter(Boolean);

const shaPattern = /^[0-9a-f]{40}$/u;
const treePattern = /^[0-9a-f]{40}$/u;
const allowedStatuses = new Set([
  "accepted-component",
  "wip",
  "reference-only",
  "rejected",
  "superseded",
]);
const plannedStatuses = new Set(["accepted-component", "wip"]);
const neverApplyStatuses = new Set(["rejected", "superseded"]);

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.scope, "mail-delivery-authority-and-retention");
assert.ok(Array.isArray(manifest.artifacts));
assert.ok(manifest.artifacts.length > 0);

const { contentBase, recoveryAnchor, allowedCurrentHeadDeltaPaths } =
  manifest.baseline;
for (const entry of [contentBase, recoveryAnchor]) {
  assert.match(entry.commit, shaPattern);
  assert.match(entry.tree, treePattern);
  assert.equal(git("rev-parse", `${entry.commit}^{tree}`), entry.tree);
  assert.equal(git("show", "-s", "--format=%s", entry.commit), entry.subject);
}

assert.equal(
  recoveryAnchor.tree,
  contentBase.tree,
  "recovery anchor must retain the exact coherent content-base tree",
);
assert.equal(
  git("diff", "--name-only", contentBase.commit, recoveryAnchor.commit),
  "",
  "recovery ancestry must not apply any candidate tree changes",
);
assert.ok(
  isAncestor(contentBase.commit, recoveryAnchor.commit),
  "content base must be the first-parent foundation of the recovery anchor",
);
assert.ok(
  isAncestor(recoveryAnchor.commit, "HEAD"),
  "current HEAD must retain the immutable recovery anchor",
);

const ids = new Set();
const commits = new Set();
for (const artifact of manifest.artifacts) {
  assert.ok(!ids.has(artifact.id), `duplicate artifact id: ${artifact.id}`);
  assert.ok(
    !commits.has(artifact.commit),
    `duplicate artifact commit: ${artifact.commit}`,
  );
  ids.add(artifact.id);
  commits.add(artifact.commit);

  assert.match(artifact.commit, shaPattern);
  assert.match(artifact.tree, treePattern);
  assert.ok(
    allowedStatuses.has(artifact.status),
    `unknown status for ${artifact.id}: ${artifact.status}`,
  );
  assert.equal(
    artifact.sourceTreeApplied,
    false,
    `${artifact.id} must remain recovery-only at this baseline`,
  );
  assert.equal(
    git("rev-parse", `${artifact.commit}^{tree}`),
    artifact.tree,
    `${artifact.id} tree drifted`,
  );
  assert.equal(
    git("show", "-s", "--format=%s", artifact.commit),
    artifact.subject,
    `${artifact.id} subject drifted`,
  );
  assert.ok(
    isAncestor(artifact.commit, recoveryAnchor.commit),
    `${artifact.id} is not recoverable from the recovery anchor`,
  );
  assert.ok(
    !isAncestor(artifact.commit, contentBase.commit),
    `${artifact.id} was unexpectedly applied to the coherent content base`,
  );

  if (neverApplyStatuses.has(artifact.status)) {
    assert.equal(
      artifact.integrationAction,
      "never-apply",
      `${artifact.id} must fail closed against integration`,
    );
  } else {
    assert.notEqual(
      artifact.integrationAction,
      "never-apply",
      `${artifact.id} has a contradictory integration action`,
    );
  }
}

const plannedArtifactIds = manifest.integrationPlan.flatMap(
  (stage) => stage.artifacts,
);
assert.equal(
  new Set(plannedArtifactIds).size,
  plannedArtifactIds.length,
  "an artifact appears in more than one integration stage",
);
assert.deepEqual(
  manifest.integrationPlan.map((stage) => stage.order),
  manifest.integrationPlan.map((_, index) => index + 1),
  "integration stages must remain contiguous and chronological",
);

const expectedPlannedIds = manifest.artifacts
  .filter((artifact) => plannedStatuses.has(artifact.status))
  .map((artifact) => artifact.id)
  .sort();
assert.deepEqual(
  [...plannedArtifactIds].sort(),
  expectedPlannedIds,
  "every accepted or WIP artifact must be mapped exactly once",
);

for (const artifact of manifest.artifacts.filter((entry) =>
  neverApplyStatuses.has(entry.status),
)) {
  assert.ok(
    !plannedArtifactIds.includes(artifact.id),
    `${artifact.id} must not enter the integration plan`,
  );
}

if (process.env.RECOVERY_BASELINE_REQUIRE_CURRENT_HEAD === "1") {
  assert.equal(
    git("status", "--porcelain"),
    "",
    "current-head proof requires a clean working tree",
  );
  assert.deepEqual(
    lines(git("diff", "--name-only", recoveryAnchor.commit, "HEAD")).sort(),
    [...allowedCurrentHeadDeltaPaths].sort(),
    "current HEAD contains changes beyond the baseline manifest and its proof",
  );
}

console.log(
  JSON.stringify({
    status: "mail-authority-recovery-baseline-ok",
    contentBase: contentBase.commit,
    recoveryAnchor: recoveryAnchor.commit,
    mappedArtifacts: manifest.artifacts.length,
    acceptedComponents: manifest.artifacts.filter(
      (artifact) => artifact.status === "accepted-component",
    ).length,
    wipCheckpoints: manifest.artifacts.filter(
      (artifact) => artifact.status === "wip",
    ).length,
    rejectedOrSuperseded: manifest.artifacts.filter((artifact) =>
      neverApplyStatuses.has(artifact.status),
    ).length,
  }),
);
