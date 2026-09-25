// Contended role bootstrap for infra/tests/production-topology.test.sh.
//
// The production CLI deliberately collapses every failure into one opaque
// event. When the bootstrap races the first migration for the shared
// database-administration lock, losing that race is expected to fail closed
// with the reviewed "pre-lock-phase-drift" section (the ledger changed while
// the bootstrap waited). This harness runs the same exported bootstrap with the
// same inputs as the CLI and reports only that exact, secret-free outcome so
// the topology test can tell a correct fail-closed result from any other
// failure. Every other error stays opaque and fails the test.
import {
  parseDatabaseRoleBootstrapBooleanSetting,
  runDatabaseRoleBootstrap,
} from "/app/scripts/bootstrap-database-roles.mjs";
import { BootstrapDatabaseRuntimeCapabilityError } from "/app/scripts/bootstrap-database-runtime-capabilities.mjs";

const PRE_LOCK_PHASE_DRIFT_MESSAGE =
  "database runtime capability bootstrap failed: pre-lock-phase-drift";

try {
  await runDatabaseRoleBootstrap({
    postgresUser: process.env.POSTGRES_USER ?? "",
    postgresDatabase: process.env.POSTGRES_DB ?? "",
    databaseBootstrapUrl: process.env.DATABASE_BOOTSTRAP_URL ?? "",
    databaseAppUrl: process.env.DATABASE_APP_URL ?? "",
    databaseMigratorUrl: process.env.DATABASE_MIGRATOR_URL ?? "",
    databaseWorkerUrl: process.env.DATABASE_WORKER_URL ?? "",
    databaseOpsUrl: process.env.DATABASE_OPS_URL ?? "",
    databaseBackupReporterUrl: process.env.DATABASE_BACKUP_REPORTER_URL ?? "",
    bootstrapMode: "strict",
    requireCompleteMigrationLedger: parseDatabaseRoleBootstrapBooleanSetting(
      process.env.REQUIRE_COMPLETE_MIGRATION_LEDGER,
      "REQUIRE_COMPLETE_MIGRATION_LEDGER",
    ),
  });
  console.info(JSON.stringify({ event: "database.roles_bootstrapped" }));
} catch (error) {
  if (
    error instanceof BootstrapDatabaseRuntimeCapabilityError &&
    error.message === PRE_LOCK_PHASE_DRIFT_MESSAGE
  ) {
    console.info(
      JSON.stringify({ event: "database.role_bootstrap_pre_lock_phase_drift" }),
    );
    process.exitCode = 3;
  } else {
    console.error(
      JSON.stringify({
        event: "database.role_bootstrap_failed",
        code: "DATABASE_ROLE_BOOTSTRAP_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
