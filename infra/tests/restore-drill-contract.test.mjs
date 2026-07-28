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
if (
  smokeServiceStart < 0
  || smokeServiceEnd <= smokeServiceStart
  || bootstrapServiceStart < 0
  || bootstrapServiceEnd <= bootstrapServiceStart
) {
  throw new Error("restore compose service boundaries are invalid");
}
const smokeService = compose.slice(smokeServiceStart, smokeServiceEnd);
const bootstrapService = compose.slice(bootstrapServiceStart, bootstrapServiceEnd);

function requireText(document, text, label) {
  if (!document.includes(text)) throw new Error(`${label} is missing: ${text}`);
}

requireText(compose, "postgres:17-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394", "restore compose");
requireText(compose, "RESTORE_OPERATIONS_IMAGE", "restore compose");
requireText(compose, "database-role-bootstrap", "restore compose");
requireText(compose, "database-boundary-preflight", "restore compose");
requireText(compose, "database-boundary-verifier", "restore compose");
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
  "/app/scripts/verify-restored-backup.ts --install-ledger-authority",
  "restore role bootstrap service",
);
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
const installAuthority = bootstrapService.indexOf("--install-ledger-authority");
if (
  removeAuthority < 0
  || bootstrapRoles <= removeAuthority
  || installAuthority <= bootstrapRoles
) {
  throw new Error("restore authority convergence/bootstrap/install order is unsafe");
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
if (
  restoreMutation < 0
  || noAclRestoreAssignment <= restoreMutation
  || postRestoreBootstrap <= noAclRestoreAssignment
) {
  throw new Error(
    "restore no-ACL reconciliation must apply only to the post-pg_restore bootstrap",
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
requireText(smoke, "process.env.DATABASE_BOOTSTRAP_URL", "restore smoke verifier");
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

process.stdout.write("restore-drill-contract-tests-ok\n");
