#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common="$repo_root/scripts/backup/common.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# shellcheck source=../../scripts/backup/common.sh
source "$common"

receipt_a="44444444-4444-4444-8444-444444444444"
receipt_b="55555555-5555-4555-8555-555555555555"
receipt_dir="$work/receipts"
mkdir -m 0700 "$receipt_dir"

valid_backup_run_receipt_id "$receipt_a"
for invalid in \
  20260725T051500Z \
  44444444-4444-1444-8444-444444444444 \
  44444444-4444-4444-7444-444444444444 \
  44444444-4444-4444-8444-44444444444A \
  ../unsafe; do
  if valid_backup_run_receipt_id "$invalid"; then
    echo "invalid backup run receipt UUID was accepted: $invalid" >&2
    exit 1
  fi
done

generate_backup_run_receipt_id() {
  printf '%s\n' "$receipt_a"
}
begin_backup_status_receipt "$receipt_dir"
[[ "$BACKUP_STATUS_RECEIPT_ID" == "$receipt_a" ]]
[[ "$BACKUP_STATUS_RECEIPT_PATH" == "$receipt_dir/$receipt_a.receipt" ]]
require_secure_regular_file "$BACKUP_STATUS_RECEIPT_PATH" 600 "$(id -u)"
read_backup_status_receipt "$BACKUP_STATUS_RECEIPT_PATH"
[[ "$BACKUP_STATUS_RECEIPT_ID" == "$receipt_a" ]]
[[ "$BACKUP_STATUS_RECEIPT_OUTCOME" == running ]]

finalize_backup_status_receipt \
  "$BACKUP_STATUS_RECEIPT_PATH" "$receipt_a" success
read_backup_status_receipt "$BACKUP_STATUS_RECEIPT_PATH"
[[ "$BACKUP_STATUS_RECEIPT_OUTCOME" == success ]]
if finalize_backup_status_receipt \
  "$BACKUP_STATUS_RECEIPT_PATH" "$receipt_a" failure; then
  echo "a finalized backup run receipt changed outcome" >&2
  exit 1
fi
read_backup_status_receipt "$BACKUP_STATUS_RECEIPT_PATH"
[[ "$BACKUP_STATUS_RECEIPT_OUTCOME" == success ]]

report_calls="$work/report-calls"
report_result=1
enqueue_backup_status() {
  printf '%s:%s\n' "$1" "$2" >>"$report_calls"
  return "$report_result"
}
if deliver_backup_status_receipt "$BACKUP_STATUS_RECEIPT_PATH"; then
  echo "a failed backup status delivery was acknowledged" >&2
  exit 1
fi
[[ -f "$BACKUP_STATUS_RECEIPT_PATH" ]]
[[ "$(cat "$report_calls")" == "success:$receipt_a" ]]
report_result=0
deliver_backup_status_receipt "$BACKUP_STATUS_RECEIPT_PATH"
[[ ! -e "$BACKUP_STATUS_RECEIPT_PATH" ]]
[[ "$(tail -n 1 "$report_calls")" == "success:$receipt_a" ]]

printf '%s\n%s\n' \
  "BACKUP_RUN_RECEIPT_ID=$receipt_b" \
  "BACKUP_RUN_RECEIPT_OUTCOME=running" \
  >"$receipt_dir/$receipt_b.receipt"
chmod 0600 "$receipt_dir/$receipt_b.receipt"
: >"$report_calls"
replay_pending_backup_status_receipts "$receipt_dir"
[[ "$(cat "$report_calls")" == "failure:$receipt_b" ]]
[[ ! -e "$receipt_dir/$receipt_b.receipt" ]]

malformed="$receipt_dir/$receipt_a.receipt"
printf '%s\n%s\n%s\n' \
  "BACKUP_RUN_RECEIPT_ID=$receipt_a" \
  'BACKUP_RUN_RECEIPT_OUTCOME=success' \
  'INJECTED=value' >"$malformed"
chmod 0600 "$malformed"
if read_backup_status_receipt "$malformed"; then
  echo "a backup status receipt with trailing data was accepted" >&2
  exit 1
fi
rm -f "$malformed"
printf '%s\n%s\n' \
  "BACKUP_RUN_RECEIPT_ID=$receipt_a" \
  'BACKUP_RUN_RECEIPT_OUTCOME=success' >"$work/target"
chmod 0600 "$work/target"
ln -s "$work/target" "$malformed"
if read_backup_status_receipt "$malformed"; then
  echo "a symlinked backup status receipt was accepted" >&2
  exit 1
fi

backup_script="$repo_root/scripts/backup/backup.sh"
grep -Fq 'receipt_dir="$state_dir/backup-status-receipts"' "$backup_script"
grep -Fq 'replay_pending_backup_status_receipts "$receipt_dir"' "$backup_script"
grep -Fq 'begin_backup_status_receipt "$receipt_dir"' "$backup_script"
grep -Fq 'finalize_backup_status_receipt' "$backup_script"
grep -Fq 'deliver_backup_status_receipt' "$backup_script"
if grep -Fq 'enqueue_backup_status failure "$timestamp"' "$backup_script" \
  || grep -Fq 'enqueue_backup_status success "$timestamp"' "$backup_script"; then
  echo "backup status event identity still comes from the wall clock" >&2
  exit 1
fi

printf '%s\n' backup-status-run-receipt-tests-ok