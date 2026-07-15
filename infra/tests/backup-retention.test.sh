#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prune="$repo_root/scripts/backup/prune.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
cat >"$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 0755 "$work/bin/flock"
if [[ "${OSTYPE:-}" == msys* ]]; then
  cat >"$work/bin/stat" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${TEST_MARKER_MODE:-}" && "$*" == *"%a"* \
  && "${@: -1}" == */state/local-last-success.env ]]; then
  printf '%s\n' "$TEST_MARKER_MODE"
  exit 0
fi
exec /usr/bin/stat "$@"
EOF
  chmod 0755 "$work/bin/stat"
fi

backup_root="$work/backups"
full="$backup_root/full"
mkdir -p "$full"
chmod 0700 "$full"
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
  archive_hash="$(sha256sum "$full/$name" | awk '{print $1}')"
  printf '%s  %s\n' "$archive_hash" "$name" >"$full/$name.sha256"
done

corrupt="learncoding-full-20260601T120000Z.tar.gz.age"
printf corrupt >"$full/$corrupt"
printf '%064d  %s\n' 0 "$corrupt" >"$full/$corrupt.sha256"

count_archives() {
  find "$full" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' '
}

[[ "$(count_archives)" == "21" ]]

# A newest-looking filename is not a recovery point. Pruning must not delete
# anything until the exact local publication marker has been validated.
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" bash "$prune" >/dev/null 2>&1; then
  echo "retention accepted a missing local success marker" >&2
  exit 1
fi
[[ "$(count_archives)" == "21" ]]

escape_root="$work/escaped-full"
symlink_root="$work/symlink-backups"
mkdir -p "$escape_root" "$symlink_root/state"
chmod 0700 "$symlink_root/state"
printf '%s\n' LEARNCODING_BACKUP_V1 >"$symlink_root/.learncoding-backup-root"
chmod 0600 "$symlink_root/.learncoding-backup-root"
ln -s "$escape_root" "$symlink_root/full"
escape_name=learncoding-full-20260720T010203Z.tar.gz.age
printf escaped >"$escape_root/$escape_name"
escape_hash="$(sha256sum "$escape_root/$escape_name" | awk '{print $1}')"
printf '%s  %s\n' "$escape_hash" "$escape_name" >"$escape_root/$escape_name.sha256"
cat >"$symlink_root/state/local-last-success.env" <<EOF
SUCCESS_ARCHIVE=$escape_name
SUCCESS_COMPLETED_UTC=20260720T010204Z
SUCCESS_SHA256=$escape_hash
EOF
chmod 0600 "$symlink_root/state/local-last-success.env"
cat >"$work/symlink-backup.env" <<EOF
BACKUP_ROOT=$symlink_root
BACKUP_LOCK_FILE=$work/symlink-backup.lock
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
EOF
chmod 0600 "$work/symlink-backup.env"
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$work/symlink-backup.env" \
  BACKUP_PRUNE_DRY_RUN=1 bash "$prune" >/dev/null 2>&1; then
  echo "retention accepted a symlinked full backup directory" >&2
  exit 1
fi
[[ -f "$escape_root/$escape_name" && -f "$escape_root/$escape_name.sha256" ]]

state="$backup_root/state"
mkdir -p "$state"
chmod 0700 "$state"
marked="learncoding-full-20260720T120000Z.tar.gz.age"
marked_hash="$(sha256sum "$full/$marked" | awk '{print $1}')"
cat >"$state/local-last-success.env" <<EOF
SUCCESS_ARCHIVE=$marked
SUCCESS_COMPLETED_UTC=20260720T120001Z
SUCCESS_SHA256=$marked_hash
EOF
chmod 0600 "$state/local-last-success.env"

valid_marker="$work/valid-marker"
cp "$state/local-last-success.env" "$valid_marker"

assert_prune_refuses_marker() {
  local label="$1" marker_mode=""
  [[ "$label" != wrong-mode ]] || marker_mode=640
  if PATH="$work/bin:$PATH" TEST_MARKER_MODE="$marker_mode" \
    BACKUP_CONFIG_FILE="$config" bash "$prune" >/dev/null 2>&1; then
    echo "retention accepted $label local success marker" >&2
    exit 1
  fi
  [[ "$(count_archives)" == "21" ]]
}

printf '%s\n' 'SUCCESS_ARCHIVE=not-a-backup' >"$state/local-last-success.env"
chmod 0600 "$state/local-last-success.env"
assert_prune_refuses_marker malformed

cp "$valid_marker" "$state/local-last-success.env"
chmod 0640 "$state/local-last-success.env"
assert_prune_refuses_marker wrong-mode

cp "$valid_marker" "$state/local-last-success.env"
sed -i 's/^SUCCESS_SHA256=.*/SUCCESS_SHA256=0000000000000000000000000000000000000000000000000000000000000000/' \
  "$state/local-last-success.env"
chmod 0600 "$state/local-last-success.env"
assert_prune_refuses_marker hash-mismatched

rm -f "$state/local-last-success.env"
cp "$valid_marker" "$work/symlink-marker-target"
chmod 0600 "$work/symlink-marker-target"
ln -s "$work/symlink-marker-target" "$state/local-last-success.env"
if [[ -L "$state/local-last-success.env" ]]; then
  assert_prune_refuses_marker symlinked
fi
rm -f "$state/local-last-success.env"

# The marked archive is retained even when it is older than every ordinary
# daily/weekly/monthly tier choice.
marked="learncoding-full-20250101T120000Z.tar.gz.age"
printf old-marked-recovery-point >"$full/$marked"
marked_hash="$(sha256sum "$full/$marked" | awk '{print $1}')"
printf '%s  %s\n' "$marked_hash" "$marked" >"$full/$marked.sha256"
cat >"$state/local-last-success.env" <<EOF
SUCCESS_ARCHIVE=$marked
SUCCESS_COMPLETED_UTC=20260720T120001Z
SUCCESS_SHA256=$marked_hash
EOF
chmod 0600 "$state/local-last-success.env"

PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" BACKUP_PRUNE_DRY_RUN=1 bash "$prune" >/dev/null
[[ "$(count_archives)" == "22" ]]

PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" bash "$prune" >/dev/null
[[ "$(count_archives)" == "11" ]]

for ((offset = 0; offset < 7; offset++)); do
  stamp="$(date -u -d "2026-07-20 -$offset days" +%Y%m%dT120000Z)"
  [[ -f "$full/learncoding-full-$stamp.tar.gz.age" ]]
done
[[ -f "$full/$corrupt" && -f "$full/$corrupt.sha256" ]]
[[ -f "$full/$marked" && -f "$full/$marked.sha256" ]]
[[ ! -e "$full/learncoding-full-20260701T120000Z.tar.gz.age" ]]
[[ ! -e "$full/learncoding-full-20260701T120000Z.tar.gz.age.sha256" ]]

echo "backup-retention-tests-ok"
