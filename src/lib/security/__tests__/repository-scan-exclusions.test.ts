import { describe, expect, it } from "vitest";

import {
  isGeneratedNextOutputDirectory,
  isGeneratedRepositoryArtifactDirectory,
  isWithinGeneratedRepositoryArtifactDirectory,
} from "../../../../scripts/lib/repository-scan-exclusions";

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

  it.each([
    "playwright-report",
    "test-artifacts",
    "test-results",
    ".\\test-artifacts",
    "./test-results/",
  ])("excludes generated artifact directory %s", (directoryName) => {
    expect(isGeneratedRepositoryArtifactDirectory(directoryName)).toBe(true);
  });

  it.each([
    "src",
    "content",
    "docs",
    ".superpowers",
    "artifact",
    "test-artifact",
    "src/test-artifacts",
    "content\\test-results",
    "docs/playwright-report",
  ])("keeps repository directory %s outside artifact exclusions", (directoryName) => {
    expect(isGeneratedRepositoryArtifactDirectory(directoryName)).toBe(false);
  });

  it.each([
    "test-artifacts/generated.txt",
    "test-results\\vitest-unit-final.json",
    "./playwright-report/index.html",
  ])("identifies tracked files inside a generated root %s", (relativePath) => {
    expect(isWithinGeneratedRepositoryArtifactDirectory(relativePath)).toBe(true);
  });

  it.each([
    "test-artifacts",
    "src/test-artifacts/source.ts",
    "docs/playwright-report/index.html",
  ])("does not treat non-descendant path %s as a generated-root file", (relativePath) => {
    expect(isWithinGeneratedRepositoryArtifactDirectory(relativePath)).toBe(false);
  });

  it.each([
    "../test-results/output.json",
    "src/../test-results/output.json",
    "src\\..\\test-results\\output.json",
  ])("rejects traversal path %s", (relativePath) => {
    expect(() =>
      isWithinGeneratedRepositoryArtifactDirectory(relativePath),
    ).toThrow(/traversal/u);
  });
});
