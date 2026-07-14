#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config
require_command flock
require_command rclone

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE must be a dedicated Google Drive backup path}"
: "${RCLONE_CONFIG:?RCLONE_CONFIG must name a root-owned rclone config file}"
[[ "$RCLONE_REMOTE" == *:* ]] || die "RCLONE_REMOTE must include an rclone remote name"
[[ -f "$RCLONE_CONFIG" && -r "$RCLONE_CONFIG" ]] || die "rclone config is missing"
backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
acquire_backup_lock

latest="$(find "$backup_root/full" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' -printf '%f\n' | sort -r | head -n 1)"
[[ -n "$latest" ]] || die "there is no local backup to sync"
verify_ciphertext_checksum "$backup_root/full/$latest" || die "latest encrypted archive failed checksum validation"

log "syncing encrypted archives and checksums to the configured offsite target"
rclone sync "$backup_root/full" "$RCLONE_REMOTE" \
  --config "$RCLONE_CONFIG" \
  --include 'learncoding-full-*.tar.gz.age' \
  --include 'learncoding-full-*.tar.gz.age.sha256' \
  --exclude '*' \
  --checksum \
  --create-empty-src-dirs \
  --max-delete "${RCLONE_MAX_DELETE:-20}" \
  --log-level NOTICE
emit_alert info offsite_sync_complete "weekly encrypted backup sync completed"
