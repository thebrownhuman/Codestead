import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const compose = readFileSync(path.join(root, "infra/restore/restore-drill.compose.yaml"), "utf8");
const dispatcher = readFileSync(path.join(root, "scripts/backup/restore-drill.sh"), "utf8");
const drill = [
  dispatcher,
  readFileSync(path.join(root, "scripts/backup/restore-drill-isolated.sh"), "utf8"),
  readFileSync(path.join(root, "scripts/backup/validate-restore-metrics.sh"), "utf8"),
].join("\n");
const smoke = readFileSync(path.join(root, "scripts/verify-restored-backup.ts"), "utf8");
const entrypoint = readFileSync(path.join(root, "infra/docker/entrypoint.sh"), "utf8");
const smokeServiceStart = compose.indexOf("\n  smoke:");
const smokeServiceEnd = compose.indexOf("\nsecrets:", smokeServiceStart);
const bootstrapServiceStart = compose.indexOf("\n  database-role-bootstrap:");
const bootstrapServiceEnd = compose.indexOf(
  "\n  database-boundary-preflight:",
  bootstrapServiceStart,
);
const boundaryVerifierServiceStart = compose.indexOf(
  "\n  database-boundary-verifier:",
);
const installerServiceStart = compose.indexOf(
  "\n  restore-ledger-authority-installer:",
);
const installerServiceEnd = compose.indexOf("\n  smoke:", installerServiceStart);
if (
  smokeServiceStart < 0
  || smokeServiceEnd <= smokeServiceStart
  || bootstrapServiceStart < 0
  || bootstrapServiceEnd <= bootstrapServiceStart
  || boundaryVerifierServiceStart < 0
  || installerServiceStart <= boundaryVerifierServiceStart
  || installerServiceEnd <= installerServiceStart
) {
  throw new Error("restore compose service boundaries are invalid");
}
const smokeService = compose.slice(smokeServiceStart, smokeServiceEnd);
const bootstrapService = compose.slice(bootstrapServiceStart, bootstrapServiceEnd);
const boundaryPreflightService = compose.slice(
  bootstrapServiceEnd,
  boundaryVerifierServiceStart,
);
const boundaryVerifierService = compose.slice(
  boundaryVerifierServiceStart,
  installerServiceStart,
);
const installerService = compose.slice(installerServiceStart, installerServiceEnd);

function requireText(document, text, label) {
  if (!document.includes(text)) throw new Error(`${label} is missing: ${text}`);
}

for (const [label, service] of [
  ["restore boundary preflight", boundaryPreflightService],
  ["restore boundary verifier", boundaryVerifierService],
]) {
  requireText(
    service,
    "DATABASE_BOOTSTRAP_URL_FILE: /run/secrets/database_bootstrap_url",
    label,
  );
  requireText(
    service,
    "DATABASE_APP_URL_FILE: /run/secrets/database_app_url",
    label,
  );
  requireText(service, "source: database_url", label);
  requireText(service, "target: database_app_url", label);
  if (
    service.includes("DATABASE_URL_FILE")
    || service.includes("target: database_url")
  ) {
    throw new Error(`${label} uses the generic application credential path`);
  }
}

