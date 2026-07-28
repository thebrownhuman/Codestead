import { Buffer } from "node:buffer";

import type { DisposableIntegrationEnvironmentSource } from
  "./disposable-integration-environment";
import { buildDisposableToolEnvironment } from
  "./disposable-tool-environment";

const DISPOSABLE_DATABASE = "/learncoding_integration";
const DISPOSABLE_HOST = "127.0.0.1";
const DISPOSABLE_OWNER_QUERY =
  "?options=-c+role%3Dlearncoding_owner";

function failRuntimeDatabaseValidation(): never {
  throw new Error(
    "disposable integration runtime database validation failed",
  );
}

function parseRuntimeDatabaseUrl(
  value: string,
  expectedUsername: string,
  ownerAssumption: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failRuntimeDatabaseValidation();
  }

  const port = Number(url.port);
  if (
    url.protocol !== "postgresql:"
    || url.username !== expectedUsername
    || url.password.length === 0
    || url.hostname !== DISPOSABLE_HOST
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || port === 5_432
    || url.pathname !== DISPOSABLE_DATABASE
    || url.hash !== ""
    || (
      ownerAssumption
        ? url.search !== DISPOSABLE_OWNER_QUERY
        : url.search !== ""
    )
  ) {
    failRuntimeDatabaseValidation();
  }
  return url;
}

function validateRuntimeDatabaseTopology(input: Readonly<{
  databaseAppUrl: string;
  databaseMigratorUrl: string;
  databaseWorkerUrl: string;
  databaseOpsUrl: string;
  databaseBackupReporterUrl: string;
  databaseOwnerUrl: string;
  betterAuthSecret: string;
}>): void {
  const entries = [
    [input.databaseAppUrl, "learncoding_app", false],
    [input.databaseMigratorUrl, "learncoding_migrator", false],
    [input.databaseWorkerUrl, "learncoding_worker", false],
    [input.databaseOpsUrl, "learncoding_ops", false],
    [
      input.databaseBackupReporterUrl,
      "learncoding_backup_reporter",
      false,
    ],
    [input.databaseOwnerUrl, "learncoding_migrator", true],
  ] as const;
  if (
    new Set(entries.map(([value]) => value)).size !== entries.length
    || typeof input.betterAuthSecret !== "string"
    || input.betterAuthSecret.length === 0
  ) {
    failRuntimeDatabaseValidation();
  }

  const parsed = entries.map(([value, username, ownerAssumption]) =>
    parseRuntimeDatabaseUrl(value, username, ownerAssumption)
  );
  const reference = parsed[0]!;
  if (parsed.some((url) =>
    url.hostname !== reference.hostname
    || url.port !== reference.port
    || url.pathname !== reference.pathname
  )) {
    failRuntimeDatabaseValidation();
  }
}

export function buildDisposableIntegrationRuntimeEnvironment(
  source: DisposableIntegrationEnvironmentSource,
  input: Readonly<{
    taskHomeDirectory: string;
    databaseAppUrl: string;
    databaseMigratorUrl: string;
    databaseWorkerUrl: string;
    databaseOpsUrl: string;
    databaseBackupReporterUrl: string;
    databaseOwnerUrl: string;
    betterAuthSecret: string;
  }>,
): NodeJS.ProcessEnv {
  validateRuntimeDatabaseTopology(input);
  return {
    ...buildDisposableToolEnvironment(
      source,
      input.taskHomeDirectory,
    ),
    DATABASE_APP_URL: input.databaseAppUrl,
    DATABASE_MIGRATOR_URL: input.databaseMigratorUrl,
    DATABASE_WORKER_URL: input.databaseWorkerUrl,
    DATABASE_OPS_URL: input.databaseOpsUrl,
    DATABASE_BACKUP_REPORTER_URL: input.databaseBackupReporterUrl,
    DATABASE_OWNER_URL: input.databaseOwnerUrl,
    DATABASE_URL: input.databaseAppUrl,
    DATABASE_POOL_SIZE: "8",
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: input.betterAuthSecret,
    INTEGRATION_TEST: "1",
  };
}

