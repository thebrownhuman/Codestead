#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command date
require_command df
require_command find
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
mapfile -t sidecars < <(find "$backup_root/full" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age.sha256' -printf '%f\n' | sort -r)
local_marker="$backup_root/state/local-last-success.env"
marker_valid=0
if ! read_success_marker "$local_marker"; then
  alert_problem critical backup_marker_invalid \
    "the strict local success marker is missing or invalid"
else
  marked_archive="$SUCCESS_ARCHIVE"
  marked_completed="$SUCCESS_COMPLETED_UTC"
  marked_sha256="$SUCCESS_SHA256"
  marked_path="$backup_root/full/$marked_archive"
  marked_sidecar="$marked_path.sha256"

  if ! require_secure_regular_file "$marked_path" 600 "$(id -u)" \
    || ! require_secure_regular_file "$marked_sidecar" 600 "$(id -u)"; then
    alert_problem critical backup_marker_target_missing \
      "the marked local recovery point or checksum sidecar is missing or unsafe"
  elif [[ "$(<"$marked_sidecar")" != "$marked_sha256  $marked_archive" ]] \
    || ! verify_ciphertext_checksum "$marked_path"; then
    alert_problem critical backup_marker_checksum_failed \
      "the marked local recovery point differs from its exact checksum attestation"
  else
    marker_valid=1
    now_epoch="$(date -u +%s)"
    completed_epoch="$(date -u -d \
      "${marked_completed:0:4}-${marked_completed:4:2}-${marked_completed:6:2} ${marked_completed:9:2}:${marked_completed:11:2}:${marked_completed:13:2} UTC" +%s)" \
      || die "local marker completion timestamp could not be parsed"
    snapshot="${marked_archive#learncoding-full-}"
    snapshot="${snapshot%.tar.gz.age}"
    snapshot_epoch="$(date -u -d \
      "${snapshot:0:4}-${snapshot:4:2}-${snapshot:6:2} ${snapshot:9:2}:${snapshot:11:2}:${snapshot:13:2} UTC" +%s)" \
      || die "local backup snapshot timestamp could not be parsed"
    [[ "$MAX_BACKUP_AGE_HOURS" =~ ^[1-9][0-9]*$ ]] \
      || die "MAX_BACKUP_AGE_HOURS must be a positive integer"
    maximum_age_seconds=$((MAX_BACKUP_AGE_HOURS * 3600))
    if ((completed_epoch < snapshot_epoch)); then
      alert_problem critical backup_marker_chronology \
        "local backup completion precedes its snapshot"
    elif ((completed_epoch > now_epoch + 300 || snapshot_epoch > now_epoch + 300)); then
      alert_problem critical backup_clock_skew \
        "marked local recovery-point time is more than five minutes in the future"
    elif ((now_epoch - completed_epoch > maximum_age_seconds \
      || now_epoch - snapshot_epoch > maximum_age_seconds)); then
      age_hours=$(( (now_epoch - snapshot_epoch) / 3600 ))
      alert_problem critical backup_stale \
        "marked local recovery point is ${age_hours} hours old"
    fi
  fi

  if ((${#archives[@]} > 0)) && [[ "${archives[0]}" > "$marked_archive" ]]; then
    alert_problem critical backup_uncommitted_newer_point \
      "a newer local archive exists without marker commitment"
  fi
  if ((${#sidecars[@]} > 0)); then
    newest_sidecar_archive="${sidecars[0]%.sha256}"
    if [[ "$newest_sidecar_archive" > "$marked_archive" ]]; then
      alert_problem critical backup_uncommitted_newer_point \
        "a newer local checksum sidecar exists without marker commitment"
    fi
  fi
fi

if ((marker_valid == 1)); then
  sample_count="${CHECKSUM_SAMPLE_COUNT:-3}"
  [[ "$sample_count" =~ ^[1-9][0-9]*$ ]] \
    || die "CHECKSUM_SAMPLE_COUNT must be a positive integer"
  sample_index=0
  for archive_name in "$marked_archive" "${archives[@]}"; do
    [[ "$archive_name" > "$marked_archive" ]] && continue
    if ((sample_index > 0)) && [[ "$archive_name" == "$marked_archive" ]]; then
      continue
    fi
    if ! verify_ciphertext_checksum "$backup_root/full/$archive_name"; then
      alert_problem critical backup_checksum_failed \
        "a committed recent encrypted archive failed checksum validation"
      break
    fi
    sample_index=$((sample_index + 1))
    ((sample_index < sample_count)) || break
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
  require_command cmp
  require_command python3
  require_command rclone
  : "${RCLONE_REMOTE:?RCLONE_REMOTE is required when CHECK_OFFSITE=1}"
  : "${RCLONE_CONFIG:?RCLONE_CONFIG is required when CHECK_OFFSITE=1}"
  require_secure_rclone_config \
    || die "rclone config must be a root-owned, non-symlink mode-0600 file"
  validate_rclone_remote || die "RCLONE_REMOTE is invalid"
  install -d -m 0700 "$BACKUP_STAGE_ROOT"
  offsite_stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/offsite-check.XXXXXX")"
  chmod 0700 -- "$offsite_stage"
  cleanup_offsite_check() {
    rm -rf --one-file-system -- "$offsite_stage"
  }
  trap cleanup_offsite_check EXIT
  remote_base="${RCLONE_REMOTE%/}"
  remote_object_is_unique() {
    local remote="$1" listing="$2" expected
    rm -f -- "$listing"
    run_rclone_capture "$listing" "$RCLONE_OUTPUT_LIMIT_BYTES" \
      lsf "$remote" --files-only --max-depth 1 || return 1
    expected="$(basename -- "$remote")"
    mapfile -t exact_entries < <(sed '/^$/d' "$listing")
    ((${#exact_entries[@]} == 1)) && [[ "${exact_entries[0]}" == "$expected" ]]
  }

  pointer="$offsite_stage/LAST_SUCCESS"
  if ! remote_object_is_unique \
    "$remote_base/state/LAST_SUCCESS" "$offsite_stage/listing.pointer"; then
    alert_problem critical offsite_pointer_missing \
      "offsite success pointer is missing or has a duplicate name"
  elif ! run_rclone copyto "$remote_base/state/LAST_SUCCESS" "$pointer"; then
    alert_problem critical offsite_pointer_missing "offsite success pointer could not be read"
  elif ! read_success_marker "$pointer"; then
    alert_problem critical offsite_pointer_invalid "offsite success pointer is invalid"
  else
    offsite_archive="$SUCCESS_ARCHIVE"
    offsite_completed="$SUCCESS_COMPLETED_UTC"
    offsite_sha256="$SUCCESS_SHA256"
    attestation="$offsite_stage/$offsite_archive.env"
    if ! remote_object_is_unique "$remote_base/state/points/$offsite_archive.env" \
      "$offsite_stage/listing.attestation"; then
      alert_problem critical offsite_attestation_missing \
        "immutable offsite point attestation is missing or has a duplicate name"
    elif ! run_rclone copyto "$remote_base/state/points/$offsite_archive.env" "$attestation"; then
      alert_problem critical offsite_attestation_missing "immutable offsite point attestation is missing"
    elif ! cmp -s -- "$pointer" "$attestation" \
      || ! read_success_marker "$attestation" \
      || [[ "$SUCCESS_ARCHIVE" != "$offsite_archive" \
        || "$SUCCESS_COMPLETED_UTC" != "$offsite_completed" \
        || "$SUCCESS_SHA256" != "$offsite_sha256" ]]; then
      alert_problem critical offsite_attestation_invalid \
        "offsite pointer differs from its immutable point attestation"
    else
      now_epoch="$(date -u +%s)"
      completed_epoch="$(date -u -d \
        "${offsite_completed:0:4}-${offsite_completed:4:2}-${offsite_completed:6:2} ${offsite_completed:9:2}:${offsite_completed:11:2}:${offsite_completed:13:2} UTC" +%s)" \
        || die "offsite completion timestamp could not be parsed"
      snapshot="${offsite_archive#learncoding-full-}"
      snapshot="${snapshot%.tar.gz.age}"
      snapshot_epoch="$(date -u -d \
        "${snapshot:0:4}-${snapshot:4:2}-${snapshot:6:2} ${snapshot:9:2}:${snapshot:11:2}:${snapshot:13:2} UTC" +%s)" \
        || die "offsite snapshot timestamp could not be parsed"
      maximum_age_seconds=$((MAX_OFFSITE_AGE_HOURS * 3600))
      if ((completed_epoch > now_epoch + 300 || snapshot_epoch > now_epoch + 300)); then
        alert_problem critical offsite_clock_skew \
          "offsite recovery point timestamp is more than five minutes in the future"
      elif ((now_epoch - completed_epoch > maximum_age_seconds \
        || now_epoch - snapshot_epoch > maximum_age_seconds)); then
        alert_problem critical offsite_backup_stale \
          "the marked offsite recovery point is older than the configured freshness limit"
      fi
      for remote_object in "$remote_base/full/$offsite_archive" \
        "$remote_base/full/$offsite_archive.sha256"; do
        listing="$offsite_stage/listing.$RANDOM"
        if ! run_rclone_capture "$listing" "$RCLONE_OUTPUT_LIMIT_BYTES" \
          lsf "$remote_object" --files-only --max-depth 1 \
          || [[ "$(sed '/^$/d' "$listing" | wc -l)" -ne 1 ]] \
          || ! grep -Fxq "$(basename -- "$remote_object")" "$listing"; then
          alert_problem critical offsite_backup_missing \
            "a marked offsite recovery-point object is missing or ambiguous"
          break
        fi
      done
    fi
  fi
  cleanup_offsite_check
  trap - EXIT
fi

if (( status == 0 )); then
  log "backup age, checksums, and filesystem capacity are healthy"
fi
exit "$status"
