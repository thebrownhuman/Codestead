// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  terminateImmediately: vi.fn(),
}));

vi.mock("../mail-dispatch-fatal-termination", () => ({
  terminateMailDispatchImmediately: mocks.terminateImmediately,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");

  class ClosingChild extends EventEmitter {
    connected = true;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    constructor() {
      super();
      queueMicrotask(() => {
        this.emit("message", { type: "READY" });
      });
    }

    send(
      message: unknown,
      callback?: (error: Error | null) => void,
    ): boolean {
      if (
        !message
        || typeof message !== "object"
        || (message as { type?: unknown }).type !== "CLOSE"
      ) {
        throw new Error("Unexpected fake-child message.");
      }

      this.exitCode = 0;
      this.emit("message", { type: "CLOSED" });
      this.connected = false;
      this.emit("disconnect");
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
      callback?.(null);
      return true;
    }

    kill(): boolean {
      this.signalCode = "SIGKILL";
      return true;
    }
  }

  return {
    ...actual,
    fork: vi.fn(() => new ClosingChild()),
  };
});

import {
  startMailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";

describe("mail dispatch watchdog close ordering", () => {
  beforeEach(() => {
    mocks.terminateImmediately.mockClear();
  });

  it("accepts CLOSED before same-turn disconnect and exit events", async () => {
    const controller = await startMailDispatchHardWatchdog();

    await expect(controller.close()).resolves.toBeUndefined();
    expect(mocks.terminateImmediately).not.toHaveBeenCalled();
  });
});
