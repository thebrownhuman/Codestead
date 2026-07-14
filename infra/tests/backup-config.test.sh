#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common="$repo_root/scripts/backup/common.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

expect_config_failure() {
  local config="$1"
  if BACKUP_CONFIG_FILE="$config" bash -Eeuo pipefail -c \
    'source "$1"; load_backup_config' _ "$common" >/dev/null 2>&1; then
    echo "invalid backup config was accepted: $config" >&2
    exit 1
  fi
}

touch "$work/default.env"
chmod 0600 "$work/default.env"
BACKUP_CONFIG_FILE="$work/default.env"
# shellcheck source=../../scripts/backup/common.sh
source "$common"
load_backup_config
[[ "$FILESYSTEM_WARN_PERCENT" == "70" ]]
[[ "$FILESYSTEM_CRITICAL_PERCENT" == "85" ]]

if grep -E 'df .*-[^ ]*P[^ ]* .*--output|df .* -P .*--output' \
  "$repo_root/scripts/backup/init-backup-target.sh" \
  "$repo_root/scripts/backup/check-backups.sh"; then
  echo "GNU df rejects combining -P with --output" >&2
  exit 1
fi

printf '%s\n' 'FILESYSTEM_WARN_PERCENT=90' 'FILESYSTEM_CRITICAL_PERCENT=85' > "$work/invalid.env"
chmod 0600 "$work/invalid.env"
expect_config_failure "$work/invalid.env"

for values in \
  $'FILESYSTEM_WARN_PERCENT=0\nFILESYSTEM_CRITICAL_PERCENT=85' \
  $'FILESYSTEM_WARN_PERCENT=70\nFILESYSTEM_CRITICAL_PERCENT=100' \
  $'FILESYSTEM_WARN_PERCENT=seventy\nFILESYSTEM_CRITICAL_PERCENT=85'; do
  printf '%s\n' "$values" >"$work/invalid.env"
  chmod 0600 "$work/invalid.env"
  expect_config_failure "$work/invalid.env"
done

touch "$work/writable.env"
chmod 0666 "$work/writable.env"
expect_config_failure "$work/writable.env"

if [[ "$(id -u)" == "0" ]] && id nobody >/dev/null 2>&1; then
  touch "$work/other-owner.env"
  chmod 0600 "$work/other-owner.env"
  chown nobody "$work/other-owner.env"
  expect_config_failure "$work/other-owner.env"
fi

full_root="$work/full-root"
mkdir -p "$full_root"
printf '%s\n' "$FULL_BACKUP_MAGIC" >"$full_root/.learncoding-backup-root"
chmod 0600 "$full_root/.learncoding-backup-root"
[[ "$(validated_root "$full_root" "$FULL_BACKUP_MAGIC")" == "$(realpath -e "$full_root")" ]]

chmod 0666 "$full_root/.learncoding-backup-root"
if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
  echo "world-writable backup marker was accepted" >&2
  exit 1
fi
chmod 0600 "$full_root/.learncoding-backup-root"
printf '%s\n' WRONG_MARKER >"$full_root/.learncoding-backup-root"
if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
  echo "wrong backup marker was accepted" >&2
  exit 1
fi
if [[ "$(id -u)" == "0" ]] && id nobody >/dev/null 2>&1; then
  printf '%s\n' "$FULL_BACKUP_MAGIC" >"$full_root/.learncoding-backup-root"
  chown nobody "$full_root/.learncoding-backup-root"
  if bash -Eeuo pipefail -c 'source "$1"; validated_root "$2" "$3"' _ "$common" "$full_root" "$FULL_BACKUP_MAGIC" >/dev/null 2>&1; then
    echo "backup marker owned by another account was accepted" >&2
    exit 1
  fi
fi

archive="$work/archive.age"
printf '%s' ciphertext >"$archive"
(cd "$work" && sha256sum "$(basename "$archive")" >"$(basename "$archive").sha256")
verify_ciphertext_checksum "$archive"
printf '%s' tampered >>"$archive"
if verify_ciphertext_checksum "$archive"; then
  echo "tampered archive passed checksum verification" >&2
  exit 1
fi
printf '%s' ciphertext >"$archive"
(cd "$work" && sha256sum "$(basename "$archive")" >"$(basename "$archive").sha256")
printf '%s\n' 'unexpected second line' >>"${archive}.sha256"
if verify_ciphertext_checksum "$archive"; then
  echo "multi-line checksum manifest was accepted" >&2
  exit 1
fi

compose_calls="$work/compose-calls"
compose_sql="$work/compose-sql"
compose_result=queued
compose_cmd() {
  printf '%s\n' "$@" >>"$compose_calls"
  cat >"$compose_sql"
  printf '%s\n' "$compose_result"
}

enqueue_backup_status success 20260712T120000Z
grep -Fq "template_version" "$compose_sql"
grep -Fq "'backup-status'" "$compose_sql"
grep -Fq "BACKUP_REPORT_OUTCOME=success" "$compose_calls"
grep -Fq "No archive is attached" "$compose_sql"
if grep -Eqi 'learncoding-full-|\.tar\.gz|AGE-SECRET-KEY|database\.dump' "$compose_calls" "$compose_sql"; then
  echo "backup status report exposed an archive, dump, or encryption identity" >&2
  exit 1
fi

compose_result=existing
enqueue_backup_status failure 20260712T120000Z
grep -Fq "BACKUP_REPORT_OUTCOME=failure" "$compose_calls"
grep -Fq "no archive or log is attached" "$compose_sql"

compose_result=no-admin
if enqueue_backup_status success 20260712T120001Z >/dev/null 2>&1; then
  echo "missing administrator was treated as a queued backup report" >&2
  exit 1
fi
if enqueue_backup_status invalid 20260712T120002Z >/dev/null 2>&1; then
  echo "invalid backup report outcome was accepted" >&2
  exit 1
fi
if enqueue_backup_status success ../unsafe >/dev/null 2>&1; then
  echo "invalid backup report idempotency seed was accepted" >&2
  exit 1
fi

grep -Fq 'enqueue_backup_status failure "$timestamp"' "$repo_root/scripts/backup/backup.sh"
grep -Fq 'enqueue_backup_status success "$timestamp"' "$repo_root/scripts/backup/backup.sh"

echo "backup-config-tests-ok"
