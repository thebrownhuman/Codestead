import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  deriveMigrationTailContract,
  runFullSchemaRestoreVerification,
  type FullSchemaRestoreSnapshot,
} from "../lib/full-schema-restore-gate";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const journal = {
  version: "7",
  dialect: "postgresql",
  entries: [
    {
      idx: 0,
      version: "7",
      when: 1_783_804_640_793,
      tag: "0000_workable_deadpool",
      breakpoints: true,
    },
    {
      idx: 1,
      version: "7",
      when: 1_783_804_714_660,
      tag: "0001_nostalgic_thunderball",
      breakpoints: true,
    },
  ],
} as const;

const tailSql = "select 'tail';\n";
const migration = {
  entryCount: 2,
  tailIndex: 1,
  tailTag: "0001_nostalgic_thunderball",
  tailWhen: 1_783_804_714_660,
  tailSha256: digest(tailSql),
} as const;

function snapshot(
  overrides: Partial<FullSchemaRestoreSnapshot> = {},
): FullSchemaRestoreSnapshot {
  return {
    postgresMajor: 17,
    journalEntryCount: migration.entryCount,
    journalTailSha256: migration.tailSha256,
    journalTailWhen: migration.tailWhen,
    objectContractSha256: digest("objects"),
    mailRowsSha256: digest("mail-rows"),
    mailRowCount: 4,
    ...overrides,
  };
}

describe("full-schema restore migration contract", () => {
  it("derives the exact dynamic tail and SQL digest from a contiguous journal", () => {
    expect(deriveMigrationTailContract(journal, tailSql)).toEqual(migration);
  });

  it("tracks the checked-in journal tail instead of hard-coding a migration number", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const source = await readFile(
      path.join(root, "drizzle/meta/_journal.json"),
      "utf8",
    );
    const checkedInJournal = JSON.parse(source) as unknown;
    const entries = (checkedInJournal as {
      entries: Array<{ tag: string }>;
    }).entries;
    const tail = entries.at(-1);
    expect(tail).toBeDefined();
    const checkedInTailSql = await readFile(
      path.join(root, "drizzle", `${tail!.tag}.sql`),
      "utf8",
    );

    const contract = deriveMigrationTailContract(
      checkedInJournal,
      checkedInTailSql,
    );

    expect(contract.entryCount).toBe(entries.length);
    expect(contract.tailIndex).toBe(entries.length - 1);
    expect(contract.tailTag).toBe(tail!.tag);
    expect(contract.tailSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    {
      name: "journal index gap",
      value: {
        ...journal,
        entries: [journal.entries[0], { ...journal.entries[1], idx: 2 }],
      },
    },
    {
      name: "tag prefix mismatch",
      value: {
        ...journal,
        entries: [
          journal.entries[0],
          { ...journal.entries[1], tag: "0064_nostalgic_thunderball" },
        ],
      },
    },
    {
      name: "duplicate or non-monotonic timestamp",
      value: {
        ...journal,
        entries: [
          journal.entries[0],
          { ...journal.entries[1], when: journal.entries[0].when },
        ],
      },
    },
  ])("rejects a $name", ({ value }) => {
    expect(() => deriveMigrationTailContract(value, tailSql))
      .toThrow("full-schema restore migration journal is invalid");
  });
});

