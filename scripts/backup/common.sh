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

require_secure_regular_file() {
  local path="${1:-}" expected_mode="${2:-}" expected_owner="${3:-}"
  local actual_mode actual_owner

  [[ -n "$path" && "$expected_mode" =~ ^[0-7]{3,4}$ && "$expected_owner" =~ ^[0-9]+$ ]] || return 1
  [[ -f "$path" && ! -L "$path" ]] || return 1
  actual_mode="$(stat -c '%a' -- "$path" 2>/dev/null)" || return 1
  actual_owner="$(stat -c '%u' -- "$path" 2>/dev/null)" || return 1
  [[ "$actual_mode" == "${expected_mode#0}" && "$actual_owner" == "$expected_owner" ]]
}

path_is_within() {
  local candidate root

  [[ "${1:-}" == /* && "${2:-}" == /* ]] || return 1
  candidate="$(realpath -m -- "$1" 2>/dev/null)" || return 1
  root="$(realpath -m -- "$2" 2>/dev/null)" || return 1

  [[ "$candidate" == "$root" ]] && return 0
  if [[ "$root" == / ]]; then
    [[ "$candidate" == /* ]]
  else
    [[ "$candidate" == "$root/"* ]]
  fi
}

_valid_compact_utc_timestamp() {
  local value="${1:-}" normalized

  [[ "$value" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  normalized="$(date -u -d \
    "${value:0:4}-${value:4:2}-${value:6:2} ${value:9:2}:${value:11:2}:${value:13:2} UTC" \
    '+%Y%m%dT%H%M%SZ' 2>/dev/null)" || return 1
  [[ "$normalized" == "$value" ]]
}

_valid_success_marker_values() {
  local archive="${1:-}" completed_utc="${2:-}" sha256="${3:-}"

  [[ "$archive" =~ ^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]] || return 1
  _valid_compact_utc_timestamp "$completed_utc" || return 1
  [[ "$sha256" =~ ^[0-9a-f]{64}$ ]]
}

write_success_marker() {
  local path="${1:-}" archive="${2:-}" completed_utc="${3:-}" sha256="${4:-}"
  local directory base directory_mode directory_owner

  [[ -n "$path" && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  _valid_success_marker_values "$archive" "$completed_utc" "$sha256" || return 1

  directory="$(dirname -- "$path" 2>/dev/null)" || return 1
  base="$(basename -- "$path" 2>/dev/null)" || return 1
  [[ -n "$base" && "$base" != . && "$base" != .. ]] || return 1
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  directory_mode="$(stat -c '%a' -- "$directory" 2>/dev/null)" || return 1
  directory_owner="$(stat -c '%u' -- "$directory" 2>/dev/null)" || return 1
  (( (8#$directory_mode & 0022) == 0 )) || return 1
  [[ "$directory_owner" == "$(id -u)" ]] || return 1
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || return 1
  fi

  (
    local temporary=""
    cleanup_success_marker_temporary() {
      if [[ -n "$temporary" ]]; then
        rm -f -- "$temporary"
      fi
    }
    trap cleanup_success_marker_temporary EXIT

    temporary="$(mktemp -- "$directory/.${base}.tmp.XXXXXX")" || exit 1
    printf '%s\n%s\n%s\n' \
      "SUCCESS_ARCHIVE=$archive" \
      "SUCCESS_COMPLETED_UTC=$completed_utc" \
      "SUCCESS_SHA256=$sha256" >"$temporary" || exit 1
    chmod 0600 -- "$temporary" || exit 1
    if command -v sync >/dev/null 2>&1; then
      sync -f -- "$temporary" || exit 1
    fi
    mv -fT -- "$temporary" "$path" || exit 1
    temporary=""
    if command -v sync >/dev/null 2>&1; then
      sync -f -- "$directory" || exit 1
    fi
  )
}

read_success_marker() {
  local path="${1:-}" line_archive line_completed line_sha extra
  local archive completed_utc sha256 marker_fd

  SUCCESS_ARCHIVE=""
  SUCCESS_COMPLETED_UTC=""
  SUCCESS_SHA256=""

  require_secure_regular_file "$path" 600 "$(id -u)" || return 1
  exec {marker_fd}<"$path" || return 1
  if ! IFS= read -r line_archive <&"$marker_fd" \
    || ! IFS= read -r line_completed <&"$marker_fd" \
    || ! IFS= read -r line_sha <&"$marker_fd"; then
    exec {marker_fd}<&-
    return 1
  fi
  if IFS= read -r extra <&"$marker_fd"; then
    exec {marker_fd}<&-
    return 1
  fi
  exec {marker_fd}<&-

  [[ "$line_archive" == SUCCESS_ARCHIVE=* ]] || return 1
  [[ "$line_completed" == SUCCESS_COMPLETED_UTC=* ]] || return 1
  [[ "$line_sha" == SUCCESS_SHA256=* ]] || return 1
  archive="${line_archive#SUCCESS_ARCHIVE=}"
  completed_utc="${line_completed#SUCCESS_COMPLETED_UTC=}"
  sha256="${line_sha#SUCCESS_SHA256=}"
  _valid_success_marker_values "$archive" "$completed_utc" "$sha256" || return 1
  cmp -s -- "$path" <(printf '%s\n%s\n%s\n' \
    "SUCCESS_ARCHIVE=$archive" \
    "SUCCESS_COMPLETED_UTC=$completed_utc" \
    "SUCCESS_SHA256=$sha256") || return 1

  SUCCESS_ARCHIVE="$archive"
  SUCCESS_COMPLETED_UTC="$completed_utc"
  SUCCESS_SHA256="$sha256"
}

readonly -a BACKUP_MUTATING_SERVICES=(
  cloudflared app mail-worker reward-worker regrade-worker
  project-review-correction-worker exam-finalization-worker
  practice-runner-recovery-worker scan-worker
)

_require_indexed_array_name() {
  local array_name="${1:-}" declaration

  [[ "$array_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || return 1
  declaration="$(declare -p "$array_name" 2>/dev/null)" || return 1
  [[ "$declaration" == declare\ -a* ]]
}

_is_backup_mutating_service() {
  local candidate="${1:-}" allowed

  for allowed in "${BACKUP_MUTATING_SERVICES[@]}"; do
    [[ "$candidate" == "$allowed" ]] && return 0
  done
  return 1
}

capture_running_mutators() {
  local array_name="${1:-}" running_output allowed running_service

  _require_indexed_array_name "$array_name" || return 1
  local -n destination="$array_name"
  destination=()
  running_output="$(compose_cmd ps --status running --services)" || return 1

  for allowed in "${BACKUP_MUTATING_SERVICES[@]}"; do
    while IFS= read -r running_service; do
      if [[ "$running_service" == "$allowed" ]]; then
        destination+=("$allowed")
        break
      fi
    done <<<"$running_output"
  done
}

quiesce_mutators() {
  local array_name="${1:-}" service

  _require_indexed_array_name "$array_name" || return 1
  local -n services="$array_name"
  ((${#services[@]} > 0)) || return 0
  for service in "${services[@]}"; do
    _is_backup_mutating_service "$service" || return 1
  done
  compose_cmd stop --timeout 60 "${services[@]}"
}

resume_mutators() {
  local array_name="${1:-}" service cloudflared_was_running=0
  local -a non_tunnel_services=()

  _require_indexed_array_name "$array_name" || return 1
  local -n services="$array_name"
  ((${#services[@]} > 0)) || return 0
  for service in "${services[@]}"; do
    _is_backup_mutating_service "$service" || return 1
    if [[ "$service" == cloudflared ]]; then
      cloudflared_was_running=1
    else
      non_tunnel_services+=("$service")
    fi
  done

  if ((${#non_tunnel_services[@]} > 0)); then
    compose_cmd up -d --no-deps --no-build --pull never "${non_tunnel_services[@]}" || return 1
  fi
  if ((cloudflared_was_running)); then
    compose_cmd up -d --no-deps --no-build --pull never cloudflared
  fi
}

load_backup_config() {
  local config_file="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}"
  require_secure_regular_file "$config_file" 600 "$(id -u)" \
    || die "backup config is missing or unsafe: $config_file"
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
  local root="$1" expected_magic="$2" marker real
  require_absolute_path "$root"
  [[ -d "$root" ]] || die "backup target is not mounted: $root"
  marker="$root/.learncoding-backup-root"
  require_secure_regular_file "$marker" 600 "$(id -u)" \
    || die "backup marker is missing or unsafe: $marker"
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
