import { describe, expect, it } from "vitest";

import { aggregateArtifactHash, hashCurriculumValue } from "../hash";

describe("curriculum integrity hashing", () => {
  it("canonicalizes object-key insertion order", () => {
    expect(hashCurriculumValue({ beta: 2, alpha: { zeta: 3, eta: 4 } })).toBe(
      hashCurriculumValue({ alpha: { eta: 4, zeta: 3 }, beta: 2 }),
    );
  });

  it("orders Unicode artifact identifiers byte-independently without locale collation", () => {
    const artifacts = [
      { artifactKey: "zeta", artifactType: "authored_lesson", contentHash: "a".repeat(64) },
      { artifactKey: "Ångström", artifactType: "assessment_bank", contentHash: "b".repeat(64) },
      { artifactKey: "alpha", artifactType: "course_manifest", contentHash: "c".repeat(64) },
    ];
    expect(aggregateArtifactHash(artifacts)).toBe(aggregateArtifactHash([...artifacts].reverse()));
  });

  it("uses type and content hash as deterministic tie-breakers", () => {
    const artifacts = [
      { artifactKey: "same", artifactType: "z", contentHash: "f".repeat(64) },
      { artifactKey: "same", artifactType: "a", contentHash: "e".repeat(64) },
      { artifactKey: "same", artifactType: "a", contentHash: "d".repeat(64) },
    ];
    expect(aggregateArtifactHash(artifacts)).toBe(aggregateArtifactHash([artifacts[1]!, artifacts[2]!, artifacts[0]!]));
  });
});
