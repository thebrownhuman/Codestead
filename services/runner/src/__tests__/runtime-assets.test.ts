import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string) => readFileSync(`${runnerRoot}/${relative}`, "utf8");

describe("runtime image release assets", () => {
  it("pins every source image to an immutable linux/amd64 manifest", () => {
    const entries = read("runtime/images.env")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const);
    const images = entries.filter(([name]) => name === "HARNESS_BUILD_IMAGE" || name.startsWith("RUNTIME_BASE_"));
    expect(images).toHaveLength(6);
    for (const [, value] of images) {
      expect(value).toMatch(/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/i);
      expect(value).not.toContain("0000000000000000");
      expect(value).not.toContain("REPLACE");
    }
    const packages = entries.filter(([name]) => name === "HARNESS_BUILD_PACKAGES" || name.startsWith("RUNTIME_PACKAGES_"));
    expect(packages.map(([name]) => name).sort()).toEqual([
      "HARNESS_BUILD_PACKAGES",
      "RUNTIME_PACKAGES_C",
      "RUNTIME_PACKAGES_CPP",
      "RUNTIME_PACKAGES_JAVA",
    ]);
    for (const [, value] of packages) {
      for (const specification of value.split(/\s+/)) {
        expect(specification).toMatch(/^[a-z0-9][a-z0-9+_.-]*=[a-z0-9][a-z0-9+_.:~-]*$/i);
      }
    }
  });

  it("builds a non-root runtime with only exact Alpine package inputs", () => {
    const dockerfile = read("runtime/Dockerfile");
    expect(dockerfile).toContain("USER 65532:65532");
    expect(dockerfile).toContain("ENTRYPOINT []");
    expect(dockerfile).toContain("--chown=65532:65532");
    expect(dockerfile).toContain("apk add --no-cache ${HARNESS_BUILD_PACKAGES}");
    expect(dockerfile).toContain("apk add --no-cache ${RUNTIME_PACKAGES}");
    expect(dockerfile).toContain("rm -f /sbin/apk");
    expect(dockerfile).toContain("rm -rf /usr/local/lib/node_modules");
    expect(dockerfile).toContain("rm -rf /usr/local/lib/python3.14/ensurepip");
    expect(dockerfile).toContain("rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.14");
    expect(dockerfile).not.toMatch(/\b(?:apt-get|apt|yum|dnf|pip|npm)\s+(?:add|install)\b/i);
  });

  it("uses fixed execv commands and never constructs a learner shell command", () => {
    const harness = read("runtime/harness.c");
    expect(harness).toContain("execv(arguments[0], arguments)");
    expect(harness).toContain("safe_relative_path");
    expect(harness).toContain("clearenv()");
    expect(harness).not.toMatch(/\b(?:system|popen)\s*\(/);
    expect(harness).not.toContain("/bin/sh");
    expect(harness).not.toContain("eval");
  });

  it("keeps deployment defaults blank instead of presenting fake digests", () => {
    for (const file of [".env.example", "../../infra/env/runner.env.example"]) {
      const example = read(file);
      expect(example).not.toMatch(/sha256:0{64}/);
      expect(example).toContain("RUNNER_IMAGE_C=");
      expect(example).toContain("RUNNER_IMAGE_JAVASCRIPT=");
    }
  });

  it("runs the vulnerability gate offline and without finding suppressions", () => {
    const manager = read("runtime/manage-images.mjs");
    expect(manager).toContain('"--skip-db-update"');
    expect(manager).toContain('"--skip-java-db-update"');
    expect(manager).toContain('"--offline-scan"');
    expect(manager).toContain('"--severity", "HIGH,CRITICAL"');
    expect(manager).toContain('"--exit-code", "1"');
    expect(manager).not.toMatch(/ignore-unfixed|ignorefile|vex/i);
  });
});
