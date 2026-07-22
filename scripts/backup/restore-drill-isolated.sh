#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
for command_name in date docker find flock grep id python3 realpath sha256sum sort stat tar; do
  require_command "$command_name"
done

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the temporarily attached backup identity}"
: "${RECOVERY_KIT_IDENTITY_FILE:?RECOVERY_KIT_IDENTITY_FILE is required for the drill}"
: "${RESTORE_INCIDENT_RECORD:?RESTORE_INCIDENT_RECORD is required for the drill}"
: "${RESTORE_OPERATIONS_IMAGE:?RESTORE_OPERATIONS_IMAGE is required for the drill}"
: "${RESTORE_DRILL_COMPOSE_FILE:=$REPO_ROOT/infra/restore/restore-drill.compose.yaml}"
: "${RESTORE_DRILL_WORK_ROOT:=/var/tmp}"
readonly restore_postgres_image="postgres:17-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394"
readonly restore_secrets_gid=2000
readonly POSTGRES_SOCKET=/run/learncoding-postgres

(( EUID == 0 )) || die "the isolated restore drill must run as root"

[[ "$RESTORE_OPERATIONS_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] \
  || die "RESTORE_OPERATIONS_IMAGE must be an immutable digest reference"
for configured in "$AGE_IDENTITY_FILE" "$RECOVERY_KIT_IDENTITY_FILE" \
  "$RESTORE_INCIDENT_RECORD" "$RESTORE_DRILL_COMPOSE_FILE" "$RESTORE_DRILL_WORK_ROOT"; do
  require_absolute_path "$configured"
done
require_secure_regular_file "$AGE_IDENTITY_FILE" 600 "$(id -u)" \
  || die "backup identity is missing or unsafe"
require_secure_regular_file "$RECOVERY_KIT_IDENTITY_FILE" 600 "$(id -u)" \
  || die "recovery-kit identity is missing or unsafe"
require_secure_regular_file "$RESTORE_INCIDENT_RECORD" 600 "$(id -u)" \
  || die "incident record is missing or unsafe"
[[ -f "$RESTORE_DRILL_COMPOSE_FILE" && ! -L "$RESTORE_DRILL_COMPOSE_FILE" ]] \
  || die "restore-drill Compose file is unavailable"

root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
install -d -m 0700 "$root/restore-reports" "$RESTORE_DRILL_WORK_ROOT"
[[ -d "$RESTORE_DRILL_WORK_ROOT" && ! -L "$RESTORE_DRILL_WORK_ROOT" \
  && "$(stat -c '%u' "$RESTORE_DRILL_WORK_ROOT")" == "$(id -u)" ]] \
  || die "restore-drill work root is unsafe"

mapfile -t incident_lines <"$RESTORE_INCIDENT_RECORD"
[[ ${#incident_lines[@]} -eq 2 \
  && "${incident_lines[0]}" == INCIDENT_UTC=* \
  && "${incident_lines[1]}" == RECORDED_UTC=* ]] \
  || die "incident record has an invalid schema"
incident_utc="${incident_lines[0]#INCIDENT_UTC=}"
recorded_utc="${incident_lines[1]#RECORDED_UTC=}"
_valid_compact_utc_timestamp "$incident_utc" || die "INCIDENT_UTC is invalid"
_valid_compact_utc_timestamp "$recorded_utc" || die "RECORDED_UTC is invalid"

clock_utc() {
  if [[ "${CODESTEAD_DISPOSABLE_HOST:-0}" == 1 \
    && "${RESTORE_DRILL_TEST_MODE:-0}" == 1 \
    && -n "${RESTORE_DRILL_APPROVAL_UTC_OVERRIDE:-}" ]]; then
    printf '%s\n' "$RESTORE_DRILL_APPROVAL_UTC_OVERRIDE"
  else
    date -u +%Y%m%dT%H%M%SZ
  fi
}

clock_monotonic_ns() {
  local override_name="$1" override=""
  if [[ "${CODESTEAD_DISPOSABLE_HOST:-0}" == 1 && "${RESTORE_DRILL_TEST_MODE:-0}" == 1 ]]; then
    case "$override_name" in
      approval) override="${RESTORE_DRILL_APPROVAL_MONOTONIC_NS_OVERRIDE:-}" ;;
      smoke) override="${RESTORE_DRILL_SMOKE_MONOTONIC_NS_OVERRIDE:-}" ;;
    esac
  fi
  if [[ -n "$override" ]]; then
    [[ "$override" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$override"
  else
    python3 -c 'import time; print(time.clock_gettime_ns(time.CLOCK_MONOTONIC))'
  fi
}

compact_epoch() {
  local value="$1"
  date -u -d "${value:0:4}-${value:4:2}-${value:6:2} ${value:9:2}:${value:11:2}:${value:13:2} UTC" +%s
}

approval_utc="$(clock_utc)"
_valid_compact_utc_timestamp "$approval_utc" || die "restore approval timestamp is invalid"
approval_monotonic_ns="$(clock_monotonic_ns approval)" \
  || die "restore approval monotonic timestamp is invalid"
[[ "$approval_monotonic_ns" =~ ^[0-9]+$ ]] || die "restore approval monotonic timestamp is invalid"

acquire_backup_lock
work="$(mktemp -d -- "$RESTORE_DRILL_WORK_ROOT/learncoding-restore-drill.XXXXXX")"
chmod 0700 "$work"
work_identity="$(stat -c '%d:%i:%u:%a' "$work")"
project="codestead_restore_$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
[[ "$project" =~ ^codestead_restore_[0-9a-f]{16}$ ]] || die "restore project name is invalid"

mapfile -t postgres_identity < <(
  docker run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges "$restore_postgres_image" \
    /bin/sh -ceu 'id -u postgres; id -g postgres'
)
[[ ${#postgres_identity[@]} -eq 2 \
  && "${postgres_identity[0]}" =~ ^[1-9][0-9]*$ \
  && "${postgres_identity[1]}" =~ ^[1-9][0-9]*$ ]] \
  || die "the pinned restore PostgreSQL image has an invalid postgres identity"
readonly restore_postgres_uid="${postgres_identity[0]}"
readonly restore_postgres_gid="${postgres_identity[1]}"
unset postgres_identity

restore_secret_root="$work/database-secrets"
install -d -m 0750 -o 0 -g "$restore_secrets_gid" "$restore_secret_root"
restore_postgres_password_file="$restore_secret_root/postgres_password"
restore_database_bootstrap_url_file="$restore_secret_root/database_bootstrap_url"
restore_database_app_url_file="$restore_secret_root/database_url"
restore_database_migrator_url_file="$restore_secret_root/database_migrator_url"
restore_database_worker_url_file="$restore_secret_root/database_worker_url"
restore_database_ops_url_file="$restore_secret_root/database_ops_url"

mapfile -t restore_passwords < <(
  python3 -c 'import secrets; [print(secrets.token_urlsafe(48)) for _ in range(5)]'
)
[[ ${#restore_passwords[@]} -eq 5 ]] || die "restore database credential generation failed"
declare -A restore_password_set=()
for restore_password in "${restore_passwords[@]}"; do
  [[ "$restore_password" =~ ^[A-Za-z0-9_-]{48,}$ \
    && ! ${restore_password_set[$restore_password]+present} ]] \
    || die "restore database credential generation failed"
  restore_password_set[$restore_password]=1
done

write_restore_secret() {
  local destination="$1" value="$2"
  [[ "$destination" == "$restore_secret_root"/* && ! -e "$destination" && ! -L "$destination" ]] \
    || die "restore database secret path is unsafe"
  printf '%s' "$value" >"$destination"
  chown "0:$restore_secrets_gid" "$destination"
  chmod 0440 "$destination"
}

restore_postgres_password="${restore_passwords[0]}"
write_restore_secret "$restore_postgres_password_file" "$restore_postgres_password"
write_restore_secret "$restore_database_bootstrap_url_file" \
  "postgresql://learncoding_restore:$restore_postgres_password@postgres:5432/learncoding_restore"
write_restore_secret "$restore_database_app_url_file" \
  "postgresql://learncoding_app:${restore_passwords[1]}@postgres:5432/learncoding_restore"
write_restore_secret "$restore_database_migrator_url_file" \
  "postgresql://learncoding_migrator:${restore_passwords[2]}@postgres:5432/learncoding_restore"
write_restore_secret "$restore_database_worker_url_file" \
  "postgresql://learncoding_worker:${restore_passwords[3]}@postgres:5432/learncoding_restore"
write_restore_secret "$restore_database_ops_url_file" \
  "postgresql://learncoding_ops:${restore_passwords[4]}@postgres:5432/learncoding_restore"
unset restore_password restore_passwords restore_password_set restore_postgres_password

archive_name=unknown
snapshot_utc=unknown
database_schema_valid=false
app_data_valid=false
credential_recovery=false
live_database_modified=false
cleanup_complete=false
chronology_valid=false
rpo_seconds=-1
rpo_within_24h=false
rto_seconds=-1
rto_within_4h=false
public_table_count=0
smoke_passed=0
compose_started=0
report_timestamp="$approval_utc"
report="$root/restore-reports/restore-drill-$report_timestamp.txt"
report_checksum="${report}.sha256"
[[ ! -e "$report" && ! -L "$report" && ! -e "$report_checksum" && ! -L "$report_checksum" ]] \
  || die "restore report for this approval already exists"

extracted="$work/extracted"
app_data_root="$work/app-data"
recovered="$work/recovered-kit"
download="$work/offsite"
credential_key="$recovered/credential_master_key"

restore_compose() {
  RESTORE_OPERATIONS_IMAGE="$RESTORE_OPERATIONS_IMAGE" \
  RESTORE_POSTGRES_IMAGE="$restore_postgres_image" \
  RESTORE_POSTGRES_UID="$restore_postgres_uid" \
  RESTORE_POSTGRES_GID="$restore_postgres_gid" \
  RESTORE_SECRETS_GID="$restore_secrets_gid" \
  RESTORE_POSTGRES_PASSWORD_FILE="$restore_postgres_password_file" \
  RESTORE_DATABASE_BOOTSTRAP_URL_FILE="$restore_database_bootstrap_url_file" \
  RESTORE_DATABASE_APP_URL_FILE="$restore_database_app_url_file" \
  RESTORE_DATABASE_MIGRATOR_URL_FILE="$restore_database_migrator_url_file" \
  RESTORE_DATABASE_WORKER_URL_FILE="$restore_database_worker_url_file" \
  RESTORE_DATABASE_OPS_URL_FILE="$restore_database_ops_url_file" \
  RESTORE_EXTRACTED_ROOT="$extracted" \
  RESTORE_APP_DATA_ROOT_HOST="$app_data_root" \
  RESTORE_CREDENTIAL_MASTER_KEY_FILE="$credential_key" \
    docker compose --project-name "$project" -f "$RESTORE_DRILL_COMPOSE_FILE" "$@"
}

restore_one_shot() {
  local service="$1"
  restore_compose --profile operations up --no-deps --no-build --pull never \
    --force-recreate --exit-code-from "$service" "$service"
  restore_compose --profile operations rm -f "$service"
}

write_report() {
  local result="$1" temporary
  rm -f -- "$report_checksum"
  temporary="$(mktemp -- "$root/restore-reports/.restore-drill-report.XXXXXX")"
  cat >"$temporary" <<EOF
version=1
result=$result
source=offsite
archive=$archive_name
approval_utc=$approval_utc
snapshot_utc=$snapshot_utc
incident_utc=$incident_utc
recorded_utc=$recorded_utc
chronology_valid=$chronology_valid
database_schema_valid=$database_schema_valid
public_table_count=$public_table_count
app_data_valid=$app_data_valid
credential_recovery=$credential_recovery
live_database_modified=$live_database_modified
cleanup_complete=$cleanup_complete
rpo_seconds=$rpo_seconds
rpo_within_24h=$rpo_within_24h
rto_seconds=$rto_seconds
rto_within_4h=$rto_within_4h
EOF
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -fT "$temporary" "$report"
  sync -f "$root/restore-reports"
  if [[ "$result" == pass ]]; then
    (cd "$root/restore-reports" && sha256sum "$(basename "$report")" >"$(basename "$report_checksum")")
    chmod 0600 "$report_checksum"
    sync -f "$report_checksum"
  fi
}

cleanup() {
  local status=$? current_identity="" teardown_ok=1 removal_ok=1 remaining=""
  trap - EXIT
  if ((compose_started)); then
    restore_compose down --volumes --remove-orphans >/dev/null 2>&1 || teardown_ok=0
    remaining="$(restore_compose ps -aq 2>/dev/null || true)"
    [[ -z "$remaining" ]] || teardown_ok=0
  fi
  current_identity="$(stat -c '%d:%i:%u:%a' "$work" 2>/dev/null || true)"
  if [[ "$current_identity" == "$work_identity" && -d "$work" && ! -L "$work" ]]; then
    find -P "$work" -mindepth 1 -delete 2>/dev/null || removal_ok=0
    rmdir "$work" 2>/dev/null || removal_ok=0
  else
    removal_ok=0
  fi
  [[ ! -e "$work" && ! -L "$work" ]] || removal_ok=0
  if ((teardown_ok && removal_ok)); then cleanup_complete=true; else cleanup_complete=false; fi
  if ((status == 0 && smoke_passed == 1)) \
    && [[ "$chronology_valid" == true && "$rpo_within_24h" == true \
      && "$rto_within_4h" == true && "$database_schema_valid" == true \
      && "$app_data_valid" == true && "$credential_recovery" == true \
      && "$live_database_modified" == false && "$cleanup_complete" == true ]]; then
    write_report pass || exit 1
    emit_alert info restore_drill_complete "offsite isolated restore drill completed successfully"
    exit 0
  fi
  write_report fail || true
  rm -f -- "$report_checksum"
  exit 1
}
trap cleanup EXIT

archive="$(BACKUP_LOCK_HELD=1 BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" \
  bash "$SCRIPT_DIR/fetch-offsite.sh" "$download")" \
  || die "offsite recovery point retrieval failed"
[[ "$archive" == "$download"/learncoding-full-*.tar.gz.age ]] \
  || die "offsite retrieval returned an invalid archive path"
archive_name="$(basename "$archive")"

BACKUP_LOCK_HELD=1 BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" \
  bash "$SCRIPT_DIR/restore.sh" "$archive" --destination "$extracted" \
  || die "offsite archive decrypt and structural verification failed"

recovery_archive="${RECOVERY_KIT_ARCHIVE:-}"
if [[ -z "$recovery_archive" ]]; then
  mapfile -t recovery_archives < <(find -P "$root/recovery-kits" -maxdepth 1 -type f \
    -name 'learncoding-recovery-kit-*.tar.gz.age' -printf '%p\n' | sort -r)
  [[ ${#recovery_archives[@]} -ge 1 ]] || die "there is no recovery kit to verify"
  recovery_archive="${recovery_archives[0]}"
fi
require_absolute_path "$recovery_archive"
BACKUP_LOCK_HELD=1 BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" \
  bash "$SCRIPT_DIR/verify-recovery-kit.sh" "$recovery_archive" \
    "$RECOVERY_KIT_IDENTITY_FILE" "$recovered" \
  | grep -Fxq recovery_kit_valid=true \
  || die "credential recovery kit verification failed"

snapshot_line="$(grep -E '^snapshot_utc=[0-9]{8}T[0-9]{6}Z$' "$extracted/MANIFEST.txt" || true)"
[[ -n "$snapshot_line" && "$(grep -Ec '^snapshot_utc=' "$extracted/MANIFEST.txt")" -eq 1 ]] \
  || die "restored backup snapshot timestamp is invalid"
snapshot_utc="${snapshot_line#snapshot_utc=}"
_valid_compact_utc_timestamp "$snapshot_utc" || die "restored backup snapshot timestamp is invalid"
preflight_ok=0
preflight_metrics=""
if preflight_metrics="$(bash "$SCRIPT_DIR/validate-restore-metrics.sh" preflight \
  "$snapshot_utc" "$incident_utc" "$recorded_utc" "$approval_utc")"; then
  preflight_ok=1
fi
mapfile -t preflight_lines <<<"$preflight_metrics"
if ((${#preflight_lines[@]} == 3)) \
  && [[ "${preflight_lines[0]}" =~ ^chronology_valid=(true|false)$ \
    && "${preflight_lines[1]}" =~ ^rpo_seconds=-?[0-9]+$ \
    && "${preflight_lines[2]}" =~ ^rpo_within_24h=(true|false)$ ]]; then
  chronology_valid="${preflight_lines[0]#chronology_valid=}"
  rpo_seconds="${preflight_lines[1]#rpo_seconds=}"
  rpo_within_24h="${preflight_lines[2]#rpo_within_24h=}"
fi
((preflight_ok)) || die "restore chronology or 24-hour RPO threshold failed"

mkdir -m 0700 "$app_data_root"
: >"$extracted/app-data-objects.sha256"
chmod 0600 "$extracted/app-data-objects.sha256"
if [[ -f "$extracted/app-data.tar.gz" ]]; then
  names="$work/app-data.names"
  verbose="$work/app-data.verbose"
  tar -tzf "$extracted/app-data.tar.gz" >"$names"
  tar -tvzf "$extracted/app-data.tar.gz" >"$verbose"
  while IFS= read -r entry; do
    [[ "$entry" =~ ^app-data(/[A-Za-z0-9._-]+)*/?$ && "$entry" != *..* ]] \
      || die "application-data archive contains an unsafe path"
  done <"$names"
  grep -Eq '^[^d-]' "$verbose" && die "application-data archive contains a special entry"
  tar -xzf "$extracted/app-data.tar.gz" -C "$work" \
    --no-same-owner --no-same-permissions --delay-directory-restore
  [[ -d "$work/app-data" && ! -L "$work/app-data" ]] || die "restored app-data root is invalid"
  find -P "$app_data_root" -type d -exec chmod 0700 {} +
  find -P "$app_data_root" -type f -exec chmod 0600 {} +
  while IFS= read -r -d '' object; do
    relative="${object#"$app_data_root/"}"
    [[ "$relative" =~ ^[A-Za-z0-9._/-]+$ && "$relative" != *..* ]] \
      || die "restored application object path is unsafe"
    object_hash="$(sha256sum "$object" | awk '{print $1}')"
    printf '%s  %s\n' "$object_hash" "$relative" >>"$extracted/app-data-objects.sha256"
  done < <(find -P "$app_data_root" -type f -print0 | sort -z)
fi

compose_started=1
restore_compose up -d --wait postgres >/dev/null
restore_one_shot database-role-bootstrap
# Authenticated negative probes must pass before restored bytes are accepted.
restore_one_shot database-boundary-preflight
restore_compose exec -T postgres /bin/sh -ceu '
  export PGPASSWORD="$(cat /run/secrets/postgres_password)"
  exec pg_restore --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --role=learncoding_owner --exit-on-error --no-owner --no-acl
' <"$extracted/database.dump" >/dev/null
restore_one_shot database-role-bootstrap
restore_one_shot database-boundary-verifier

smoke_output="$work/smoke.out"
restore_compose run --rm --no-deps smoke >"$smoke_output"
[[ "$(wc -l <"$smoke_output")" -eq 3 ]]
grep -Fxq database_schema_valid=true "$smoke_output"
grep -Fxq app_data_valid=true "$smoke_output"
grep -Fxq credential_recovery=true "$smoke_output"
database_schema_valid=true
app_data_valid=true
credential_recovery=true
public_table_count="$(restore_compose exec -T postgres /bin/sh -ceu '
  export PGPASSWORD="$(cat /run/secrets/postgres_password)"
  exec psql --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM information_schema.tables WHERE table_schema='\''public'\''"
' | tr -d '\r\n ')"
[[ "$public_table_count" =~ ^[0-9]+$ && "$public_table_count" -gt 0 ]] \
  || die "restored public table count is invalid"

smoke_monotonic_ns="$(clock_monotonic_ns smoke)" \
  || die "passing smoke monotonic timestamp is invalid"
rto_ok=0
rto_metrics=""
if rto_metrics="$(bash "$SCRIPT_DIR/validate-restore-metrics.sh" complete \
  "$approval_monotonic_ns" "$smoke_monotonic_ns")"; then
  rto_ok=1
fi
mapfile -t rto_lines <<<"$rto_metrics"
if ((${#rto_lines[@]} == 2)) \
  && [[ "${rto_lines[0]}" =~ ^rto_seconds=-?[0-9]+$ \
    && "${rto_lines[1]}" =~ ^rto_within_4h=(true|false)$ ]]; then
  rto_seconds="${rto_lines[0]#rto_seconds=}"
  rto_within_4h="${rto_lines[1]#rto_within_4h=}"
fi
((rto_ok)) || die "restore monotonic chronology or four-hour RTO threshold failed"
smoke_passed=1
