#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config

for command_name in age age-keygen docker find flock gzip realpath sha256sum sync tar; do
  require_command "$command_name"
done

: "${EMERGENCY_BACKUP_ROOT:?EMERGENCY_BACKUP_ROOT must name the mounted emergency drive}"
: "${AGE_RECIPIENT_FILE:?AGE_RECIPIENT_FILE is required}"
: "${BACKUP_EPHEMERAL_ROOT:=/run}"
for configured_path in "$EMERGENCY_BACKUP_ROOT" "$REPO_ROOT" "$LEARN_DATA_ROOT" \
  "$COMPOSE_ENV_FILE" "$AGE_RECIPIENT_FILE" "$BACKUP_STAGE_ROOT" \
  "$BACKUP_EPHEMERAL_ROOT" "$BACKUP_LOCK_FILE"; do
  [[ "$configured_path" == /* ]] || die "backup configuration contains a non-absolute path"
done
[[ -z "${BACKUP_ROOT:-}" || "$BACKUP_ROOT" == /* ]] \
  || die "backup configuration contains a non-absolute path"
require_secure_regular_file "$COMPOSE_ENV_FILE" 640 "$(id -u)" \
  || die "Compose environment is missing or unsafe"
require_secure_regular_file "$AGE_RECIPIENT_FILE" 600 "$(id -u)" \
  || die "age recipient file is missing or unsafe"
[[ -s "$AGE_RECIPIENT_FILE" ]] || die "age recipient file is empty"
if grep -Eq 'AGE-SECRET-KEY-|AGE-PLUGIN-.+-' "$AGE_RECIPIENT_FILE"; then
  die "age recipient file contains private identity material"
fi

secure_directory() {
  local directory="$1" mode="$2" resolved
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || return 1
    chmod "$mode" -- "$directory" || return 1
  else
    mkdir -m "$mode" -- "$directory" || return 1
  fi
  resolved="$(realpath -e -- "$directory")" || return 1
  [[ "$resolved" == "$directory" \
    && "$(stat -c '%a' -- "$directory")" == "${mode#0}" \
    && "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]]
}

secure_ephemeral_parent() {
  local directory="$1" mode resolved
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" \
      && "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]] || return 1
    mode="$(stat -c '%a' -- "$directory")" || return 1
    (( (8#$mode & 0022) == 0 )) || return 1
  else
    mkdir -m 0700 -- "$directory" || return 1
  fi
  resolved="$(realpath -e -- "$directory")" || return 1
  [[ "$resolved" == "$directory" ]]
}

root="$(validated_root "$EMERGENCY_BACKUP_ROOT" "$EMERGENCY_BACKUP_MAGIC")"
directory="$root/emergency"
protected_roots=("$REPO_ROOT" "$LEARN_DATA_ROOT" "$root")
[[ -z "${BACKUP_ROOT:-}" ]] || protected_roots+=("$BACKUP_ROOT")
for protected_root in "${protected_roots[@]}"; do
  if path_is_within "$BACKUP_STAGE_ROOT" "$protected_root" \
    || path_is_within "$protected_root" "$BACKUP_STAGE_ROOT"; then
    die "backup staging root overlaps a protected root"
  fi
  if path_is_within "$BACKUP_EPHEMERAL_ROOT" "$protected_root" \
    || path_is_within "$protected_root" "$BACKUP_EPHEMERAL_ROOT"; then
    die "ephemeral-key root overlaps a protected root"
  fi
done
if path_is_within "$BACKUP_STAGE_ROOT" "$BACKUP_EPHEMERAL_ROOT" \
  || path_is_within "$BACKUP_EPHEMERAL_ROOT" "$BACKUP_STAGE_ROOT"; then
  die "backup staging and ephemeral-key roots overlap"
fi
secure_directory "$directory" 0700 || die "emergency publication directory is unsafe"
secure_directory "$BACKUP_STAGE_ROOT" 0700 || die "backup staging root is unsafe"
secure_ephemeral_parent "$BACKUP_EPHEMERAL_ROOT" || die "ephemeral-key root is unsafe"
acquire_backup_lock

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="learncoding-emergency-${timestamp}.tar.gz.age"
final="$directory/$filename"
final_checksum="${final}.sha256"
[[ ! -e "$final" && ! -L "$final" \
  && ! -e "$final_checksum" && ! -L "$final_checksum" ]] \
  || die "emergency backup timestamp already exists"

stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/emergency.${timestamp}.XXXXXX")"
verify_dir="$(mktemp -d -- "$BACKUP_STAGE_ROOT/emergency-verify.${timestamp}.XXXXXX")"
ephemeral_dir="$(mktemp -d -- "$BACKUP_EPHEMERAL_ROOT/learncoding-emergency.${timestamp}.XXXXXX")"
chmod 0700 -- "$stage" "$verify_dir" "$ephemeral_dir"
identity="$ephemeral_dir/identity.txt"
ephemeral_recipient="$ephemeral_dir/recipient.txt"
combined_recipients="$ephemeral_dir/recipients.txt"
plaintext="$stage/.plaintext-envelope.tar.gz"
temporary=""
checksum_temporary=""
archive_published=0
checksum_published=0
published=0

safe_remove_stage_tree() {
  local target="$1"
  [[ -d "$target" && ! -L "$target" \
    && "$target" != "$BACKUP_STAGE_ROOT" \
    && "$(stat -c '%u' -- "$target" 2>/dev/null)" == "$(id -u)" ]] || return 1
  path_is_within "$target" "$BACKUP_STAGE_ROOT" || return 1
  find -P "$target" -mindepth 1 -delete 2>/dev/null || return 1
  rmdir -- "$target"
}

remove_ephemeral_material() {
  [[ -d "$ephemeral_dir" && ! -L "$ephemeral_dir" \
    && "$ephemeral_dir" != "$BACKUP_EPHEMERAL_ROOT" \
    && "$(stat -c '%u' -- "$ephemeral_dir" 2>/dev/null)" == "$(id -u)" ]] || return 1
  path_is_within "$ephemeral_dir" "$BACKUP_EPHEMERAL_ROOT" || return 1
  rm -f -- "$identity" "$ephemeral_recipient" "$combined_recipients" 2>/dev/null || true
  find -P "$ephemeral_dir" -mindepth 1 -delete 2>/dev/null || return 1
  rmdir -- "$ephemeral_dir"
}

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT
  remove_ephemeral_material || cleanup_failed=1
  [[ -z "$temporary" ]] || rm -f -- "$temporary" 2>/dev/null || cleanup_failed=1
  [[ -z "$checksum_temporary" ]] || rm -f -- "$checksum_temporary" 2>/dev/null || cleanup_failed=1
  if ((published == 0)); then
    ((archive_published == 0)) || rm -f -- "$final" 2>/dev/null || cleanup_failed=1
    ((checksum_published == 0)) || rm -f -- "$final_checksum" 2>/dev/null || cleanup_failed=1
  fi
  safe_remove_stage_tree "$verify_dir" || cleanup_failed=1
  safe_remove_stage_tree "$stage" || cleanup_failed=1
  if ((status == 0 && cleanup_failed != 0)); then
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT

assert_safe_source_tree() {
  local source
  for source in "$@"; do
    [[ ! -L "$source" && ( -f "$source" || -d "$source" ) ]] || return 1
    if [[ -d "$source" ]] \
      && find -P "$source" -mindepth 1 ! -type f ! -type d -print -quit | grep -q .; then
      return 1
    fi
  done
}

if ! age-keygen -o "$identity" >/dev/null 2>&1; then
  die "ephemeral age identity generation failed"
fi
chmod 0600 -- "$identity"
if ! age-keygen -y "$identity" >"$ephemeral_recipient" 2>/dev/null; then
  die "ephemeral age recipient derivation failed"
fi
chmod 0600 -- "$ephemeral_recipient"
cat -- "$AGE_RECIPIENT_FILE" "$ephemeral_recipient" >"$combined_recipients"
chmod 0600 -- "$combined_recipients"

log "emergency backup phase=dumping"
compose_cmd exec -T postgres sh -ceu \
  'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  >"$stage/database.dump"
[[ -s "$stage/database.dump" ]] || die "PostgreSQL dump is empty"

recovery_sources=(
  "$REPO_ROOT/compose.yaml" "$REPO_ROOT/Dockerfile" "$REPO_ROOT/.dockerignore"
  "$REPO_ROOT/drizzle" "$REPO_ROOT/infra/env" "$REPO_ROOT/infra/systemd"
  "$REPO_ROOT/docs/deployment.md" "$REPO_ROOT/docs/runbooks"
)
assert_safe_source_tree "${recovery_sources[@]}" \
  || die "emergency recovery configuration contains an unsafe entry"
tar_mtime="${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC"
tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
  --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' \
  --mtime="$tar_mtime" --use-compress-program='gzip -n' \
  --exclude='infra/secrets' --exclude='infra/cloudflare/config.yml' \
  --exclude='.env' --exclude='.env.*' --exclude='*.pem' --exclude='*.key' \
  --exclude='*credentials*.json' --create --file "$stage/recovery-config.tar.gz" \
  --directory "$REPO_ROOT" .dockerignore Dockerfile compose.yaml docs/deployment.md \
  docs/runbooks drizzle infra/env infra/systemd >/dev/null 2>&1

cat >"$stage/MANIFEST.txt" <<EOF
format=learncoding-emergency-v1
created_utc=$timestamp
scope=database-and-non-secret-recovery-config-only
contains_secret_files=false
contains_email_exports=false
EOF
(cd "$stage" && sha256sum --text database.dump recovery-config.tar.gz MANIFEST.txt >SHA256SUMS)
tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
  --owner=0 --group=0 --numeric-owner --mode='u=rw,go=' --mtime="$tar_mtime" \
  --use-compress-program='gzip -n' --create --file "$plaintext" \
  --directory "$stage" MANIFEST.txt SHA256SUMS database.dump recovery-config.tar.gz

temporary="$(mktemp -- "$directory/.${filename}.tmp.XXXXXX")"
rm -f -- "$temporary"
age --encrypt --recipients-file "$combined_recipients" \
  --output "$temporary" "$plaintext" >/dev/null 2>&1
[[ -f "$temporary" && ! -L "$temporary" && -s "$temporary" ]] \
  || die "encrypted emergency candidate is empty"
chmod 0600 -- "$temporary"

verify_result="$(bash "$SCRIPT_DIR/verify-archive.sh" \
  "$temporary" "$identity" "$verify_dir")" \
  || die "emergency candidate decrypt verification failed"
[[ "$verify_result" == archive_valid=true ]] \
  || die "emergency verifier returned an invalid acknowledgement"
log "emergency backup phase=candidate_verified"

sync -f -- "$temporary"
ciphertext_hash="$(sha256sum "$temporary" | awk '{print $1}')"
[[ "$ciphertext_hash" =~ ^[0-9a-f]{64}$ ]] || die "emergency ciphertext checksum is invalid"
checksum_temporary="$(mktemp -- "$directory/.${filename}.sha256.tmp.XXXXXX")"
printf '%s  %s\n' "$ciphertext_hash" "$filename" >"$checksum_temporary"
chmod 0600 -- "$checksum_temporary"
sync -f -- "$checksum_temporary"

mv -T -- "$temporary" "$final"
temporary=""
archive_published=1
mv -T -- "$checksum_temporary" "$final_checksum"
checksum_temporary=""
checksum_published=1
require_secure_regular_file "$final" 600 "$(id -u)" \
  || die "emergency archive metadata is unsafe"
require_secure_regular_file "$final_checksum" 600 "$(id -u)" \
  || die "emergency sidecar metadata is unsafe"
verify_ciphertext_checksum "$final" || die "emergency archive pair verification failed"
[[ "$(sha256sum "$final" | awk '{print $1}')" == "$ciphertext_hash" ]] \
  || die "emergency archive changed during publication"
sync -f -- "$directory"
published=1
log "emergency backup phase=published"

mapfile -t emergency_archives < <(
  find "$directory" -maxdepth 1 -type f \
    -name 'learncoding-emergency-*.tar.gz.age' -printf '%f\n' | sort -r
)
valid_count=0
for old in "${emergency_archives[@]}"; do
  [[ "$old" =~ ^learncoding-emergency-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]] || continue
  if ! verify_ciphertext_checksum "$directory/$old"; then
    emit_alert warning emergency_backup_not_pruned \
      "an emergency archive with an invalid checksum was preserved for inspection"
    continue
  fi
  ((valid_count += 1))
  ((valid_count > 3)) || continue
  rm -f -- "$directory/$old" "$directory/${old}.sha256"
done
log "emergency backup phase=complete"
