import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
  appendReviewedMigrationLedgerEntry,
  reviewedMigrationLedgerSha256,
  verifyAppliedMigrationLedger,
  verifyReviewedMigrationRepository,
} from "./reviewed-migration-ledger.mjs";

const repositoryDrizzleDirectory = path.resolve(import.meta.dirname, "../../drizzle");

function withDrizzleFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "codestead-reviewed-ledger-"));
  const drizzleDirectory = path.join(root, "drizzle");
  cpSync(repositoryDrizzleDirectory, drizzleDirectory, { recursive: true });
  try {
    return run(drizzleDirectory);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function mutateJournal(drizzleDirectory, mutate) {
  const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  mutate(journal);
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

function appliedRows(entries = REVIEWED_MIGRATION_LEDGER) {
  return entries.map((entry, offset) => ({
    id: String(offset + 1),
    hash: entry.sqlSha256,
    created_at: String(entry.when),
  }));
}

function appliedLedgerClient({ present = true, rows = appliedRows() } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      if (normalized.includes("reviewed_migration_journal_present")) {
        return {
          rows: [{ reviewed_migration_journal_present: present }],
        };
      }
      if (normalized.includes("reviewed_full_migration_journal_rows")) {
        return { rows };
      }
      throw new Error(`unexpected ledger query: ${normalized}`);
    },
  };
}

test("binds the complete ordered repository ledger through 0064", () => {
  assert.equal(REVIEWED_MIGRATION_LEDGER.length, 65);
  assert.equal(REVIEWED_MIGRATION_LEDGER[0]?.idx, 0);
  assert.equal(REVIEWED_MIGRATION_LEDGER.at(-1)?.idx, 64);
  assert.equal(
    REVIEWED_MIGRATION_LEDGER.at(-1)?.tag,
    "0064_mail_outbox_dispatch_binding",
  );
  assert.match(REVIEWED_MIGRATION_LEDGER_SHA256, /^[0-9a-f]{64}$/u);
  assert.equal(
    reviewedMigrationLedgerSha256(REVIEWED_MIGRATION_LEDGER),
    REVIEWED_MIGRATION_LEDGER_SHA256,
  );

  const result = verifyReviewedMigrationRepository({
    drizzleDirectory: repositoryDrizzleDirectory,
  });
  assert.deepEqual(result, {
    entryCount: 65,
    ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
    tailIndex: 64,
    tailTag: "0064_mail_outbox_dispatch_binding",
  });
});

for (const [label, mutate] of [
  [
    "missing journal entry",
    (journal) => {
      journal.entries.splice(10, 1);
    },
  ],
  [
    "duplicate journal entry",
    (journal) => {
      journal.entries.splice(10, 0, { ...journal.entries[10] });
    },
  ],
  [
    "reordered journal entries",
    (journal) => {
      [journal.entries[10], journal.entries[11]] = [
        journal.entries[11],
        journal.entries[10],
      ];
    },
  ],
  [
    "idx drift",
    (journal) => {
      journal.entries[10].idx = 999;
    },
  ],
  [
    "version drift",
    (journal) => {
      journal.entries[10].version = "8";
    },
  ],
  [
    "when drift",
    (journal) => {
      journal.entries[10].when += 1;
    },
  ],
  [
    "tag drift",
    (journal) => {
      journal.entries[10].tag = "0010_unreviewed";
    },
  ],
  [
    "breakpoints drift",
    (journal) => {
      journal.entries[10].breakpoints = false;
    },
  ],
  [
    "extra journal field",
    (journal) => {
      journal.entries[10].unreviewed = true;
    },
  ],
]) {
  test(`rejects ${label}`, () => {
    withDrizzleFixture((drizzleDirectory) => {
      mutateJournal(drizzleDirectory, mutate);
      assert.throws(
        () => verifyReviewedMigrationRepository({ drizzleDirectory }),
        {
          name: "ReviewedMigrationLedgerError",
          code: "REPOSITORY_JOURNAL_MISMATCH",
        },
      );
    });
  });
}

