import { describe, expect, it } from "vitest";

import {
  LOCAL_RUNTIME_IDENTITY_LIMITATION,
  projectRuntimeIdentityEvidence,
  validateLocalRuntimeIdentity,
  type InspectLocalRuntimeImage,
} from "./local-runtime-identity";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;
const D = `sha256:${"d".repeat(64)}`;

function record(id: "c" | "cpp" | "java" | "javascript" | "python", manifestDigest: string, configDigest: string) {
  return { id, tag: `learncoding/runtime-${id}:local`, manifestDigest, configDigest, reference: `learncoding/runtime-${id}@${manifestDigest}` };
}
function completeRecords() {
  return [record("c", A, B), record("cpp", B, C), record("java", C, D), record("javascript", D, A), record("python", A, C)];
}
function manifest(records: unknown[] = completeRecords()) { return { schemaVersion: 1, records }; }
function inspector(id: string = A): InspectLocalRuntimeImage {
  return (requested) => ({
    Id: id,
    Descriptor: { digest: A },
    RepoTags: ["learncoding/runtime-c:local"],
    RepoDigests: [`learncoding/runtime-c@${A}`],
    requested,
  });
}
const expectation = { language: "c" as const, tag: "learncoding/runtime-c:local", declaredContentDigest: A };

describe("local runtime identity contract", () => {
  it.each([["manifest", A], ["config", B]])("accepts a container store exposing the %s digest", (_kind, imageId) => {
    const evidence = validateLocalRuntimeIdentity({
      manifest: manifest(),
      expectations: [expectation],
      inspectImage: inspector(imageId),      resolveConfigDigest: () => B,
    }).c!;
    expect(evidence).toMatchObject({
      language: "c",
      tag: "learncoding/runtime-c:local",
      declaredContentDigest: A,
      recordedLocalDigest: A,
      recordedConfigDigest: B,
      recordedLocalReference: `learncoding/runtime-c@${A}`,
      immutableReference: `learncoding/runtime-c@${A}`,
      actualTaggedImageId: imageId,
      recordMatchesTaggedImage: true,
      independentlyValidated: true,
    });
    expect(projectRuntimeIdentityEvidence(evidence)).toMatchObject({
      manifestDigest: A,
      configDigest: B,
      immutableReference: `learncoding/runtime-c@${A}`,
      tagImageId: imageId,
      exactReferenceImageId: imageId,
    });
    expect(LOCAL_RUNTIME_IDENTITY_LIMITATION).toMatch(/production publication.*separate release gates/i);
  });

  it("fails closed when the local manifest differs from the declared exam digest", () => {
    expect(() => validateLocalRuntimeIdentity({
      manifest: manifest(),
      expectations: [{ ...expectation, declaredContentDigest: B }],
      inspectImage: inspector(),      resolveConfigDigest: () => B,
    })).toThrow(/declared content digest for c does not match.*manifest/i);
  });

  it("fails closed when a required language is missing or duplicated", () => {
    expect(() => validateLocalRuntimeIdentity({
      manifest: manifest(completeRecords().filter((item) => item.id !== "c")),
      expectations: [expectation],
      inspectImage: inspector(),      resolveConfigDigest: () => B,
    })).toThrow(/exactly one local build identity for c; found 0/i);
    expect(() => validateLocalRuntimeIdentity({
      manifest: manifest([...completeRecords(), record("c", A, B)]),
      expectations: [expectation],
      inspectImage: inspector(),      resolveConfigDigest: () => B,
    })).toThrow(/exactly one local build identity for c; found 2/i);
  });

  it("rejects an image ID unrelated to both archive identities", () => {
    expect(() => validateLocalRuntimeIdentity({
      manifest: manifest(),
      expectations: [expectation],
      inspectImage: inspector(D),      resolveConfigDigest: () => B,
    })).toThrow(/matches neither.*manifest nor config/i);
  });

  it.each([
    ["unknown top-level field", { ...manifest(), unexpected: true }, /exactly records and schemaversion/i],
    ["wrong schema", { ...manifest(), schemaVersion: 2 }, /schemaversion must be 1/i],
    ["unknown identity field", manifest(completeRecords().map((item) => item.id === "c" ? { ...item, extra: true } : item)), /contain exactly configdigest/i],
    ["malformed digest", manifest(completeRecords().map((item) => item.id === "c" ? { ...item, manifestDigest: "sha256:unsafe" } : item)), /manifest digest for c.*oci/i],
    ["equal manifest/config", manifest(completeRecords().map((item) => item.id === "c" ? { ...item, configDigest: A } : item)), /must be distinct/i],
    ["unsafe reference", manifest(completeRecords().map((item) => item.id === "c" ? { ...item, reference: `learncoding/runtime-c:local@${A}` } : item)), /reference for c must be exactly/i],
  ])("rejects an unsafe %s", (_name, runtimeManifest, message) => {
    expect(() => validateLocalRuntimeIdentity({
      manifest: runtimeManifest,
      expectations: [expectation],
      inspectImage: inspector(),      resolveConfigDigest: () => B,
    })).toThrow(message);
  });
});