describe("full-schema restore verification", () => {
  it("orders source migration, isolated restore, post-restore reconciliation, and smoke", async () => {
    const trace: string[] = [];
    const sourceSnapshot = snapshot();
    const restoredSnapshot = snapshot();
    const result = await runFullSchemaRestoreVerification({
      expectedPostgresMajor: 17,
      migration,
      source: {
        reconcileRoles: async () => { trace.push("source.roles"); },
        verifyRoleBoundaries: async (requireApplicationObjects) => {
          trace.push(`source.boundary:${String(requireApplicationObjects)}`);
        },
        migrate: async () => { trace.push("source.migrate"); },
        seedRepresentativeMailRows: async () => {
          trace.push("source.seed");
        },
        snapshot: async () => {
          trace.push("source.snapshot");
          return sourceSnapshot;
        },
      },
      target: {
        reconcileRoles: async () => { trace.push("target.roles"); },
        verifyRoleBoundaries: async (requireApplicationObjects) => {
          trace.push(`target.boundary:${String(requireApplicationObjects)}`);
        },
        snapshot: async () => {
          trace.push("target.snapshot");
          return restoredSnapshot;
        },
        runNonNetworkSmoke: async () => {
          trace.push("target.smoke");
          return {
            claimedRows: 1,
            redactedRows: 2,
            externalCalls: 0,
          };
        },
      },
      dumpSource: async () => {
        trace.push("archive.dump");
        return { opaqueArchive: true };
      },
      restoreTarget: async (archive) => {
        expect(archive).toEqual({ opaqueArchive: true });
        trace.push("archive.restore");
      },
      disposeArchive: (archive) => {
        expect(archive).toEqual({ opaqueArchive: true });
        trace.push("archive.dispose");
      },
    });

    expect(trace).toEqual([
      "source.roles",
      "source.boundary:false",
      "source.migrate",
      "source.roles",
      "source.boundary:true",
      "source.seed",
      "source.snapshot",
      "archive.dump",
      "target.roles",
      "target.boundary:false",
      "archive.restore",
      "archive.dispose",
      "target.roles",
      "target.boundary:true",
      "target.snapshot",
      "target.smoke",
    ]);
    expect(result).toEqual({
      migration,
      source: sourceSnapshot,
      restored: restoredSnapshot,
      smoke: {
        claimedRows: 1,
        redactedRows: 2,
        externalCalls: 0,
      },
    });
  });

  it.each([
    ["PostgreSQL major", { postgresMajor: 18 }],
    ["journal count", { journalEntryCount: 1 }],
    ["journal tail hash", { journalTailSha256: digest("wrong-tail") }],
    ["journal tail timestamp", { journalTailWhen: migration.tailWhen + 1 }],
    ["object owner or ACL digest", { objectContractSha256: digest("wrong-object") }],
    ["mail row digest", { mailRowsSha256: digest("wrong-row") }],
    ["mail row count", { mailRowCount: 3 }],
  ])("fails closed on a restored %s mismatch before smoke", async (
    _name,
    restoredOverride,
  ) => {
    const smoke = vi.fn(async () => ({
      claimedRows: 1,
      redactedRows: 1,
      externalCalls: 0,
    }));

    await expect(runFullSchemaRestoreVerification({
      expectedPostgresMajor: 17,
      migration,
      source: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        migrate: async () => undefined,
        seedRepresentativeMailRows: async () => undefined,
        snapshot: async () => snapshot(),
      },
      target: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        snapshot: async () => snapshot(restoredOverride),
        runNonNetworkSmoke: smoke,
      },
      dumpSource: async () => "archive",
      restoreTarget: async () => undefined,
      disposeArchive: () => undefined,
    })).rejects.toThrow("full-schema restore verification failed");

    expect(smoke).not.toHaveBeenCalled();
  });

  it.each([
    { claimedRows: 0, redactedRows: 2, externalCalls: 0 },
    { claimedRows: 1, redactedRows: 0, externalCalls: 0 },
    { claimedRows: 1, redactedRows: 1, externalCalls: 0 },
    { claimedRows: 1, redactedRows: 2, externalCalls: 1 },
  ])("rejects incomplete or network-capable smoke evidence %#", async (smoke) => {
    await expect(runFullSchemaRestoreVerification({
      expectedPostgresMajor: 17,
      migration,
      source: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        migrate: async () => undefined,
        seedRepresentativeMailRows: async () => undefined,
        snapshot: async () => snapshot(),
      },
      target: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        snapshot: async () => snapshot(),
        runNonNetworkSmoke: async () => smoke,
      },
      dumpSource: async () => "archive",
      restoreTarget: async () => undefined,
      disposeArchive: () => undefined,
    })).rejects.toThrow("full-schema restore smoke verification failed");
  });

  it("disposes the archive when target setup fails before restore", async () => {
    const archive = { sensitive: true };
    const restore = vi.fn(async () => undefined);
    const dispose = vi.fn();

    await expect(runFullSchemaRestoreVerification({
      expectedPostgresMajor: 17,
      migration,
      source: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        migrate: async () => undefined,
        seedRepresentativeMailRows: async () => undefined,
        snapshot: async () => snapshot(),
      },
      target: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async (requireApplicationObjects) => {
          if (!requireApplicationObjects) {
            throw new Error("target setup failed");
          }
        },
        snapshot: async () => snapshot(),
        runNonNetworkSmoke: async () => ({
          claimedRows: 1,
          redactedRows: 2,
          externalCalls: 0,
        }),
      },
      dumpSource: async () => archive,
      restoreTarget: restore,
      disposeArchive: dispose,
    })).rejects.toThrow("target setup failed");

    expect(restore).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(archive);
  });
});