test("rejects SQL byte drift", () => {
  withDrizzleFixture((drizzleDirectory) => {
    const migrationPath = path.join(
      drizzleDirectory,
      "0010_tricky_lord_tyger.sql",
    );
    writeFileSync(
      migrationPath,
      Buffer.concat([readFileSync(migrationPath), Buffer.from("\n", "utf8")]),
    );
    assert.throws(
      () => verifyReviewedMigrationRepository({ drizzleDirectory }),
      {
        name: "ReviewedMigrationLedgerError",
        code: "REPOSITORY_SQL_DIGEST_MISMATCH",
      },
    );
  });
});

test("rejects a missing SQL file", () => {
  withDrizzleFixture((drizzleDirectory) => {
    unlinkSync(path.join(drizzleDirectory, "0010_tricky_lord_tyger.sql"));
    assert.throws(
      () => verifyReviewedMigrationRepository({ drizzleDirectory }),
      {
        name: "ReviewedMigrationLedgerError",
        code: "REPOSITORY_SQL_INVENTORY_MISMATCH",
      },
    );
  });
});

test("rejects an extra unknown SQL file", () => {
  withDrizzleFixture((drizzleDirectory) => {
    writeFileSync(
      path.join(drizzleDirectory, "0065_unreviewed.sql"),
      "-- unreviewed\n",
      "utf8",
    );
    assert.throws(
      () => verifyReviewedMigrationRepository({ drizzleDirectory }),
      {
        name: "ReviewedMigrationLedgerError",
        code: "REPOSITORY_SQL_INVENTORY_MISMATCH",
      },
    );
  });
});

test("extends the reviewed ledger by exactly one deterministic append", () => {
  const supplied0065SqlSha256 = createHash("sha256")
    .update("test-only supplied 0065 bytes", "utf8")
    .digest("hex");
  const reviewed0065 = {
    idx: 65,
    version: "7",
    when: 1_784_936_400_000,
    tag: "0065_backup_status_mail_authority",
    breakpoints: true,
    sqlSha256: supplied0065SqlSha256,
  };
  const through0065 = appendReviewedMigrationLedgerEntry(
    REVIEWED_MIGRATION_LEDGER,
    reviewed0065,
  );

  assert.equal(REVIEWED_MIGRATION_LEDGER.length, 65);
  assert.equal(through0065.length, 66);
  assert.deepEqual(through0065.at(-1), reviewed0065);
  assert.match(reviewedMigrationLedgerSha256(through0065), /^[0-9a-f]{64}$/u);
  assert.notEqual(
    reviewedMigrationLedgerSha256(through0065),
    REVIEWED_MIGRATION_LEDGER_SHA256,
  );

  for (const invalid of [
    { ...reviewed0065, idx: 66 },
    { ...reviewed0065, tag: "0066_backup_status_mail_authority" },
    { ...reviewed0065, when: REVIEWED_MIGRATION_LEDGER.at(-1).when },
    { ...reviewed0065, sqlSha256: "0".repeat(63) },
  ]) {
    assert.throws(
      () => appendReviewedMigrationLedgerEntry(REVIEWED_MIGRATION_LEDGER, invalid),
      {
        name: "ReviewedMigrationLedgerError",
        code: "CONTRACT_EXTENSION_INVALID",
      },
    );
  }
});

