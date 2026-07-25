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

abort_restore_database() {
  local reason="${1:-database restore failed}"

  if remove_restore_database "$restore_db"; then
    die "$reason; temporary database was removed"
  fi
  die "$reason; cleanup failed; temporary database may remain"
}

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
  restore_owner_count="$(compose_cmd exec -T postgres sh -ceu \
    'psql --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname=postgres -tAc "$1"' _ \
    "select pg_catalog.count(*)::text
       from (
         select role.rolname,
                role.rolcanlogin,
                role.rolsuper,
                role.rolcreatedb,
                role.rolcreaterole,
                role.rolinherit,
                role.rolreplication,
                role.rolbypassrls,
                role.rolconnlimit,
                role.rolvaliduntil = 'infinity'::pg_catalog.timestamptz
                  as valid_until_infinity,
                role.rolpassword is null as password_is_null,
                not exists (
                  select 1
                    from pg_catalog.pg_db_role_setting setting
                   where setting.setrole = role.oid
                ) as role_settings_empty,
                (
                  select pg_catalog.count(*) = 1
                         and pg_catalog.count(*) filter (
                           where granted.rolname = 'learncoding_owner'
                             and member.rolname = 'learncoding_migrator'
                             and not membership.admin_option
                             and not membership.inherit_option
                             and membership.set_option
                         ) = 1
                    from pg_catalog.pg_auth_members membership
                    join pg_catalog.pg_roles granted
                      on granted.oid = membership.roleid
                    join pg_catalog.pg_roles member
                      on member.oid = membership.member
                   where granted.rolname in (
                     'learncoding_owner', 'learncoding_migrator',
                     'learncoding_app', 'learncoding_worker', 'learncoding_ops',
                     'learncoding_backup_reporter'
                   )
                      or member.rolname in (
                        'learncoding_owner', 'learncoding_migrator',
                        'learncoding_app', 'learncoding_worker', 'learncoding_ops',
                        'learncoding_backup_reporter'
                      )
                ) as membership_contract_exact
           from pg_catalog.pg_authid role
       ) role
      where role.rolname = 'learncoding_owner'
        and not role.rolcanlogin and not role.rolsuper
        and not role.rolcreatedb and not role.rolcreaterole
        and not role.rolinherit and not role.rolreplication
        and not role.rolbypassrls and role.rolconnlimit = -1
        and role.valid_until_infinity and role.password_is_null
        and role.role_settings_empty
        and role.membership_contract_exact")"
  [[ "$restore_owner_count" == 1 ]] \
    || die "exact learncoding_owner restore role is unavailable"
  compose_cmd exec -T postgres sh -ceu 'createdb --host=/run/learncoding-postgres --username="$POSTGRES_USER" --owner=learncoding_owner "$1"' _ "$restore_db"
  if ! compose_cmd exec -T postgres sh -ceu \
    'exec pg_restore --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname="$1" --exit-on-error --no-owner --role=learncoding_owner' _ "$restore_db" \
    <"$destination/database.dump"; then
    abort_restore_database "database restore failed"
  fi
  pre_repair_verification="$(compose_cmd --profile operations run --rm \
    --no-deps --no-build --pull never \
    -e "RESTORE_DATABASE_NAME=$restore_db" \
    database-role-bootstrap \
    node /app/scripts/verify-pre-repair-restored-database.mjs)" \
    || {
      abort_restore_database "raw restored catalog verification failed"
    }
  if [[ "$pre_repair_verification" != restore_pre_repair_catalog_valid=true ]]; then
    abort_restore_database "raw restored catalog verifier returned an invalid acknowledgement"
  fi
  log "database restored into isolated database: $restore_db"
fi

log "restore staged successfully at $destination; live data was not overwritten"
