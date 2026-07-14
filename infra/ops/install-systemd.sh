#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }
repo_root="${REPO_ROOT:-/opt/learncoding}"
[[ -f "$repo_root/compose.yaml" ]] || { echo "repository not found at $repo_root" >&2; exit 1; }

for unit in "$repo_root"/infra/systemd/*; do
  install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename -- "$unit")"
done
systemctl daemon-reload

if [[ "${1:-}" == "--enable" ]]; then
  systemctl enable --now learncoding-compose.service
  systemctl enable --now learncoding-backup.timer learncoding-backup-check.timer learncoding-retention.timer
fi

echo "systemd units installed; restore drills remain manual by design"
