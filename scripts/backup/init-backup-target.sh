#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  echo "usage: $0 (--full PATH | --emergency PATH)" >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
mode="$1"
root="$2"
require_absolute_path "$root"
[[ "$root" != "/" ]] || die "refusing to initialize the root filesystem"
require_command findmnt
require_command df
require_command realpath

case "$mode" in
  --full)
    magic="$FULL_BACKUP_MAGIC"
    minimum_bytes="${MIN_FULL_TARGET_BYTES:-1500000000000}"
    subdirectories=(full restore-reports)
    ;;
  --emergency)
    magic="$EMERGENCY_BACKUP_MAGIC"
    minimum_bytes="${MIN_EMERGENCY_TARGET_BYTES:-28000000000}"
    subdirectories=(emergency)
    ;;
  *) usage ;;
esac

[[ -d "$root" ]] || die "mount the target first; directory does not exist: $root"
root="$(realpath -e -- "$root")"
[[ "$root" != "/" ]] || die "refusing to initialize the root filesystem"

target_source="$(findmnt -n -o SOURCE -T "$root")"
system_source="$(findmnt -n -o SOURCE -T /)"
if [[ "$target_source" == "$system_source" && "${BACKUP_ALLOW_ROOT_FILESYSTEM:-0}" != "1" ]]; then
  die "target is on the operating-system filesystem; mount the dedicated drive first"
fi

available_bytes="$(df -B1 --output=size "$root" | tail -n 1 | tr -d ' ')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || die "could not determine target capacity"
(( available_bytes >= minimum_bytes )) || die "target capacity is below the safety minimum of $minimum_bytes bytes"

marker="$root/.learncoding-backup-root"
if [[ -e "$marker" ]]; then
  [[ "$(<"$marker")" == "$magic" ]] || die "an incompatible backup marker already exists"
else
  printf '%s\n' "$magic" >"$marker"
fi
chmod 0600 "$marker"
for directory in "${subdirectories[@]}"; do
  install -d -m 0700 "$root/$directory"
done
log "initialized $mode backup target at $root"
