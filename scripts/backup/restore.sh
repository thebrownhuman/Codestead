#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command age
require_command docker
require_command find
require_command flock
require_command grep
require_command realpath
require_command sha256sum
require_command stat
require_command tar

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
[[ -f "$AGE_IDENTITY_FILE" && -r "$AGE_IDENTITY_FILE" ]] || die "age restore identity is unavailable"
identity_mode="$(stat -c %a "$AGE_IDENTITY_FILE")"
identity_owner="$(stat -c %u "$AGE_IDENTITY_FILE")"
(( (8#$identity_mode & 0077) == 0 )) || die "age restore identity must not be readable by group or other users"
[[ "$identity_owner" == "$(id -u)" ]] || die "age restore identity must be owned by the invoking operator"
[[ -n "$destination" ]] || usage
require_absolute_path "$archive"
require_absolute_path "$destination"
archive="$(realpath -e -- "$archive")"
destination="$(realpath -m -- "$destination")"
for unsafe in / "$REPO_ROOT" "$LEARN_DATA_ROOT" "${BACKUP_ROOT:-/nonexistent}"; do
  [[ "$destination" != "$unsafe" ]] || die "refusing unsafe restore destination: $destination"
done
if [[ -e "$destination" ]]; then
  [[ -d "$destination" ]] || die "restore destination exists and is not a directory"
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die "restore destination must be empty"
else
  install -d -m 0700 "$destination"
fi

if [[ -n "$restore_db" && ! "$restore_db" =~ ^learncoding_restore_[A-Za-z0-9_]+$ ]]; then
  die "restore database must start with learncoding_restore_ and contain only letters, digits, or underscores"
fi

acquire_backup_lock
verify_ciphertext_checksum "$archive" || die "ciphertext checksum failed"
install -d -m 0700 "$BACKUP_STAGE_ROOT"
listing="$(mktemp "$BACKUP_STAGE_ROOT/restore-list.XXXXXX")"
verbose_listing="$(mktemp "$BACKUP_STAGE_ROOT/restore-verbose.XXXXXX")"
trap 'rm -f -- "$listing" "$verbose_listing"' EXIT

age --decrypt --identity "$AGE_IDENTITY_FILE" "$archive" | tar -tzf - >"$listing"
while IFS= read -r entry; do
  case "$entry" in
    /*|..|../*|*/../*|*/..) die "archive contains an unsafe path" ;;
  esac
done <"$listing"
age --decrypt --identity "$AGE_IDENTITY_FILE" "$archive" | tar -tvzf - >"$verbose_listing"
if grep -Eq '^[^d-]' "$verbose_listing"; then
  die "archive contains a link, device, socket, or other special entry"
fi

age --decrypt --identity "$AGE_IDENTITY_FILE" "$archive" | \
  tar -xzf - -C "$destination" --no-same-owner --no-same-permissions --delay-directory-restore
[[ -f "$destination/SHA256SUMS" ]] || die "internal checksum manifest is missing"
while IFS= read -r checksum_line; do
  if [[ ! "$checksum_line" =~ ^[0-9a-fA-F]{64}[[:space:]][[:space:]](database\.dump|repository\.tar\.gz|app-data\.tar\.gz|recovery-config\.tar\.gz|MANIFEST\.txt)$ ]]; then
    die "internal checksum manifest contains an unexpected path or format"
  fi
done <"$destination/SHA256SUMS"
(cd "$destination" && sha256sum --check --strict --quiet SHA256SUMS) || die "internal backup checksum failed"

if [[ -n "$restore_db" ]]; then
  [[ -f "$destination/database.dump" ]] || die "database dump is missing"
  exists="$(compose_cmd exec -T postgres sh -ceu \
    'psql --username="$POSTGRES_USER" --dbname=postgres -tAc "$1"' _ \
    "SELECT 1 FROM pg_database WHERE datname = '$restore_db'")"
  [[ -z "$exists" ]] || die "restore database already exists: $restore_db"
  compose_cmd exec -T postgres sh -ceu 'createdb --username="$POSTGRES_USER" "$1"' _ "$restore_db"
  if ! compose_cmd exec -T postgres sh -ceu \
    'exec pg_restore --username="$POSTGRES_USER" --dbname="$1" --exit-on-error --no-owner --no-acl' _ "$restore_db" \
    <"$destination/database.dump"; then
    compose_cmd exec -T postgres sh -ceu 'dropdb --username="$POSTGRES_USER" --if-exists "$1"' _ "$restore_db" || true
    die "database restore failed; temporary database was removed"
  fi
  log "database restored into isolated database: $restore_db"
fi

log "restore staged successfully at $destination; live data was not overwritten"
