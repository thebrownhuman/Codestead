#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command df
require_command flock
require_command sha256sum
require_command stat

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
acquire_backup_lock_shared
status=0

alert_problem() {
  emit_alert "$1" "$2" "$3"
  [[ "$1" == "critical" ]] && status=1
}

mapfile -t archives < <(find "$backup_root/full" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' -printf '%f\n' | sort -r)
if (( ${#archives[@]} == 0 )); then
  alert_problem critical backup_missing "no encrypted local backup exists"
else
  latest_path="$backup_root/full/${archives[0]}"
  latest_epoch="$(stat -c %Y "$latest_path")"
  now_epoch="$(date +%s)"
  if (( latest_epoch > now_epoch + 300 )); then
    alert_problem critical backup_clock_skew "latest backup timestamp is more than five minutes in the future"
  fi
  age_hours=$(( ( now_epoch - latest_epoch ) / 3600 ))
  if (( age_hours > MAX_BACKUP_AGE_HOURS )); then
    alert_problem critical backup_stale "latest local backup is ${age_hours} hours old"
  fi

  sample_count="${CHECKSUM_SAMPLE_COUNT:-3}"
  [[ "$sample_count" =~ ^[1-9][0-9]*$ ]] || die "CHECKSUM_SAMPLE_COUNT must be a positive integer"
  for ((i = 0; i < ${#archives[@]} && i < sample_count; i++)); do
    if ! verify_ciphertext_checksum "$backup_root/full/${archives[$i]}"; then
      alert_problem critical backup_checksum_failed "a recent encrypted archive failed checksum validation"
      break
    fi
  done
fi

check_filesystem() {
  local label="$1" path="$2" used
  [[ -e "$path" ]] || { alert_problem critical filesystem_missing "$label filesystem path is missing"; return; }
  used="$(df --output=pcent "$path" | tail -n 1 | tr -dc '0-9')"
  [[ "$used" =~ ^[0-9]+$ ]] || { alert_problem critical filesystem_unknown "cannot read $label filesystem usage"; return; }
  if (( used >= FILESYSTEM_CRITICAL_PERCENT )); then
    alert_problem critical filesystem_capacity "$label filesystem is ${used}% full"
  elif (( used >= FILESYSTEM_WARN_PERCENT )); then
    alert_problem warning filesystem_capacity "$label filesystem is ${used}% full"
  fi
}

check_filesystem backup "$backup_root"
check_filesystem application "$LEARN_DATA_ROOT"

if [[ "${CHECK_OFFSITE:-0}" == "1" && ${#archives[@]} -gt 0 ]]; then
  require_command rclone
  : "${RCLONE_REMOTE:?RCLONE_REMOTE is required when CHECK_OFFSITE=1}"
  : "${RCLONE_CONFIG:?RCLONE_CONFIG is required when CHECK_OFFSITE=1}"
  if ! rclone lsf "$RCLONE_REMOTE" --config "$RCLONE_CONFIG" --files-only --include "${archives[0]}" | grep -Fxq "${archives[0]}"; then
    alert_problem critical offsite_backup_missing "the newest local encrypted archive is absent offsite"
  fi
fi

if (( status == 0 )); then
  log "backup age, checksums, and filesystem capacity are healthy"
fi
exit "$status"
