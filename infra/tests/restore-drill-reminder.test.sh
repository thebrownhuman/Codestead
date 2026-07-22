#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/scripts/backup/check-restore-drill.sh"
work="$(mktemp -d)"
trap 'rm -rf --one-file-system -- "$work"' EXIT
fail() { printf 'restore-drill-reminder-test-failed: %s\n' "$*" >&2; exit 1; }
backup="$work/backup"
reports="$backup/restore-reports"
mkdir -m 0700 -p "$backup/state" "$backup/full" "$reports" "$work/live"
printf '%s\n' LEARNCODING_BACKUP_V1 >"$backup/.learncoding-backup-root"
chmod 0600 "$backup/.learncoding-backup-root"
config="$work/backup.env"
cat >"$config" <<EOF
REPO_ROOT=$repo_root
LEARN_DATA_ROOT=$work/live
BACKUP_ROOT=$backup
BACKUP_STAGE_ROOT=$work/stage
BACKUP_LOCK_FILE=$work/backup.lock
MAX_RESTORE_DRILL_AGE_HOURS=1
EOF
chmod 0600 "$config"
run_checker() { BACKUP_CONFIG_FILE="$config" bash "$checker"; }
if missing_output="$(run_checker 2>&1)"; then fail "missing restore report was accepted"; fi
[[ "$missing_output" == *'event=restore_drill_due'* ]] || fail "missing report did not emit reminder"

write_report() {
  local approval="$1" snapshot="$2" incident="$3" recorded="$4" result="${5:-pass}" rpo report
  find "$reports" -mindepth 1 -maxdepth 1 -delete
  rpo=$(( $(date -u -d "${incident:0:4}-${incident:4:2}-${incident:6:2} ${incident:9:2}:${incident:11:2}:${incident:13:2} UTC" +%s) - $(date -u -d "${snapshot:0:4}-${snapshot:4:2}-${snapshot:6:2} ${snapshot:9:2}:${snapshot:11:2}:${snapshot:13:2} UTC" +%s) ))
  report="$reports/restore-drill-$approval.txt"
  cat >"$report" <<EOF
version=1
result=$result
source=offsite
archive=learncoding-full-20260719T120000Z.tar.gz.age
approval_utc=$approval
snapshot_utc=$snapshot
incident_utc=$incident
recorded_utc=$recorded
chronology_valid=true
database_schema_valid=true
public_table_count=18
app_data_valid=true
credential_recovery=true
live_database_modified=false
cleanup_complete=true
rpo_seconds=$rpo
rpo_within_24h=true
rto_seconds=60
rto_within_4h=true
EOF
  chmod 0600 "$report"
  (cd "$reports" && sha256sum "$(basename -- "$report")" >"$(basename -- "$report").sha256")
  chmod 0600 "$report.sha256"
}
snapshot="$(date -u -d '2 hours ago' +%Y%m%dT%H%M%SZ)"
incident="$(date -u -d '90 minutes ago' +%Y%m%dT%H%M%SZ)"
recorded="$(date -u -d '80 minutes ago' +%Y%m%dT%H%M%SZ)"
fresh="$(date -u -d '58 minutes ago' +%Y%m%dT%H%M%SZ)"
write_report "$fresh" "$snapshot" "$incident" "$recorded"
fresh_output="$(run_checker 2>&1)" || fail "just-inside freshness boundary was rejected"
[[ "$fresh_output" == *'event=restore_drill_fresh'* ]] || fail "fresh report omitted healthy event"
stale="$(date -u -d '62 minutes ago' +%Y%m%dT%H%M%SZ)"
write_report "$stale" "$snapshot" "$incident" "$recorded"
run_checker >/dev/null 2>&1 && fail "just-outside freshness boundary was accepted"
future="$(date -u -d '10 minutes' +%Y%m%dT%H%M%SZ)"
write_report "$future" "$snapshot" "$incident" "$recorded"
run_checker >/dev/null 2>&1 && fail "future-dated approval was accepted"
write_report "$fresh" "$snapshot" "$incident" "$recorded"
report="$reports/restore-drill-$fresh.txt"
printf tampered >>"$report"
run_checker >/dev/null 2>&1 && fail "tampered report was accepted"
write_report "$fresh" "$snapshot" "$incident" "$recorded"
report="$reports/restore-drill-$fresh.txt"
ln "$report" "$work/report-hardlink"
run_checker >/dev/null 2>&1 && fail "hard-linked report was accepted"
rm -f -- "$work/report-hardlink"
write_report "$fresh" "$snapshot" "$incident" "$recorded" fail
run_checker >/dev/null 2>&1 && fail "failed report was accepted"
write_report "$fresh" "$snapshot" "$incident" "$recorded"
report="$reports/restore-drill-$fresh.txt"
chmod 0640 "$report"
run_checker >/dev/null 2>&1 && fail "group-readable report was accepted"
write_report "$fresh" "$snapshot" "$incident" "$recorded"
report="$reports/restore-drill-$fresh.txt"
mv "$report.sha256" "$work/sidecar-target"
ln -s "$work/sidecar-target" "$report.sha256"
run_checker >/dev/null 2>&1 && fail "symlinked checksum was accepted"
echo restore-drill-reminder-tests-ok
