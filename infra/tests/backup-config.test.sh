#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common="$repo_root/scripts/backup/common.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

expect_config_failure() {
  local config="$1"
  if BACKUP_CONFIG_FILE="$config" bash -Eeuo pipefail -c \
    'source "$1"; load_backup_config' _ "$common" >/dev/null 2>&1; then
    echo "invalid backup config was accepted: $config" >&2
    exit 1
  fi
}

touch "$work/default.env"
chmod 0600 "$work/default.env"
BACKUP_CONFIG_FILE="$work/default.env"
# shellcheck source=../../scripts/backup/common.sh
source "$common"
load_backup_config
[[ "$FILESYSTEM_WARN_PERCENT" == "70" ]]
[[ "$FILESYSTEM_CRITICAL_PERCENT" == "85" ]]
[[ "$MAX_OFFSITE_AGE_HOURS" == "30" ]]
[[ "$RCLONE_CONTROL_TIMEOUT_SECONDS" == "120" ]]
[[ "$RCLONE_MIN_BULK_BYTES_PER_SECOND" == "4194304" ]]
[[ "$RCLONE_BULK_OVERHEAD_SECONDS" == "600" ]]
[[ "$RCLONE_SERVICE_BUDGET_SECONDS" == "14400" ]]
[[ "$RCLONE_SERVICE_RESERVE_SECONDS" == "600" ]]

[[ "$(rclone_bulk_timeout_seconds 1)" == "601" ]]
[[ "$(rclone_bulk_timeout_seconds 4194304)" == "601" ]]
[[ "$(rclone_bulk_timeout_seconds 4194305)" == "602" ]]
rclone_bulk_plan_fits_service_budget 4194304 2

for invalid_policy in \
  'RCLONE_CONTROL_TIMEOUT_SECONDS=0' \
  'RCLONE_MIN_BULK_BYTES_PER_SECOND=0' \
  'RCLONE_MIN_BULK_BYTES_PER_SECOND=invalid' \
  'RCLONE_MIN_BULK_BYTES_PER_SECOND=999999999999999999999999999999999' \
  'RCLONE_BULK_OVERHEAD_SECONDS=0' \
  'RCLONE_SERVICE_RESERVE_SECONDS=0' \
  'RCLONE_OPERATION_GRACE_SECONDS=3601' \
  'RCLONE_SERVICE_BUDGET_SECONDS=14401' \
  $'RCLONE_BULK_OVERHEAD_SECONDS=7200\nRCLONE_SERVICE_RESERVE_SECONDS=1\nRCLONE_SERVICE_BUDGET_SECONDS=14400'; do
  printf '%s\n' "$invalid_policy" >"$work/invalid-policy.env"
  chmod 0600 "$work/invalid-policy.env"
  expect_config_failure "$work/invalid-policy.env"
done

if rclone_bulk_plan_fits_service_budget 28940697601 2; then
  echo "publication accepted archive whose upload and readback exceed the service budget" >&2
  exit 1
fi
if rclone_bulk_plan_fits_service_budget invalid 2; then
  echo "bulk budget accepted an invalid archive size" >&2
  exit 1
fi

deadline_case_setup() {
  RCLONE_CONTROL_TIMEOUT_SECONDS=120
  RCLONE_MIN_BULK_BYTES_PER_SECOND=4194304
  RCLONE_BULK_OVERHEAD_SECONDS=600
  RCLONE_SERVICE_BUDGET_SECONDS=1000
  RCLONE_SERVICE_RESERVE_SECONDS=100
  RCLONE_OPERATION_GRACE_SECONDS=5
  fake_now_ms=0
  fake_advance_ms=0
  fake_consume_allocated=0
  fake_status=0
  deadline_calls=()
  rclone_monotonic_milliseconds() {
    RCLONE_MONOTONIC_MILLISECONDS="$fake_now_ms"
  }
  _run_rclone_with_deadline() {
    local allocated="$1" operation="${2:-missing}"
    deadline_calls+=("$allocated:$operation")
    if ((fake_consume_allocated)); then
      fake_now_ms=$((fake_now_ms + allocated * 1000))
    else
      fake_now_ms=$((fake_now_ms + fake_advance_ms))
    fi
    return "$fake_status"
  }
  _run_backup_with_deadline() {
    _run_rclone_with_deadline "$@"
  }
}

(
  deadline_case_setup
  start_rclone_service_budget
  original_deadline="$RCLONE_SERVICE_HARD_DEADLINE_MILLISECONDS"
  if start_rclone_service_budget; then
    echo "rclone service deadline was reset" >&2
    exit 1
  fi
  [[ "$RCLONE_SERVICE_HARD_DEADLINE_MILLISECONDS" == "$original_deadline" ]]
  run_rclone_control lsf fake:metadata
  [[ "${deadline_calls[*]}" == "120:lsf" ]]
)

(
  deadline_case_setup
  start_rclone_service_budget
  run_backup_work_control sha256sum archive
  [[ "${deadline_calls[*]}" == "120:sha256sum" ]]
)

