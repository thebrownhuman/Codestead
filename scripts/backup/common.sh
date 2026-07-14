#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly FULL_BACKUP_MAGIC="LEARNCODING_BACKUP_V1"
readonly EMERGENCY_BACKUP_MAGIC="LEARNCODING_EMERGENCY_V1"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "fatal: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

load_backup_config() {
  local config_file="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" mode owner
  [[ -f "$config_file" ]] || die "backup config is missing: $config_file"
  mode="$(stat -c %a "$config_file")"
  owner="$(stat -c %u "$config_file")"
  (( (8#$mode & 0022) == 0 )) || die "backup config must not be group/world writable"
  [[ "$owner" == "$(id -u)" ]] || die "backup config must be owned by the invoking operator"
  # This is a root-owned shell environment file and may contain an rclone path,
  # but must never contain the age private identity itself.
  # shellcheck disable=SC1090
  source "$config_file"

  : "${REPO_ROOT:=/opt/learncoding}"
  : "${COMPOSE_ENV_FILE:=/etc/learncoding/compose.env}"
  : "${LEARN_DATA_ROOT:=/srv/learncoding}"
  : "${BACKUP_LOCK_FILE:=/run/lock/learncoding-backup.lock}"
  : "${BACKUP_STAGE_ROOT:=/var/tmp/learncoding-backup}"
  : "${MAX_BACKUP_AGE_HOURS:=36}"
  : "${FILESYSTEM_WARN_PERCENT:=70}"
  : "${FILESYSTEM_CRITICAL_PERCENT:=85}"
  : "${ALERT_HOOK:=/etc/learncoding/alert-hook}"
  [[ "$FILESYSTEM_WARN_PERCENT" =~ ^[0-9]+$ && "$FILESYSTEM_CRITICAL_PERCENT" =~ ^[0-9]+$ ]] \
    || die "filesystem capacity thresholds must be whole percentages"
  (( FILESYSTEM_WARN_PERCENT >= 1 && FILESYSTEM_WARN_PERCENT < FILESYSTEM_CRITICAL_PERCENT && FILESYSTEM_CRITICAL_PERCENT <= 99 )) \
    || die "filesystem capacity thresholds must satisfy 1 <= warning < critical <= 99"
}

compose_cmd() {
  local args=(docker compose)
  if [[ -f "$COMPOSE_ENV_FILE" ]]; then
    args+=(--env-file "$COMPOSE_ENV_FILE")
  fi
  args+=(-f "$REPO_ROOT/compose.yaml")
  "${args[@]}" "$@"
}

emit_alert() {
  local severity="$1" event="$2" message="$3"
  log "alert severity=$severity event=$event message=$message"
  if [[ -x "${ALERT_HOOK:-}" ]]; then
    "$ALERT_HOOK" "$severity" "$event" "$message" || log "alert hook failed"
  fi
}

enqueue_backup_status() {
  local outcome="$1" seed="$2" key result
  case "$outcome" in
    success|failure) ;;
    *)
      log "backup status report rejected an invalid outcome"
      return 1
      ;;
  esac
  [[ "$seed" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
    log "backup status report rejected an invalid idempotency seed"
    return 1
  }

  key="$(printf '%s' "backup-status:$outcome:$seed" | sha256sum)"
  key="${key%% *}"
  if ! result="$({
    cat <<'SQL'
WITH administrator AS MATERIALIZED (
  SELECT id, lower(email) AS email
  FROM "user"
  WHERE role = 'admin'
    AND status = 'active'
    AND coalesce(banned, false) = false
), inserted AS (
  INSERT INTO email_outbox (
    user_id,
    to_email,
    template,
    template_version,
    variables,
    idempotency_key
  )
  SELECT
    id,
    email,
    'backup-status',
    '1',
    jsonb_build_object(
      'name', 'administrator',
      'summary', CASE :'report_outcome'
        WHEN 'success' THEN 'The nightly encrypted backup completed and passed local verification. No archive is attached to this email.'
        WHEN 'failure' THEN 'The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.'
      END
    ),
    :'report_key'
  FROM administrator
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM inserted) THEN 'queued'
  WHEN EXISTS (
    SELECT 1 FROM email_outbox WHERE idempotency_key = :'report_key'
  ) THEN 'existing'
  WHEN NOT EXISTS (SELECT 1 FROM administrator) THEN 'no-admin'
  ELSE 'not-queued'
END;
SQL
  } | compose_cmd exec -T \
    --env "BACKUP_REPORT_KEY=$key" \
    --env "BACKUP_REPORT_OUTCOME=$outcome" \
    postgres sh -ceu \
      'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=report_key="$BACKUP_REPORT_KEY" --set=report_outcome="$BACKUP_REPORT_OUTCOME"')"; then
    log "backup status report could not reach the application outbox"
    return 1
  fi

  result="${result//$'\r'/}"
  case "$result" in
    queued)
      log "backup status report queued for the administrator"
      ;;
    existing)
      log "backup status report was already queued"
      ;;
    no-admin)
      log "backup status report was not queued because no active administrator exists"
      return 1
      ;;
    *)
      log "backup status report returned an invalid acknowledgement"
      return 1
      ;;
  esac
}

