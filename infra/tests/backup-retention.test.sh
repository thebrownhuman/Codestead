#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prune="$repo_root/scripts/backup/prune.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

backup_root="$work/backups"
full="$backup_root/full"
mkdir -p "$full"
printf '%s\n' LEARNCODING_BACKUP_V1 >"$backup_root/.learncoding-backup-root"
chmod 0600 "$backup_root/.learncoding-backup-root"

config="$work/backup.env"
cat >"$config" <<EOF
BACKUP_ROOT=$backup_root
BACKUP_LOCK_FILE=$work/backup.lock
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
EOF
chmod 0600 "$config"

for ((offset = 0; offset < 20; offset++)); do
  stamp="$(date -u -d "2026-07-20 -$offset days" +%Y%m%dT120000Z)"
  name="learncoding-full-$stamp.tar.gz.age"
  printf 'archive-%s' "$stamp" >"$full/$name"
  (cd "$full" && sha256sum "$name" >"$name.sha256")
done

corrupt="learncoding-full-20260601T120000Z.tar.gz.age"
printf corrupt >"$full/$corrupt"
printf '%064d  %s\n' 0 "$corrupt" >"$full/$corrupt.sha256"

count_archives() {
  find "$full" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' '
}

[[ "$(count_archives)" == "21" ]]
BACKUP_CONFIG_FILE="$config" BACKUP_PRUNE_DRY_RUN=1 bash "$prune" >/dev/null
[[ "$(count_archives)" == "21" ]]

BACKUP_CONFIG_FILE="$config" bash "$prune" >/dev/null
[[ "$(count_archives)" == "10" ]]

for ((offset = 0; offset < 7; offset++)); do
  stamp="$(date -u -d "2026-07-20 -$offset days" +%Y%m%dT120000Z)"
  [[ -f "$full/learncoding-full-$stamp.tar.gz.age" ]]
done
[[ -f "$full/$corrupt" && -f "$full/$corrupt.sha256" ]]
[[ ! -e "$full/learncoding-full-20260701T120000Z.tar.gz.age" ]]
[[ ! -e "$full/learncoding-full-20260701T120000Z.tar.gz.age.sha256" ]]

echo "backup-retention-tests-ok"
