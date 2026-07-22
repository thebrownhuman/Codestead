#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
for command_name in awk basename date find realpath sha256sum sort stat wc; do
  require_command "$command_name"
done

healthy=0
finish() {
  local status=$?
  trap - EXIT
  if ((healthy == 0)); then
    emit_alert warning restore_drill_due \
      "no recent checksum-bound passing restore drill satisfies the configured freshness limit"
    ((status != 0)) || status=1
  fi
  exit "$status"
}
trap finish EXIT

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
restore_dir="$backup_root/restore-reports"
[[ -d "$restore_dir" && ! -L "$restore_dir" \
  && "$(realpath -e -- "$restore_dir" 2>/dev/null)" == "$restore_dir" \
  && "$(stat -c '%a' -- "$restore_dir" 2>/dev/null)" == 700 \
  && "$(stat -c '%u' -- "$restore_dir" 2>/dev/null)" == "$(id -u)" ]] \
  || die "restore drill report directory is missing or unsafe"

shopt -s nullglob
restore_candidates=("$restore_dir"/restore-drill-*.txt)
shopt -u nullglob
((${#restore_candidates[@]} > 0)) || die "no restore drill report is available"
for candidate in "${restore_candidates[@]}"; do
  require_secure_regular_file "$candidate" 600 "$(id -u)" \
    || die "restore drill report is unsafe"
done
mapfile -t restore_candidates < <(printf '%s\n' "${restore_candidates[@]}" | sort -r)
restore_report="${restore_candidates[0]}"
restore_name="$(basename -- "$restore_report")"
restore_checksum="$restore_report.sha256"
require_secure_regular_file "$restore_checksum" 600 "$(id -u)" \
  || die "restore drill report checksum is missing or unsafe"
[[ "$(wc -l <"$restore_checksum")" -eq 1 ]] \
  || die "restore drill report checksum is malformed"
restore_expected_hash=""
restore_expected_name=""
restore_checksum_extra=""
read -r restore_expected_hash restore_expected_name restore_checksum_extra <"$restore_checksum"
[[ -z "$restore_checksum_extra" && "$restore_expected_hash" =~ ^[0-9a-f]{64}$ \
  && "$restore_expected_name" == "$restore_name" \
  && "$(sha256sum "$restore_report" | awk '{print $1}')" == "$restore_expected_hash" ]] \
  || die "restore drill report checksum verification failed"

mapfile -t restore_lines <"$restore_report"
[[ ${#restore_lines[@]} -eq 19 \
  && "${restore_lines[0]}" == version=1 \
  && "${restore_lines[1]}" == result=pass \
  && "${restore_lines[2]}" == source=offsite \
  && "${restore_lines[3]}" =~ ^archive=learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ \
  && "${restore_lines[4]}" =~ ^approval_utc=[0-9]{8}T[0-9]{6}Z$ \
  && "${restore_lines[5]}" =~ ^snapshot_utc=[0-9]{8}T[0-9]{6}Z$ \
  && "${restore_lines[6]}" =~ ^incident_utc=[0-9]{8}T[0-9]{6}Z$ \
  && "${restore_lines[7]}" =~ ^recorded_utc=[0-9]{8}T[0-9]{6}Z$ \
  && "${restore_lines[8]}" == chronology_valid=true \
  && "${restore_lines[9]}" == database_schema_valid=true \
  && "${restore_lines[10]}" =~ ^public_table_count=[1-9][0-9]*$ \
  && "${restore_lines[11]}" == app_data_valid=true \
  && "${restore_lines[12]}" == credential_recovery=true \
  && "${restore_lines[13]}" == live_database_modified=false \
  && "${restore_lines[14]}" == cleanup_complete=true \
  && "${restore_lines[15]}" =~ ^rpo_seconds=[0-9]+$ \
  && "${restore_lines[16]}" == rpo_within_24h=true \
  && "${restore_lines[17]}" =~ ^rto_seconds=[0-9]+$ \
  && "${restore_lines[18]}" == rto_within_4h=true ]] \
  || die "latest restore drill report is malformed or not passing"

approval="${restore_lines[4]#approval_utc=}"
snapshot="${restore_lines[5]#snapshot_utc=}"
incident="${restore_lines[6]#incident_utc=}"
recorded="${restore_lines[7]#recorded_utc=}"
rpo="${restore_lines[15]#rpo_seconds=}"
rto="${restore_lines[17]#rto_seconds=}"
[[ "$restore_name" == "restore-drill-$approval.txt" ]] \
  || die "restore drill report name conflicts with its approval timestamp"
for timestamp in "$approval" "$snapshot" "$incident" "$recorded"; do
  _valid_compact_utc_timestamp "$timestamp" || die "restore drill report timestamp is invalid"
done
compact_epoch() {
  local value="$1"
  date -u -d "${value:0:4}-${value:4:2}-${value:6:2} ${value:9:2}:${value:11:2}:${value:13:2} UTC" +%s
}
approval_epoch="$(compact_epoch "$approval")"
snapshot_epoch="$(compact_epoch "$snapshot")"
incident_epoch="$(compact_epoch "$incident")"
recorded_epoch="$(compact_epoch "$recorded")"
now_epoch="$(date -u +%s)"
((snapshot_epoch <= incident_epoch && incident_epoch <= recorded_epoch \
  && recorded_epoch <= approval_epoch \
  && incident_epoch - snapshot_epoch == rpo \
  && rpo <= 86400 && rto <= 14400)) \
  || die "restore drill chronology or recovery objectives are invalid"
maximum_age_seconds=$((MAX_RESTORE_DRILL_AGE_HOURS * 3600))
((approval_epoch <= now_epoch + 300)) || die "restore drill approval timestamp is too far in the future"
((now_epoch - approval_epoch <= maximum_age_seconds)) \
  || die "restore drill report is older than the configured freshness limit"

healthy=1
emit_alert info restore_drill_fresh \
  "latest checksum-bound passing restore drill is within the configured freshness limit"
