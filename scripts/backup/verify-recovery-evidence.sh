#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
for command_name in awk cmp date find flock grep mktemp rclone sed sha256sum sort stat; do
  require_command "$command_name"
done

usage() {
  printf 'usage: %s --output /absolute/path\n' "$(basename -- "$0")" >&2
  exit 64
}

[[ $# -eq 2 && "$1" == --output ]] || usage
output="$2"
require_absolute_path "$output"
: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
require_secure_rclone_config \
  || die "rclone config must be a root-owned, non-symlink mode-0600 file"
validate_rclone_remote || die "RCLONE_REMOTE is invalid"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
state_root="$backup_root/state"
[[ -d "$state_root" && ! -L "$state_root" ]] \
  || die "backup state directory is missing or unsafe"
path_is_within "$output" "$state_root" \
  || die "evidence output must remain inside the initialized backup state directory"
if [[ -e "$output" || -L "$output" ]]; then
  require_secure_regular_file "$output" 600 "$(id -u)" \
    || die "existing evidence output is unsafe"
fi
acquire_backup_lock_shared

install -d -m 0700 "$BACKUP_STAGE_ROOT"
stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/recovery-evidence.XXXXXX")"
chmod 0700 -- "$stage"
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf --one-file-system -- "$stage"
  exit "$status"
}
trap cleanup EXIT

remote_base="${RCLONE_REMOTE%/}"
readonly archive_pattern='^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$'
readonly retention_report="$state_root/offsite-retention-last-report.txt"
readonly metrics_validator="$SCRIPT_DIR/validate-restore-metrics.sh"
require_secure_regular_file "$retention_report" 600 "$(id -u)" \
  || die "offsite retention report is missing or unsafe"
[[ -f "$metrics_validator" && ! -L "$metrics_validator" ]] \
  || die "restore metrics validator is missing or unsafe"

mapfile -t retention_lines <"$retention_report"
[[ ${#retention_lines[@]} -eq 15 ]] \
  || die "offsite retention report has an invalid schema"
[[ "${retention_lines[0]}" == version=1 \
  && "${retention_lines[1]}" =~ ^run_id=([0-9a-f]{32})$ \
  && "${retention_lines[2]}" =~ ^completed_utc=([0-9]{8}T[0-9]{6}Z)$ \
  && "${retention_lines[3]}" =~ ^pointer_archive=(learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age)$ \
  && "${retention_lines[4]}" == policy=7-daily-4-weekly-12-monthly \
  && "${retention_lines[5]}" =~ ^active_listing_sha256=([0-9a-f]{64})$ \
  && "${retention_lines[6]}" =~ ^trashed_listing_sha256=([0-9a-f]{64})$ \
  && "${retention_lines[7]}" =~ ^active_committed_count=([1-9][0-9]*)$ \
  && "${retention_lines[8]}" == trashed_recovery_points=* \
  && "${retention_lines[9]}" == daily_buckets=* \
  && "${retention_lines[10]}" == weekly_buckets=* \
  && "${retention_lines[11]}" == monthly_buckets=* \
  && "${retention_lines[12]}" == preserved_debris=* \
  && "${retention_lines[13]}" == pending_journal=false \
  && "${retention_lines[14]}" == result=pass ]] \
  || die "offsite retention report is malformed or not passing"
retention_run_id="${retention_lines[1]#run_id=}"
retention_completed="${retention_lines[2]#completed_utc=}"
pointer_archive="${retention_lines[3]#pointer_archive=}"
reported_active_digest="${retention_lines[5]#active_listing_sha256=}"
reported_trash_digest="${retention_lines[6]#trashed_listing_sha256=}"
reported_committed_count="${retention_lines[7]#active_committed_count=}"
reported_trashed="${retention_lines[8]#trashed_recovery_points=}"
reported_daily="${retention_lines[9]#daily_buckets=}"
reported_weekly="${retention_lines[10]#weekly_buckets=}"
reported_monthly="${retention_lines[11]#monthly_buckets=}"
reported_debris="${retention_lines[12]#preserved_debris=}"
_valid_compact_utc_timestamp "$retention_completed" \
  || die "retention completion timestamp is invalid"
retention_epoch="$(date -u -d \
  "${retention_completed:0:4}-${retention_completed:4:2}-${retention_completed:6:2} ${retention_completed:9:2}:${retention_completed:11:2}:${retention_completed:13:2} UTC" +%s)"
now_epoch="$(date -u +%s)"
((retention_epoch <= now_epoch + 300 && now_epoch - retention_epoch <= 21600)) \
  || die "retention evidence is stale or from the future"

capture_listing() {
  local destination="$1" trash_only="${2:-0}"
  rm -f -- "$destination"
  if [[ "$trash_only" == 1 ]]; then
    run_rclone_capture "$destination" "$RCLONE_OUTPUT_LIMIT_BYTES" \
      lsf "$remote_base" --recursive --files-only --drive-trashed-only=true \
      || die "trashed offsite listing failed or exceeded its bound"
  else
    run_rclone_capture "$destination" "$RCLONE_OUTPUT_LIMIT_BYTES" \
      lsf "$remote_base" --recursive --files-only \
      || die "active offsite listing failed or exceeded its bound"
  fi
  LC_ALL=C sort -o "$destination" "$destination"
  [[ ! -s "$destination" || "$(wc -l <"$destination")" -le 10000 ]] \
    || die "offsite listing contains too many objects"
  if [[ -s "$destination" && -n "$(uniq -d "$destination" | head -n 1)" ]]; then
    die "offsite listing contains duplicate paths"
  fi
  while IFS= read -r listed_path; do
    [[ -n "$listed_path" && "$listed_path" != /* && "$listed_path" != *'..'* \
      && "$listed_path" != *$'\n'* && "$listed_path" != *$'\r'* ]] \
      || die "offsite listing contains an unsafe path"
  done <"$destination"
}

download_remote() {
  local remote="$1" destination="$2"
  rm -f -- "$destination"
  run_rclone copyto "$remote" "$destination" \
    || die "required offsite evidence could not be downloaded"
  [[ -f "$destination" && ! -L "$destination" ]] \
    || die "downloaded offsite evidence is unsafe"
  chmod 0600 -- "$destination"
}

split_csv() {
  local value="$1" array_name="$2" item
  local -n destination="$array_name"
  destination=()
  [[ -n "$value" ]] || return 0
  IFS=, read -r -a destination <<<"$value"
  for item in "${destination[@]}"; do
    [[ -n "$item" && "$item" != *$'\n'* && "$item" != *$'\r'* ]] \
      || die "retention report contains a malformed list"
  done
  [[ "$(printf '%s\n' "${destination[@]}" | LC_ALL=C sort | uniq | wc -l)" \
    -eq "${#destination[@]}" ]] \
    || die "retention report contains a duplicate list entry"
}

join_csv() {
  local IFS=,
  printf '%s' "$*"
}

active_initial="$stage/active.initial"
trash_initial="$stage/trash.initial"
capture_listing "$active_initial" 0
capture_listing "$trash_initial" 1
[[ "$(sha256sum "$active_initial" | awk '{print $1}')" == "$reported_active_digest" \
  && "$(sha256sum "$trash_initial" | awk '{print $1}')" == "$reported_trash_digest" ]] \
  || die "offsite inventory no longer matches the retention report"

pointer_local="$stage/pointer.env"
download_remote "$remote_base/state/LAST_SUCCESS" "$pointer_local"
read_success_marker "$pointer_local" || die "offsite pointer is invalid"
[[ "$SUCCESS_ARCHIVE" == "$pointer_archive" ]] \
  || die "offsite pointer conflicts with the retention report"
pointer_sha="$SUCCESS_SHA256"
pointer_point="$stage/pointer-point.env"
download_remote "$remote_base/state/points/$pointer_archive.env" "$pointer_point"
read_success_marker "$pointer_point" || die "pointer attestation is invalid"
[[ "$SUCCESS_ARCHIVE" == "$pointer_archive" && "$SUCCESS_SHA256" == "$pointer_sha" ]] \
  || die "pointer attestation conflicts with the pointer"
cmp -s -- "$pointer_local" "$pointer_point" \
  || die "offsite pointer is not byte-identical to its immutable attestation"

declare -A committed_sha=() expected_active=()
declare -a committed=()
expected_active["state/LAST_SUCCESS"]=1
while IFS= read -r attestation_path; do
  [[ "$attestation_path" == state/points/learncoding-full-*.tar.gz.age.env ]] || continue
  archive="${attestation_path#state/points/}"
  archive="${archive%.env}"
  [[ "$archive" =~ $archive_pattern ]] || die "offsite attestation name is malformed"
  point_local="$stage/point-$archive.env"
  sidecar_local="$stage/sidecar-$archive"
  download_remote "$remote_base/$attestation_path" "$point_local"
  read_success_marker "$point_local" || die "offsite attestation is invalid"
  [[ "$SUCCESS_ARCHIVE" == "$archive" ]] \
    || die "offsite attestation conflicts with its path"
  committed_sha["$archive"]="$SUCCESS_SHA256"
  download_remote "$remote_base/full/$archive.sha256" "$sidecar_local"
  [[ "$(wc -l <"$sidecar_local")" -eq 1 ]] \
    || die "offsite checksum sidecar is malformed"
  read -r sidecar_sha sidecar_name sidecar_extra <"$sidecar_local"
  [[ -z "${sidecar_extra:-}" && "$sidecar_sha" == "$SUCCESS_SHA256" \
    && "$sidecar_name" == "$archive" ]] \
    || die "offsite checksum sidecar conflicts with its attestation"
  committed+=("$archive")
  expected_active["full/$archive"]=1
  expected_active["full/$archive.sha256"]=1
  expected_active["state/points/$archive.env"]=1
done <"$active_initial"
[[ ${#committed[@]} -eq "$reported_committed_count" \
  && -n "${committed_sha[$pointer_archive]+x}" \
  && "${committed_sha[$pointer_archive]}" == "$pointer_sha" ]] \
  || die "active committed recovery points conflict with the retention report"
mapfile -t committed < <(printf '%s\n' "${committed[@]}" | LC_ALL=C sort -r -u)
[[ ${#committed[@]} -eq "$reported_committed_count" ]] \
  || die "active committed recovery points contain duplicates"

declare -a debris=() reported_debris_items=()
split_csv "$reported_debris" reported_debris_items
for debris_path in "${reported_debris_items[@]}"; do
  case "$debris_path" in
    full/learncoding-full-*.tar.gz.age|full/learncoding-full-*.tar.gz.age.sha256|state/.LAST_SUCCESS.pending-*|state/points/.learncoding-full-*.tar.gz.age.pending-*) ;;
    *) die "retention report identifies an invalid preserved debris path" ;;
  esac
  [[ -z "${expected_active[$debris_path]+x}" ]] \
    || die "retention report misclassifies committed evidence as debris"
  expected_active["$debris_path"]=1
  debris+=("$debris_path")
done
expected_active_file="$stage/active.expected"
printf '%s\n' "${!expected_active[@]}" | LC_ALL=C sort >"$expected_active_file"
cmp -s -- "$expected_active_file" "$active_initial" \
  || die "active offsite inventory is incomplete, unexpected, or unreported"
[[ "$(join_csv "${debris[@]}")" == "$reported_debris" ]] \
  || die "preserved debris ordering conflicts with the retention report"

declare -A daily_seen=() weekly_seen=() monthly_seen=()
declare -a calculated_daily=() calculated_weekly=() calculated_monthly=()
daily_count=0
weekly_count=0
monthly_count=0
for archive in "${committed[@]}"; do
  timestamp="${archive#learncoding-full-}"
  timestamp="${timestamp%.tar.gz.age}"
  _valid_compact_utc_timestamp "$timestamp" \
    || die "committed recovery point timestamp is invalid"
  day="${timestamp:0:8}"
  week="$(date -u -d \
    "${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC" +%G-W%V)"
  month="${timestamp:0:6}"
  if ((daily_count < 7)) && [[ -z "${daily_seen[$day]+x}" ]]; then
    daily_seen["$day"]=1
    calculated_daily+=("$day:$archive")
    ((daily_count+=1))
  fi
  if ((weekly_count < 4)) && [[ -z "${weekly_seen[$week]+x}" ]]; then
    weekly_seen["$week"]=1
    calculated_weekly+=("$week:$archive")
    ((weekly_count+=1))
  fi
  if ((monthly_count < 12)) && [[ -z "${monthly_seen[$month]+x}" ]]; then
    monthly_seen["$month"]=1
    calculated_monthly+=("$month:$archive")
    ((monthly_count+=1))
  fi
done
[[ "$(join_csv "${calculated_daily[@]}")" == "$reported_daily" \
  && "$(join_csv "${calculated_weekly[@]}")" == "$reported_weekly" \
  && "$(join_csv "${calculated_monthly[@]}")" == "$reported_monthly" ]] \
  || die "retention bucket evidence does not match the deterministic policy"

declare -a trashed_archives=()
declare -A reported_trash_paths=() reported_trash_archives=()
split_csv "$reported_trashed" trashed_archives
for archive in "${trashed_archives[@]}"; do
  [[ "$archive" =~ $archive_pattern && -z "${committed_sha[$archive]+x}" ]] \
    || die "trashed recovery-point evidence is malformed or still active"
  [[ -z "${reported_trash_archives[$archive]+x}" ]] \
    || die "trashed recovery-point evidence contains duplicates"
  reported_trash_archives["$archive"]=1
  for trashed_path in \
    "full/$archive" \
    "full/$archive.sha256" \
    "state/points/$archive.env"; do
    grep -Fxq -- "$trashed_path" "$trash_initial" \
      || die "trashed recovery-point triplet is incomplete"
    reported_trash_paths["$trashed_path"]=1
  done
done
while IFS= read -r trashed_path; do
  if [[ -n "${reported_trash_paths[$trashed_path]+x}" ]]; then
    continue
  fi
  case "$trashed_path" in
    state/retention/*.journal)
      [[ "${trashed_path#state/retention/}" =~ ^[0-9a-f]{32}\.journal$ ]] \
        || die "trashed retention journal name is malformed"
      ;;
    *) die "trashed offsite inventory contains an unreported object" ;;
  esac
done <"$trash_initial"

restore_dir="$backup_root/restore-reports"
[[ -d "$restore_dir" && ! -L "$restore_dir" ]] \
  || die "restore report directory is missing or unsafe"
shopt -s nullglob
restore_candidates=("$restore_dir"/restore-drill-*.txt)
shopt -u nullglob
((${#restore_candidates[@]} > 0)) || die "no restore drill report is available"
for candidate in "${restore_candidates[@]}"; do
  require_secure_regular_file "$candidate" 600 "$(id -u)" \
    || die "restore drill report is unsafe"
done
mapfile -t restore_candidates < <(printf '%s\n' "${restore_candidates[@]}" | LC_ALL=C sort -r)
restore_report="${restore_candidates[0]}"
restore_name="$(basename -- "$restore_report")"
restore_checksum="$restore_report.sha256"
require_secure_regular_file "$restore_checksum" 600 "$(id -u)" \
  || die "restore drill report checksum is missing or unsafe"
[[ "$(wc -l <"$restore_checksum")" -eq 1 ]] \
  || die "restore drill report checksum is malformed"
read -r restore_expected_hash restore_expected_name restore_checksum_extra <"$restore_checksum"
[[ -z "${restore_checksum_extra:-}" && "$restore_expected_hash" =~ ^[0-9a-f]{64}$ \
  && "$restore_expected_name" == "$restore_name" \
  && "$(sha256sum "$restore_report" | awk '{print $1}')" == "$restore_expected_hash" ]] \
  || die "restore drill report checksum verification failed"

mapfile -t restore_lines <"$restore_report"
[[ ${#restore_lines[@]} -eq 19 \
  && "${restore_lines[0]}" == version=1 \
  && "${restore_lines[1]}" == result=pass \
  && "${restore_lines[2]}" == source=offsite \
  && "${restore_lines[3]}" =~ ^archive=(learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age)$ \
  && "${restore_lines[4]}" =~ ^approval_utc=([0-9]{8}T[0-9]{6}Z)$ \
  && "${restore_lines[5]}" =~ ^snapshot_utc=([0-9]{8}T[0-9]{6}Z)$ \
  && "${restore_lines[6]}" =~ ^incident_utc=([0-9]{8}T[0-9]{6}Z)$ \
  && "${restore_lines[7]}" =~ ^recorded_utc=([0-9]{8}T[0-9]{6}Z)$ \
  && "${restore_lines[8]}" == chronology_valid=true \
  && "${restore_lines[9]}" == database_schema_valid=true \
  && "${restore_lines[10]}" =~ ^public_table_count=([1-9][0-9]*)$ \
  && "${restore_lines[11]}" == app_data_valid=true \
  && "${restore_lines[12]}" == credential_recovery=true \
  && "${restore_lines[13]}" == live_database_modified=false \
  && "${restore_lines[14]}" == cleanup_complete=true \
  && "${restore_lines[15]}" =~ ^rpo_seconds=([0-9]+)$ \
  && "${restore_lines[16]}" == rpo_within_24h=true \
  && "${restore_lines[17]}" =~ ^rto_seconds=([0-9]+)$ \
  && "${restore_lines[18]}" == rto_within_4h=true ]] \
  || die "latest restore drill report is malformed or not passing"
restore_approval="${restore_lines[4]#approval_utc=}"
restore_snapshot="${restore_lines[5]#snapshot_utc=}"
restore_incident="${restore_lines[6]#incident_utc=}"
restore_recorded="${restore_lines[7]#recorded_utc=}"
restore_rpo="${restore_lines[15]#rpo_seconds=}"
restore_rto="${restore_lines[17]#rto_seconds=}"
[[ "$restore_name" == "restore-drill-$restore_approval.txt" ]] \
  || die "restore drill report name conflicts with its approval timestamp"
restore_approval_epoch="$(date -u -d \
  "${restore_approval:0:4}-${restore_approval:4:2}-${restore_approval:6:2} ${restore_approval:9:2}:${restore_approval:11:2}:${restore_approval:13:2} UTC" +%s)" \
  || die "restore drill approval timestamp is invalid"
restore_now_epoch="$(date -u +%s)"
restore_maximum_age_seconds=$((MAX_RESTORE_DRILL_AGE_HOURS * 3600))
if ((restore_approval_epoch > restore_now_epoch + 300)); then
  die "restore drill approval timestamp is too far in the future"
fi
if ((restore_now_epoch - restore_approval_epoch > restore_maximum_age_seconds)); then
  die "restore drill report is older than the configured freshness limit"
fi
if ! preflight_metrics="$(bash "$metrics_validator" preflight \
  "$restore_snapshot" "$restore_incident" "$restore_recorded" "$restore_approval")"; then
  die "restore drill chronology or RPO evidence is invalid"
fi
mapfile -t preflight_lines <<<"$preflight_metrics"
[[ ${#preflight_lines[@]} -eq 3 \
  && "${preflight_lines[0]}" == chronology_valid=true \
  && "${preflight_lines[1]}" == "rpo_seconds=$restore_rpo" \
  && "${preflight_lines[2]}" == rpo_within_24h=true \
  && "$restore_rto" -le 14400 ]] \
  || die "restore drill recovery objectives are invalid"

active_final="$stage/active.final"
trash_final="$stage/trash.final"
pointer_final="$stage/pointer.final"
capture_listing "$active_final" 0
capture_listing "$trash_final" 1
download_remote "$remote_base/state/LAST_SUCCESS" "$pointer_final"
cmp -s -- "$active_initial" "$active_final" \
  && cmp -s -- "$trash_initial" "$trash_final" \
  && cmp -s -- "$pointer_local" "$pointer_final" \
  || die "offsite recovery evidence changed during verification"

observed_utc="$(date -u +%Y%m%dT%H%M%SZ)"
output_parent="$(dirname -- "$output")"
temporary="$(mktemp -- "$output_parent/.recovery-evidence-verification.XXXXXX")"
cat >"$temporary" <<EOF
version=1
result=pass
retention_run_id=$retention_run_id
observed_utc=$observed_utc
pointer_attestation_verified=true
active_inventory_verified=true
trashed_inventory_verified=true
retention_policy_verified=true
preserved_debris_verified=true
restore_report_verified=true
EOF
chmod 0600 -- "$temporary"
sync -f -- "$temporary"
mv -fT -- "$temporary" "$output"
sync -f -- "$output_parent"
emit_alert info recovery_evidence_verified \
  "offsite retention and isolated restore evidence verified"
