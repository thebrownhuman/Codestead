import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDisposableToolEnvironment } from
  "../lib/disposable-tool-environment";

describe("disposable integration temporary-directory boundary", () => {
  it("rebases every ambient temp variable inside the disposable task home", () => {
    const taskHomeDirectory = path.resolve("task-home", "temp-boundary");
    const environment = buildDisposableToolEnvironment({
      TEMP: "C:\\ambient-temp-secret-canary",
      TMP: "C:\\ambient-tmp-secret-canary",
      TMPDIR: "/ambient/tmpdir/secret-canary",
    }, taskHomeDirectory);
    const expected = path.join(taskHomeDirectory, "tmp");

    expect(environment).toMatchObject({
      TEMP: expected,
      TMP: expected,
      TMPDIR: expected,
    });
    expect(JSON.stringify(environment)).not.toContain("ambient");
  });
});