requireText(compose, "postgres:17-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394", "restore compose");
requireText(compose, "RESTORE_OPERATIONS_IMAGE", "restore compose");
requireText(compose, "database-role-bootstrap", "restore compose");
requireText(compose, "database-boundary-preflight", "restore compose");
requireText(compose, "database-boundary-verifier", "restore compose");
requireText(compose, "restore-ledger-authority-installer", "restore compose");
requireText(compose, "POSTGRES_USER: codestead_restore", "restore compose");
requireText(compose, "database_bootstrap_url", "restore compose");
requireText(compose, "database_migrator_url", "restore compose");
requireText(compose, "database_worker_url", "restore compose");
requireText(compose, "database_ops_url", "restore compose");
requireText(compose, "database_backup_reporter_url", "restore compose");
requireText(compose, "/run/learncoding-postgres", "restore compose");
requireText(compose, "POSTGRES_UID", "restore compose");
requireText(compose, "POSTGRES_GID", "restore compose");
requireText(compose, "POSTGRES_PASSWORD_FILE", "restore compose");
requireText(compose, "internal: true", "restore compose");
if (
  (
    compose.match(/POSTGRES_USER:\s+codestead_restore/gu) ?? []
  ).length !== 5
) {
  throw new Error(
    "every restore database authority service must receive the bootstrap identity",
  );
}
requireText(compose, "restart: \"no\"", "restore compose");
requireText(compose, "cap_drop:\n      - ALL", "restore compose");
requireText(compose, "read_only: true", "restore compose");
requireText(compose, "source: ${RESTORE_EXTRACTED_ROOT", "restore compose");
requireText(compose, "source: ${RESTORE_CREDENTIAL_MASTER_KEY_FILE", "restore compose");
requireText(
  smokeService,
  "RESTORE_CREDENTIAL_MASTER_KEY_PATH: /run/secrets/credential_master_key",
  "restore smoke service",
);
requireText(smokeService, "source: database_ops_url", "restore smoke service");
requireText(smokeService, "target: database_url", "restore smoke service");
if (/^\s+CREDENTIAL_MASTER_KEY_FILE\s*:/mu.test(smokeService)) {
  throw new Error("restore smoke must not use the generic entrypoint-consumed key path");
}
requireText(
  bootstrapService,
  "/app/scripts/verify-restored-backup.ts --remove-ledger-authority-before-bootstrap",
  "restore role bootstrap service",
);
requireText(
  bootstrapService,
  "REQUIRE_COMPLETE_MIGRATION_LEDGER: ${REQUIRE_COMPLETE_MIGRATION_LEDGER:-false}",
  "restore role bootstrap service",
);
if (bootstrapService.includes("--install-ledger-authority")) {
  throw new Error("restore role bootstrap must not install temporary authority");
}
requireText(
  installerService,
  "/app/scripts/verify-restored-backup.ts",
  "restore ledger authority installer",
);
requireText(
  installerService,
  "--install-ledger-authority",
  "restore ledger authority installer",
);
requireText(
  installerService,
  'RESTORE_LEDGER_AUTHORITY_INSTALLER: "1"',
  "restore ledger authority installer",
);
requireText(
  installerService,
  'REQUIRE_COMPLETE_MIGRATION_LEDGER: "true"',
  "restore ledger authority installer",
);
requireText(installerService, "database_bootstrap_url", "restore ledger authority installer");
for (const forbidden of ["database_url", "database_migrator_url", "database_worker_url", "database_ops_url", "database_backup_reporter_url"]) {
  if (installerService.includes(forbidden)) {
    throw new Error(`restore ledger authority installer receives forbidden secret: ${forbidden}`);
  }
}
requireText(
  bootstrapService,
  "RESTORE_NO_ACL_RECONCILIATION: ${RESTORE_NO_ACL_RECONCILIATION:-false}",
  "restore role bootstrap service",
);
if (
  (
    compose.match(
      /RESTORE_NO_ACL_RECONCILIATION:\s*\$\{RESTORE_NO_ACL_RECONCILIATION:-false\}/gu,
    ) ?? []
  ).length !== 1
) {
  throw new Error("restore no-ACL pass-through must be scoped to one bootstrap service");
}
const removeAuthority = bootstrapService.indexOf(
  "--remove-ledger-authority-before-bootstrap",
);
const bootstrapRoles = bootstrapService.indexOf(
  "node /app/scripts/bootstrap-database-roles.mjs",
);
if (
  removeAuthority < 0
  || bootstrapRoles <= removeAuthority
  || !bootstrapService.includes("exec node /app/scripts/bootstrap-database-roles.mjs")
) {
  throw new Error("restore authority removal/bootstrap order is unsafe");
}
if (/\n\s+ports\s*:/.test(compose) || /network_mode\s*:/.test(compose)) {
  throw new Error("restore compose must not publish ports or join a host/production network");
}

if (dispatcher.includes("\nload_backup_config") || dispatcher.includes("\ntrap cleanup")) {
  throw new Error("restore drill dispatcher contains unreachable legacy code after exec");
}