(
  deadline_case_setup
  start_rclone_service_budget
  fake_now_ms=850000
  run_rclone_control lsf fake:metadata
  [[ "${deadline_calls[*]}" == "50:lsf" ]]
)

(
  deadline_case_setup
  start_rclone_service_budget
  fake_now_ms=900000
  control_status=0
  run_rclone_control lsf fake:metadata || control_status=$?
  [[ "$control_status" == 75 && ${#deadline_calls[@]} -eq 0 ]]
  begin_rclone_service_finalization
  run_rclone_finalization_control copyto point pointer
  [[ "${deadline_calls[*]}" == "100:copyto" ]]
  bulk_status=0
  run_rclone_bulk 1 copyto archive remote || bulk_status=$?
  [[ "$bulk_status" == 70 ]]
)

(
  deadline_case_setup
  start_rclone_service_budget
  fake_now_ms=990000
  begin_rclone_service_finalization
  insufficient_teardown_status=0
  run_rclone_finalization_control copyto point pointer \
    || insufficient_teardown_status=$?
  [[ "$insufficient_teardown_status" == 75 \
    && ${#deadline_calls[@]} -eq 0 ]]
)

(
  deadline_case_setup
  RCLONE_SERVICE_BUDGET_SECONDS=14400
  RCLONE_SERVICE_RESERVE_SECONDS=600
  start_rclone_service_budget
  fake_consume_allocated=1
  large_archive_bytes=26419920896
  run_rclone_bulk "$large_archive_bytes" copyto archive remote
  [[ "${deadline_calls[0]}" == "6899:copyto" ]]
  for _ in 1 2 3 4 5 6 7; do
    run_rclone_control lsf fake:metadata
  done
  calls_before_second=${#deadline_calls[@]}
  second_status=0
  run_rclone_bulk "$large_archive_bytes" copyto remote readback || second_status=$?
  [[ "$second_status" == 75 && ${#deadline_calls[@]} -eq calls_before_second ]]
)

(
  deadline_case_setup
  start_rclone_service_budget
  fake_advance_ms=901000
  overrun_status=0
  run_rclone_control lsf fake:metadata || overrun_status=$?
  [[ "$overrun_status" == 75 && ${#deadline_calls[@]} -eq 1 ]]
)

(
  deadline_case_setup
  fake_now_ms=08
  leading_zero_status=0
  leading_zero_diagnostic="$work/leading-zero-clock.stderr"
  start_rclone_service_budget 2>"$leading_zero_diagnostic" \
    || leading_zero_status=$?
  [[ "$leading_zero_status" == 70 && ! -s "$leading_zero_diagnostic" ]]
)

(
  deadline_case_setup
  fake_now_ms=9223372036854775808
  overflow_status=0
  start_rclone_service_budget || overflow_status=$?
  [[ "$overflow_status" == 70 ]]
)

(
  deadline_case_setup
  fake_now_ms=10000
  start_rclone_service_budget
  fake_now_ms=9999
  backward_status=0
  run_rclone_control lsf fake:metadata || backward_status=$?
  [[ "$backward_status" == 70 && ${#deadline_calls[@]} -eq 0 ]]
)

(
  deadline_case_setup
  start_rclone_service_budget
  fake_status=17
  child_status=0
  run_rclone_control lsf fake:metadata || child_status=$?
  [[ "$child_status" == 17 ]]
)
ln -s "$work/default.env" "$work/symlink.env"
expect_config_failure "$work/symlink.env"

touch "$work/wrong-exact-mode.env"
chmod 0400 "$work/wrong-exact-mode.env"
expect_config_failure "$work/wrong-exact-mode.env"

if grep -E 'df .*-[^ ]*P[^ ]* .*--output|df .* -P .*--output' \
  "$repo_root/scripts/backup/init-backup-target.sh" \
  "$repo_root/scripts/backup/check-backups.sh"; then
  echo "GNU df rejects combining -P with --output" >&2
  exit 1
fi

printf '%s\n' 'FILESYSTEM_WARN_PERCENT=90' 'FILESYSTEM_CRITICAL_PERCENT=85' > "$work/invalid.env"
chmod 0600 "$work/invalid.env"
expect_config_failure "$work/invalid.env"

for values in \
  $'FILESYSTEM_WARN_PERCENT=0\nFILESYSTEM_CRITICAL_PERCENT=85' \
  $'FILESYSTEM_WARN_PERCENT=70\nFILESYSTEM_CRITICAL_PERCENT=100' \
  $'FILESYSTEM_WARN_PERCENT=seventy\nFILESYSTEM_CRITICAL_PERCENT=85'; do
  printf '%s\n' "$values" >"$work/invalid.env"
  chmod 0600 "$work/invalid.env"
  expect_config_failure "$work/invalid.env"
done

for invalid_restore_age in 0 2161 87601 999999999999999999999999999999999 invalid; do
  printf '%s\n' "MAX_RESTORE_DRILL_AGE_HOURS=$invalid_restore_age" >"$work/invalid.env"
  chmod 0600 "$work/invalid.env"
  expect_config_failure "$work/invalid.env"
done
printf '%s\n' 'MAX_RESTORE_DRILL_AGE_HOURS=2160' >"$work/maximum-valid.env"
chmod 0600 "$work/maximum-valid.env"
BACKUP_CONFIG_FILE="$work/maximum-valid.env" bash -Eeuo pipefail -c \
  'source "$1"; load_backup_config' _ "$common"

touch "$work/writable.env"
chmod 0666 "$work/writable.env"
expect_config_failure "$work/writable.env"

if [[ "$(id -u)" == "0" ]] && id nobody >/dev/null 2>&1; then
  touch "$work/other-owner.env"
  chmod 0600 "$work/other-owner.env"
  chown nobody "$work/other-owner.env"
  expect_config_failure "$work/other-owner.env"
fi

full_root="$work/full-root"
mkdir -p "$full_root"
printf '%s\n' "$FULL_BACKUP_MAGIC" >"$full_root/.learncoding-backup-root"
chmod 0600 "$full_root/.learncoding-backup-root"
[[ "$(validated_root "$full_root" "$FULL_BACKUP_MAGIC")" == "$(realpath -e "$full_root")" ]]

mv "$full_root/.learncoding-backup-root" "$full_root/real-backup-marker"
ln -s "$full_root/real-backup-marker" "$full_root/.learncoding-backup-root"
if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
  echo "symlinked backup marker was accepted" >&2
  exit 1
fi
rm "$full_root/.learncoding-backup-root"
mv "$full_root/real-backup-marker" "$full_root/.learncoding-backup-root"

chmod 0400 "$full_root/.learncoding-backup-root"
if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
  echo "backup marker with a non-0600 mode was accepted" >&2
  exit 1
fi

chmod 0666 "$full_root/.learncoding-backup-root"
if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
  echo "world-writable backup marker was accepted" >&2
  exit 1
fi
chmod 0600 "$full_root/.learncoding-backup-root"
printf '%s\n' WRONG_MARKER >"$full_root/.learncoding-backup-root"
if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
  echo "wrong backup marker was accepted" >&2
  exit 1
fi
if [[ "$(id -u)" == "0" ]] && id nobody >/dev/null 2>&1; then
  printf '%s\n' "$FULL_BACKUP_MAGIC" >"$full_root/.learncoding-backup-root"
  chown nobody "$full_root/.learncoding-backup-root"
  if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
    echo "backup marker owned by another account was accepted" >&2
    exit 1
  fi
fi

archive="$work/archive.age"
printf '%s' ciphertext >"$archive"
(cd "$work" && sha256sum "$(basename "$archive")" >"$(basename "$archive").sha256")
verify_ciphertext_checksum "$archive"
printf '%s' tampered >>"$archive"
if verify_ciphertext_checksum "$archive"; then
  echo "tampered archive passed checksum verification" >&2
  exit 1
fi
printf '%s' ciphertext >"$archive"
(cd "$work" && sha256sum "$(basename "$archive")" >"$(basename "$archive").sha256")
printf '%s\n' 'unexpected second line' >>"${archive}.sha256"
if verify_ciphertext_checksum "$archive"; then
  echo "multi-line checksum manifest was accepted" >&2
  exit 1
fi

compose_calls="$work/compose-calls"
compose_sql="$work/compose-sql"
compose_result=queued
compose_cmd() {
  printf '%s\n' "$@" >>"$compose_calls"
  cat >"$compose_sql"
  printf '%s\n' "$compose_result"
}

enqueue_backup_status success 20260712T120000Z
grep -Fq "template_version" "$compose_sql"
grep -Fq "'backup-status'" "$compose_sql"
grep -Fq "BACKUP_REPORT_OUTCOME=success" "$compose_calls"
grep -Fq "No archive is attached" "$compose_sql"
if grep -Eqi 'learncoding-full-|\.tar\.gz|AGE-SECRET-KEY|database\.dump' "$compose_calls" "$compose_sql"; then
  echo "backup status report exposed an archive, dump, or encryption identity" >&2
  exit 1
fi

compose_result=existing
enqueue_backup_status failure 20260712T120000Z
grep -Fq "BACKUP_REPORT_OUTCOME=failure" "$compose_calls"
grep -Fq "no archive or log is attached" "$compose_sql"

compose_result=no-admin
if enqueue_backup_status success 20260712T120001Z >/dev/null 2>&1; then
  echo "missing administrator was treated as a queued backup report" >&2
  exit 1
fi
if enqueue_backup_status invalid 20260712T120002Z >/dev/null 2>&1; then
  echo "invalid backup report outcome was accepted" >&2
  exit 1
fi
if enqueue_backup_status success ../unsafe >/dev/null 2>&1; then
  echo "invalid backup report idempotency seed was accepted" >&2
  exit 1
fi

grep -Fq 'enqueue_backup_status failure "$timestamp"' "$repo_root/scripts/backup/backup.sh"
grep -Fq 'enqueue_backup_status success "$timestamp"' "$repo_root/scripts/backup/backup.sh"

echo "backup-config-tests-ok"
