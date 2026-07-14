import { describe, expect, it } from "vitest";

import { isGeneratedNextOutputDirectory } from "../../../../scripts/lib/repository-scan-exclusions";

describe("repository scan exclusions", () => {
  it.each([
    ".next",
    ".next-e2e-",
    ".next-e2e-3100",
    ".next-e2e-webkit",
    ".\\.next-e2e-windows",
  ])("excludes generated Next output directory %s", (directoryName) => {
    expect(isGeneratedNextOutputDirectory(directoryName)).toBe(true);
  });

  it.each([
    "src",
    "content",
    "docs",
    ".next-e2e",
    "next-e2e-3100",
    ".next-source",
    "src/.next",
    "content/.next-e2e-3100",
    "docs\\.next-e2e-generated-looking",
  ])("keeps repository directory %s in scanner scope", (directoryName) => {
    expect(isGeneratedNextOutputDirectory(directoryName)).toBe(false);
  });
});
