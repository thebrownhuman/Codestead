#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
verifier="$repo_root/scripts/backup/verify-recovery-evidence.sh"
[[ -f "$verifier" ]] || {
  echo "recovery-evidence-verifier-test-failed: verifier missing" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf --one-file-system "$work"' EXIT
backup="$work/backup"
remote_root="$work/remote"
remote="$remote_root/Codestead/backups"
trash="$work/trash"
mkdir -p -m 0700 "$backup/state" "$backup/restore-reports" \
  "$remote/full" "$remote/state/points" "$trash"
printf '%s\n' LEARNCODING_BACKUP_V1 >"$backup/.learncoding-backup-root"
chmod 0600 "$backup/.learncoding-backup-root"

now="$(date -u +%Y%m%dT%H%M%SZ)"
timestamps=(
  "$(date -u -d '1 hour ago' +%Y%m%dT%H%M%SZ)"
  "$(date -u -d '2 days ago' +%Y%m%dT%H%M%SZ)"
  "$(date -u -d '40 days ago' +%Y%m%dT%H%M%SZ)"
)
archives=()
for timestamp in "${timestamps[@]}"; do
  archive="learncoding-full-$timestamp.tar.gz.age"
  archives+=("$archive")
  printf 'ciphertext-%s' "$timestamp" >"$remote/full/$archive"
  sha="$(sha256sum "$remote/full/$archive" | awk '{print $1}')"
  printf '%s  %s\n' "$sha" "$archive" >"$remote/full/$archive.sha256"
  printf 'SUCCESS_ARCHIVE=%s\nSUCCESS_COMPLETED_UTC=%s\nSUCCESS_SHA256=%s\n' \
    "$archive" "$now" "$sha" >"$remote/state/points/$archive.env"
  chmod 0600 "$remote/full/$archive" "$remote/full/$archive.sha256" "$remote/state/points/$archive.env"
done
cp "$remote/state/points/${archives[0]}.env" "$remote/state/LAST_SUCCESS"
chmod 0600 "$remote/state/LAST_SUCCESS"
printf 'pending-debris\n' >"$remote/state/.LAST_SUCCESS.pending-known"

active_listing="$work/active-listing"
trash_listing="$work/trash-listing"
(cd "$remote" && find . -type f -printf '%P\n' | LC_ALL=C sort) >"$active_listing"
: >"$trash_listing"
active_digest="$(sha256sum "$active_listing" | awk '{print $1}')"
trash_digest="$(sha256sum "$trash_listing" | awk '{print $1}')"

declare -A daily_seen=() weekly_seen=() monthly_seen=()
daily=() weekly=() monthly=()
for archive in "${archives[@]}"; do
  timestamp="${archive#learncoding-full-}"; timestamp="${timestamp%.tar.gz.age}"
  day="${timestamp:0:8}"
  week="$(date -u -d "${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC" +%G-W%V)"
  month="${timestamp:0:6}"
  if [[ -z "${daily_seen[$day]+x}" ]]; then daily_seen[$day]=1; daily+=("$day:$archive"); fi
  if [[ -z "${weekly_seen[$week]+x}" ]]; then weekly_seen[$week]=1; weekly+=("$week:$archive"); fi
  if [[ -z "${monthly_seen[$month]+x}" ]]; then monthly_seen[$month]=1; monthly+=("$month:$archive"); fi
done
join_csv() { local IFS=,; printf '%s' "$*"; }
run_id=0123456789abcdef0123456789abcdef
cat >"$backup/state/offsite-retention-last-report.txt" <<EOF
version=1
run_id=$run_id
completed_utc=$now
pointer_archive=${archives[0]}
policy=7-daily-4-weekly-12-monthly
active_listing_sha256=$active_digest
trashed_listing_sha256=$trash_digest
active_committed_count=3
trashed_recovery_points=
daily_buckets=$(join_csv "${daily[@]}")
weekly_buckets=$(join_csv "${weekly[@]}")
monthly_buckets=$(join_csv "${monthly[@]}")
preserved_debris=state/.LAST_SUCCESS.pending-known
pending_journal=false
result=pass
EOF
chmod 0600 "$backup/state/offsite-retention-last-report.txt"

snapshot="${timestamps[0]}"
incident="$(date -u -d '30 minutes ago' +%Y%m%dT%H%M%SZ)"
recorded="$(date -u -d '20 minutes ago' +%Y%m%dT%H%M%SZ)"
approval="$(date -u -d '10 minutes ago' +%Y%m%dT%H%M%SZ)"
rpo="$(( $(date -u -d "${incident:0:4}-${incident:4:2}-${incident:6:2} ${incident:9:2}:${incident:11:2}:${incident:13:2} UTC" +%s) - $(date -u -d "${snapshot:0:4}-${snapshot:4:2}-${snapshot:6:2} ${snapshot:9:2}:${snapshot:11:2}:${snapshot:13:2} UTC" +%s) ))"
restore="$backup/restore-reports/restore-drill-$approval.txt"
cat >"$restore" <<EOF
version=1
result=pass
source=offsite
archive=${archives[0]}
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
chmod 0600 "$restore"
(cd "$(dirname "$restore")" && sha256sum "$(basename "$restore")" >"$(basename "$restore").sha256")
chmod 0600 "$restore.sha256"

fake_bin="$work/bin"
mkdir -m 0700 "$fake_bin"
cat >"$fake_bin/rclone" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
command_name="$1"; shift
case "$command_name" in
  copyto)
    source_path="$1"; destination="$2"
    if [[ "$source_path" == fake:* ]]; then
      relative="${source_path#fake:}"; relative="${relative#/}"
      cp -- "$FAKE_REMOTE_ROOT/$relative" "$destination"
    else
      exit 91
    fi
    ;;
  lsf)
    requested="$1"; shift
    root="$FAKE_REMOTE_ROOT"
    for argument in "$@"; do [[ "$argument" == --drive-trashed-only=true ]] && root="$FAKE_TRASH_ROOT"; done
    relative="${requested#fake:}"; relative="${relative#/}"
    target="$root/$relative"
    if [[ -f "$target" ]]; then basename -- "$target"
    elif [[ -d "$target" ]]; then (cd "$target" && find . -type f -printf '%P\n' | LC_ALL=C sort)
    fi
    ;;
  *) exit 92 ;;
