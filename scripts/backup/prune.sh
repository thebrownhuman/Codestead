#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command flock
require_command realpath
require_command sha256sum

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
full_dir="$backup_root/full"
state_dir="$backup_root/state"

require_protected_directory() {
  local directory="$1" resolved
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  resolved="$(realpath -e -- "$directory" 2>/dev/null)" || return 1
  [[ "$resolved" == "$directory"
    && "$(stat -c '%a' -- "$directory")" == 700
    && "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]]
}

require_protected_directory "$full_dir" || die "full backup directory is unsafe"
require_protected_directory "$state_dir" || die "backup state directory is unsafe"
acquire_backup_lock

marker="$state_dir/local-last-success.env"
read_success_marker "$marker" || die "local success marker is missing or invalid"
marked_archive="$full_dir/$SUCCESS_ARCHIVE"
marked_checksum="${marked_archive}.sha256"
path_is_within "$marked_archive" "$full_dir" \
  || die "local success marker points outside the full backup directory"
[[ "$(dirname -- "$marked_archive")" == "$full_dir" \
  && -f "$marked_archive" && ! -L "$marked_archive" && -s "$marked_archive" \
  && -f "$marked_checksum" && ! -L "$marked_checksum" && -s "$marked_checksum" ]] \
  || die "marked local recovery point is missing or unsafe"
[[ "$(wc -l <"$marked_checksum")" -eq 1 \
  && "$(<"$marked_checksum")" == "$SUCCESS_SHA256  $SUCCESS_ARCHIVE" ]] \
  || die "marked local recovery point sidecar is invalid"
verify_ciphertext_checksum "$marked_archive" \
  || die "marked local recovery point checksum failed"
marked_actual_hash="$(sha256sum "$marked_archive" | awk '{print $1}')"
[[ "$marked_actual_hash" == "$SUCCESS_SHA256" ]] \
  || die "marked local recovery point hash does not match the marker"

# Grandfather-father-son retention: newest archive in each of the newest seven
# UTC days, four ISO weeks, and twelve UTC months. One archive may satisfy more
# than one tier.
readonly RETENTION_DAILY=7
readonly RETENTION_WEEKLY=4
readonly RETENTION_MONTHLY=12
declare -A seen_days=() seen_weeks=() seen_months=() keep=()
keep[$SUCCESS_ARCHIVE]=1
daily_count=0
weekly_count=0
monthly_count=0

mapfile -t archives < <(find "$full_dir" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' -printf '%f\n' | sort -r)
for filename in "${archives[@]}"; do
  if [[ ! "$filename" =~ ^learncoding-full-([0-9]{8}T[0-9]{6}Z)\.tar\.gz\.age$ ]]; then
    continue
  fi
  stamp="${BASH_REMATCH[1]}"
  if ! verify_ciphertext_checksum "$full_dir/$filename"; then
    keep[$filename]=1
    emit_alert warning backup_not_pruned "an archive with a missing or invalid checksum was preserved for inspection"
    continue
  fi
  date_expression="${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2} UTC"
  date -u -d "$date_expression" >/dev/null 2>&1 || continue
  day="${stamp:0:8}"
  week="$(date -u -d "$date_expression" +%G-W%V)"
  month="${stamp:0:6}"

  if (( daily_count < RETENTION_DAILY )) && [[ -z "${seen_days[$day]+x}" ]]; then
    seen_days[$day]=1
    keep[$filename]=1
    ((daily_count += 1))
  fi
  if (( weekly_count < RETENTION_WEEKLY )) && [[ -z "${seen_weeks[$week]+x}" ]]; then
    seen_weeks[$week]=1
    keep[$filename]=1
    ((weekly_count += 1))
  fi
  if (( monthly_count < RETENTION_MONTHLY )) && [[ -z "${seen_months[$month]+x}" ]]; then
    seen_months[$month]=1
    keep[$filename]=1
    ((monthly_count += 1))
  fi
done

for filename in "${archives[@]}"; do
  [[ "$filename" =~ ^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]] || continue
  [[ -n "${keep[$filename]+x}" ]] && continue
  if [[ "${BACKUP_PRUNE_DRY_RUN:-0}" == "1" ]]; then
    log "retention would prune one unmarked recovery point"
  else
    rm -f -- "$full_dir/$filename" "$full_dir/${filename}.sha256"
    log "retention pruned one unmarked recovery point"
  fi
done

log "retention complete: ${#archives[@]} archives examined; tiers=$RETENTION_DAILY/$RETENTION_WEEKLY/$RETENTION_MONTHLY"
