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
  "learncoding_app",
  "learncoding_migrator",
  "learncoding_worker",
  "learncoding_ops",
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

if (!/RESTORE_OPERATIONS_IMAGE[^\n]*@sha256:/.test(drill)) {
  throw new Error("restore drill must reject a mutable operations image reference");
}
for (const expected of [
  "verifyDatabaseSchema",
  "verifyAppData",
  "verifyCredentialProbe",
  "timingSafeEqual",
]) requireText(smoke, expected, "restore smoke verifier");
requireText(smoke, "process.env.DATABASE_URL", "restore smoke verifier");

process.stdout.write("restore-drill-contract-tests-ok\n");