esac
EOF
chmod 0700 "$fake_bin/rclone"
rclone_config="$work/rclone.conf"
printf '[fake]\ntype = local\n' >"$rclone_config"
chmod 0600 "$rclone_config"
config="$work/backup.env"
cat >"$config" <<EOF
REPO_ROOT=$repo_root
LEARN_DATA_ROOT=$work/live
BACKUP_ROOT=$backup
BACKUP_STAGE_ROOT=$work/stage
BACKUP_LOCK_FILE=$work/backup.lock
RCLONE_REMOTE=fake:Codestead/backups
RCLONE_CONFIG=$rclone_config
RCLONE_OPERATION_TIMEOUT_SECONDS=30
RCLONE_OPERATION_GRACE_SECONDS=2
RCLONE_OUTPUT_LIMIT_BYTES=1048576
MAX_RESTORE_DRILL_AGE_HOURS=1
EOF
chmod 0600 "$config"
mkdir -m 0700 "$work/live"

output="$backup/state/recovery-evidence-verification.txt"
PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" --output "$output"
grep -Fxq result=pass "$output"
grep -Fxq "retention_run_id=$run_id" "$output"
grep -Fxq pointer_attestation_verified=true "$output"
grep -Fxq restore_report_verified=true "$output"
if grep -Eqi '(sha256|ciphertext|drive[_ -]?id|token|secret)' "$output"; then
  echo "recovery-evidence-verifier-test-failed: evidence exposed prohibited material" >&2
  exit 1
fi

cp "$backup/state/offsite-retention-last-report.txt" "$work/report-good"
sed -i 's/^result=pass$/result=fail/' "$backup/state/offsite-retention-last-report.txt"
if PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" --output "$backup/state/should-not-exist" >/dev/null 2>&1; then
  echo "recovery-evidence-verifier-test-failed: tampered retention report passed" >&2
  exit 1
fi
[[ ! -e "$backup/state/should-not-exist" ]]
mv "$work/report-good" "$backup/state/offsite-retention-last-report.txt"
chmod 0600 "$backup/state/offsite-retention-last-report.txt"
cp "$backup/state/offsite-retention-last-report.txt" "$work/report-baseline"

printf 'unexpected\n' >"$remote/full/unattested-extra"
if PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" --output "$backup/state/extra-should-not-exist" >/dev/null 2>&1; then
  echo "recovery-evidence-verifier-test-failed: changed active inventory passed" >&2
  exit 1
fi
[[ ! -e "$backup/state/extra-should-not-exist" ]]
rm -f -- "$remote/full/unattested-extra"

trash_base="$trash/Codestead/backups"
unreported="learncoding-full-20000101T000000Z.tar.gz.age"
mkdir -p "$trash_base/full" "$trash_base/state/points"
printf ciphertext >"$trash_base/full/$unreported"
printf '%064d  %s\n' 0 "$unreported" >"$trash_base/full/$unreported.sha256"
printf 'SUCCESS_ARCHIVE=%s\nSUCCESS_COMPLETED_UTC=20000101T000000Z\nSUCCESS_SHA256=%064d\n' \
  "$unreported" 0 >"$trash_base/state/points/$unreported.env"
(cd "$trash_base" && find . -type f -printf '%P\n' | LC_ALL=C sort) >"$work/unreported-trash-listing"
unreported_trash_digest="$(sha256sum "$work/unreported-trash-listing" | awk '{print $1}')"
cp "$work/report-baseline" "$backup/state/offsite-retention-last-report.txt"
sed -i "s/^trashed_listing_sha256=.*/trashed_listing_sha256=$unreported_trash_digest/" \
  "$backup/state/offsite-retention-last-report.txt"
if PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" --output "$backup/state/unreported-trash-output" >/dev/null 2>&1; then
  echo "recovery-evidence-verifier-test-failed: unreported trashed recovery point passed" >&2
  exit 1
fi
[[ ! -e "$backup/state/unreported-trash-output" ]]
rm -rf --one-file-system -- "$trash_base"

missing="learncoding-full-19990101T000000Z.tar.gz.age"
cp "$work/report-baseline" "$backup/state/offsite-retention-last-report.txt"
sed -i "s/^trashed_recovery_points=.*/trashed_recovery_points=$missing/" \
  "$backup/state/offsite-retention-last-report.txt"
if PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" --output "$backup/state/missing-trash-output" >/dev/null 2>&1; then
  echo "recovery-evidence-verifier-test-failed: missing declared trash triplet passed" >&2
  exit 1
fi
[[ ! -e "$backup/state/missing-trash-output" ]]

cp "$work/report-baseline" "$backup/state/offsite-retention-last-report.txt"
chmod 0600 "$backup/state/offsite-retention-last-report.txt"
cp "$restore" "$work/restore-baseline.txt"
cp "$restore.sha256" "$work/restore-baseline.txt.sha256"

write_boundary_restore_report() {
  local boundary_approval="$1" boundary_snapshot="$2" boundary_incident="$3"
  local boundary_recorded="$4" boundary_rpo boundary_report
  find "$backup/restore-reports" -mindepth 1 -maxdepth 1 -delete
  boundary_rpo=$(( $(date -u -d \
    "${boundary_incident:0:4}-${boundary_incident:4:2}-${boundary_incident:6:2} ${boundary_incident:9:2}:${boundary_incident:11:2}:${boundary_incident:13:2} UTC" +%s) \
    - $(date -u -d \
    "${boundary_snapshot:0:4}-${boundary_snapshot:4:2}-${boundary_snapshot:6:2} ${boundary_snapshot:9:2}:${boundary_snapshot:11:2}:${boundary_snapshot:13:2} UTC" +%s) ))
  boundary_report="$backup/restore-reports/restore-drill-$boundary_approval.txt"
  cat >"$boundary_report" <<EOF
version=1
result=pass
source=offsite
archive=${archives[0]}
approval_utc=$boundary_approval
snapshot_utc=$boundary_snapshot
incident_utc=$boundary_incident
recorded_utc=$boundary_recorded
chronology_valid=true
database_schema_valid=true
public_table_count=18
app_data_valid=true
credential_recovery=true
live_database_modified=false
cleanup_complete=true
rpo_seconds=$boundary_rpo
rpo_within_24h=true
rto_seconds=60
rto_within_4h=true
EOF
  chmod 0600 "$boundary_report"
  (cd "$backup/restore-reports" \
    && sha256sum "$(basename -- "$boundary_report")" \
      >"$(basename -- "$boundary_report").sha256")
  chmod 0600 "$boundary_report.sha256"
}

boundary_snapshot="$(date -u -d '2 hours ago' +%Y%m%dT%H%M%SZ)"
boundary_incident="$(date -u -d '90 minutes ago' +%Y%m%dT%H%M%SZ)"
boundary_recorded="$(date -u -d '80 minutes ago' +%Y%m%dT%H%M%SZ)"
inside_approval="$(date -u -d '58 minutes ago' +%Y%m%dT%H%M%SZ)"
write_boundary_restore_report "$inside_approval" "$boundary_snapshot" \
  "$boundary_incident" "$boundary_recorded"
PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" \
  --output "$backup/state/inside-boundary-output" >/dev/null \
  || { echo "recovery-evidence-verifier-test-failed: report inside age boundary failed" >&2; exit 1; }
grep -Fxq result=pass "$backup/state/inside-boundary-output"

outside_approval="$(date -u -d '62 minutes ago' +%Y%m%dT%H%M%SZ)"
write_boundary_restore_report "$outside_approval" "$boundary_snapshot" \
  "$boundary_incident" "$boundary_recorded"
if PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" \
  --output "$backup/state/outside-boundary-output" >/dev/null 2>&1; then
  echo "recovery-evidence-verifier-test-failed: stale restore report passed" >&2
  exit 1
fi
[[ ! -e "$backup/state/outside-boundary-output" ]]

future_approval="$(date -u -d '10 minutes' +%Y%m%dT%H%M%SZ)"
write_boundary_restore_report "$future_approval" "$boundary_snapshot" \
  "$boundary_incident" "$boundary_recorded"
if PATH="$fake_bin:$PATH" FAKE_REMOTE_ROOT="$remote_root" FAKE_TRASH_ROOT="$trash" \
  BACKUP_CONFIG_FILE="$config" bash "$verifier" \
  --output "$backup/state/future-boundary-output" >/dev/null 2>&1; then
  echo "recovery-evidence-verifier-test-failed: future restore report passed" >&2
  exit 1
fi
[[ ! -e "$backup/state/future-boundary-output" ]]

echo recovery-evidence-verifier-tests-ok
