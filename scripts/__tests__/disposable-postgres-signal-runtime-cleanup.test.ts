import { describe, expect, it, vi } from "vitest";

import { installDisposablePostgresSignalHandlers } from
  "../lib/disposable-postgres-container";

describe("disposable PostgreSQL signal runtime cleanup", () => {
  it("cleans the exact container and fresh task home before exiting", async () => {
    const listeners = new Map<string, () => void>();
    const order: string[] = [];
    const exit = vi.fn();
    installDisposablePostgresSignalHandlers({
      container: {
        start: () => undefined,
        cleanup: () => order.push("container"),
        getIdentity: () => ({
          containerId: "a".repeat(64),
          port: 54321,
          database: "learncoding_integration",
          username: "learncoding_it",
        }),
      },
      terminateActiveChildren: async () => undefined,
      cleanupRuntime: () => order.push("task-home"),
      processTarget: {
        on: (signal, listener) => listeners.set(signal, listener),
        exit,
      },
      writeError: vi.fn(),
    });

    listeners.get("SIGTERM")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(order).toEqual(["container", "task-home"]);
  });

  it("still attempts task-home cleanup after container cleanup fails", async () => {
    const listeners = new Map<string, () => void>();
    const cleanupRuntime = vi.fn();
    const exit = vi.fn();
    const diagnostics: string[] = [];
    installDisposablePostgresSignalHandlers({
      container: {
        start: () => undefined,
        cleanup: () => {
          throw new Error("raw-container-cleanup-canary");
        },
        getIdentity: () => {
          throw new Error("not started");
        },
      },
      terminateActiveChildren: async () => undefined,
      cleanupRuntime,
      processTarget: {
        on: (signal, listener) => listeners.set(signal, listener),
        exit,
      },
      writeError: (message) => diagnostics.push(message),
    });

    listeners.get("SIGINT")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(cleanupRuntime).toHaveBeenCalledOnce();
    expect(diagnostics.join("\n")).toContain("signal_cleanup_failed");
    expect(diagnostics.join("\n")).not.toContain(
      "raw-container-cleanup-canary",
    );
  });
});
