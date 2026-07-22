import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationBuildPlan } from "./application-image-operations.mjs";

test("local OCI exports rewrite timestamps for reproducible linux/amd64 identities", () => {
  const plan = createApplicationBuildPlan({
    sourceDateEpoch: "1784419200",
    sourceRepository: "https://github.com/thebrownhuman/Codestead",
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    sourceContextSha256: "c".repeat(64),
    registry: "registry.example.test/codestead",
    release: "20260719T000000Z-a",
    local: true,
  });
  for (const entry of plan) {
    assert.match(entry.output, /,rewrite-timestamp=true$/);
  }
});
