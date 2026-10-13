#!/usr/bin/env bash
# Nightly off-site backup: PostgreSQL custom dump + an object manifest + the
# uploaded objects the dump references -> restic repository on Cloudflare R2,
# then retention (RESTIC_KEEP_* in restic-common.sh: 7 daily, 4 weekly,
# 12 monthly) with prune, then a structural repository check.
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup/restic-common.sh
source "$script_dir/restic-common.sh"

restic_load_config
restic_prepare_dirs

run_key="$(date -u +%Y%m%dT%H%M%SZ)"
stage=""
finished=0

on_exit() {
  local status=$?
  [[ -n "$stage" ]] && rm -rf -- "$stage"
  if ((status != 0 || !finished)); then
    restic_alert critical restic_backup_failed "off-site backup failed; inspect journalctl -u learncoding-restic-backup.service"
    restic_report_status failure "$run_key"
    restic_write_metrics || true
  fi
  exit "$status"
}
trap on_exit EXIT

# Share the existing backup lock: the mail outbox cutover holds it as a
# database-writer fence, so this run waits rather than dumping mid-cutover.
exec 9>"$BACKUP_LOCK_FILE"
flock -w 3600 9 || restic_die "timed out waiting for the backup lock"

stage="$(mktemp -d -- "$RESTIC_STAGE_ROOT/learncoding-restic.XXXXXX")"
chmod 0700 -- "$stage"

# Fail closed before any work when the expected uploads are not there.
uploads="$LEARN_DATA_ROOT/app-data/objects"
if [[ "$RESTIC_UPLOADS_EXPECTED" == true ]]; then
  [[ -d "$uploads" && ! -L "$uploads" ]] \
    || restic_die "uploads directory is missing or a symlink: $uploads (set RESTIC_UPLOADS_EXPECTED=false only for a database-only deployment)"
fi

restic_log "restic backup phase=dump"
dump="$stage/$RESTIC_DUMP_NAME"
dump_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
restic_compose exec -T postgres sh -ceu \
  'exec pg_dump --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  >"$dump" \
  || restic_die "pg_dump failed"
dump_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ -s "$dump" ]] || restic_die "pg_dump produced an empty dump"
# A truncated custom-format dump fails to list; never upload one.
restic_compose exec -T postgres pg_restore --list <"$dump" >/dev/null \
  || restic_die "database dump failed its table-of-contents check"

# The manifest lists every object the dump references, so the dump and the
# files it needs share one recovery point. App writes are not fenced: an object
# deleted after the dump makes the backup fail instead of silently missing.
restic_log "restic backup phase=manifest"
manifest="$stage/$RESTIC_MANIFEST_NAME"
restic_referenced_objects <"$dump" >"$stage/referenced" \
  || restic_die "could not read stored_object rows from the dump"
: >"$manifest"
referenced_objects=0
while read -r key size sha; do
  [[ "$key" =~ $RESTIC_STORAGE_KEY_PATTERN && "$size" =~ ^[0-9]+$ && "$sha" =~ ^[0-9a-f]{64}$ ]] \
    || restic_die "dump contains a malformed stored_object row"
  [[ "$RESTIC_UPLOADS_EXPECTED" == true ]] \
    || restic_die "database references uploaded objects but RESTIC_UPLOADS_EXPECTED=false"
  object_status=0
  restic_verify_object "$uploads" "$key" "$size" "$sha" || object_status=$?
  case "$object_status" in
    0) ;;
    1) restic_die "referenced object is missing or not a regular file: $key" ;;
    *) restic_die "object does not match the database size/sha256: $key" ;;
  esac
  printf '%s %s %s\n' "$sha" "$size" "$key" >>"$manifest"
  referenced_objects=$((referenced_objects + 1))
done <"$stage/referenced"
rm -f -- "$stage/referenced"
manifest_sha256="$(sha256sum -- "$manifest" | cut -d' ' -f1)"

recovery_point_body() {
  printf '  "dump_started_at": "%s",\n' "$dump_started_at"
  printf '  "dump_completed_at": "%s",\n' "$dump_completed_at"
  printf '  "uploads_expected": %s,\n' "$RESTIC_UPLOADS_EXPECTED"
  printf '  "referenced_objects": %s,\n' "$referenced_objects"
  printf '  "manifest_sha256": "%s"' "$manifest_sha256"
}
{ printf '{\n'; recovery_point_body; printf '\n}\n'; } >"$stage/$RESTIC_RECOVERY_POINT_NAME"

backup_paths=("$RESTIC_STAGE_PATH")
mounts=(-v "$stage:$RESTIC_STAGE_PATH:ro")
if [[ "$RESTIC_UPLOADS_EXPECTED" == true ]]; then
  mounts+=(-v "$uploads:$RESTIC_UPLOADS_PATH:ro")
  backup_paths+=("$RESTIC_UPLOADS_PATH")
fi

restic_log "restic backup phase=upload"
backup_output="$(restic_run "${mounts[@]}" -- backup --quiet --json \
  --host "$RESTIC_SNAPSHOT_HOST" --tag "$RESTIC_SNAPSHOT_TAG" \
  "${backup_paths[@]}")" \
  || restic_die "restic backup failed"
snapshot_id="$(grep -o '"snapshot_id":"[0-9a-f]\{64\}"' <<<"$backup_output" | tail -n 1 | cut -d'"' -f4)"
[[ "$snapshot_id" =~ ^[0-9a-f]{64}$ ]] || restic_die "restic backup did not report a snapshot id"
rm -rf -- "$stage"
stage=""

# Record dump time, manifest and snapshot id together for this recovery point.
point_tmp="$(mktemp -- "$RESTIC_STATE_DIR/.recovery-point.XXXXXX")"
{
  printf '{\n'
  recovery_point_body
  printf ',\n  "snapshot_id": "%s"\n}\n' "$snapshot_id"
} >"$point_tmp"
mv -f -- "$point_tmp" "$RESTIC_STATE_DIR/$RESTIC_RECOVERY_POINT_NAME"
restic_log "restic backup recovery point snapshot=$snapshot_id objects=$referenced_objects"

restic_log "restic backup phase=retention"
restic_run -- forget --quiet --prune \
  --host "$RESTIC_SNAPSHOT_HOST" --tag "$RESTIC_SNAPSHOT_TAG" \
  --keep-daily "$RESTIC_KEEP_DAILY" --keep-weekly "$RESTIC_KEEP_WEEKLY" --keep-monthly "$RESTIC_KEEP_MONTHLY" \
  || restic_die "restic forget/prune failed"

restic_log "restic backup phase=check"
restic_run -- check --quiet || restic_die "restic check failed"

restic_mark last-backup-success
restic_write_metrics
finished=1
restic_report_status success "$run_key"
restic_log "restic backup complete"
