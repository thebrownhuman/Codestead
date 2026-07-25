import { describe, expect, it, vi } from "vitest";

import {
  installFullSchemaRestoreSignalHandlers,
} from "../lib/full-schema-restore-signal";

type Signal = "SIGINT" | "SIGTERM";

describe("full-schema restore signal cleanup", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("cleans target, source, and task root before %s exit", (
    signal,
    expectedExit,
  ) => {
    const listeners = new Map<Signal, () => void>();
    const trace: string[] = [];
    const exit = vi.fn();
    installFullSchemaRestoreSignalHandlers({
      source: { cleanup: () => { trace.push("source"); } },
      target: { cleanup: () => { trace.push("target"); } },
      cleanupTaskRoot: () => { trace.push("task"); },
      processTarget: {
        once: (name, listener) => {
          listeners.set(name, listener);
        },
        removeListener: vi.fn(),
        exit,
      },
      writeError: vi.fn(),
    });

    listeners.get(signal)!();

    expect(trace).toEqual(["target", "source", "task"]);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(expectedExit);
  });

  it("attempts every cleanup, emits one fixed error, and exits one on failure", () => {
    const listeners = new Map<Signal, () => void>();
    const trace: string[] = [];
    const exit = vi.fn();
    const writeError = vi.fn();
    installFullSchemaRestoreSignalHandlers({
      source: {
        cleanup: () => {
          trace.push("source");
          throw new Error("source-secret");
        },
      },
      target: {
        cleanup: () => {
          trace.push("target");
          throw new Error("target-secret");
        },
      },
      cleanupTaskRoot: () => {
        trace.push("task");
        throw new Error("task-secret");
      },
      processTarget: {
        once: (name, listener) => {
          listeners.set(name, listener);
        },
        removeListener: vi.fn(),
        exit,
      },
      writeError,
    });

    listeners.get("SIGINT")!();
    listeners.get("SIGTERM")!();

    expect(trace).toEqual(["target", "source", "task"]);
    expect(writeError).toHaveBeenCalledOnce();
    expect(writeError).toHaveBeenCalledWith(
      "Full-schema restore gate failed: signal_cleanup_failed\n",
    );
    expect(JSON.stringify(writeError.mock.calls)).not.toMatch(/secret/u);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("returns an uninstaller for the normal-completion cleanup window", () => {
    const listeners = new Map<Signal, () => void>();
    const removeListener = vi.fn();
    const uninstall = installFullSchemaRestoreSignalHandlers({
      source: { cleanup: vi.fn() },
      target: { cleanup: vi.fn() },
      cleanupTaskRoot: vi.fn(),
      processTarget: {
        once: (name, listener) => {
          listeners.set(name, listener);
        },
        removeListener,
        exit: vi.fn(),
      },
      writeError: vi.fn(),
    });

    uninstall();

    expect(removeListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledWith(
      "SIGINT",
      listeners.get("SIGINT"),
    );
    expect(removeListener).toHaveBeenCalledWith(
      "SIGTERM",
      listeners.get("SIGTERM"),
    );
  });
});
