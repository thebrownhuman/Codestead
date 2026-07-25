import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createDisposableIntegrationChildController } from
  "../lib/disposable-integration-child-controller";

class BarrierFakeChild extends EventEmitter {
  exitCode: number | null = null;
  pid = 9876;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

describe("disposable integration child termination barrier", () => {
  it("does not release normal child completion ahead of tree reaping", async () => {
    const child = new BarrierFakeChild();
    let treeAlive = true;
    const controller = createDisposableIntegrationChildController({
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 100,
      isTreeAlive: () => treeAlive,
      terminate: (_child, signal) => {
        child.signalCode = signal;
        child.emit("close");
      },
    });
    controller.spawnAndTrack(() => child);

    const termination = controller.terminateAndWait("SIGTERM");
    let barrierSettled = false;
    const barrier = controller.waitForTermination().then(() => {
      barrierSettled = true;
    });
    await Promise.resolve();
    expect(barrierSettled).toBe(false);

    treeAlive = false;
    await Promise.all([termination, barrier]);
    expect(barrierSettled).toBe(true);
  });

  it("retains a closed root for a later parent-signal tree reap", async () => {
    const child = new BarrierFakeChild();
    const signals: NodeJS.Signals[] = [];
    let treeAlive = true;
    const controller = createDisposableIntegrationChildController({
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 100,
      isTreeAlive: () => treeAlive,
      terminate: (_child, signal) => {
        signals.push(signal);
      },
    });
    controller.spawnAndTrack(() => child);
    child.signalCode = "SIGINT";
    child.emit("close");

    expect(controller.hasActiveChild()).toBe(true);
    const termination = controller.terminateAndWait("SIGINT");
    const concurrent = controller.terminateAndWait("SIGTERM");
    expect(concurrent).toBe(termination);
    await Promise.resolve();
    expect(signals).toEqual(["SIGINT"]);

    treeAlive = false;
    await termination;
    expect(controller.hasActiveChild()).toBe(false);
  });
});
