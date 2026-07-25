import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createFullSchemaRestoreLifecycle,
} from "../lib/full-schema-restore-lifecycle";

type Signal = "SIGINT" | "SIGTERM";

function fakeProcessTarget() {
  const listeners = new Map<Signal, () => void>();
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    listeners,
    exited,
    target: {
      once: (signal: Signal, listener: () => void) => {
        listeners.set(signal, listener);
      },
      removeListener: vi.fn(),
      exit: vi.fn((code: number) => {
        resolveExit(code);
      }),
    },
  };
}

describe("full-schema restore lifecycle ownership", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "settles the active child before exact container/root cleanup on %s",
    async (signal, exitCode) => {
      const trace: string[] = [];
      const processTarget = fakeProcessTarget();
      const lifecycle = createFullSchemaRestoreLifecycle({
        childController: {
          hasActiveChild: () => true,
          terminateAndWait: async (received) => {
            trace.push(`child:${received}`);
          },
        },
        processTarget: processTarget.target,
        writeError: vi.fn(),
      });

      lifecycle.ownTaskRoot(() => {
        trace.push("root");
      });
      lifecycle.ownContainer("source", {
        cleanup: () => { trace.push("source"); },
      });
      lifecycle.ownContainer("target", {
        cleanup: () => { trace.push("target"); },
      });

      processTarget.listeners.get(signal)!();
      await expect(processTarget.exited).resolves.toBe(exitCode);
      expect(trace).toEqual([
        `child:${signal}`,
        "target",
        "source",
        "root",
      ]);
    },
  );

  it("attempts every cleanup once and emits only a fixed failure", async () => {
    const trace: string[] = [];
    const processTarget = fakeProcessTarget();
    const writeError = vi.fn();
    const lifecycle = createFullSchemaRestoreLifecycle({
      childController: {
        hasActiveChild: () => true,
        terminateAndWait: async () => {
          trace.push("child");
          throw new Error("sensitive child failure");
        },
      },
      processTarget: processTarget.target,
      writeError,
    });
    lifecycle.ownTaskRoot(() => {
      trace.push("root");
      throw new Error("sensitive root failure");
    });
    lifecycle.ownContainer("source", {
      cleanup: () => {
        trace.push("source");
        throw new Error("sensitive source failure");
      },
    });
    lifecycle.ownContainer("target", {
      cleanup: () => {
        trace.push("target");
        throw new Error("sensitive target failure");
      },
    });

    processTarget.listeners.get("SIGTERM")!();
    processTarget.listeners.get("SIGINT")!();
    await expect(processTarget.exited).resolves.toBe(1);
    expect(trace).toEqual(["child", "target", "source", "root"]);
    expect(writeError).toHaveBeenCalledOnce();
    expect(writeError).toHaveBeenCalledWith(
      "Full-schema restore gate failed: signal_cleanup_failed\n",
    );
    expect(JSON.stringify(writeError.mock.calls)).not.toMatch(/sensitive/u);
  });

  it("reaps a real child held open before signal cleanup", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    await once(child, "spawn");
    let childClosed = false;
    child.once("close", () => {
      childClosed = true;
    });
    const processTarget = fakeProcessTarget();
    const lifecycle = createFullSchemaRestoreLifecycle({
      childController: {
        hasActiveChild: () => !childClosed,
        terminateAndWait: async (signal) => {
          if (childClosed) return;
          const closed = once(child, "close");
          child.kill(signal);
          await closed;
        },
      },
      processTarget: processTarget.target,
      writeError: vi.fn(),
    });
    lifecycle.ownTaskRoot(() => {
      expect(childClosed).toBe(true);
    });
    lifecycle.ownContainer("source", {
      cleanup: () => {
        expect(childClosed).toBe(true);
      },
    });
    lifecycle.ownContainer("target", {
      cleanup: () => {
        expect(childClosed).toBe(true);
      },
    });

    processTarget.listeners.get("SIGTERM")!();
    await expect(processTarget.exited).resolves.toBe(143);
    expect(childClosed).toBe(true);
  }, 10_000);
});
