import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  deriveMigrationLedgerContract,
  requireFullSchemaRestoreMigrationContract,
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

const migrationSql = ["select 'initial';\n", "select 'tail';\n"] as const;
const tailSql = "select 'tail';\n";
const ledgerDigest = (
  entries: readonly Record<string, string>[],
) => digest(JSON.stringify({
  entries,
  version: "drizzle-migration-ledger-v1",
}));
const derivedMigration = {
  entries: [
    {
      idx: 0,
      tag: "0000_workable_deadpool",
      when: 1_783_804_640_793,
      sqlSha256: digest(migrationSql[0]),
    },
    {
      idx: 1,
      tag: "0001_nostalgic_thunderball",
      when: 1_783_804_714_660,
      sqlSha256: digest(migrationSql[1]),
    },
  ],
  entryCount: 2,
  tailIndex: 1,
  tailTag: "0001_nostalgic_thunderball",
  tailWhen: 1_783_804_714_660,
  tailSha256: digest(tailSql),
  databaseLedgerSha256: ledgerDigest([
    {
      migration_index: "0",
      migration_sha256: digest(migrationSql[0]),
      migration_when: "1783804640793",
    },
    {
      migration_index: "1",
      migration_sha256: digest(migrationSql[1]),
      migration_when: "1783804714660",
    },
  ]),
} as const;
const releaseJournal = {
  version: "7",
  dialect: "postgresql",
  entries: Array.from({ length: 64 }, (_, idx) => ({
    idx,
    version: "7",
    when: 1_785_000_000_000 + idx,
    tag: `${String(idx).padStart(4, "0")}_restore_gate_${idx}`,
    breakpoints: true,
  })),
};
const releaseSql = releaseJournal.entries.map((entry) =>
  `select '${entry.tag}';\n`);
const migration = deriveMigrationLedgerContract(releaseJournal, releaseSql);

function snapshot(
  overrides: Partial<FullSchemaRestoreSnapshot> = {},
): FullSchemaRestoreSnapshot {
  return {
    postgresMajor: 17,
    journalEntryCount: migration.entryCount,
    journalTailSha256: migration.tailSha256,
    journalTailWhen: migration.tailWhen,
    migrationLedgerSha256: migration.databaseLedgerSha256,
    objectContractSha256: digest("objects"),
    mailRowsSha256: digest("mail-rows"),
    mailRowCount: 4,
    ...overrides,
  };
}

