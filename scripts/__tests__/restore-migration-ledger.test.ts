import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  deriveCheckedInRestoreMigrationLedger,
  verifyRestoredMigrationLedger,
} from "../lib/restore-migration-ledger.mjs";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

type Query = (
  sql: string,
  values?: readonly unknown[],
) => Promise<Readonly<{
  rows: readonly Record<string, unknown>[];
}>>;

const journal = {
  version: "7",
  dialect: "postgresql",
  entries: Array.from({ length: 64 }, (_, idx) => ({
    idx,
    version: "7",
    when: 1_780_000_000_000 + idx,
    tag: `${String(idx).padStart(4, "0")}_restore_ledger_${idx}`,
    breakpoints: true,
  })),
};
const sqlSources = journal.entries.map((entry) =>
  `select '${entry.tag}';\n`);

describe("pre-repair restored migration ledger", () => {
  it("derives every ordered checked-in migration hash", () => {
    const expected = deriveCheckedInRestoreMigrationLedger(
      journal,
      sqlSources,
    );

    expect(expected).toHaveLength(64);
    expect(expected[0]).toEqual({
      migration_index: "0",
      migration_sha256: digest(sqlSources[0]!),
      migration_when: String(journal.entries[0]!.when),
    });
    expect(expected[63]).toEqual({
      migration_index: "63",
      migration_sha256: digest(sqlSources[63]!),
      migration_when: String(journal.entries[63]!.when),
    });
  });

  it("compares the complete ordered database ledger, including early rows", async () => {
    const expected = deriveCheckedInRestoreMigrationLedger(
      journal,
      sqlSources,
    );
    const query = vi.fn<Query>(async () => ({ rows: expected }));

    await expect(verifyRestoredMigrationLedger({ query }, expected))
      .resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain(
      "drizzle.__drizzle_migrations",
    );

    const mutated = expected.map((row, index) => index === 1
      ? { ...row, migration_sha256: digest("mutated") }
      : row);
    await expect(verifyRestoredMigrationLedger({
      query: async () => ({ rows: mutated }),
    }, expected)).rejects.toThrow(
      "pre-repair restored migration ledger verification failed",
    );
  });

  it.each([
    ["missing tail", (rows: readonly Record<string, string>[]) =>
      rows.slice(0, -1)],
    ["duplicate row", (rows: readonly Record<string, string>[]) =>
      [...rows.slice(0, -1), rows[0]!]],
    ["changed timestamp", (rows: readonly Record<string, string>[]) =>
      rows.map((row, index) => index === 20
        ? { ...row, migration_when: "1780000999999" }
        : row)],
  ])("rejects a %s", async (_name, mutate) => {
    const expected = deriveCheckedInRestoreMigrationLedger(
      journal,
      sqlSources,
    );
    await expect(verifyRestoredMigrationLedger({
      query: async () => ({ rows: mutate(expected) }),
    }, expected)).rejects.toThrow(
      "pre-repair restored migration ledger verification failed",
    );
  });

  it("wires the wrapper and operations image to the checked-in ledger", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const [wrapper, dockerfile] = await Promise.all([
      readFile(
        path.join(
          root,
          "scripts/verify-pre-repair-restored-database.mjs",
        ),
        "utf8",
      ),
      readFile(path.join(root, "Dockerfile"), "utf8"),
    ]);

    expect(wrapper).toContain(
      "readCheckedInRestoreMigrationLedger",
    );
    expect(wrapper).toContain("verifyRestoredMigrationLedger");
    expect(dockerfile).toContain(
      "COPY --chown=node:node drizzle ./drizzle",
    );
    expect(dockerfile).toContain(
      "scripts/lib/restore-migration-ledger.mjs",
    );
  });
});
