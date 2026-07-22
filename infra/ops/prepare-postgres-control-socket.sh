#!/usr/bin/env bash
set -Eeuo pipefail

readonly socket_root="/run/learncoding-postgres"
readonly expected_uid="${POSTGRES_UID:?POSTGRES_UID is required}"
readonly expected_gid="${POSTGRES_GID:?POSTGRES_GID is required}"
readonly data_root="${LEARN_DATA_ROOT:-/srv/learncoding}"
readonly pgdata="$data_root/postgres"
readonly trusted_realpath_bin="/usr/bin/realpath"
readonly trusted_findmnt_bin="/usr/bin/findmnt"

fatal() {
  printf '%s\n' 'PostgreSQL control socket preparation failed.' >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fatal
[[ "$expected_uid" =~ ^[1-9][0-9]*$ && "$expected_gid" =~ ^[1-9][0-9]*$ ]] || fatal
[[ "$data_root" == /* && "$data_root" != / && "$data_root" != */ && "$data_root" != *[[:space:]]* ]] || fatal
[[ -x "$trusted_realpath_bin" && ! -L "$trusted_realpath_bin" ]] || fatal
[[ -x "$trusted_findmnt_bin" && ! -L "$trusted_findmnt_bin" ]] || fatal
[[ -d /run && ! -L /run ]] || fatal
[[ "$(stat -Lc '%u:%g:%a' -- /run)" == '0:0:755' ]] || fatal

reject_symlink_components() {
  local path="$1" component current=""
  local -a components=()
  IFS='/' read -r -a components <<<"$path"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    [[ "$component" != . && "$component" != .. ]] || fatal
    current="$current/$component"
    [[ ! -L "$current" ]] || fatal
  done
}

prepare_directory() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || fatal
  else
    mkdir -- "$path" || fatal
    chown -- "$expected_uid:$expected_gid" "$path" || fatal
    chmod 0700 -- "$path" || fatal
  fi
  [[ "$(stat -Lc '%u:%g:%a' -- "$path")" == "${expected_uid}:${expected_gid}:700" ]] || fatal
}

reject_symlink_components "$data_root"
[[ -d "$data_root" && ! -L "$data_root" ]] || fatal
canonical_data_root="$("$trusted_realpath_bin" --canonicalize-existing --no-symlinks -- "$data_root")" || fatal
readonly canonical_data_root
[[ "$canonical_data_root" == "$data_root" ]] || fatal
reject_symlink_components "$pgdata"

if [[ ! -e "$pgdata" && ! -L "$pgdata" ]]; then
  old_umask="$(umask)"
  umask 077
  prepare_directory "$pgdata"
  umask "$old_umask"
fi
prepare_directory "$pgdata"

# PGDATA is one reviewed filesystem tree. Nested mounts, symlinks, owner drift,
# and group/world permissions fail before Docker is allowed to start it.
pgdata_mount_target="$("$trusted_findmnt_bin" --raw --noheadings --output TARGET --target "$pgdata")" || fatal
[[ -n "$pgdata_mount_target" ]] || fatal
all_mount_targets="$("$trusted_findmnt_bin" --raw --noheadings --output TARGET)" || fatal
while IFS= read -r mount_target; do
  [[ -n "$mount_target" ]] || continue
  case "$mount_target" in
    "$pgdata"/*) fatal ;;
  esac
done <<<"$all_mount_targets"
unset all_mount_targets mount_target pgdata_mount_target
unsafe_entry="$(
  find -P "$pgdata" -xdev -mindepth 1 \
    \( -type l -o ! -uid "$expected_uid" -o ! -gid "$expected_gid" -o -perm /077 \) \
    -print -quit
)"
[[ -z "$unsafe_entry" ]] || fatal

if [[ ! -e "$socket_root" && ! -L "$socket_root" ]]; then
  old_umask="$(umask)"
  umask 077
  prepare_directory "$socket_root"
  umask "$old_umask"
fi
prepare_directory "$socket_root"
socket_identity="$(stat -Lc '%u:%g:%a:%h' -- "$socket_root")" || fatal
[[ "$socket_identity" == "${expected_uid}:${expected_gid}:700:2" ]] || fatal
