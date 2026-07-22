#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command cmp
require_command flock
require_command python3
require_command rclone
require_command sed

usage() {
  printf 'usage: %s EMPTY_DESTINATION\n' "$0" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
destination="$1"
require_absolute_path "$destination"
require_secure_rclone_config \
  || die "rclone config must be a root-owned, non-symlink mode-0600 file"
validate_rclone_remote || die "RCLONE_REMOTE is invalid"

destination="$(realpath -m -- "$destination")"
for live_root in "$REPO_ROOT" "$LEARN_DATA_ROOT" "${BACKUP_ROOT:-/nonexistent}"; do
  if path_is_within "$destination" "$live_root"; then
    die "offsite retrieval destination is inside a live data root"
  fi
done
[[ "$destination" != / && "$destination" != /srv && "$destination" != /var ]] \
  || die "offsite retrieval destination is unsafe"
if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -d "$destination" && ! -L "$destination" ]] \
    || die "offsite retrieval destination is not a safe directory"
  [[ -z "$(find -P "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
    || die "offsite retrieval destination must be empty"
else
  install -d -m 0700 "$destination"
fi
[[ "$(stat -c '%a:%u' -- "$destination")" == "700:$(id -u)" ]] \
  || die "offsite retrieval destination metadata is unsafe"

acquire_backup_lock_shared
stage="$(mktemp -d -- "$destination/.offsite-fetch.XXXXXX")"
chmod 0700 -- "$stage"
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf --one-file-system -- "$stage"
  if ((status != 0)); then
    find -P "$destination" -mindepth 1 -maxdepth 1 -type f \
      -name '.offsite-fetch-*' -delete 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

remote_base="${RCLONE_REMOTE%/}"
require_unique_remote_object() {
  local remote="$1" listing="$2" expected
  rm -f -- "$listing"
  run_rclone_capture "$listing" "$RCLONE_OUTPUT_LIMIT_BYTES" \
    lsf "$remote" --files-only --max-depth 1 \
    || die "required remote object listing failed or exceeded its bound"
  expected="$(basename -- "$remote")"
  mapfile -t exact_entries < <(sed '/^$/d' "$listing")
  ((${#exact_entries[@]} == 1)) && [[ "${exact_entries[0]}" == "$expected" ]] \
    || die "required remote object is missing or has a duplicate name"
}

pointer="$stage/LAST_SUCCESS"
require_unique_remote_object "$remote_base/state/LAST_SUCCESS" "$stage/listing.pointer"
run_rclone_control copyto "$remote_base/state/LAST_SUCCESS" "$pointer" \
  || die "remote success pointer could not be downloaded"
read_success_marker "$pointer" || die "remote success pointer is invalid"
archive="$SUCCESS_ARCHIVE"
archive_sha256="$SUCCESS_SHA256"

attestation="$stage/$archive.env"
require_unique_remote_object "$remote_base/state/points/$archive.env" "$stage/listing.attestation"
run_rclone_control copyto "$remote_base/state/points/$archive.env" "$attestation" \
  || die "immutable point attestation could not be downloaded"
cmp -s -- "$pointer" "$attestation" \
  || die "remote pointer differs from its immutable point attestation"
read_success_marker "$attestation" \
  || die "immutable point attestation is invalid"
[[ "$SUCCESS_ARCHIVE" == "$archive" && "$SUCCESS_SHA256" == "$archive_sha256" ]] \
  || die "remote point metadata changed during retrieval"

downloaded_archive="$stage/$archive"
require_unique_remote_object "$remote_base/full/$archive" "$stage/listing.archive"
require_unique_remote_object \
  "$remote_base/full/$archive.sha256" "$stage/listing.sidecar"
archive_size_metadata="$stage/archive-size.json"
run_rclone_capture "$archive_size_metadata" "$RCLONE_OUTPUT_LIMIT_BYTES" \
  size "$remote_base/full/$archive" --json \
  || die "marked offsite archive size could not be read"
archive_bytes="$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1], encoding="utf-8")); count=value.get("count"); size=value.get("bytes"); assert count == 1 and isinstance(size, int) and size > 0; print(size)' "$archive_size_metadata")" \
  || die "marked offsite archive size metadata is invalid"
rclone_bulk_plan_fits_service_budget "$archive_bytes" 1 \
  || die "archive download and restore reserve cannot fit the four-hour service budget"
run_rclone_bulk "$archive_bytes" copyto "$remote_base/full/$archive" "$downloaded_archive" \
  || die "marked offsite archive could not be downloaded"
run_rclone_control copyto "$remote_base/full/$archive.sha256" "$downloaded_archive.sha256" \
  || die "marked offsite checksum could not be downloaded"
verify_ciphertext_checksum "$downloaded_archive" \
  || die "downloaded offsite recovery point failed checksum verification"
actual_sha256="$(sha256sum "$downloaded_archive" | awk '{print $1}')"
[[ "$actual_sha256" == "$archive_sha256" ]] \
  || die "downloaded archive hash differs from the immutable point attestation"

mv -T -- "$downloaded_archive" "$destination/$archive"
mv -T -- "$downloaded_archive.sha256" "$destination/$archive.sha256"
chmod 0600 -- "$destination/$archive" "$destination/$archive.sha256"
sync -f -- "$destination/$archive" "$destination/$archive.sha256"
rm -f -- "$pointer" "$attestation" \
  "$stage/listing.pointer" "$stage/listing.attestation" \
  "$stage/listing.archive" "$stage/listing.sidecar" "$archive_size_metadata"
rmdir -- "$stage"
stage="$destination/.offsite-fetch.removed"
sync -f -- "$destination"
printf '%s\n' "$destination/$archive"
