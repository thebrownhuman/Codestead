import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createDisposableIntegrationProcessTreeOperations } from
  "../lib/disposable-integration-child-controller";

class ProcessTreeFakeChild extends EventEmitter {
  exitCode: number | null = null;
  pid = 4321;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

describe("disposable integration process-tree operations", () => {
  it("uses a tree-scoped forced termination on the first Windows signal", () => {
    const executeWindowsTreeKill = vi.fn(() => 0);
    const operations = createDisposableIntegrationProcessTreeOperations({
      platform: "win32",
      executeWindowsTreeKill,
    });
    const child = new ProcessTreeFakeChild();

    operations.terminate(child, "SIGTERM");

    expect(executeWindowsTreeKill).toHaveBeenCalledWith(4321);
    expect(operations.isTreeAlive(child)).toBe(false);
  });

  it("signals and probes the detached POSIX process group", () => {
    const signalProcess = vi.fn(
      (_pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) {
          const error = new Error("gone") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
      },
    );
    const operations = createDisposableIntegrationProcessTreeOperations({
      platform: "linux",
      signalProcess,
    });
    const child = new ProcessTreeFakeChild();

    operations.terminate(child, "SIGINT");

    expect(signalProcess).toHaveBeenNthCalledWith(1, -4321, "SIGINT");
    expect(operations.isTreeAlive(child)).toBe(false);
    expect(signalProcess).toHaveBeenNthCalledWith(2, -4321, 0);
  });
});
