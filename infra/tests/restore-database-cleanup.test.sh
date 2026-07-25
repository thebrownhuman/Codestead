#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
common="$repo_root/scripts/backup/common.sh"

fail() {
  printf 'restore-database-cleanup-test-failed: %s\n' "$*" >&2
  exit 1
}

# shellcheck source=../../scripts/backup/common.sh
source "$common"
declare -F remove_restore_database >/dev/null \
  || fail "verified restore database cleanup helper is missing"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
calls="$work/compose-calls"
mode=absent
presence=""

compose_cmd() {
  printf '%s\n' "$*" >>"$calls"
  if [[ "$*" == *dropdb* ]]; then
    [[ "$mode" != drop-fails ]] || return 73
    return 0
  fi
  if [[ "$*" == *psql* ]]; then
    [[ "$mode" != query-fails ]] || return 74
    printf '%s' "$presence"
    return 0
  fi
  return 75
}

: >"$calls"
if remove_restore_database 'production;drop database postgres'; then
  fail "unsafe restore database name was accepted"
fi
[[ ! -s "$calls" ]] || fail "unsafe name reached Compose"

: >"$calls"
mode=drop-fails
if remove_restore_database learncoding_restore_cleanup; then
  fail "drop failure was reported as cleanup success"
fi
[[ "$(wc -l <"$calls" | tr -d ' ')" == 1 ]] \
  || fail "presence was queried after drop failure"

: >"$calls"
mode=query-fails
if remove_restore_database learncoding_restore_cleanup; then
  fail "unknown post-drop state was reported as cleanup success"
fi

: >"$calls"
mode=present
presence=1
if remove_restore_database learncoding_restore_cleanup; then
  fail "remaining database was reported as removed"
fi

: >"$calls"
mode=absent
presence=""
remove_restore_database learncoding_restore_cleanup \
  || fail "confirmed-absent database was rejected"
grep -Fq 'dropdb ' "$calls" || fail "drop command was not issued"
grep -Fq 'pg_database' "$calls" || fail "absence query was not issued"
