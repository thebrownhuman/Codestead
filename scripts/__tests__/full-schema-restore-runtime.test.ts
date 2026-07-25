import { describe, expect, it, vi } from "vitest";

import {
  buildPostgresArchiveCommands,
  parseFullSchemaRestorePostgresMajor,
  requireOwnedRestoreContainerId,
  runWithRestoreContainerPair,
  runWithRestoreTaskRoot,
} from "../lib/full-schema-restore-runtime";

const sourceId = "a".repeat(64);
const targetId = "b".repeat(64);

describe("full-schema restore runtime selection", () => {
  it.each([
    [[], 17],
    [["--postgres-major=17"], 17],
    [["--postgres-major=18"], 18],
  ])("accepts only the pinned PG17 primary and targeted PG18: %j", (
    args,
    expected,
  ) => {
    expect(parseFullSchemaRestorePostgresMajor(args)).toBe(expected);
  });

  it.each([
    ["--postgres-major=16"],
    ["--postgres-major=latest"],
    ["--postgres-major=17", "--postgres-major=18"],
    ["--image=postgres:latest"],
    ["--postgres-major=17", "--extra"],
  ])("rejects unreviewed runtime arguments: %j", (...args) => {
    expect(() => parseFullSchemaRestorePostgresMajor(args))
      .toThrow("full-schema restore arguments are invalid");
  });
});

describe("full-schema restore exact container authority", () => {
  it("accepts one exact full ID with the two ownership labels", () => {
    expect(requireOwnedRestoreContainerId({
      expectedName: "codestead-full-restore-source-1234abcd",
      expectedRole: "source",
      listedIds: `${sourceId}\n`,
      inspection: {
        id: sourceId,
        name: "/codestead-full-restore-source-1234abcd",
        purpose: "disposable-integration-test",
        run: "codestead-full-restore-source-1234abcd",
        restoreRole: "source",
      },
    })).toBe(sourceId);
  });

  it.each([
    {
      name: "short ID",
      input: { listedIds: "abc\n" },
    },
    {
      name: "multiple IDs",
      input: { listedIds: `${sourceId}\n${targetId}\n` },
    },
    {
      name: "name swap",
      input: { inspection: { name: "/attacker" } },
    },
    {
      name: "missing run label",
      input: { inspection: { run: "" } },
    },
    {
      name: "wrong restore role",
      input: { inspection: { restoreRole: "target" } },
    },
  ])("rejects a $name", ({ input }) => {
    expect(() => requireOwnedRestoreContainerId({
      expectedName: "codestead-full-restore-source-1234abcd",
      expectedRole: "source",
      listedIds: `${sourceId}\n`,
      ...input,
      inspection: {
        id: sourceId,
        name: "/codestead-full-restore-source-1234abcd",
        purpose: "disposable-integration-test",
        run: "codestead-full-restore-source-1234abcd",
        restoreRole: "source",
        ...input.inspection,
      },
    })).toThrow("full-schema restore container identity is invalid");
  });

  it("builds password-free exact-ID dump and restore commands", () => {
    expect(buildPostgresArchiveCommands({
      dockerCommand: "docker",
      sourceContainerId: sourceId,
      targetContainerId: targetId,
      sourceDatabase: "learncoding_restore_source",
      targetDatabase: "learncoding_restore_target",
      postgresUser: "learncoding_restore_it",
    })).toEqual({
      dump: {
        command: "docker",
        args: [
          "exec",
          sourceId,
          "pg_dump",
          "--format=custom",
          "--compress=0",
          "--no-password",
          "--username=learncoding_restore_it",
          "--dbname=learncoding_restore_source",
        ],
      },
      restore: {
        command: "docker",
        args: [
          "exec",
          "--interactive",
          targetId,
          "pg_restore",
          "--clean",
          "--if-exists",
          "--exit-on-error",
          "--single-transaction",
          "--no-password",
          "--username=learncoding_restore_it",
          "--dbname=learncoding_restore_target",
        ],
      },
    });
    expect(JSON.stringify(buildPostgresArchiveCommands({
      dockerCommand: "docker",
      sourceContainerId: sourceId,
      targetContainerId: targetId,
      sourceDatabase: "learncoding_restore_source",
      targetDatabase: "learncoding_restore_target",
      postgresUser: "learncoding_restore_it",
    }))).not.toMatch(/password=|postgresql:\/\//iu);
  });
});

describe("full-schema restore paired cleanup", () => {
  it("cleans target then source after success", async () => {
    const trace: string[] = [];
    await expect(runWithRestoreContainerPair({
      source: {
        start: () => { trace.push("source.start"); },
        cleanup: () => { trace.push("source.cleanup"); },
      },
      target: {
        start: () => { trace.push("target.start"); },
        cleanup: () => { trace.push("target.cleanup"); },
      },
      operation: async () => {
        trace.push("operation");
        return "ok";
      },
    })).resolves.toBe("ok");
    expect(trace).toEqual([
      "source.start",
      "target.start",
      "operation",
      "target.cleanup",
      "source.cleanup",
    ]);
  });

  it("attempts both cleanups and emits only a fixed failure on combined failure", async () => {
    const sourceCleanup = vi.fn(() => {
      throw new Error("secret-source-cleanup");
    });
    const targetCleanup = vi.fn(() => {
      throw new Error("secret-target-cleanup");
    });

    await expect(runWithRestoreContainerPair({
      source: { start: vi.fn(), cleanup: sourceCleanup },
      target: { start: vi.fn(), cleanup: targetCleanup },
      operation: async () => {
        throw new Error("secret-operation");
      },
    })).rejects.toThrow(
      "full-schema restore operation and cleanup failed",
    );
    await expect(runWithRestoreContainerPair({
      source: { start: vi.fn(), cleanup: sourceCleanup },
      target: { start: vi.fn(), cleanup: targetCleanup },
      operation: async () => {
        throw new Error("secret-operation");
      },
    })).rejects.not.toThrow(/secret-/u);
    expect(sourceCleanup).toHaveBeenCalledTimes(2);
    expect(targetCleanup).toHaveBeenCalledTimes(2);
  });
});

describe("full-schema restore task-root cleanup", () => {
  it("cleans the task root when setup fails before containers start", async () => {
    const cleanup = vi.fn();

    await expect(runWithRestoreTaskRoot({
      cleanup,
      operation: async () => {
        throw new Error("sensitive setup failure");
      },
    })).rejects.toThrow("full-schema restore task operation failed");

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("attempts cleanup and emits only a fixed combined failure", async () => {
    const cleanup = vi.fn(() => {
      throw new Error("sensitive cleanup failure");
    });

    const operation = runWithRestoreTaskRoot({
      cleanup,
      operation: async () => {
        throw new Error("sensitive operation failure");
      },
    });

    await expect(operation).rejects.toThrow(
      "full-schema restore task operation and cleanup failed",
    );
    await expect(operation).rejects.not.toThrow(/sensitive/u);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