test("accepts the fixed 0066 shape only when its reviewed SQL digest is supplied", () => {
  const supplied0065SqlSha256 = createHash("sha256")
    .update("test-only supplied 0065 bytes", "utf8")
    .digest("hex");
  const through0065 = appendReviewedMigrationLedgerEntry(
    REVIEWED_MIGRATION_LEDGER,
    {
      idx: 65,
      version: "7",
      when: 1_784_936_400_000,
      tag: "0065_backup_status_mail_authority",
      breakpoints: true,
      sqlSha256: supplied0065SqlSha256,
    },
  );
  const suppliedSqlSha256 = createHash("sha256")
    .update("test-only supplied 0066 bytes", "utf8")
    .digest("hex");
  const through0066 = appendReviewedMigrationLedgerEntry(through0065, {
    idx: 66,
    version: "7",
    when: 1_784_940_000_000,
    tag: "0066_mail_outbox_provider_correlation_evidence",
    breakpoints: true,
    sqlSha256: suppliedSqlSha256,
  });

  assert.equal(through0066.length, 67);
  assert.deepEqual(through0066.at(-1), {
    idx: 66,
    version: "7",
    when: 1_784_940_000_000,
    tag: "0066_mail_outbox_provider_correlation_evidence",
    breakpoints: true,
    sqlSha256: suppliedSqlSha256,
  });
  assert.notEqual(
    reviewedMigrationLedgerSha256(through0066),
    reviewedMigrationLedgerSha256(through0065),
  );
});

test("accepts the exact applied full ledger", async () => {
  const client = appliedLedgerClient();
  const result = await verifyAppliedMigrationLedger(client, {
    requireComplete: true,
  });
  assert.deepEqual(result, {
    appliedCount: 65,
    complete: true,
    ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
  });
  assert.equal(client.queries.length, 2);
});

test("accepts only an exact applied prefix before migration", async () => {
  const client = appliedLedgerClient({
    rows: appliedRows(REVIEWED_MIGRATION_LEDGER.slice(0, 60)),
  });
  const result = await verifyAppliedMigrationLedger(client);
  assert.deepEqual(result, {
    appliedCount: 60,
    complete: false,
    ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
  });
  await assert.rejects(
    verifyAppliedMigrationLedger(client, { requireComplete: true }),
    {
      name: "ReviewedMigrationLedgerError",
      code: "DATABASE_LEDGER_INCOMPLETE",
    },
  );
});

test("accepts an absent journal only before the first migration", async () => {
  await assert.doesNotReject(
    verifyAppliedMigrationLedger(appliedLedgerClient({ present: false })),
  );
  await assert.rejects(
    verifyAppliedMigrationLedger(appliedLedgerClient({ present: false }), {
      requireComplete: true,
    }),
    {
      name: "ReviewedMigrationLedgerError",
      code: "DATABASE_LEDGER_INCOMPLETE",
    },
  );
});

for (const [label, mutate] of [
  [
    "missing row",
    (rows) => {
      rows.splice(10, 1);
    },
  ],
  [
    "duplicate row",
    (rows) => {
      rows.splice(10, 0, { ...rows[10], id: "999" });
      rows.pop();
    },
  ],
  [
    "reordered rows",
    (rows) => {
      [rows[10], rows[11]] = [rows[11], rows[10]];
    },
  ],
  [
    "historical hash drift",
    (rows) => {
      rows[10].hash = "0".repeat(64);
    },
  ],
  [
    "historical timestamp drift",
    (rows) => {
      rows[10].created_at = String(Number(rows[10].created_at) + 1);
    },
  ],
]) {
  test(`rejects applied database ${label}`, async () => {
    const rows = appliedRows();
    mutate(rows);
    await assert.rejects(
      verifyAppliedMigrationLedger(appliedLedgerClient({ rows })),
      {
        name: "ReviewedMigrationLedgerError",
        code: "DATABASE_LEDGER_MISMATCH",
      },
    );
  });
}

test("rejects an extra unknown applied database row", async () => {
  const rows = appliedRows();
  rows.push({
    id: "66",
    hash: "f".repeat(64),
    created_at: "1784936400000",
  });
  await assert.rejects(
    verifyAppliedMigrationLedger(appliedLedgerClient({ rows })),
    {
      name: "ReviewedMigrationLedgerError",
      code: "DATABASE_LEDGER_EXTRA",
    },
  );
});
