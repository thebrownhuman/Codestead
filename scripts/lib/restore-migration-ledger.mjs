import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MINIMUM_MIGRATION_COUNT = 64;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail() {
  throw new Error(
    "pre-repair restored migration ledger verification failed",
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

export function deriveCheckedInRestoreMigrationLedger(
  journal,
  sqlSources,
) {
  if (
    !isRecord(journal)
    || journal.version !== "7"
    || journal.dialect !== "postgresql"
    || !Array.isArray(journal.entries)
    || journal.entries.length < MINIMUM_MIGRATION_COUNT
    || !Array.isArray(sqlSources)
    || sqlSources.length !== journal.entries.length
  ) {
    return fail();
  }

  let priorWhen = -1;
  const rows = [];
  for (const [index, entry] of journal.entries.entries()) {
    const sql = sqlSources[index];
    const expectedPrefix = `${String(index).padStart(4, "0")}_`;
    if (
      !isRecord(entry)
      || entry.idx !== index
      || entry.version !== journal.version
      || !Number.isSafeInteger(entry.when)
      || entry.when <= priorWhen
      || typeof entry.tag !== "string"
      || !entry.tag.startsWith(expectedPrefix)
      || !/^[0-9]{4}_[a-z0-9_]+$/u.test(entry.tag)
      || entry.breakpoints !== true
      || typeof sql !== "string"
      || sql.length === 0
      || sql.includes("\0")
    ) {
      return fail();
    }
    priorWhen = entry.when;
    rows.push(Object.freeze({
      migration_index: String(index),
      migration_sha256: createHash("sha256")
        .update(sql, "utf8")
        .digest("hex"),
      migration_when: String(entry.when),
    }));
  }
  return Object.freeze(rows);
}

export async function readCheckedInRestoreMigrationLedger(
  applicationRoot,
) {
  if (
    typeof applicationRoot !== "string"
    || !path.isAbsolute(applicationRoot)
  ) {
    return fail();
  }
  const drizzleRoot = path.join(applicationRoot, "drizzle");
  let journal;
  try {
    journal = JSON.parse(await readFile(
      path.join(drizzleRoot, "meta", "_journal.json"),
      "utf8",
    ));
  } catch {
    return fail();
  }
  if (
    !isRecord(journal)
    || !Array.isArray(journal.entries)
    || journal.entries.some((entry) =>
      !isRecord(entry)
      || typeof entry.tag !== "string"
      || !/^[0-9]{4}_[a-z0-9_]+$/u.test(entry.tag))
  ) {
    return fail();
  }
  let sqlSources;
  try {
    sqlSources = await Promise.all(journal.entries.map((entry) =>
      readFile(path.join(drizzleRoot, `${entry.tag}.sql`), "utf8")));
  } catch {
    return fail();
  }
  return deriveCheckedInRestoreMigrationLedger(journal, sqlSources);
}

function validExpectedLedger(expected) {
  return (
    Array.isArray(expected)
    && expected.length >= MINIMUM_MIGRATION_COUNT
    && expected.every((row, index) =>
      isRecord(row)
      && row.migration_index === String(index)
      && typeof row.migration_sha256 === "string"
      && SHA256_PATTERN.test(row.migration_sha256)
      && typeof row.migration_when === "string"
      && /^[1-9][0-9]*$/u.test(row.migration_when)
      && (
        index === 0
        || BigInt(row.migration_when)
          > BigInt(expected[index - 1].migration_when)
      ))
  );
}

export async function verifyRestoredMigrationLedger(client, expected) {
  try {
    if (
      !isRecord(client)
      || typeof client.query !== "function"
      || !validExpectedLedger(expected)
    ) {
      return fail();
    }
    const result = await client.query(`
      select (
               pg_catalog.row_number()
                 over (order by migration.id) - 1
             )::text as migration_index,
             migration.hash::text as migration_sha256,
             migration.created_at::text as migration_when
        from drizzle.__drizzle_migrations migration
       order by migration.id
    `);
    if (
      !isRecord(result)
      || !Array.isArray(result.rows)
      || result.rows.length !== expected.length
      || result.rows.some((row, index) =>
        !isRecord(row)
        || row.migration_index !== expected[index].migration_index
        || row.migration_sha256 !== expected[index].migration_sha256
        || row.migration_when !== expected[index].migration_when)
    ) {
      return fail();
    }
  } catch {
    return fail();
  }
}