describe("full-schema restore migration contract", () => {
  it("derives the exact dynamic tail and SQL digest from a contiguous journal", () => {
    expect(deriveMigrationLedgerContract(journal, migrationSql)).toEqual(
      derivedMigration,
    );
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
    const sqlSources = await Promise.all(entries.map((entry) =>
      readFile(path.join(root, "drizzle", `${entry.tag}.sql`), "utf8")));
    const tail = entries.at(-1)!;

    const contract = deriveMigrationLedgerContract(
      checkedInJournal,
      sqlSources,
    );

    expect(contract.entryCount).toBe(entries.length);
    expect(contract.tailIndex).toBe(entries.length - 1);
    expect(contract.tailTag).toBe(tail!.tag);
    expect(contract.tailSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(contract.entries).toHaveLength(entries.length);
    expect(contract.databaseLedgerSha256).toMatch(/^[0-9a-f]{64}$/u);
    if (contract.tailIndex < 63) {
      expect(() => requireFullSchemaRestoreMigrationContract(contract))
        .toThrow("full-schema restore requires migration 0063 or later");
    } else {
      expect(requireFullSchemaRestoreMigrationContract(contract)).toBe(
        contract,
      );
    }
  });

  it("rejects a pre-0063 journal contract with a clear gate error", () => {
    expect(() =>
      requireFullSchemaRestoreMigrationContract(derivedMigration)
    ).toThrow("full-schema restore requires migration 0063 or later");
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
    expect(() => deriveMigrationLedgerContract(value, migrationSql))
      .toThrow("full-schema restore migration journal is invalid");
  });

  it("detects an earlier SQL mutation even when count and tail are unchanged", () => {
    const mutated = deriveMigrationLedgerContract(journal, [
      "select 'mutated initial';\n",
      migrationSql[1],
    ]);
    expect(mutated.entryCount).toBe(derivedMigration.entryCount);
    expect(mutated.tailSha256).toBe(derivedMigration.tailSha256);
    expect(mutated.tailWhen).toBe(derivedMigration.tailWhen);
    expect(mutated.entries[0]!.sqlSha256)
      .not.toBe(derivedMigration.entries[0]!.sqlSha256);
    expect(mutated.databaseLedgerSha256)
      .not.toBe(derivedMigration.databaseLedgerSha256);
  });
});

describe("full-schema restore verification", () => {
  it("rejects pre-0063 before touching either database", async () => {
    const sourceReconcile = vi.fn(async () => undefined);

    await expect(runFullSchemaRestoreVerification({
      expectedPostgresMajor: 17,
      migration: derivedMigration,
      source: {
        reconcileRoles: sourceReconcile,
        verifyRoleBoundaries: async () => undefined,
        verifyMailAuthorityCatalog: async () => undefined,
        migrate: async () => undefined,
        seedRepresentativeMailRows: async () => undefined,
        snapshot: async () => snapshot(),
      },
      target: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        verifyMailAuthorityCatalog: async () => undefined,
        snapshot: async () => snapshot(),
        runNonNetworkSmoke: async () => ({
          claimedRows: 1,
          redactedRows: 2,
          externalCalls: 0,
        }),
      },
      dumpSource: async () => "archive",
      restoreTarget: async () => undefined,
      disposeArchive: () => undefined,
    })).rejects.toThrow(
      "full-schema restore requires migration 0063 or later",
    );

    expect(sourceReconcile).not.toHaveBeenCalled();
  });

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
        verifyMailAuthorityCatalog: async () => {
          trace.push("source.catalog");
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
        verifyMailAuthorityCatalog: async () => {
          trace.push("target.catalog");
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
      "source.catalog",
      "source.roles",
      "source.boundary:true",
      "source.catalog",
      "source.seed",
      "source.snapshot",
      "archive.dump",
      "target.roles",
      "target.boundary:false",
      "archive.restore",
      "archive.dispose",
      "target.catalog",
      "target.roles",
      "target.boundary:true",
      "target.catalog",
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

  it.each(["source", "target"] as const)(
    "rejects identical source/target catalog tamper at the %s manifest gate",
    async (failingStage) => {
      const identicalTamper = snapshot({
        objectContractSha256: digest("identical-tampered-routine"),
      });
      const dump = vi.fn(async () => "archive");
      const restore = vi.fn(async () => undefined);
      const sourceCatalog = vi.fn(async () => {
        if (failingStage === "source") {
          throw new Error("reviewed mail-authority catalog failed");
        }
      });
      const targetCatalog = vi.fn(async () => {
        if (failingStage === "target") {
          throw new Error("reviewed mail-authority catalog failed");
        }
      });
      const targetSnapshot = vi.fn(async () => identicalTamper);

      await expect(runFullSchemaRestoreVerification({
        expectedPostgresMajor: 17,
        migration,
        source: {
          reconcileRoles: async () => undefined,
          verifyRoleBoundaries: async () => undefined,
          verifyMailAuthorityCatalog: sourceCatalog,
          migrate: async () => undefined,
          seedRepresentativeMailRows: async () => undefined,
          snapshot: async () => identicalTamper,
        },
        target: {
          reconcileRoles: async () => undefined,
          verifyRoleBoundaries: async () => undefined,
          verifyMailAuthorityCatalog: targetCatalog,
          snapshot: targetSnapshot,
          runNonNetworkSmoke: async () => ({
            claimedRows: 1,
            redactedRows: 2,
            externalCalls: 0,
          }),
        },
        dumpSource: dump,
        restoreTarget: restore,
        disposeArchive: () => undefined,
      })).rejects.toThrow("reviewed mail-authority catalog failed");

      expect(sourceCatalog).toHaveBeenCalledTimes(
        failingStage === "source" ? 1 : 2,
      );
      if (failingStage === "source") {
        expect(dump).not.toHaveBeenCalled();
        expect(targetCatalog).not.toHaveBeenCalled();
      } else {
        expect(dump).toHaveBeenCalledOnce();
        expect(restore).toHaveBeenCalledOnce();
        expect(targetCatalog).toHaveBeenCalledOnce();
        expect(targetSnapshot).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["PostgreSQL major", { postgresMajor: 18 }],
    ["journal count", { journalEntryCount: 1 }],
    ["journal tail hash", { journalTailSha256: digest("wrong-tail") }],
    ["journal tail timestamp", { journalTailWhen: migration.tailWhen + 1 }],
    ["ordered migration ledger", { migrationLedgerSha256: digest("wrong-ledger") }],
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
        verifyMailAuthorityCatalog: async () => undefined,
        migrate: async () => undefined,
        seedRepresentativeMailRows: async () => undefined,
        snapshot: async () => snapshot(),
      },
      target: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        verifyMailAuthorityCatalog: async () => undefined,
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
        verifyMailAuthorityCatalog: async () => undefined,
        migrate: async () => undefined,
        seedRepresentativeMailRows: async () => undefined,
        snapshot: async () => snapshot(),
      },
      target: {
        reconcileRoles: async () => undefined,
        verifyRoleBoundaries: async () => undefined,
        verifyMailAuthorityCatalog: async () => undefined,
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
        verifyMailAuthorityCatalog: async () => undefined,
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
        verifyMailAuthorityCatalog: async () => undefined,
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
