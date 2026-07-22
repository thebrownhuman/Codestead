#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config

[[ $# -ge 1 ]] || die "usage: $0 DESTINATION..."
for command_name in age age-keygen base64 cp date df find flock gzip hostname mktemp realpath sha256sum stat sync tar; do
  require_command "$command_name"
done

: "${CREDENTIAL_MASTER_KEY_FILE:=/etc/learncoding/secrets/credential_master_key}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the offline backup identity}"
: "${RECOVERY_KIT_RECIPIENT_FILE:?RECOVERY_KIT_RECIPIENT_FILE is required}"
: "${RECOVERY_KIT_METADATA_FILE:?RECOVERY_KIT_METADATA_FILE is required}"
: "${RECOVERY_KIT_MIN_FREE_BYTES:=1048576}"
[[ "$RECOVERY_KIT_MIN_FREE_BYTES" =~ ^[1-9][0-9]*$ ]] || die "recovery-kit capacity minimum is invalid"
for configured in "$CREDENTIAL_MASTER_KEY_FILE" "$AGE_IDENTITY_FILE" \
  "$RECOVERY_KIT_RECIPIENT_FILE" "$RECOVERY_KIT_METADATA_FILE" "$BACKUP_STAGE_ROOT"; do
  require_absolute_path "$configured"
done

require_secure_regular_file "$CREDENTIAL_MASTER_KEY_FILE" 440 "$(id -u)" \
  || die "credential master key is missing or unsafe"
require_secure_regular_file "$AGE_IDENTITY_FILE" 600 "$(id -u)" \
  || die "backup age identity is missing or unsafe"
require_secure_regular_file "$RECOVERY_KIT_RECIPIENT_FILE" 600 "$(id -u)" \
  || die "recovery-kit recipient is missing or unsafe"
require_secure_regular_file "$RECOVERY_KIT_METADATA_FILE" 600 "$(id -u)" \
  || die "recovery-kit metadata is missing or unsafe"

credential_value="$(tr -d '\r\n' <"$CREDENTIAL_MASTER_KEY_FILE")"
[[ "$credential_value" =~ ^[A-Za-z0-9+/]{43}=$ \
  && "$(printf '%s' "$credential_value" | base64 --decode 2>/dev/null | wc -c)" -eq 32 ]] \
  || die "credential master key must be exactly 32 base64-encoded bytes"
unset credential_value
[[ "$(grep -Ec '^AGE-SECRET-KEY-1[A-Z0-9]+$' "$AGE_IDENTITY_FILE" || true)" -eq 1 ]] \
  || die "backup age identity has an invalid format"
age-keygen -y "$AGE_IDENTITY_FILE" >/dev/null 2>&1 \
  || die "backup age identity cannot derive a public recipient"
mapfile -t recipient_lines <"$RECOVERY_KIT_RECIPIENT_FILE"
[[ ${#recipient_lines[@]} -eq 1 && "${recipient_lines[0]}" =~ ^age1[0-9a-z]+$ ]] \
  || die "recovery-kit recipient must contain one age public recipient"
grep -Eq 'AGE-SECRET-KEY-|AGE-PLUGIN-.+-' "$RECOVERY_KIT_RECIPIENT_FILE" \
  && die "recovery-kit recipient contains private identity material"

declare -A metadata=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" == *=* ]] || die "recovery-kit metadata has an invalid line"
  key="${line%%=*}"
  value="${line#*=}"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && -n "$value" && -z "${metadata[$key]+x}" \
    && "$value" != *$'\r'* && "$value" != *$'\n'* ]] \
    || die "recovery-kit metadata has an invalid field"
  metadata[$key]="$value"
done <"$RECOVERY_KIT_METADATA_FILE"
required_metadata=(
  CLOUDFLARE_ACCOUNT CLOUDFLARE_TUNNEL CLOUDFLARE_HOSTNAME
  CLOUDFLARE_RECOVERY_PROCEDURE GMAIL_OAUTH_PROJECT GMAIL_ACCOUNT
  GMAIL_REAUTHORIZATION_PROCEDURE GIT_COMMIT IMAGE_IDS IDENTITY_STORAGE_LOCATION
)
[[ ${#metadata[@]} -eq ${#required_metadata[@]} ]] || die "recovery-kit metadata inventory is invalid"
for key in "${required_metadata[@]}"; do
  [[ -n "${metadata[$key]+x}" ]] || die "recovery-kit metadata is missing $key"
  LC_ALL=C grep -q '[^ -~]' <<<"${metadata[$key]}" && die "recovery-kit metadata contains non-printable text"
done
[[ "${metadata[GIT_COMMIT]}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ \
  && "${metadata[CLOUDFLARE_HOSTNAME]}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ \
  && "${metadata[GMAIL_ACCOUNT]}" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] \
  || die "recovery-kit metadata contains an invalid identity"
printf '%s\n' "${metadata[@]}" | grep -Eq 'AGE-SECRET-KEY-|(^|[^A-Za-z])(nvapi-|sk-ant-|sk-proj-)' \
  && die "recovery-kit metadata contains credential material"

declare -a roots=() kit_dirs=() final_archives=() final_checksums=() temporary_paths=()
declare -A root_seen=()
for requested in "$@"; do
  require_absolute_path "$requested"
  [[ -d "$requested" && ! -L "$requested" ]] || die "recovery-kit destination is unavailable"
  root="$(realpath -e -- "$requested")"
  [[ "$root" == "$requested" && "$root" != / && -z "${root_seen[$root]+x}" ]] \
    || die "recovery-kit destination is duplicate or non-canonical"
  marker="$root/.learncoding-backup-root"
  require_secure_regular_file "$marker" 600 "$(id -u)" || die "recovery-kit destination marker is unsafe"
  marker_value="$(<"$marker")"
  [[ "$marker_value" == "$FULL_BACKUP_MAGIC" || "$marker_value" == "$EMERGENCY_BACKUP_MAGIC" ]] \
    || die "recovery-kit destination marker is invalid"
  kit_dir="$root/recovery-kits"
  [[ -d "$kit_dir" && ! -L "$kit_dir" \
    && "$(stat -c '%a' -- "$kit_dir")" == 700 \
    && "$(stat -c '%u' -- "$kit_dir")" == "$(id -u)" ]] \
    || die "recovery-kit destination directory is unsafe"
  available="$(df -B1 --output=avail "$root" | tail -n 1 | tr -d ' ')"
  [[ "$available" =~ ^[0-9]+$ ]] && ((available >= RECOVERY_KIT_MIN_FREE_BYTES)) \
    || die "recovery-kit destination capacity is below the safety minimum"
  root_seen[$root]=1
  roots+=("$root")
  kit_dirs+=("$kit_dir")
done

acquire_backup_lock
install -d -m 0700 -- "$BACKUP_STAGE_ROOT"
stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/recovery-kit.XXXXXX")"
stage_identity="$(stat -c '%d:%i:%u:%a' -- "$stage")"
success=0
cleanup() {
  local rc=$? current_identity=""
  trap - EXIT
  for path in "${temporary_paths[@]:-}"; do
    [[ -z "$path" ]] || rm -f -- "$path" 2>/dev/null || rc=1
  done
  for path in "${final_checksums[@]:-}" "${final_archives[@]:-}"; do
    [[ -z "$path" || $success -eq 1 ]] || rm -f -- "$path" 2>/dev/null || rc=1
  done
  current_identity="$(stat -c '%d:%i:%u:%a' -- "$stage" 2>/dev/null || true)"
  if [[ "$current_identity" == "$stage_identity" && -d "$stage" && ! -L "$stage" ]]; then
    find -P "$stage" -mindepth 1 -delete 2>/dev/null || rc=1
    rmdir -- "$stage" 2>/dev/null || rc=1
  else
    rc=1
  fi
  ((success == 1)) || exit 1
  exit "$rc"
}
trap cleanup EXIT

cp -- "$CREDENTIAL_MASTER_KEY_FILE" "$stage/credential_master_key"
cp -- "$AGE_IDENTITY_FILE" "$stage/backup-age-identity.txt"
chmod 0600 "$stage/credential_master_key" "$stage/backup-age-identity.txt"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
source_host="$(hostname -f 2>/dev/null || hostname)"
[[ "$source_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || die "source hostname is invalid"

cat >"$stage/RECOVERY.md" <<EOF
# Codestead recovery references

Created UTC: $timestamp
Cloudflare account: ${metadata[CLOUDFLARE_ACCOUNT]}
Cloudflare tunnel: ${metadata[CLOUDFLARE_TUNNEL]}
Cloudflare hostname: ${metadata[CLOUDFLARE_HOSTNAME]}
Cloudflare reissue procedure: ${metadata[CLOUDFLARE_RECOVERY_PROCEDURE]}
Gmail OAuth project: ${metadata[GMAIL_OAUTH_PROJECT]}
Gmail administrator account: ${metadata[GMAIL_ACCOUNT]}
Gmail reauthorization procedure: ${metadata[GMAIL_REAUTHORIZATION_PROCEDURE]}
Git commit: ${metadata[GIT_COMMIT]}
Container image identities: ${metadata[IMAGE_IDS]}
Offline identity location: ${metadata[IDENTITY_STORAGE_LOCATION]}
Secret bearer credentials in this document: false
EOF
cat >"$stage/MANIFEST.txt" <<EOF
format=learncoding-recovery-kit-v1
created_utc=$timestamp
source_host=$source_host
git_commit=${metadata[GIT_COMMIT]}
contains_access_tokens=false
inventory=credential_master_key,backup-age-identity.txt,RECOVERY.md,MANIFEST.txt,SHA256SUMS
EOF
chmod 0600 "$stage/RECOVERY.md" "$stage/MANIFEST.txt"
(cd "$stage" && sha256sum --text credential_master_key backup-age-identity.txt RECOVERY.md MANIFEST.txt >SHA256SUMS)
chmod 0600 "$stage/SHA256SUMS"

plain="$stage/recovery-kit.tar.gz"
tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
  --owner=0 --group=0 --numeric-owner --mode='u=rw,go=' \
  --mtime="${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC" \
  --use-compress-program='gzip -n' --create --file "$plain" --directory "$stage" \
  credential_master_key backup-age-identity.txt RECOVERY.md MANIFEST.txt SHA256SUMS
archive="$stage/learncoding-recovery-kit-$timestamp.tar.gz.age"
age --encrypt --recipients-file "$RECOVERY_KIT_RECIPIENT_FILE" --output "$archive" "$plain" >/dev/null 2>&1
[[ -f "$archive" && ! -L "$archive" && -s "$archive" ]] || die "recovery-kit encryption failed"
chmod 0600 "$archive"
rm -f -- "$plain" "$stage/credential_master_key" "$stage/backup-age-identity.txt" \
  "$stage/RECOVERY.md" "$stage/MANIFEST.txt" "$stage/SHA256SUMS"
archive_hash="$(sha256sum "$archive" | awk '{print $1}')"
printf '%s  %s\n' "$archive_hash" "$(basename -- "$archive")" >"${archive}.sha256"
chmod 0600 "${archive}.sha256"

if [[ -n "${RECOVERY_KIT_VERIFY_IDENTITY_FILE:-}" ]]; then
  require_absolute_path "$RECOVERY_KIT_VERIFY_IDENTITY_FILE"
  require_secure_regular_file "$RECOVERY_KIT_VERIFY_IDENTITY_FILE" 600 "$(id -u)" \
    || die "recovery-kit verification identity is unsafe"
  verify_dir="$stage/verified"
  BACKUP_LOCK_HELD=1 BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" \
    bash "$SCRIPT_DIR/verify-recovery-kit.sh" "$archive" "$RECOVERY_KIT_VERIFY_IDENTITY_FILE" "$verify_dir" \
    | grep -Fxq recovery_kit_valid=true || die "recovery-kit decrypt verification failed"
  find -P "$verify_dir" -mindepth 1 -delete
  rmdir "$verify_dir"
fi

filename="$(basename -- "$archive")"
for kit_dir in "${kit_dirs[@]}"; do
  final="$kit_dir/$filename"
  final_checksum="${final}.sha256"
  [[ ! -e "$final" && ! -L "$final" && ! -e "$final_checksum" && ! -L "$final_checksum" ]] \
    || die "recovery-kit destination already contains this recovery point"
  temporary="$(mktemp -- "$kit_dir/.${filename}.tmp.XXXXXX")"
  temporary_checksum="$(mktemp -- "$kit_dir/.${filename}.sha256.tmp.XXXXXX")"
  temporary_paths+=("$temporary" "$temporary_checksum")

  cp -- "$archive" "$temporary"
  cp -- "${archive}.sha256" "$temporary_checksum"
  chmod 0600 "$temporary" "$temporary_checksum"
  cmp -s -- "$archive" "$temporary" && cmp -s -- "${archive}.sha256" "$temporary_checksum" \
    || die "recovery-kit destination copy verification failed"
  sync -f -- "$temporary"
  sync -f -- "$temporary_checksum"
  mv -T -- "$temporary" "$final"
  final_archives+=("$final")
  mv -T -- "$temporary_checksum" "$final_checksum"
  final_checksums+=("$final_checksum")
  verify_ciphertext_checksum "$final" || die "published recovery-kit checksum failed"
  [[ "$(sha256sum "$final" | awk '{print $1}')" == "$archive_hash" ]] \
    || die "published recovery-kit bytes changed"
  sync -f -- "$kit_dir"
done

success=1
printf 'recovery_kit_created=true\n'