require_absolute_path() {
  [[ "$1" = /* ]] || die "path must be absolute: $1"
}

validated_root() {
  local root="$1" expected_magic="$2" marker marker_mode marker_owner real
  require_absolute_path "$root"
  [[ -d "$root" ]] || die "backup target is not mounted: $root"
  marker="$root/.learncoding-backup-root"
  [[ -f "$marker" && ! -L "$marker" ]] || die "backup marker is missing or unsafe: $marker"
  marker_mode="$(stat -c %a "$marker")"
  marker_owner="$(stat -c %u "$marker")"
  (( (8#$marker_mode & 0022) == 0 )) || die "backup marker must not be group/world writable"
  [[ "$marker_owner" == "$(id -u)" ]] || die "backup marker must be owned by the invoking operator"
  [[ "$(<"$marker")" == "$expected_magic" ]] || die "backup marker has the wrong value"
  real="$(realpath -e -- "$root")"
  [[ "$real" != "/" && "$real" != "/srv" && "$real" != "/var" ]] || die "unsafe backup root: $real"
  printf '%s\n' "$real"
}

acquire_backup_lock() {
  if [[ "${BACKUP_LOCK_HELD:-0}" == "1" ]]; then
    return
  fi
  install -d -m 0755 "$(dirname -- "$BACKUP_LOCK_FILE")"
  exec {BACKUP_LOCK_FD}>"$BACKUP_LOCK_FILE"
  flock -n "$BACKUP_LOCK_FD" || die "another backup, restore, or prune operation is running"
}

acquire_backup_lock_shared() {
  if [[ "${BACKUP_LOCK_HELD:-0}" == "1" ]]; then
    return
  fi
  install -d -m 0755 "$(dirname -- "$BACKUP_LOCK_FILE")"
  exec {BACKUP_LOCK_FD}>"$BACKUP_LOCK_FILE"
  flock -s -n "$BACKUP_LOCK_FD" || die "backup state is currently being changed"
}

verify_ciphertext_checksum() {
  local archive="$1" checksum="${1}.sha256" expected_hash expected_name extra actual_hash
  [[ -f "$archive" && ! -L "$archive" && -s "$archive" ]] || return 1
  [[ -f "$checksum" && ! -L "$checksum" && -s "$checksum" ]] || return 1
  [[ "$(wc -l <"$checksum")" -eq 1 ]] || return 1
  read -r expected_hash expected_name extra <"$checksum"
  [[ -z "${extra:-}" && "$expected_hash" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  [[ "$expected_name" == "$(basename -- "$archive")" ]] || return 1
  actual_hash="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$actual_hash" == "$expected_hash" ]]
}
