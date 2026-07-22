#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command flock
require_command python3
require_command rclone
require_command sha256sum

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE must be a dedicated Google Drive backup path}"
: "${RCLONE_CONFIG:?RCLONE_CONFIG must name a root-owned rclone config file}"
require_secure_rclone_config \
  || die "rclone config must be a root-owned, non-symlink mode-0600 file"
validate_rclone_remote || die "RCLONE_REMOTE is invalid"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
acquire_backup_lock

marker="$backup_root/state/local-last-success.env"
read_success_marker "$marker" || die "local success marker is missing or invalid"
archive="$SUCCESS_ARCHIVE"
completed_utc="$SUCCESS_COMPLETED_UTC"
archive_sha256="$SUCCESS_SHA256"
archive_path="$backup_root/full/$archive"
verify_ciphertext_checksum "$archive_path" \
  || die "marked encrypted archive failed checksum validation"
actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
[[ "$actual_sha256" == "$archive_sha256" ]] \
  || die "local marker hash differs from the marked archive"

install -d -m 0700 "$BACKUP_STAGE_ROOT"
stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/offsite-sync.XXXXXX")"
chmod 0700 -- "$stage"
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf --one-file-system -- "$stage"
  exit "$status"
}
trap cleanup EXIT

remote_base="${RCLONE_REMOTE%/}"
remote_archive="$remote_base/full/$archive"
remote_sidecar="$remote_archive.sha256"
remote_point="$remote_base/state/points/$archive.env"
remote_pointer="$remote_base/state/LAST_SUCCESS"
archive_bytes="$(stat -c '%s' -- "$archive_path")" || die "marked archive size could not be read"
rclone_bulk_plan_fits_service_budget "$archive_bytes" 2 \
  || die "archive upload and readback cannot fit the four-hour service budget"


log "uploading the marked encrypted recovery point"
run_rclone_bulk "$archive_bytes" copyto "$archive_path" "$remote_archive" --checksum \
  || die "offsite archive upload failed"
run_rclone_control copyto "$archive_path.sha256" "$remote_sidecar" --checksum \
  || die "offsite checksum upload failed"
readback_dir="$stage/readback"
install -d -m 0700 "$readback_dir"
run_rclone_bulk "$archive_bytes" copyto "$remote_archive" "$readback_dir/$archive" \
  || die "offsite archive read-back failed"
run_rclone_control copyto "$remote_sidecar" "$readback_dir/$archive.sha256" \
  || die "offsite checksum read-back failed"
verify_ciphertext_checksum "$readback_dir/$archive" \
  || die "offsite read-back checksum verification failed"
cmp -s -- "$archive_path" "$readback_dir/$archive" \
  || die "offsite read-back archive bytes differ"
cmp -s -- "$archive_path.sha256" "$readback_dir/$archive.sha256" \
  || die "offsite read-back checksum bytes differ"

listing="$stage/point-listing"
run_rclone_capture "$listing" "$RCLONE_OUTPUT_LIMIT_BYTES" \
  lsf "$remote_point" --files-only --max-depth 1 \
  || die "offsite point-attestation listing failed"
mapfile -t point_entries < <(sed '/^$/d' "$listing")
if ((${#point_entries[@]} == 0)); then
  attestation_completed="$(date -u +%Y%m%dT%H%M%SZ)"
  point_candidate="$stage/point.env"
  write_success_marker "$point_candidate" "$archive" \
    "$attestation_completed" "$archive_sha256" \
    || die "offsite point attestation could not be created"
  pending_point="$remote_base/state/points/.${archive}.pending-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  run_rclone_control copyto "$point_candidate" "$pending_point" \
    || die "offsite point-attestation upload was not confirmed"
  run_rclone_control moveto "$pending_point" "$remote_point" \
    || die "offsite point-attestation publication was not confirmed"
elif ((${#point_entries[@]} == 1)) \
  && [[ "${point_entries[0]}" == "$archive.env" ]]; then
  point_candidate="$stage/point.env"
  run_rclone_control copyto "$remote_point" "$point_candidate" \
    || die "existing offsite point attestation could not be read"
  read_success_marker "$point_candidate" \
    || die "existing offsite point attestation is invalid"
  [[ "$SUCCESS_ARCHIVE" == "$archive" && "$SUCCESS_SHA256" == "$archive_sha256" ]] \
    || die "existing offsite point attestation conflicts with local bytes"
else
  die "offsite point attestation is duplicate or ambiguous"
fi

point_readback="$stage/point-readback.env"
run_rclone_control copyto "$remote_point" "$point_readback" \
  || die "offsite point-attestation read-back failed"
cmp -s -- "$point_candidate" "$point_readback" \
  || die "offsite point-attestation read-back differs"
read_success_marker "$point_readback" \
  || die "offsite point-attestation read-back is invalid"
[[ "$SUCCESS_ARCHIVE" == "$archive" && "$SUCCESS_SHA256" == "$archive_sha256" ]] \
  || die "verified point attestation does not describe the uploaded archive"

pending_pointer="$remote_base/state/.LAST_SUCCESS.pending-$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_rclone_control copyto "$point_readback" "$pending_pointer" \
  || die "offsite pointer upload was not confirmed"
run_rclone_control moveto "$pending_pointer" "$remote_pointer" \
  || die "offsite pointer publication was not confirmed"
pointer_readback="$stage/pointer-readback.env"
run_rclone_control copyto "$remote_pointer" "$pointer_readback" \
  || die "offsite pointer read-back failed"
cmp -s -- "$point_readback" "$pointer_readback" \
  || die "offsite pointer differs from immutable point attestation"
read_success_marker "$pointer_readback" || die "offsite pointer is invalid"

write_success_marker "$backup_root/state/offsite-last-success.env" \
  "$SUCCESS_ARCHIVE" "$SUCCESS_COMPLETED_UTC" "$SUCCESS_SHA256" \
  || die "local offsite acknowledgement could not be committed"
cmp -s -- "$backup_root/state/offsite-last-success.env" "$pointer_readback" \
  || die "local offsite acknowledgement differs from remote verified bytes"

emit_alert info offsite_sync_complete \
  "encrypted recovery point upload and read-back verification completed"
