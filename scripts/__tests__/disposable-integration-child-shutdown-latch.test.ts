import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createDisposableIntegrationChildController } from
  "../lib/disposable-integration-child-controller";

class ShutdownLatchFakeChild extends EventEmitter {
  exitCode: number | null = null;
  pid = 2468;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

describe("disposable integration child shutdown latch", () => {
  it("rejects a queued spawn after shutdown begins with no active child", async () => {
    const controller = createDisposableIntegrationChildController({
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 100,
      isTreeAlive: () => false,
      terminate: () => undefined,
    });
    const shutdown = controller.terminateAndWait("SIGTERM");
    let spawned = false;

    expect(() => controller.spawnAndTrack(() => {
      spawned = true;
      return new ShutdownLatchFakeChild();
    })).toThrow("child_spawn_after_shutdown");
    expect(spawned).toBe(false);
    await shutdown;
  });

  it("reaps a residual tree after a successful root close before release", async () => {
    const child = new ShutdownLatchFakeChild();
    const signals: NodeJS.Signals[] = [];
    let treeAlive = true;
    const controller = createDisposableIntegrationChildController({
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 100,
      isTreeAlive: () => treeAlive,
      terminate: (_target, signal) => {
        signals.push(signal);
      },
    });
    const tracked = controller.spawnAndTrack(() => child);
    child.exitCode = 0;
    child.emit("close");

    let settled = false;
    const completion = tracked.completeAndWait("SIGTERM").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);
    expect(controller.hasActiveChild()).toBe(true);

    treeAlive = false;
    await completion;
    expect(settled).toBe(true);
    expect(controller.hasActiveChild()).toBe(false);
  });

  it("propagates a fixed reap failure on an organic abnormal close", async () => {
    const child = new ShutdownLatchFakeChild();
    const controller = createDisposableIntegrationChildController({
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      isTreeAlive: () => true,
      terminate: () => undefined,
    });
    const tracked = controller.spawnAndTrack(() => child);
    child.exitCode = 1;
    child.emit("close");

    await expect(tracked.completeAndWait("SIGTERM")).rejects.toThrow(
      "active_child_reap_failed",
    );
  });
});
