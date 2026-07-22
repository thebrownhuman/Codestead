#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command docker
require_command find
require_command flock
require_command realpath
require_command stat

usage() {
  echo "usage: $0 ARCHIVE --destination EMPTY_DIRECTORY [--restore-db learncoding_restore_NAME]" >&2
  exit 64
}

[[ $# -ge 3 ]] || usage
archive="$1"
shift
destination=""
restore_db=""
while (( $# > 0 )); do
  case "$1" in
    --destination) [[ $# -ge 2 ]] || usage; destination="$2"; shift 2 ;;
    --restore-db) [[ $# -ge 2 ]] || usage; restore_db="$2"; shift 2 ;;
    *) usage ;;
  esac
done

: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the offline restore identity}"
require_secure_regular_file "$AGE_IDENTITY_FILE" 600 "$(id -u)" \
  || die "age restore identity must be a single-link mode-0600 file owned by the invoking operator"
[[ -n "$destination" ]] || usage
require_absolute_path "$archive"
require_absolute_path "$destination"
archive="$(realpath -e -- "$archive")"
require_secure_regular_file "$archive" 600 "$(id -u)" \
  || die "encrypted restore archive is unsafe"
destination="$(realpath -m -- "$destination")"
: "${BACKUP_STAGE_ROOT:=/var/tmp/learncoding-backup}"
: "${BACKUP_EPHEMERAL_ROOT:=/run}"
protected_roots=(
  "$REPO_ROOT" "$LEARN_DATA_ROOT" "$BACKUP_ROOT" "$BACKUP_STAGE_ROOT"
  "$BACKUP_EPHEMERAL_ROOT"
)
if [[ -n "${EMERGENCY_BACKUP_ROOT:-}" ]]; then
  protected_roots+=("$EMERGENCY_BACKUP_ROOT")
fi
for protected_root in "${protected_roots[@]}"; do
  require_absolute_path "$protected_root"
  if path_is_within "$destination" "$protected_root" \
    || path_is_within "$protected_root" "$destination"; then
    die "refusing restore destination that overlaps a protected root"
  fi
done
if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -d "$destination" && ! -L "$destination" ]] || die "restore destination exists and is not a safe directory"
  [[ "$(stat -c '%a:%u' -- "$destination")" == "700:$(id -u)" ]] \
    || die "restore destination metadata is unsafe"
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die "restore destination must be empty"
fi

if [[ -n "$restore_db" && ! "$restore_db" =~ ^learncoding_restore_[A-Za-z0-9_]+$ ]]; then
  die "restore database must start with learncoding_restore_ and contain only letters, digits, or underscores"
fi

acquire_backup_lock
verify_ciphertext_checksum "$archive" || die "ciphertext checksum failed"
verification_result="$(BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" \
  bash "$SCRIPT_DIR/verify-archive.sh" "$archive" "$AGE_IDENTITY_FILE" "$destination")" \
  || die "archive inventory or content verification failed"
[[ "$verification_result" == archive_valid=true ]] \
  || die "archive verifier returned an invalid acknowledgement"

if [[ -n "$restore_db" ]]; then
  [[ -f "$destination/database.dump" ]] || die "database dump is missing"
  exists="$(compose_cmd exec -T postgres sh -ceu \
    'psql --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname=postgres -tAc "$1"' _ \
    "SELECT 1 FROM pg_database WHERE datname = '$restore_db'")"
  [[ -z "$exists" ]] || die "restore database already exists: $restore_db"
  compose_cmd exec -T postgres sh -ceu 'createdb --host=/run/learncoding-postgres --username="$POSTGRES_USER" "$1"' _ "$restore_db"
  if ! compose_cmd exec -T postgres sh -ceu \
    'exec pg_restore --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname="$1" --exit-on-error --no-owner --no-acl' _ "$restore_db" \
    <"$destination/database.dump"; then
    compose_cmd exec -T postgres sh -ceu 'dropdb --host=/run/learncoding-postgres --username="$POSTGRES_USER" --if-exists "$1"' _ "$restore_db" || true
    die "database restore failed; temporary database was removed"
  fi
  log "database restored into isolated database: $restore_db"
fi

log "restore staged successfully at $destination; live data was not overwritten"
