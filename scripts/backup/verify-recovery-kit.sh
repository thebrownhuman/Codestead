#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config

fail() {
  printf 'recovery_kit_verification_failed\n' >&2
  exit 1
}

[[ $# -eq 3 ]] || fail
archive="$1"
identity="$2"
destination="$3"
for path in "$archive" "$identity" "$destination"; do
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || fail
done

for command_name in age age-keygen base64 find realpath sha256sum stat tar; do
  require_command "$command_name"
done

require_secure_regular_file "$archive" 600 "$(id -u)" || fail
require_secure_regular_file "${archive}.sha256" 600 "$(id -u)" || fail
require_secure_regular_file "$identity" 600 "$(id -u)" || fail
verify_ciphertext_checksum "$archive" || fail

destination="$(realpath -m -- "$destination" 2>/dev/null)" || fail
[[ "$destination" == "$3" ]] || fail
protected_roots=("${REPO_ROOT:-/opt/learncoding}" "${LEARN_DATA_ROOT:-/srv/learncoding}")
[[ -z "${BACKUP_ROOT:-}" ]] || protected_roots+=("$BACKUP_ROOT")
[[ -z "${EMERGENCY_BACKUP_ROOT:-}" ]] || protected_roots+=("$EMERGENCY_BACKUP_ROOT")
for protected in "${protected_roots[@]}"; do
  [[ "$protected" == /* ]] || fail
  if path_is_within "$destination" "$protected" || path_is_within "$protected" "$destination"; then
    fail
  fi
done

created=0
verified=0
plain=""
destination_identity=""
cleanup() {
  local rc=$? current_identity=""
  trap - EXIT
  if [[ -n "$destination_identity" ]]; then
    current_identity="$(stat -c '%d:%i:%u:%a' -- "$destination" 2>/dev/null || true)"
  fi
  if ((verified == 0)); then
    if [[ -n "$destination_identity" && "$current_identity" == "$destination_identity" \
      && -d "$destination" && ! -L "$destination" ]]; then
      find -P "$destination" -mindepth 1 -delete 2>/dev/null || rc=1
      if ((created)); then
        rmdir -- "$destination" 2>/dev/null || rc=1
      fi
    elif [[ -n "$destination_identity" ]]; then
      rc=1
    fi
    exit 1
  fi
  [[ -z "$plain" || ! -e "$plain" ]] || {
    rm -f -- "$plain" 2>/dev/null || rc=1
  }
  exit "$rc"
}
trap cleanup EXIT

if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -d "$destination" && ! -L "$destination" \
    && "$(stat -c '%a' -- "$destination")" == 700 \
    && "$(stat -c '%u' -- "$destination")" == "$(id -u)" \
    && -z "$(find -P "$destination" -mindepth 1 -print -quit)" ]] || fail
else
  mkdir -m 0700 -- "$destination" || fail
  created=1
fi
destination_identity="$(stat -c '%d:%i:%u:%a' -- "$destination")" || fail
plain="$destination/.recovery-kit.tar.tmp"

age --decrypt --identity "$identity" --output "$plain" "$archive" >/dev/null 2>&1 || fail
[[ -f "$plain" && ! -L "$plain" && -s "$plain" ]] || fail
chmod 0600 -- "$plain" || fail

mapfile -t names < <(tar --list --file "$plain" --absolute-names --quoting-style=escape 2>/dev/null) || fail
mapfile -t verbose < <(tar --list --verbose --file "$plain" --absolute-names --quoting-style=escape 2>/dev/null) || fail
expected=(MANIFEST.txt RECOVERY.md SHA256SUMS backup-age-identity.txt credential_master_key)
((${#names[@]} == 5 && ${#verbose[@]} == 5)) || fail
declare -A seen=()
for index in "${!names[@]}"; do
  name="${names[$index]}"
  [[ "$name" =~ ^(credential_master_key|backup-age-identity\.txt|RECOVERY\.md|MANIFEST\.txt|SHA256SUMS)$ \
    && -z "${seen[$name]+x}" && "${verbose[$index]:0:1}" == - ]] || fail
  seen[$name]=1
done
for name in "${expected[@]}"; do
  [[ -n "${seen[$name]+x}" ]] || fail
done

tar --extract --file "$plain" --directory "$destination" \
  --no-same-owner --no-same-permissions --keep-old-files >/dev/null 2>&1 || fail
rm -f -- "$plain" || fail
plain=""
mapfile -t extracted < <(find -P "$destination" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[[ "${extracted[*]}" == 'MANIFEST.txt RECOVERY.md SHA256SUMS backup-age-identity.txt credential_master_key' ]] || fail
for name in "${expected[@]}"; do
  [[ -f "$destination/$name" && ! -L "$destination/$name" ]] || fail
  chmod 0600 -- "$destination/$name" || fail
done

mapfile -t checksum_lines <"$destination/SHA256SUMS" || fail
((${#checksum_lines[@]} == 4)) || fail
declare -A checksum_seen=()
for line in "${checksum_lines[@]}"; do
  [[ "$line" =~ ^[0-9a-f]{64}[[:space:]][[:space:]](credential_master_key|backup-age-identity\.txt|RECOVERY\.md|MANIFEST\.txt)$ ]] || fail
  checksum_name="${BASH_REMATCH[1]}"
  [[ -z "${checksum_seen[$checksum_name]+x}" ]] || fail
  checksum_seen[$checksum_name]=1
done
for name in credential_master_key backup-age-identity.txt RECOVERY.md MANIFEST.txt; do
  [[ -n "${checksum_seen[$name]+x}" ]] || fail
done
(cd "$destination" && sha256sum --check --strict --quiet SHA256SUMS) || fail

credential_value="$(tr -d '\r\n' <"$destination/credential_master_key")"
[[ "$credential_value" =~ ^[A-Za-z0-9+/]{43}=$ \
  && "$(printf '%s' "$credential_value" | base64 --decode 2>/dev/null | wc -c)" -eq 32 ]] || fail
unset credential_value

secret_lines="$(grep -Ec '^AGE-SECRET-KEY-1[A-Z0-9]+$' "$destination/backup-age-identity.txt" || true)"
[[ "$secret_lines" -eq 1 ]] || fail
if grep -Evq '^(#.*|[[:space:]]*|AGE-SECRET-KEY-1[A-Z0-9]+)$' "$destination/backup-age-identity.txt"; then
  fail
fi
age-keygen -y "$destination/backup-age-identity.txt" >/dev/null 2>&1 || fail

mapfile -t manifest <"$destination/MANIFEST.txt" || fail
((${#manifest[@]} == 6)) || fail
[[ "${manifest[0]}" == format=learncoding-recovery-kit-v1 \
  && "${manifest[1]}" =~ ^created_utc=[0-9]{8}T[0-9]{6}Z$ \
  && "${manifest[2]}" =~ ^source_host=[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ \
  && "${manifest[3]}" =~ ^git_commit=([0-9a-f]{40}|[0-9a-f]{64})$ \
  && "${manifest[4]}" == contains_access_tokens=false \
  && "${manifest[5]}" == inventory=credential_master_key,backup-age-identity.txt,RECOVERY.md,MANIFEST.txt,SHA256SUMS ]] || fail

LC_ALL=C grep -q '[^ -~]' "$destination/RECOVERY.md" && fail
grep -Eq 'AGE-SECRET-KEY-|(^|[^A-Za-z])(nvapi-|sk-ant-|sk-proj-)' "$destination/RECOVERY.md" && fail

verified=1
printf 'recovery_kit_valid=true\n'
