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
  local actual_mode actual_owner actual_links

  [[ -n "$path" && "$expected_mode" =~ ^[0-7]{3,4}$ && "$expected_owner" =~ ^[0-9]+$ ]] || return 1
  [[ -f "$path" && ! -L "$path" ]] || return 1
  actual_mode="$(stat -c '%a' -- "$path" 2>/dev/null)" || return 1
  actual_owner="$(stat -c '%u' -- "$path" 2>/dev/null)" || return 1
  actual_links="$(stat -c '%h' -- "$path" 2>/dev/null)" || return 1
  [[ "$actual_mode" == "${expected_mode#0}" && "$actual_owner" == "$expected_owner" \
    && "$actual_links" == 1 ]]
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
  local path="${1:-}" line_archive="" line_completed="" line_sha="" extra=""
  local archive="" completed_utc="" sha256="" marker_fd snapshot_fd
  local snapshot_dir="" snapshot="" parse_ok=0 cleanup_ok=1

  SUCCESS_ARCHIVE=""
  SUCCESS_COMPLETED_UTC=""
  SUCCESS_SHA256=""

  require_secure_regular_file "$path" 600 "$(id -u)" || return 1
  if ! { exec {marker_fd}<"$path"; } 2>/dev/null; then
    return 1
  fi
  snapshot_dir="$(mktemp -d -- "${TMPDIR:-/tmp}/.learncoding-marker-read.XXXXXX" 2>/dev/null)" || {
    exec {marker_fd}<&-
    return 1
  }
  snapshot="$snapshot_dir/marker"
  chmod 0700 -- "$snapshot_dir" 2>/dev/null || cleanup_ok=0
  if ((cleanup_ok)) \
    && cat <&"$marker_fd" >"$snapshot" 2>/dev/null \
    && chmod 0600 -- "$snapshot" 2>/dev/null; then
    if ! { exec {snapshot_fd}<"$snapshot"; } 2>/dev/null; then
      cleanup_ok=0
    fi
    if ((cleanup_ok)) \
      && IFS= read -r line_archive <&"$snapshot_fd" \
      && IFS= read -r line_completed <&"$snapshot_fd" \
      && IFS= read -r line_sha <&"$snapshot_fd" \
      && ! IFS= read -r extra <&"$snapshot_fd" \
      && [[ "$line_archive" == SUCCESS_ARCHIVE=* ]] \
      && [[ "$line_completed" == SUCCESS_COMPLETED_UTC=* ]] \
      && [[ "$line_sha" == SUCCESS_SHA256=* ]]; then
      archive="${line_archive#SUCCESS_ARCHIVE=}"
      completed_utc="${line_completed#SUCCESS_COMPLETED_UTC=}"
      sha256="${line_sha#SUCCESS_SHA256=}"
      if _valid_success_marker_values "$archive" "$completed_utc" "$sha256" \
        && cmp -s -- "$snapshot" <(printf '%s\n%s\n%s\n' \
          "SUCCESS_ARCHIVE=$archive" \
          "SUCCESS_COMPLETED_UTC=$completed_utc" \
          "SUCCESS_SHA256=$sha256"); then
        parse_ok=1
      fi
    fi
    if ((cleanup_ok)); then
      exec {snapshot_fd}<&-
    fi
  fi
  exec {marker_fd}<&-
  rm -f -- "$snapshot" 2>/dev/null || cleanup_ok=0
  rmdir -- "$snapshot_dir" 2>/dev/null || cleanup_ok=0
  ((parse_ok && cleanup_ok)) || return 1

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
  : "${MAX_OFFSITE_AGE_HOURS:=30}"
  : "${MAX_RESTORE_DRILL_AGE_HOURS:=2160}"
  : "${RESTORE_DRILL_SOURCE:=offsite}"
  : "${RCLONE_REMOTE:=gdrive:Codestead/backups}"
  : "${RCLONE_CONFIG:=/etc/learncoding/rclone.conf}"
  : "${RCLONE_CONTROL_TIMEOUT_SECONDS:=120}"
  : "${RCLONE_MIN_BULK_BYTES_PER_SECOND:=4194304}"
  : "${RCLONE_BULK_OVERHEAD_SECONDS:=600}"
  : "${RCLONE_SERVICE_BUDGET_SECONDS:=14400}"
  : "${RCLONE_SERVICE_RESERVE_SECONDS:=600}"
  : "${RCLONE_OPERATION_GRACE_SECONDS:=5}"
  : "${RCLONE_OUTPUT_LIMIT_BYTES:=1048576}"
  : "${FILESYSTEM_WARN_PERCENT:=70}"
  : "${FILESYSTEM_CRITICAL_PERCENT:=85}"
  : "${ALERT_HOOK:=/etc/learncoding/alert-hook}"
  [[ "$FILESYSTEM_WARN_PERCENT" =~ ^[0-9]+$ && "$FILESYSTEM_CRITICAL_PERCENT" =~ ^[0-9]+$ ]] \
    || die "filesystem capacity thresholds must be whole percentages"
  (( FILESYSTEM_WARN_PERCENT >= 1 && FILESYSTEM_WARN_PERCENT < FILESYSTEM_CRITICAL_PERCENT && FILESYSTEM_CRITICAL_PERCENT <= 99 )) \
    || die "filesystem capacity thresholds must satisfy 1 <= warning < critical <= 99"
  [[ "$MAX_OFFSITE_AGE_HOURS" =~ ^[1-9][0-9]*$ \
    && "$MAX_RESTORE_DRILL_AGE_HOURS" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_CONTROL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_MIN_BULK_BYTES_PER_SECOND" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_BULK_OVERHEAD_SECONDS" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_SERVICE_BUDGET_SECONDS" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_SERVICE_RESERVE_SECONDS" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_OPERATION_GRACE_SECONDS" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_OUTPUT_LIMIT_BYTES" =~ ^[1-9][0-9]*$ ]] \
    || die "offsite/drill age, transfer policy, grace, and output limits must be positive integers"
  [[ ${#RCLONE_CONTROL_TIMEOUT_SECONDS} -le 5 \
    && ${#RCLONE_MIN_BULK_BYTES_PER_SECOND} -le 12 \
    && ${#RCLONE_BULK_OVERHEAD_SECONDS} -le 5 \
    && ${#RCLONE_SERVICE_BUDGET_SECONDS} -le 5 \
    && ${#RCLONE_SERVICE_RESERVE_SECONDS} -le 5 \
    && ${#RCLONE_OPERATION_GRACE_SECONDS} -le 4 ]] \
    || die "rclone transfer policy values exceed safe arithmetic bounds"
  ((RCLONE_MIN_BULK_BYTES_PER_SECOND <= 1000000000000 \
    && RCLONE_SERVICE_BUDGET_SECONDS <= 14400 \
    && RCLONE_OPERATION_GRACE_SECONDS <= 3600)) \
    || die "rclone throughput or service budget exceeds its policy bound"
  rclone_bulk_plan_fits_service_budget 1 2 \
    || die "rclone service budget cannot fit upload, readback, and reserve"
  [[ ${#MAX_RESTORE_DRILL_AGE_HOURS} -le 4 ]] && ((MAX_RESTORE_DRILL_AGE_HOURS <= 2160)) \
    || die "restore drill age limit must not exceed 2160 hours"
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
      'exec psql --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=report_key="$BACKUP_REPORT_KEY" --set=report_outcome="$BACKUP_REPORT_OUTCOME"')"; then
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

SERVICE_VERIFIED_CIPHERTEXT_SHA256=""
verify_ciphertext_checksum_service_budget() {
  local archive="${1:-}" archive_bytes="${2:-}" checksum="${1:-}.sha256"
  local expected_hash expected_name extra actual_bytes hash_record actual_hash actual_name

  SERVICE_VERIFIED_CIPHERTEXT_SHA256=""
  [[ -f "$archive" && ! -L "$archive" && -s "$archive" ]] || return 1
  [[ -f "$checksum" && ! -L "$checksum" && -s "$checksum" ]] || return 1
  actual_bytes="$(stat -c '%s' -- "$archive")" || return 1
  [[ "$archive_bytes" =~ ^[1-9][0-9]*$ && "$actual_bytes" == "$archive_bytes" ]] \
    || return 1
  [[ "$(wc -l <"$checksum")" -eq 1 ]] || return 1
  read -r expected_hash expected_name extra <"$checksum"
  [[ -z "${extra:-}" && "$expected_hash" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  [[ "$expected_name" == "$(basename -- "$archive")" ]] || return 1
  hash_record="$(run_backup_work_bulk "$archive_bytes" sha256sum -- "$archive")" \
    || return 1
  [[ "$hash_record" != *$'\n'* ]] || return 1
  read -r actual_hash actual_name extra <<<"$hash_record"
  [[ -z "${extra:-}" && "$actual_name" == "$archive" \
    && "$actual_hash" == "$expected_hash" ]] || return 1
  SERVICE_VERIFIED_CIPHERTEXT_SHA256="$actual_hash"
}

require_secure_rclone_config() {
  [[ "${RCLONE_CONFIG:-}" == /* ]] || return 1
  require_secure_regular_file "$RCLONE_CONFIG" 600 0
}

validate_rclone_remote() {
  local value="${RCLONE_REMOTE:-}"
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* \
    && "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*:[^[:space:]].*$ \
    && "$value" != */ ]]
}

readonly RCLONE_BUDGET_STATE_ERROR=70
readonly RCLONE_BUDGET_EXHAUSTED=75
readonly RCLONE_MANAGED_GROUP_PROOF_SECONDS=5
RCLONE_MONOTONIC_MILLISECONDS=""
RCLONE_SERVICE_PHASE="uninitialized"
RCLONE_SERVICE_START_MILLISECONDS=""
RCLONE_SERVICE_LAST_MILLISECONDS=""
RCLONE_SERVICE_HARD_DEADLINE_MILLISECONDS=""
RCLONE_SERVICE_WORK_DEADLINE_MILLISECONDS=""
RCLONE_BUDGET_REMAINING_MILLISECONDS=""
RCLONE_BUDGET_CAP_SECONDS=""

_unsigned_decimal_fits_int64() {
  local value="${1:-}"

  [[ "$value" =~ ^(0|[1-9][0-9]*)$ && ${#value} -le 19 ]] || return 1
  if ((${#value} == 19)); then
    # Fixed-width lexical comparison avoids overflowing Bash signed arithmetic.
    # shellcheck disable=SC2071
    [[ "$value" < 9223372036854775808 ]] || return 1
  fi
  return 0
}

rclone_monotonic_milliseconds() {
  local uptime="" idle="" whole="" fraction=""

  IFS=' ' read -r uptime idle </proc/uptime || return 1
  [[ "$uptime" =~ ^([0-9]{1,12})\.([0-9]{2})$ ]] || return 1
  whole="${BASH_REMATCH[1]}"
  fraction="${BASH_REMATCH[2]}"
  RCLONE_MONOTONIC_MILLISECONDS=$((10#$whole * 1000 + 10#$fraction * 10))
}

_sample_rclone_monotonic_milliseconds() {
  local sample=""

  RCLONE_MONOTONIC_MILLISECONDS=""
  rclone_monotonic_milliseconds || return "$RCLONE_BUDGET_STATE_ERROR"
  sample="$RCLONE_MONOTONIC_MILLISECONDS"
  _unsigned_decimal_fits_int64 "$sample" \
    || return "$RCLONE_BUDGET_STATE_ERROR"
  if [[ -n "$RCLONE_SERVICE_LAST_MILLISECONDS" ]]     && ((sample < RCLONE_SERVICE_LAST_MILLISECONDS)); then
    return "$RCLONE_BUDGET_STATE_ERROR"
  fi
  RCLONE_SERVICE_LAST_MILLISECONDS="$sample"
}

start_rclone_service_budget() {
  local budget_seconds reserve_seconds budget_milliseconds

  [[ "$RCLONE_SERVICE_PHASE" == "uninitialized" ]] \
    || return "$RCLONE_BUDGET_STATE_ERROR"
  [[ "$RCLONE_SERVICE_BUDGET_SECONDS" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_SERVICE_RESERVE_SECONDS" =~ ^[1-9][0-9]*$ \
    && ${#RCLONE_SERVICE_BUDGET_SECONDS} -le 5 \
    && ${#RCLONE_SERVICE_RESERVE_SECONDS} -le 5 ]] \
    || return "$RCLONE_BUDGET_STATE_ERROR"
  budget_seconds=$((10#$RCLONE_SERVICE_BUDGET_SECONDS))
  reserve_seconds=$((10#$RCLONE_SERVICE_RESERVE_SECONDS))
  ((budget_seconds <= 14400 && budget_seconds > reserve_seconds)) \
    || return "$RCLONE_BUDGET_STATE_ERROR"
  budget_milliseconds=$((budget_seconds * 1000))
  _sample_rclone_monotonic_milliseconds || return $?
  ((RCLONE_MONOTONIC_MILLISECONDS <= 9223372036854775807 - budget_milliseconds))     || return "$RCLONE_BUDGET_STATE_ERROR"
  RCLONE_SERVICE_START_MILLISECONDS="$RCLONE_MONOTONIC_MILLISECONDS"
  RCLONE_SERVICE_HARD_DEADLINE_MILLISECONDS=$((RCLONE_MONOTONIC_MILLISECONDS + budget_milliseconds))
  RCLONE_SERVICE_WORK_DEADLINE_MILLISECONDS=$((RCLONE_SERVICE_HARD_DEADLINE_MILLISECONDS - reserve_seconds * 1000))
  RCLONE_SERVICE_PHASE="work"
}

_rclone_service_remaining_milliseconds() {
  local phase="${1:-}" deadline

  [[ "$RCLONE_SERVICE_PHASE" != "uninitialized" ]]     || return "$RCLONE_BUDGET_STATE_ERROR"
  _sample_rclone_monotonic_milliseconds || return $?
  case "$phase" in
    work) deadline="$RCLONE_SERVICE_WORK_DEADLINE_MILLISECONDS" ;;
    finalization) deadline="$RCLONE_SERVICE_HARD_DEADLINE_MILLISECONDS" ;;
    *) return "$RCLONE_BUDGET_STATE_ERROR" ;;
  esac
  RCLONE_BUDGET_REMAINING_MILLISECONDS=$((deadline - RCLONE_MONOTONIC_MILLISECONDS))
  ((RCLONE_BUDGET_REMAINING_MILLISECONDS > 0))     || return "$RCLONE_BUDGET_EXHAUSTED"
}

_run_service_budgeted() {
  local runner="${1:-}" phase="${2:-}" requested_seconds="${3:-}" require_full="${4:-}"
  local available_seconds teardown_seconds child_status=0 budget_status=0
  shift 4 || return "$RCLONE_BUDGET_STATE_ERROR"
  [[ ( "$runner" == _run_rclone_with_deadline \
      || "$runner" == _run_backup_with_deadline ) \
    && "$RCLONE_SERVICE_PHASE" == "$phase" \
    && "$requested_seconds" =~ ^[1-9][0-9]*$ \
    && ( "$require_full" == 0 || "$require_full" == 1 ) \
    && "$RCLONE_OPERATION_GRACE_SECONDS" =~ ^[1-9][0-9]*$ \
    && ${#RCLONE_OPERATION_GRACE_SECONDS} -le 4 ]] \
    || return "$RCLONE_BUDGET_STATE_ERROR"
  teardown_seconds=$((10#$RCLONE_OPERATION_GRACE_SECONDS + RCLONE_MANAGED_GROUP_PROOF_SECONDS))
  ((10#$RCLONE_OPERATION_GRACE_SECONDS <= 3600)) \
    || return "$RCLONE_BUDGET_STATE_ERROR"
  _rclone_service_remaining_milliseconds "$phase" || return $?
  available_seconds=$((RCLONE_BUDGET_REMAINING_MILLISECONDS / 1000))
  ((available_seconds > 0)) || return "$RCLONE_BUDGET_EXHAUSTED"
  RCLONE_BUDGET_CAP_SECONDS="$requested_seconds"
  if ((RCLONE_BUDGET_CAP_SECONDS > available_seconds)); then
    RCLONE_BUDGET_CAP_SECONDS="$available_seconds"
  fi
  if ((require_full && RCLONE_BUDGET_CAP_SECONDS < requested_seconds)); then
    return "$RCLONE_BUDGET_EXHAUSTED"
  fi
  if ((RCLONE_BUDGET_CAP_SECONDS <= teardown_seconds)); then
    return "$RCLONE_BUDGET_EXHAUSTED"
  fi
  "$runner" "$RCLONE_BUDGET_CAP_SECONDS" "$@" || child_status=$?
  _rclone_service_remaining_milliseconds "$phase" || budget_status=$?
  if ((child_status != 0)); then
    ((budget_status == RCLONE_BUDGET_STATE_ERROR)) && return "$budget_status"
    return "$child_status"
  fi
  ((budget_status == 0)) || return "$RCLONE_BUDGET_EXHAUSTED"
}

_run_rclone_budgeted() {
  _run_service_budgeted _run_rclone_with_deadline "$@"
}

_run_backup_budgeted() {
  _run_service_budgeted _run_backup_with_deadline "$@"
}

begin_rclone_service_finalization() {
  [[ "$RCLONE_SERVICE_PHASE" == "work" ]]     || return "$RCLONE_BUDGET_STATE_ERROR"
  _rclone_service_remaining_milliseconds finalization || return $?
  RCLONE_SERVICE_PHASE="finalization"
}

require_rclone_service_finalization_budget() {
  [[ "$RCLONE_SERVICE_PHASE" == "finalization" ]]     || return "$RCLONE_BUDGET_STATE_ERROR"
  _rclone_service_remaining_milliseconds finalization
}

run_managed_backup_command() {
  local allotted_seconds="${1:-}" script_dir managed_deadline command_seconds
  local allotted_value grace_value
  shift || return 125
  [[ "$allotted_seconds" =~ ^[1-9][0-9]*$ \
    && "$RCLONE_OPERATION_GRACE_SECONDS" =~ ^[1-9][0-9]*$ \
    && ${#allotted_seconds} -le 5 \
    && ${#RCLONE_OPERATION_GRACE_SECONDS} -le 4 ]] || return 125
  allotted_value=$((10#$allotted_seconds))
  grace_value=$((10#$RCLONE_OPERATION_GRACE_SECONDS))
  ((allotted_value <= 86400 && grace_value <= 3600)) || return 125
  command_seconds=$((allotted_value - grace_value \
    - RCLONE_MANAGED_GROUP_PROOF_SECONDS))
  ((command_seconds > 0)) || return 125
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || return 125
  managed_deadline="$script_dir/run-managed-deadline.py"
  [[ -f "$managed_deadline" && ! -L "$managed_deadline" ]] || return 125
  python3 "$managed_deadline" --expected-parent-pid "$BASHPID" \
    "$command_seconds" "$grace_value" -- "$@"
}

_run_backup_with_deadline() {
  local deadline_seconds="${1:-}"
  shift || return 125
  run_managed_backup_command "$deadline_seconds" "$@"
}

rclone_bulk_timeout_seconds() {
  local archive_bytes="${1:-}" transfer_seconds
  [[ "$archive_bytes" =~ ^[1-9][0-9]*$ ]] || return 1
  _unsigned_decimal_fits_int64 "$archive_bytes" || return 1
  transfer_seconds=$(((archive_bytes - 1) / RCLONE_MIN_BULK_BYTES_PER_SECOND + 1))
  ((transfer_seconds <= 9223372036854775807 - RCLONE_BULK_OVERHEAD_SECONDS)) || return 1
  printf '%s\n' "$((transfer_seconds + RCLONE_BULK_OVERHEAD_SECONDS))"
}

rclone_bulk_plan_fits_service_budget() {
  local archive_bytes="${1:-}" bulk_legs="${2:-}" deadline required
  [[ "$bulk_legs" == 1 || "$bulk_legs" == 2 ]] || return 1
  deadline="$(rclone_bulk_timeout_seconds "$archive_bytes")" || return 1
  ((deadline < RCLONE_SERVICE_BUDGET_SECONDS)) || return 1
  required=$((deadline * bulk_legs + RCLONE_SERVICE_RESERVE_SECONDS))
  ((required < RCLONE_SERVICE_BUDGET_SECONDS))
}

_run_rclone_with_deadline() {
  local deadline_seconds="${1:-}"
  shift || return 125
  require_secure_rclone_config || return 125
  validate_rclone_remote || return 125
  run_managed_backup_command "$deadline_seconds" rclone "$@" --config "$RCLONE_CONFIG"     --contimeout 15s --timeout 60s --retries 1 --low-level-retries 1
}

run_rclone_control() {
  _run_rclone_budgeted work "$RCLONE_CONTROL_TIMEOUT_SECONDS" 0 "$@"
}

run_rclone_bulk() {
  local archive_bytes="${1:-}" deadline_seconds
  shift || return 125
  deadline_seconds="$(rclone_bulk_timeout_seconds "$archive_bytes")" || return 125
  _run_rclone_budgeted work "$deadline_seconds" 1 "$@"
}

run_rclone_finalization_control() {
  _run_rclone_budgeted finalization "$RCLONE_CONTROL_TIMEOUT_SECONDS" 0 "$@"
}

run_backup_work_control() {
  _run_backup_budgeted work "$RCLONE_CONTROL_TIMEOUT_SECONDS" 0 "$@"
}

run_backup_work_bulk() {
  local archive_bytes="${1:-}" deadline_seconds
  shift || return 125
  deadline_seconds="$(rclone_bulk_timeout_seconds "$archive_bytes")" || return 125
  _run_backup_budgeted work "$deadline_seconds" 1 "$@"
}

run_backup_finalization_control() {
  _run_backup_budgeted finalization "$RCLONE_CONTROL_TIMEOUT_SECONDS" 0 "$@"
}

# Backward-compatible fixed control deadline for retention and evidence calls.
run_rclone() {
  _run_rclone_with_deadline "$RCLONE_CONTROL_TIMEOUT_SECONDS" "$@"
}

_run_rclone_capture_with() {
  local runner="${1:-}" output="${2:-}" maximum_bytes="${3:-}" size
  shift 3 || return 125
  [[ "$runner" == run_rclone || "$runner" == run_rclone_control ]] || return 125
  [[ "$output" == /* && "$maximum_bytes" =~ ^[1-9][0-9]*$ ]] || return 125
  [[ ! -e "$output" && ! -L "$output" ]] || return 125
  if ! "$runner" "$@" >"$output"; then
    rm -f -- "$output"
    return 1
  fi
  [[ -f "$output" && ! -L "$output" ]] || return 1
  chmod 0600 -- "$output" || return 1
  size="$(stat -c '%s' -- "$output")" || return 1
  if ((size > maximum_bytes)); then
    rm -f -- "$output"
    return 1
  fi
}

run_rclone_capture() {
  _run_rclone_capture_with run_rclone "$@"
}

run_rclone_service_capture() {
  _run_rclone_capture_with run_rclone_control "$@"
}
