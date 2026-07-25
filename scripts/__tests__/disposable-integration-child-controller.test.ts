import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createDisposableIntegrationChildController } from
  "../lib/disposable-integration-child-controller";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  pid = 1234;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

describe("disposable integration child controller", () => {
  it("terminates and reaps the active child before resolving", async () => {
    const child = new FakeChild();
    const signals: NodeJS.Signals[] = [];
    const controller = createDisposableIntegrationChildController({
      gracefulTimeoutMs: 25,
      forceTimeoutMs: 25,
      isTreeAlive: () => child.signalCode === null,
      terminate: (_child, signal) => {
        signals.push(signal);
        child.signalCode = signal;
        child.emit("close");
      },
    });
    controller.spawnAndTrack(() => child);

    await controller.terminateAndWait("SIGTERM");

    expect(signals).toEqual(["SIGTERM"]);
    expect(controller.hasActiveChild()).toBe(false);
  });

  it("escalates to a forceful tree kill and reports only a fixed failure", async () => {
    const child = new FakeChild();
    const signals: NodeJS.Signals[] = [];
    const controller = createDisposableIntegrationChildController({
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      isTreeAlive: () => true,
      terminate: (_child, signal) => {
        signals.push(signal);
      },
    });
    controller.spawnAndTrack(() => child);

    let failure: unknown;
    try {
      await controller.terminateAndWait("SIGINT");
    } catch (error) {
      failure = error;
    }

    expect(signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(String(failure)).toContain("active_child_reap_failed");
    expect(String(failure)).not.toContain("1234");
  });
});
