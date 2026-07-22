import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeImageRecord,
  publishRuntimeImageRecordTransaction,
  validateRuntimeImageRecord,
} from "./runtime-operations.mjs";

const LANGUAGES = ["c", "cpp", "java", "python", "javascript"];

function digest(fill) {
  return `sha256:${fill.repeat(64)}`;
}

function identities() {
  return LANGUAGES.map((language, index) => {
    const manifestDigest = digest(String(index + 1));
    const configDigest = digest(String.fromCharCode(97 + index));
    return {
      language,
      tag: `learncoding/runtime-${language}:local`,
      imageReference: `learncoding/runtime-${language}@${manifestDigest}`,
      manifestDigest,
      configDigest,
      rootDigest: manifestDigest,
    };
  });
}

test("creates one canonical JSON commit marker and a matching environment projection", () => {
  const publication = createRuntimeImageRecord({ release: "local", local: true, identities: identities() });
  const validated = validateRuntimeImageRecord({
    envText: publication.envText,
    jsonText: publication.jsonText,
    expectedLanguages: LANGUAGES,
  });

  assert.match(publication.recordId, /^[a-f0-9]{64}$/);
  assert.match(publication.envText, new RegExp(`^# runtime-record-id=${publication.recordId}$`, "m"));
  assert.equal(validated.recordId, publication.recordId);
  assert.equal(validated.records[0].manifestDigest, digest("1"));
  assert.equal(validated.records[0].configDigest, digest("a"));
});

test("rejects a partial, stale, tampered, duplicate, or digest-conflated record projection", () => {
  const publication = createRuntimeImageRecord({ release: "local", local: true, identities: identities() });
  const validate = (overrides = {}) => validateRuntimeImageRecord({
    envText: overrides.envText ?? publication.envText,
    jsonText: overrides.jsonText ?? publication.jsonText,
    expectedLanguages: LANGUAGES,
  });

  assert.throws(() => validate({ envText: publication.envText.replace(publication.recordId, "f".repeat(64)) }), /record id/i);
  const tampered = JSON.parse(publication.jsonText);
  tampered.records[0].reference = `learncoding/runtime-c@${digest("9")}`;
  assert.throws(() => validate({ jsonText: JSON.stringify(tampered) }), /canonical record id|immutable reference/i);

  const conflated = identities();
  conflated[0].configDigest = conflated[0].manifestDigest;
  assert.throws(() => createRuntimeImageRecord({ release: "local", local: true, identities: conflated }), /config digest/i);

  const duplicate = identities();
  duplicate[1].language = "c";
  assert.throws(() => createRuntimeImageRecord({ release: "local", local: true, identities: duplicate }), /duplicate|language set/i);
});

test("durably stages both files and commits canonical JSON last", () => {
  const events = [];
  const publication = createRuntimeImageRecord({ release: "local", local: true, identities: identities() });
  publishRuntimeImageRecordTransaction({
    directory: "dist",
    publication,
    token: "pid-1",
    writeStaging: (file, text) => events.push(["write", file, text.length]),
    flushStaging: (file) => events.push(["flush", file]),
    renameStaging: (from, to) => events.push(["rename", from, to]),
    removeStaging: (file) => events.push(["remove", file]),
    flushDirectory: (directory) => events.push(["flush-directory", directory]),
  });

  const renames = events.filter(([name]) => name === "rename");
  assert.match(renames[0][2], /runtime-images\.env$/);
  assert.match(renames[1][2], /runtime-images\.json$/);
  assert.deepEqual(events.at(-1), ["flush-directory", "dist"]);
});

test("publication failure never commits canonical JSON and cleans remaining staging files", () => {
  const events = [];
  const publication = createRuntimeImageRecord({ release: "local", local: true, identities: identities() });
  assert.throws(() => publishRuntimeImageRecordTransaction({
    directory: "dist",
    publication,
    token: "pid-2",
    writeStaging: (file) => events.push(["write", file]),
    flushStaging: (file) => events.push(["flush", file]),
    renameStaging: (from, to) => {
      events.push(["rename", from, to]);
      if (to.endsWith("runtime-images.json")) throw new Error("simulated crash");
    },
    removeStaging: (file) => events.push(["remove", file]),
    flushDirectory: (directory) => events.push(["flush-directory", directory]),
  }), /simulated crash/);

  assert.equal(events.filter(([name, , to]) => name === "rename" && to?.endsWith("runtime-images.json")).length, 1);
  assert.ok(events.filter(([name]) => name === "remove").length >= 2);
});
