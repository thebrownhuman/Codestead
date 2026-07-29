import { describe, expect, it, vi } from "vitest";

import { installDisposablePostgresSignalHandlers } from
  "../lib/disposable-postgres-container";

describe("disposable integration signal child ordering", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "reaps the active child before container and home cleanup for %s",
    async (signal, exitCode) => {
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
            username: "codestead_it",
          }),
        },
        terminateActiveChildren: async (receivedSignal) => {
          order.push(`terminate-${receivedSignal}`);
          await Promise.resolve();
          order.push("child-reaped");
        },
        cleanupRuntime: () => order.push("task-home"),
        processTarget: {
          on: (receivedSignal, listener) => {
            listeners.set(receivedSignal, listener);
          },
          exit,
        },
        writeError: vi.fn(),
      });

      listeners.get(signal)?.();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(exitCode));
      expect(order).toEqual([
        `terminate-${signal}`,
        "child-reaped",
        "container",
        "task-home",
      ]);
    },
  );

  it("does not expose raw child termination failures", async () => {
    const listeners = new Map<string, () => void>();
    const diagnostics: string[] = [];
    const exit = vi.fn();
    const cleanupRuntime = vi.fn();
    installDisposablePostgresSignalHandlers({
      container: {
        start: vi.fn(),
        cleanup: vi.fn(),
        getIdentity: () => {
          throw new Error("not started");
        },
      },
      terminateActiveChildren: async () => {
        throw new Error("raw-child-secret-canary");
      },
      cleanupRuntime,
      processTarget: {
        on: (signal, listener) => listeners.set(signal, listener),
        exit,
      },
      writeError: (message) => diagnostics.push(message),
    });

    listeners.get("SIGTERM")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(cleanupRuntime).toHaveBeenCalledOnce();
    expect(diagnostics.join("\n")).toContain("signal_child_termination_failed");
    expect(diagnostics.join("\n")).not.toContain("raw-child-secret-canary");
  });
});
