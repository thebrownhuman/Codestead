import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  createDisposableIntegrationTaskHome,
  type DisposableTaskHomeOperations,
} from "../lib/disposable-integration-task-home";

function fakeOperations(input: Readonly<{
  mode?: number;
  removalLeavesDirectory?: boolean;
}> = {}) {
  const root = path.resolve("task-home-root");
  const directory = path.join(
    root,
    "codestead-integration-home-unit123",
  );
  const existing = new Set<string>();
  const secureWindowsDirectory = vi.fn();
  const operations: DisposableTaskHomeOperations = {
    makeTemporaryDirectory: () => {
      existing.add(directory);
      return directory;
    },
    makeDirectory: (directoryPath) => {
      existing.add(directoryPath);
    },
    setDirectoryMode: vi.fn(),
    readDirectoryMode: () => input.mode ?? 0o700,
    isDirectory: (candidate) => existing.has(candidate),
    pathExists: (candidate) => existing.has(candidate),
    removeDirectory: (candidate) => {
      if (!input.removalLeavesDirectory) existing.delete(candidate);
    },
    secureWindowsDirectory,
  };
  return { directory, existing, operations, root, secureWindowsDirectory };
}

function renderedFailure(error: unknown): string {
  return [
    String(error),
    inspect(error),
    JSON.stringify(error),
    JSON.stringify(Object.entries(error as object)),
  ].join("\n");
}

describe("disposable integration task home", () => {
  it("creates a private POSIX home and verifies exact cleanup", () => {
    const fake = fakeOperations();
    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: fake.root,
      platform: "linux",
      operations: fake.operations,
    });

    expect(home.path).toBe(fake.directory);
    expect(fake.operations.setDirectoryMode).toHaveBeenCalledWith(
      fake.directory,
      0o700,
    );
    home.cleanup();
    expect(fake.existing).not.toContain(fake.directory);
  });

  it("uses a private Windows ACL when POSIX mode bits are not meaningful", () => {
    const fake = fakeOperations({ mode: 0o777 });
    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: fake.root,
      platform: "win32",
      operations: fake.operations,
    });
    expect(fake.secureWindowsDirectory).toHaveBeenCalledWith(fake.directory);
    home.cleanup();
  });

  it("fails closed when directory deletion cannot be verified", () => {
    const fake = fakeOperations({ removalLeavesDirectory: true });
    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: fake.root,
      platform: "linux",
      operations: fake.operations,
    });
    let failure: unknown;
    try {
      home.cleanup();
    } catch (error) {
      failure = error;
    }
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("task_home_still_present");
    expect(rendered).not.toContain(fake.directory);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
