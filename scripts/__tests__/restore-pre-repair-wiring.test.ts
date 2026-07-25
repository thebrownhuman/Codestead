import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  requireRestoreDatabaseName,
} from "../verify-pre-repair-restored-database.mjs";

const read = (relativePath: string) =>
  readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("restore pre-repair verifier wiring", () => {
  it("normal restore verifies the raw catalog before reporting success", () => {
    const source = read("scripts/backup/restore.sh");
    const restore = source.indexOf("exec pg_restore");
    const rawVerifier = source.indexOf(
      "verify-pre-repair-restored-database.mjs",
    );
    const success = source.indexOf(
      "database restored into isolated database",
    );
    const invalidAckBranch = source.indexOf(
      'if [[ "$pre_repair_verification" !=',
    );
    const invalidAckCleanup = source.indexOf("abort_restore_database", invalidAckBranch);
    const invalidAck = source.indexOf(
      "raw restored catalog verifier returned an invalid acknowledgement",
      invalidAckCleanup,
    );

    expect(restore).toBeGreaterThanOrEqual(0);
    expect(rawVerifier).toBeGreaterThan(restore);
    expect(success).toBeGreaterThan(rawVerifier);
    expect(source).toContain(
      "restore_pre_repair_catalog_valid=true",
    );
    expect(invalidAckBranch).toBeGreaterThan(rawVerifier);
    expect(invalidAckCleanup).toBeGreaterThan(invalidAckBranch);
    expect(invalidAck).toBeGreaterThan(invalidAckCleanup);
    expect(success).toBeGreaterThan(invalidAck);
  });

  it("acknowledges removal only after verified database cleanup", () => {
    const source = read("scripts/backup/restore.sh");
    const helperStart = source.indexOf("abort_restore_database() {");
    const helperEnd = source.indexOf("\n}", helperStart);
    const helper = source.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helper).toContain(
      'if remove_restore_database "$restore_db"; then',
    );
    expect(helper).toContain("temporary database was removed");
    expect(helper).toContain(
      "cleanup failed; temporary database may remain",
    );
    expect(source.match(/abort_restore_database "/gu)).toHaveLength(3);
    expect(source).not.toMatch(/dropdb[^\n]*\|\| true/gu);
  });

  it("drill verifies the raw catalog before post-restore bootstrap", () => {
    const source = read("scripts/backup/restore-drill-isolated.sh");
    const restore = source.indexOf("exec pg_restore");
    const rawVerifier = source.indexOf(
      "verify-pre-repair-restored-database.mjs",
    );
    const secondBootstrap = source.indexOf(
      "restore_one_shot database-role-bootstrap",
      rawVerifier,
    );

    expect(rawVerifier).toBeGreaterThan(restore);
    expect(secondBootstrap).toBeGreaterThan(rawVerifier);
  });

  it("operations image packages a wrapper around the exported raw verifier", () => {
    const dockerfile = read("Dockerfile");
    const verifier = read(
      "scripts/verify-pre-repair-restored-database.mjs",
    );

    expect(dockerfile).toContain(
      "COPY --chown=node:node scripts/verify-pre-repair-restored-database.mjs",
    );
    expect(verifier).toContain(
      "verifyPostMigrationReviewedContractsBeforeReconciliation",
    );
    expect(verifier).toContain(
      "verifyReviewedMailAuthorityCatalogContracts",
    );
    expect(verifier).toContain(
      "readCheckedInRestoreMigrationLedger",
    );
    expect(verifier).toContain(
      "verifyRestoredMigrationLedger",
    );
    expect(dockerfile).toContain(
      "COPY --chown=node:node drizzle ./drizzle",
    );
    expect(dockerfile).toContain(
      "scripts/lib/restore-migration-ledger.mjs",
    );
    expect(verifier).not.toContain("pg_catalog.pg_proc");
    expect(verifier).not.toContain("pg_catalog.pg_trigger");
  });

  it("accepts isolated suffixes and rejects the unsuffixed drill name", () => {
    expect(requireRestoreDatabaseName("learncoding_restore_drill"))
      .toBe("learncoding_restore_drill");
    expect(requireRestoreDatabaseName("learncoding_restore_20260725"))
      .toBe("learncoding_restore_20260725");
    for (const rejected of [
      "learncoding_restore",
      "learncoding_restore-unsafe",
      "production",
    ]) {
      expect(() => requireRestoreDatabaseName(rejected)).toThrow(
        "pre-repair restored database verification failed",
      );
    }
  });
});
