import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDisposableIntegrationTaskHome,
  type DisposableTaskHomeOperations,
} from "../lib/disposable-integration-task-home";

describe("disposable integration task-home temp directory", () => {
  it("creates the private temp directory before returning the task home", () => {
    const root = path.resolve("task-home-temp-root");
    const homePath = path.join(
      root,
      "codestead-integration-home-temp123",
    );
    const directories = new Set<string>();
    const makeDirectory = vi.fn((directoryPath: string) => {
      directories.add(directoryPath);
    });
    const operations: DisposableTaskHomeOperations = {
      makeTemporaryDirectory: () => {
        directories.add(homePath);
        return homePath;
      },
      makeDirectory,
      setDirectoryMode: vi.fn(),
      readDirectoryMode: () => 0o700,
      isDirectory: (candidate) => directories.has(candidate),
      pathExists: (candidate) => directories.has(candidate),
      removeDirectory: () => directories.clear(),
      secureWindowsDirectory: vi.fn(),
    };

    const home = createDisposableIntegrationTaskHome({
      temporaryRoot: root,
      platform: "linux",
      operations,
    });

    expect(makeDirectory).toHaveBeenCalledWith(
      path.join(homePath, "tmp"),
      0o700,
    );
    home.cleanup();
  });
});
