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
require_command sha256sum
require_command tar

: "${EMERGENCY_BACKUP_ROOT:?EMERGENCY_BACKUP_ROOT must name the mounted emergency drive}"
: "${AGE_RECIPIENT_FILE:?AGE_RECIPIENT_FILE is required}"
[[ -r "$AGE_RECIPIENT_FILE" && -s "$AGE_RECIPIENT_FILE" ]] || die "age recipient file is missing or empty"
if grep -Eq 'AGE-SECRET-KEY-|AGE-PLUGIN-.+-' "$AGE_RECIPIENT_FILE"; then
  die "AGE_RECIPIENT_FILE appears to contain a private identity"
fi
root="$(validated_root "$EMERGENCY_BACKUP_ROOT" "$EMERGENCY_BACKUP_MAGIC")"
directory="$root/emergency"
install -d -m 0700 "$directory" "$BACKUP_STAGE_ROOT"
acquire_backup_lock

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="learncoding-emergency-${timestamp}.tar.gz.age"
final="$directory/$filename"
[[ ! -e "$final" && ! -e "${final}.sha256" ]] || die "emergency backup timestamp already exists"
temporary="$(mktemp "$directory/.${filename}.tmp.XXXXXX")"
stage="$(mktemp -d "$BACKUP_STAGE_ROOT/emergency.${timestamp}.XXXXXX")"
checksum_temporary=""
published=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -d "${stage:-}" && "$stage" == "$BACKUP_STAGE_ROOT"/emergency.* ]]; then rm -rf --one-file-system -- "$stage"; fi
  [[ -f "${temporary:-}" ]] && rm -f -- "$temporary"
  [[ -f "${checksum_temporary:-}" ]] && rm -f -- "$checksum_temporary"
  if (( ${published:-0} == 0 )); then
    [[ -f "${final:-}" ]] && rm -f -- "$final" "${final}.sha256"
  fi
  exit "$rc"
}
trap cleanup EXIT

compose_cmd exec -T postgres sh -ceu \
  'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  >"$stage/database.dump"
[[ -s "$stage/database.dump" ]] || die "PostgreSQL dump is empty"
tar -C "$REPO_ROOT" -czf "$stage/recovery-config.tar.gz" \
  --exclude='infra/secrets' --exclude='infra/cloudflare/config.yml' --exclude='.env*' \
  --exclude='*.pem' --exclude='*.key' --exclude='*credentials*.json' \
  compose.yaml Dockerfile .dockerignore drizzle infra/env infra/systemd docs/deployment.md docs/runbooks
cat >"$stage/MANIFEST.txt" <<EOF
format=learncoding-emergency-v1
created_utc=$timestamp
scope=database-and-non-secret-recovery-config-only
contains_secret_files=false
contains_email_exports=false
EOF
(cd "$stage" && sha256sum database.dump recovery-config.tar.gz MANIFEST.txt >SHA256SUMS)
tar -C "$stage" -czf - . | age --encrypt --recipients-file "$AGE_RECIPIENT_FILE" >"$temporary"
[[ -s "$temporary" ]] || die "encrypted emergency archive is empty"
chmod 0600 "$temporary"
mv -- "$temporary" "$final"
temporary=""
checksum_temporary="$(mktemp "$directory/.${filename}.sha256.tmp.XXXXXX")"
(cd "$directory" && sha256sum "$filename") >"$checksum_temporary"
chmod 0600 "$checksum_temporary"
mv -- "$checksum_temporary" "${final}.sha256"
checksum_temporary=""
verify_ciphertext_checksum "$final" || die "emergency archive checksum verification failed"
published=1

mapfile -t emergency_archives < <(find "$directory" -maxdepth 1 -type f -name 'learncoding-emergency-*.tar.gz.age' -printf '%f\n' | sort -r)
valid_count=0
for old in "${emergency_archives[@]}"; do
  [[ "$old" =~ ^learncoding-emergency-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]] || continue
  if ! verify_ciphertext_checksum "$directory/$old"; then
    emit_alert warning emergency_backup_not_pruned "an emergency archive with a missing or invalid checksum was preserved for inspection"
    continue
  fi
  ((valid_count += 1))
  (( valid_count > 3 )) || continue
  rm -f -- "$directory/$old" "$directory/${old}.sha256"
done
log "emergency encrypted database/config snapshot complete: $final"
