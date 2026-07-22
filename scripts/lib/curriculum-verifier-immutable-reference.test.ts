import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
function source(file: string): string {
  return readFileSync(path.join(root, "scripts", file), "utf8");
}

describe("curriculum verifiers execute independently validated immutable images", () => {
  it("makes the shared Java/Python executor accept and run the selected immutable reference", () => {
    const value = source("pinned-curriculum-runtime.ts");
    expect(value).toContain("readonly imageReference: string;");
    expect(value).toMatch(/--mount[\s\S]{0,250}input\.imageReference,[\s\S]{0,100}\/opt\/runner\/execute/);
    expect(value).not.toMatch(/--mount[\s\S]{0,250}runtime\.tag,[\s\S]{0,100}\/opt\/runner\/execute/);
  });

  it.each([
    ["verify-dsa-language-parity.ts", /execute\(item, test\.stdin, runtimeIdentity\.immutableReference\)/],
    ["verify-c-cpp-executable-tranche.ts", /execute\(item, test\.stdin, runtimeIdentity\.immutableReference\)/],
    ["verify-web-executable-tranche.ts", /executeNode\(item, test\.stdin, nodeIdentity\.immutableReference\)/],
    ["verify-java-python-code-tasks.ts", /imageReference: runtimeIdentity\.immutableReference/],
    ["verify-ai-code-tasks.ts", /imageReference: runtimeIdentity\.immutableReference/],
  ])("%s passes the selected immutable reference into execution", (file, pattern) => {
    expect(source(file)).toMatch(pattern);
  });

  it.each([
    "verify-dsa-language-parity.ts",
    "verify-c-cpp-executable-tranche.ts",
    "verify-web-executable-tranche.ts",
    "verify-java-python-code-tasks.ts",
    "verify-ai-code-tasks.ts",
  ])("%s records the common manifest/config/reference report projection", (file) => {
    const value = source(file);
    expect(value).toContain("projectRuntimeIdentityEvidence");
    expect(value).toContain("immutableReference");
  });
});