const INTEGRATION_FAILURE_REASONS = Object.freeze({
  "migration-journal": "migration_journal_failed",
  "loopback-port": "loopback_port_failed",
  "harness-start": "harness_start_failed",
  "role-boundary-self-test": "role_boundary_self_test_failed",
  "postgres-readiness": "postgres_readiness_failed",
  "initial-bootstrap": "role_reconciliation_failed",
  "initial-negative-probes": "role_boundary_verification_failed",
  "initial-migration": "migration_failed",
  "initial-reconciliation": "role_reconciliation_failed",
  "initial-boundary-verifier": "role_boundary_verification_failed",
  "initial-verification": "topology_verification_failed",
  "replay-bootstrap": "role_reconciliation_failed",
  "replay-negative-probes": "role_boundary_verification_failed",
  "replay-migration": "migration_failed",
  "replay-reconciliation": "role_reconciliation_failed",
  "replay-boundary-verifier": "role_boundary_verification_failed",
  "replay-verification": "topology_verification_failed",
  "reset-capability-install": "reset_capability_install_failed",
  "application-tests": "application_tests_failed",
  "reset-capability-teardown": "reset_capability_teardown_failed",
  "harness-cleanup": "harness_cleanup_failed",
} as const);

type IntegrationFailurePhase = keyof typeof INTEGRATION_FAILURE_REASONS;
type ReportedIntegrationFailurePhase = IntegrationFailurePhase | "unknown";

function isIntegrationFailurePhase(
  value: string,
): value is IntegrationFailurePhase {
  return Object.prototype.hasOwnProperty.call(
    INTEGRATION_FAILURE_REASONS,
    value,
  );
}

export function createIntegrationFailureReporter(input: Readonly<{
  write: (value: string) => void;
}>): Readonly<{
  enter: (phase: string) => void;
  report: () => void;
}> {
  let phase: ReportedIntegrationFailurePhase = "unknown";
  return {
    enter(value) {
      phase = isIntegrationFailurePhase(value) ? value : "unknown";
    },
    report() {
      const reason = phase === "unknown"
        ? "unexpected_failure"
        : INTEGRATION_FAILURE_REASONS[phase];
      input.write(`${JSON.stringify({
        event: "integration.failed",
        phase,
        reason,
      })}\n`);
    },
  };
}

function uniqueSecrets(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => result.replaceAll(secret, "[REDACTED]"),
    value,
  );
}

function safePrefixLength(
  value: string,
  secrets: readonly string[],
  maximumSecretLength: number,
): number {
  let prefixLength = Math.max(
    0,
    value.length - Math.max(0, maximumSecretLength - 1),
  );
  for (const secret of secrets) {
    const searchStart = Math.max(0, prefixLength - secret.length + 1);
    const matchIndex = value.indexOf(secret, searchStart);
    if (
      matchIndex >= 0
      && matchIndex < prefixLength
      && matchIndex + secret.length > prefixLength
    ) {
      prefixLength = matchIndex;
    }
  }
  return prefixLength;
}

export function createIntegrationOutputSanitizer(input: Readonly<{
  secrets: readonly string[];
  write: (value: string) => void;
}>): Readonly<{
  end: () => void;
  write: (value: string | Uint8Array) => void;
}> {
  const secrets = uniqueSecrets(input.secrets);
  const maximumSecretLength = Math.max(
    0,
    ...secrets.map((secret) => secret.length),
  );
  let pending = "";

  const flushPrefix = () => {
    const prefixLength = safePrefixLength(
      pending,
      secrets,
      maximumSecretLength,
    );
    if (prefixLength === 0) return;
    input.write(redact(pending.slice(0, prefixLength), secrets));
    pending = pending.slice(prefixLength);
  };

  return {
    write(value) {
      pending += typeof value === "string"
        ? value
        : Buffer.from(value).toString("utf8");
      flushPrefix();
    },
    end() {
      if (pending.length > 0) {
        input.write(redact(pending, secrets));
        pending = "";
      }
    },
  };
}
