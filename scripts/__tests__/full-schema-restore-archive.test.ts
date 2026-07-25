import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  requireSuccessfulFullSchemaArchiveDump,
  runFullSchemaArchiveChild,
  type FullSchemaArchiveChildResult,
} from "../lib/full-schema-restore-archive";

function result(
  stdout: Buffer,
  overrides: Partial<FullSchemaArchiveChildResult> = {},
): FullSchemaArchiveChildResult {
  return {
    exitCode: 0,
    failed: false,
    signalCode: null,
    stdout,
    ...overrides,
  };
}

describe("full-schema restore archive result authority", () => {
  it("returns the exact successful non-empty dump buffer", () => {
    const archive = Buffer.from("archive");
    expect(requireSuccessfulFullSchemaArchiveDump(
      result(archive),
    )).toBe(archive);
  });

  it.each([
    { exitCode: 1 },
    { failed: true },
    { signalCode: "SIGTERM" as const },
  ])("zeros partial pg_dump stdout before failing closed: %#", (
    failure,
  ) => {
    const partial = Buffer.from("sensitive-partial-archive");

    expect(() => requireSuccessfulFullSchemaArchiveDump(result(
      partial,
      failure,
    ))).toThrow("full-schema restore dump failed");

    expect(partial.every((value) => value === 0)).toBe(true);
  });

  it("rejects and zeroes an empty dump buffer", () => {
    const empty = Buffer.alloc(0);
    expect(() => requireSuccessfulFullSchemaArchiveDump(result(empty)))
      .toThrow("full-schema restore dump failed");
  });

  it.each(["timeout", "overflow", "stdin-error"] as const)(
    "fails boundedly and zeros partial output on %s when reap rejects without close",
    async (failureMode) => {
    const partial = Buffer.from("sensitive-partial-archive");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: () => false,
      pid: 4242,
      signalCode: null,
      stderr,
      stdin,
      stdout,
      unref: () => child,
    }) as unknown as ChildProcessWithoutNullStreams;
    let completeCalls = 0;
    const controller = {
      hasActiveChild: () => true,
      spawnAndTrack: (
        spawnChild: () => ChildProcessWithoutNullStreams,
      ) => {
        expect(spawnChild()).toBe(child);
        queueMicrotask(() => {
          stdout.emit("data", partial);
        });
        if (failureMode === "stdin-error") {
          queueMicrotask(() => {
            stdin.emit("error", new Error("synthetic EPIPE"));
          });
        }
        return {
          child,
          completeAndWait: async () => {
            completeCalls += 1;
            throw new Error("synthetic reap failure");
          },
        };
      },
      terminateAndWait: async () => undefined,
      waitForTermination: async () => undefined,
    };

    const maxStdoutBytes = failureMode === "overflow" ? 4 : 1024;
    const uncaught: unknown[] = [];
    const handleUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", handleUncaught);

    const operation = runFullSchemaArchiveChild({
      command: "docker",
      args: ["exec", "source", "pg_dump"],
      environment: { NODE_ENV: "test" },
      maxStdoutBytes,
      timeoutMs: failureMode === "stdin-error" ? 5_000 : 5,
      controller,
      stdin: failureMode === "stdin-error"
        ? Buffer.from("archive-input")
        : undefined,
      buildChildLaunch: ({ command, args, environment }) => ({
        command,
        args,
        environment,
        treeSupervised: false,
      }),
      spawnProcess: () => child,
    });
    try {
      await expect(operation).rejects.toThrow(
        "full-schema restore archive child failed",
      );
    } finally {
      process.removeListener("uncaughtException", handleUncaught);
    }

    expect(() => stdin.emit("error", new Error("late EPIPE")))
      .not.toThrow();
    expect(completeCalls).toBe(1);
    expect(uncaught).toEqual([]);
    expect(partial.every((value) => value === 0)).toBe(true);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
    expect(stdin.destroyed).toBe(true);
    stdout.destroy();
    stderr.destroy();
    stdin.destroy();
    },
  );
});
