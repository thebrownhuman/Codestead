#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";
import {
  readCheckedInRestoreMigrationLedger,
  verifyRestoredMigrationLedger,
} from "./lib/restore-migration-ledger.mjs";

const { Pool } = pg;
const TARGET_PATTERN = /^learncoding_restore_[A-Za-z0-9_]+$/u;

function fail() {
  throw new Error("pre-repair restored database verification failed");
}

export function requireRestoreDatabaseName(value) {
  if (typeof value !== "string" || !TARGET_PATTERN.test(value)) {
    return fail();
  }
  return value;
}

function targetConnectionString() {
  const target = requireRestoreDatabaseName(
    process.env.RESTORE_DATABASE_NAME ?? "",
  );
  const bootstrap = process.env.DATABASE_BOOTSTRAP_URL ?? "";
  if (bootstrap.length === 0) return fail();

  let url;
  try {
    url = new URL(bootstrap);
  } catch {
    return fail();
  }
  if (
    url.protocol !== "postgresql:"
    || url.username !== (process.env.POSTGRES_USER ?? "")
    || url.hostname !== "postgres"
    || url.port !== "5432"
    || url.search.length !== 0
    || url.hash.length !== 0
  ) {
    return fail();
  }
  url.pathname = `/${target}`;
  return url.href;
}

async function verify() {
  const pool = new Pool({
    connectionString: targetConnectionString(),
    application_name: "codestead_restore_pre_repair_verifier",
    max: 1,
  });
  try {
    const expectedLedger =
      await readCheckedInRestoreMigrationLedger(
        fileURLToPath(new URL("..", import.meta.url)),
      );
    await verifyRestoredMigrationLedger(pool, expectedLedger);
    const migrationTailIndex = expectedLedger.length - 1;
    const bootstrap = await import("./bootstrap-database-roles.mjs");
    const rawVerifier = bootstrap
      .verifyPostMigrationReviewedContractsBeforeReconciliation;
    if (migrationTailIndex >= 64) {
      const boundary = await import(
        "./verify-database-role-boundaries.mjs"
      );
      const aggregateVerifier = boundary
        .verifyReviewedMailAuthorityCatalogContracts;
      if (
        typeof rawVerifier !== "function"
        || typeof aggregateVerifier !== "function"
      ) {
        return fail();
      }
      await rawVerifier(pool);
      await aggregateVerifier(pool);
    } else {
      if (
        migrationTailIndex !== 63
        || typeof bootstrap.verifyDatabaseRoleBootstrapState
          !== "function"
      ) {
        return fail();
      }
      await bootstrap.verifyDatabaseRoleBootstrapState(
        pool,
        process.env.RESTORE_DATABASE_NAME,
        process.env.POSTGRES_USER,
      );
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  verify().then(() => {
    process.stdout.write("restore_pre_repair_catalog_valid=true\n");
  }).catch(() => {
    process.stderr.write(
      "Restore pre-repair catalog verification failed: verification_failed\n",
    );
    process.exitCode = 1;
  });
}
