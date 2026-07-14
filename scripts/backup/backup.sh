#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config

require_command age
require_command docker
require_command flock
require_command git
require_command realpath
require_command sha256sum
require_command tar

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${AGE_RECIPIENT_FILE:?AGE_RECIPIENT_FILE is required}"
[[ -r "$AGE_RECIPIENT_FILE" && -s "$AGE_RECIPIENT_FILE" ]] || die "age recipient file is missing or empty"
if grep -Eq 'AGE-SECRET-KEY-|AGE-PLUGIN-.+-' "$AGE_RECIPIENT_FILE"; then
  die "AGE_RECIPIENT_FILE appears to contain a private identity"
fi
[[ -f "$REPO_ROOT/compose.yaml" ]] || die "repository deployment files are missing"
[[ -z "$(find "$REPO_ROOT/content" -type l -print -quit)" ]] || die "curriculum contains a symbolic link; refusing a non-self-contained backup"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
full_dir="$backup_root/full"
install -d -m 0700 "$full_dir" "$BACKUP_STAGE_ROOT"
acquire_backup_lock

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="learncoding-full-${timestamp}.tar.gz.age"
final_archive="$full_dir/$filename"
[[ ! -e "$final_archive" && ! -e "${final_archive}.sha256" ]] || die "backup timestamp already exists"
tmp_archive="$(mktemp "$full_dir/.${filename}.tmp.XXXXXX")"
stage="$(mktemp -d "$BACKUP_STAGE_ROOT/full.${timestamp}.XXXXXX")"
published=0

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${stage:-}" && -d "$stage" && "$stage" == "$BACKUP_STAGE_ROOT"/full.* ]]; then
    rm -rf --one-file-system -- "$stage"
  fi
  [[ -n "${tmp_archive:-}" && -f "$tmp_archive" ]] && rm -f -- "$tmp_archive"
  if (( ${published:-0} == 0 )) && [[ -n "${final_archive:-}" && -f "$final_archive" ]]; then
    rm -f -- "$final_archive" "${final_archive}.sha256"
  fi
  if (( status != 0 )); then
    if ! enqueue_backup_status failure "$timestamp"; then
      emit_alert warning backup_report_not_queued "backup failure email report could not be queued; inspect protected operations logs"
    fi
    emit_alert critical backup_failed "nightly encrypted backup failed; inspect learncoding-backup.service logs"
  fi
  exit "$status"
}
trap cleanup EXIT

log "dumping PostgreSQL"
compose_cmd exec -T postgres sh -ceu \
  'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  >"$stage/database.dump"
[[ -s "$stage/database.dump" ]] || die "PostgreSQL dump is empty"

log "archiving curriculum and non-secret deployment configuration"
tar -C "$REPO_ROOT" \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='infra/secrets' \
  --exclude='infra/cloudflare/config.yml' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='*credentials*.json' \
  --exclude='*.eml' \
  --exclude='*.mbox' \
  --exclude='*.pst' \
  --exclude='*.ost' \
  -czf "$stage/repository.tar.gz" \
  content drizzle compose.yaml Dockerfile .dockerignore infra docs/deployment.md docs/runbooks

app_data_included=false
if [[ -d "$LEARN_DATA_ROOT/app-data" ]]; then
  [[ -z "$(find "$LEARN_DATA_ROOT/app-data" -type l -print -quit)" ]] || die "app-data contains a symbolic link; refusing a non-self-contained backup"
  tar -C "$LEARN_DATA_ROOT" \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='*.pem' \
    --exclude='*.key' \
    --exclude='*credentials*.json' \
    --exclude='*.eml' \
    --exclude='*.mbox' \
    --exclude='*.pst' \
    --exclude='*.ost' \
    --exclude='*/mail/*' \
    --exclude='*/email/*' \
    --exclude='*mail-backup*' \
    -czf "$stage/app-data.tar.gz" app-data
  app_data_included=true
fi

commit="$(git -C "$REPO_ROOT" rev-parse --verify HEAD 2>/dev/null || printf unknown)"
database_version="$(compose_cmd exec -T postgres postgres --version | tr -d '\r\n')"
cat >"$stage/MANIFEST.txt" <<EOF
format=learncoding-backup-v1
created_utc=$timestamp
source_host=$(hostname -s)
git_commit=$commit
database_version=$database_version
app_data_included=$app_data_included
contains_secret_files=false
contains_email_exports=false
EOF

(cd "$stage" && sha256sum database.dump repository.tar.gz MANIFEST.txt >SHA256SUMS)
if [[ -f "$stage/app-data.tar.gz" ]]; then
  (cd "$stage" && sha256sum app-data.tar.gz >>SHA256SUMS)
fi

log "encrypting backup with age"
tar -C "$stage" -czf - . | age --encrypt --recipients-file "$AGE_RECIPIENT_FILE" >"$tmp_archive"
[[ -s "$tmp_archive" ]] || die "encrypted archive is empty"
chmod 0600 "$tmp_archive"
mv -- "$tmp_archive" "$final_archive"
tmp_archive=""
tmp_checksum="$full_dir/.${filename}.sha256.tmp.$$"
(cd "$full_dir" && sha256sum "$filename") >"$tmp_checksum"
chmod 0600 "$tmp_checksum"
mv -- "$tmp_checksum" "${final_archive}.sha256"
published=1

BACKUP_LOCK_HELD=1 "$SCRIPT_DIR/prune.sh"

if [[ "${ENABLE_RCLONE_OFFSITE:-0}" == "1" ]] && { [[ "$(date -u +%u)" == "7" ]] || [[ "${FORCE_OFFSITE_SYNC:-0}" == "1" ]]; }; then
  BACKUP_LOCK_HELD=1 "$SCRIPT_DIR/offsite-sync.sh"
fi

if ! enqueue_backup_status success "$timestamp"; then
  emit_alert warning backup_report_not_queued "backup success email report could not be queued; inspect protected operations logs"
fi
emit_alert info backup_complete "nightly encrypted backup completed and was checksum-verified"
log "backup complete: $final_archive"