for (const expected of [
  "fetch-offsite.sh",
  "validate-restore-metrics.sh",
  "verify-recovery-kit.sh",
  "RESTORE_INCIDENT_RECORD",
  "INCIDENT_UTC",
  "RECORDED_UTC",
  "CLOCK_MONOTONIC",
  "docker compose",
  "--project-name",
  "docker run",
  "--pull never",
  "--network none",
  "--read-only",
  "--cap-drop ALL",
  "database-role-bootstrap",
  "database-boundary-preflight",
  "database-boundary-verifier",
  "restore-ledger-authority-installer",
  "--role=learncoding_owner",
  "--host=/run/learncoding-postgres",
  "pg_catalog.current_setting('server_version_num')",
  "codestead-restore-drill-pg-major-v1",
  "learncoding_app",
  "learncoding_migrator",
  "learncoding_worker",
  "learncoding_ops",
  "learncoding_backup_reporter",
  "negative probes",
  "down --volumes --remove-orphans",
  "source=offsite",
  "database_schema_valid=true",
  "app_data_valid=true",
  "credential_recovery=true",
  "live_database_modified=false",
  "cleanup_complete=true",
  "rpo_within_24h=true",
  "rto_within_4h=true",
]) requireText(drill, expected, "restore drill");
const noAclRestoreAssignments = [
  ...drill.matchAll(/^RESTORE_NO_ACL_RECONCILIATION=true\s*\\$/gmu),
];
if (noAclRestoreAssignments.length !== 1) {
  throw new Error("restore drill must enable no-ACL reconciliation exactly once");
}
const restoreMutation = drill.indexOf("exec pg_restore ");
const noAclRestoreAssignment = noAclRestoreAssignments[0].index;
const postRestoreBootstrap = drill.indexOf(
  "restore_one_shot database-role-bootstrap",
  noAclRestoreAssignment,
);
const postRestoreBoundaryVerifier = drill.indexOf(
  "restore_one_shot database-boundary-verifier",
  postRestoreBootstrap,
);
const postRestoreAuthorityInstaller = drill.indexOf(
  "restore_one_shot restore-ledger-authority-installer",
  postRestoreBoundaryVerifier,
);
const postRestoreSmoke = drill.indexOf(
  "restore_compose run --rm --no-deps smoke",
  postRestoreAuthorityInstaller,
);
if (
  restoreMutation < 0
  || noAclRestoreAssignment <= restoreMutation
  || postRestoreBootstrap <= noAclRestoreAssignment
  || postRestoreBoundaryVerifier <= postRestoreBootstrap
  || postRestoreAuthorityInstaller <= postRestoreBoundaryVerifier
  || postRestoreSmoke <= postRestoreAuthorityInstaller
) {
  throw new Error(
    "restore must run bootstrap, exact verification, temporary authority installation, then smoke",
  );
}

if (!/RESTORE_OPERATIONS_IMAGE[^\n]*@sha256:/.test(drill)) {
  throw new Error("restore drill must reject a mutable operations image reference");
}
for (const expected of [
  "verifyDatabaseSchema",
  "verifyAppData",
  "verifyCredentialProbe",
  "timingSafeEqual",
]) requireText(smoke, expected, "restore smoke verifier");
requireText(smoke, "resolveRestoreSmokeEnvironment(process.env)", "restore smoke verifier");
requireText(smoke, "environment.DATABASE_URL", "restore smoke verifier");
requireText(
  smoke,
  "resolveRestoreLedgerAuthorityEnvironment()",
  "restore ledger authority installer",
);
requireText(
  smoke,
  "resolveRestoreLedgerAuthorityIdentityEnvironment()",
  "restore pre-bootstrap authority removal",
);
requireText(
  smoke,
  "environment.RESTORE_CREDENTIAL_MASTER_KEY_PATH",
  "restore smoke verifier",
);
requireText(
  smoke,
  "codestead_restore_audit.reviewed_migration_ledger()",
  "restore smoke verifier",
);
requireText(smoke, "restore_ledger_runtime_identity", "restore smoke verifier");
requireText(smoke, "learncoding_restore_ledger_reader", "restore smoke verifier");
requireText(smoke, "definer_drizzle_acl_exact", "restore smoke verifier");
if (
  smoke.includes("process.env.CREDENTIAL_MASTER_KEY_FILE")
  || smoke.includes("process.env.CREDENTIAL_MASTER_KEY;")
) {
  throw new Error("restore smoke verifier must not consume generic key variables");
}
requireText(
  entrypoint,
  'RESTORE_CREDENTIAL_MASTER_KEY_PATH',
  "image entrypoint",
);
requireText(
  entrypoint,
  '"/run/secrets/credential_master_key"',
  "image entrypoint",
);
const genericFileExpansion = entrypoint.indexOf("file_env \"$variable\"");
const restorePathValidation = entrypoint.indexOf("RESTORE_CREDENTIAL_MASTER_KEY_PATH");
if (genericFileExpansion < 0 || restorePathValidation < 0) {
  throw new Error("restore credential handoff is not enforced by the image entrypoint");
}
for (const expected of [
  "RESTORE_LEDGER_AUTHORITY_INSTALLER",
  "restore ledger authority installer accepts only the bootstrap credential",
  "restore ledger authority installer command is not reviewed",
  "/app/scripts/verify-restored-backup.ts",
  "--install-ledger-authority",
]) {
  requireText(entrypoint, expected, "image entrypoint");
}
if (!entrypoint.includes('[ "$#" -ne 5 ]')) {
  throw new Error("restore ledger authority installer command arity is not pinned");
}

process.stdout.write("restore-drill-contract-tests-ok\n");
