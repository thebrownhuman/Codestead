#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }
repo_root="${REPO_ROOT:-/opt/learncoding}"
[[ -f "$repo_root/compose.yaml" ]] || { echo "repository not found at $repo_root" >&2; exit 1; }
"$repo_root/infra/ops/validate-production-load-host-runtime.sh"

for definition in "$repo_root"/infra/sysusers.d/*; do
  install -o root -g root -m 0644 "$definition" "/etc/sysusers.d/$(basename -- "$definition")"
done
systemd-sysusers /etc/sysusers.d/learncoding-production-load.conf

for definition in "$repo_root"/infra/tmpfiles.d/*; do
  install -o root -g root -m 0644 "$definition" "/etc/tmpfiles.d/$(basename -- "$definition")"
done
systemd-tmpfiles --create /etc/tmpfiles.d/learncoding-release-lock.conf
systemd-tmpfiles --create /etc/tmpfiles.d/learncoding-production-load.conf
systemd-tmpfiles --create /etc/tmpfiles.d/learncoding-ingress-control.conf

install -d -o root -g root -m 0755 /etc/learncoding
install -o root -g root -m 0444 "$repo_root/infra/runtime/production-load-network-attestation" /etc/learncoding/production-load-network-attestation

for unit in "$repo_root"/infra/systemd/*; do
  install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename -- "$unit")"
done
systemctl daemon-reload

if [[ "${1:-}" == "--enable" ]]; then
  systemctl enable --now learncoding-runner-firewall.service
  systemctl enable --now learncoding-compose.service
  systemctl enable --now learncoding-recovery-check.timer
  systemctl enable --now learncoding-ingress-recovery.timer
  systemctl enable --now learncoding-backup.timer learncoding-backup-check.timer learncoding-offsite-sync.timer learncoding-offsite-retention.timer learncoding-restore-drill-reminder.timer learncoding-retention.timer
  systemctl enable --now learncoding-production-load-recovery.path
fi

echo "systemd units installed; restore drill execution and production load gates remain manual by design"
