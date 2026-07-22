import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApplicationImageRecord } from "./application-image-operations.mjs";
import {
  deriveRepositorySourceBinding,
  parseExactEnvironmentProjection,
  verifyApplicationImageRecordProjection,
} from "../../infra/ops/verify-application-image-record.mjs";

const sourceRepository = "https://github.com/thebrownhuman/Codestead";
const sourceRevision = "a".repeat(40);
const sourceTree = "b".repeat(40);
const sourceContextSha256 = "c".repeat(64);
const generatedAt = "2026-07-19T12:00:00Z";
const validatedAt = "2026-07-19T12:30:00Z";

const targetMap = [
  ["runtime", "APP_RUNTIME_IMAGE", "runtime"],
  ["tooling", "APP_TOOLING_IMAGE", "tooling"],
  ["worker", "APP_WORKER_IMAGE", "worker"],
  ["regrade-worker", "APP_REGRADE_WORKER_IMAGE", "regrade-worker"],
  ["project-review-correction-worker", "APP_PROJECT_REVIEW_WORKER_IMAGE", "project-review-worker"],
  ["scanner-worker", "APP_SCANNER_WORKER_IMAGE", "scanner-worker"],
  ["operations", "APP_OPERATIONS_IMAGE", "operations"],
];

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function fixture() {
  const identities = targetMap.map(([target, variable, repository], index) => ({
    target,
    variable,
    reference: `ghcr.io/thebrownhuman/codestead/${repository}@${digest(String(index + 1))}`,
    manifestDigest: digest(String(index + 1)),
    configDigest: digest("abcdef89"[index]),
    rootDigest: digest(String(index + 1)),
    sourceRepository,
    sourceRevision,
  }));
  const publication = createApplicationImageRecord({
    generatedAt,
    release: "release-2026-07-19",
    local: true,
    sourceRepository,
    sourceRevision,
    sourceTree,
    sourceContextSha256,
    identities,
  });
  const composeText = [
    "POSTGRES_IMAGE=postgres@sha256:" + "f".repeat(64),
    ...identities.map((identity) => `${identity.variable}=${identity.reference}`),
    "SOURCE_CODE_URL=" + sourceRepository,
    "",
  ].join("\n");
  return { publication, composeText };
}

function rehash(document) {
  const payload = structuredClone(document);
  delete payload.recordId;
  return {
    ...document,
    recordId: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

function fakeGit({ tracked = "Dockerfile\npackage.json", archive = Buffer.from("exact archive") } = {}) {
  return (args, options = {}) => {
    const command = args.join(" ");
    if (command === "config --get remote.origin.url") return "git@github.com:thebrownhuman/Codestead.git";
    if (command === "rev-parse HEAD^{commit}") return sourceRevision;
    if (command === "rev-parse HEAD^{tree}") return sourceTree;
    if (command === "ls-tree -r --name-only --full-tree HEAD") return tracked;
    if (command === "archive --format=tar HEAD" && options.binary === true) return archive;
    throw new Error(`Unexpected Git command: ${command}`);
  };
}

test("the production verifier independently derives canonical Git origin, commit, tree, and exact archive digest", () => {
  const archive = Buffer.from("reviewed exact Git archive bytes");
  assert.deepEqual(deriveRepositorySourceBinding(fakeGit({ archive })), {
    repository: sourceRepository,
    revision: sourceRevision,
    tree: sourceTree,
    contextSha256: createHash("sha256").update(archive).digest("hex"),
  });
  assert.throws(
    () => deriveRepositorySourceBinding(fakeGit({
      tracked: "Dockerfile\npublic/monaco/editor.worker.js\n",
    })),
    /generated path.*public\/monaco/i,
  );
});

test("the production verifier accepts only one canonical source-bound seven-image Compose projection", () => {
  const { publication, composeText } = fixture();
  const result = verifyApplicationImageRecordProjection({
    jsonText: publication.jsonText,
    envText: publication.envText,
    composeText,
    expectedSourceRepository: sourceRepository,
    expectedSourceRevision: sourceRevision,
    expectedSourceTree: sourceTree,
    expectedSourceContextSha256: sourceContextSha256,
    validatedAt,
  });
  assert.equal(result.recordId, publication.recordId);
  assert.equal(
    result.recordSha256,
    createHash("sha256").update(publication.jsonText).digest("hex"),
  );
  assert.deepEqual(Object.keys(result.projection).sort(), targetMap.map(([, variable]) => variable).sort());
});

test("the production verifier rejects tampering, staleness, wrong source, and any Compose mismatch", () => {
  const { publication, composeText } = fixture();
  const base = {
    jsonText: publication.jsonText,
    envText: publication.envText,
    composeText,
    expectedSourceRepository: sourceRepository,
    expectedSourceRevision: sourceRevision,
    expectedSourceTree: sourceTree,
    expectedSourceContextSha256: sourceContextSha256,
    validatedAt,
  };

  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    jsonText: publication.jsonText.replace(publication.recordId, "0".repeat(64)),
  }), /canonical record id/i);
  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    jsonText: JSON.stringify(JSON.parse(publication.jsonText)),
  }), /canonical JSON bytes/i);
  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    validatedAt: "2026-07-20T12:00:01Z",
  }), /stale|future/i);
  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    expectedSourceRevision: "b".repeat(40),
  }), /source.*revision|release source/i);
  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    expectedSourceTree: "d".repeat(40),
  }), /source.*tree|release source/i);
  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    expectedSourceContextSha256: "e".repeat(64),
  }), /source.*context|release source/i);
  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    composeText: composeText.replace(/APP_RUNTIME_IMAGE=[^\n]+/, `APP_RUNTIME_IMAGE=x@${digest("e")}`),
  }), /compose.*projection|projection.*compose/i);

  const mutated = JSON.parse(publication.jsonText);
  mutated.records[0].variable = "APP_TOOLING_IMAGE";
  const rehashed = rehash(mutated);
  assert.throws(() => verifyApplicationImageRecordProjection({
    ...base,
    jsonText: `${JSON.stringify(rehashed, null, 2)}\n`,
  }), /target-to-variable|duplicate|canonical/i);
});

test("environment parsing rejects duplicates, unknown record keys, interpolation, and mutable references", () => {
  const { publication } = fixture();
  assert.throws(
    () => parseExactEnvironmentProjection(`${publication.envText}APP_RUNTIME_IMAGE=x@${digest("e")}\n`),
    /duplicate/i,
  );
  assert.throws(
    () => parseExactEnvironmentProjection(`${publication.envText}APP_UNKNOWN_IMAGE=x@${digest("e")}\n`),
    /unreviewed|unknown/i,
  );
  assert.throws(
    () => parseExactEnvironmentProjection(publication.envText.replace(/@sha256:[a-f0-9]{64}/, ":latest")),
    /immutable|digest/i,
  );
  assert.throws(
    () => parseExactEnvironmentProjection(publication.envText.replace(/APP_RUNTIME_IMAGE=[^\n]+/, "APP_RUNTIME_IMAGE=${BAD}")),
    /immutable|interpolation|digest/i,
  );
});
