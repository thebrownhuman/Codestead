import { describe, expect, it, vi } from "vitest";

import { installDisposablePostgresSignalHandlers } from
  "../lib/disposable-postgres-container";

describe("disposable integration repeated signal handling", () => {
  it("keeps the handler installed and ignores a repeated same signal during cleanup", async () => {
    const listeners = new Map<string, () => void>();
    const order: string[] = [];
    const exit = vi.fn();
    let releaseChildReap: () => void = () => undefined;
    const childReaped = new Promise<void>((resolve) => {
      releaseChildReap = resolve;
    });
    const terminateActiveChildren = vi.fn(async () => {
      order.push("terminate-child");
      await childReaped;
      order.push("child-reaped");
    });
    const containerCleanup = vi.fn(() => order.push("container"));
    const runtimeCleanup = vi.fn(() => order.push("task-home"));

    installDisposablePostgresSignalHandlers({
      container: {
        start: vi.fn(),
        cleanup: containerCleanup,
        getIdentity: () => {
          throw new Error("not started");
        },
      },
      terminateActiveChildren,
      cleanupRuntime: runtimeCleanup,
      processTarget: {
        on: (signal, listener) => listeners.set(signal, listener),
        exit,
      },
      writeError: vi.fn(),
    });

    const listener = listeners.get("SIGTERM");
    listener?.();
    listener?.();
    expect(terminateActiveChildren).toHaveBeenCalledOnce();
    releaseChildReap();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(containerCleanup).toHaveBeenCalledOnce();
    expect(runtimeCleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "terminate-child",
      "child-reaped",
      "container",
      "task-home",
    ]);
  });
});
