#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
systemd="$repo_root/infra/systemd"

fail() {
  echo "systemd-backup-test-failed: $*" >&2
  exit 1
}

require_exact() {
  local file="$1" line="$2"
  [[ "$(tr -d '\r' <"$file" | grep -Fxc -- "$line")" -eq 1 ]] || fail "$(basename "$file") must contain exactly: $line"
}

for name in \
  learncoding-backup.service learncoding-backup.timer \
  learncoding-backup-check.service learncoding-backup-check.timer \
  learncoding-offsite-sync.service learncoding-offsite-sync.timer \
  learncoding-offsite-retention.service learncoding-offsite-retention.timer \
  learncoding-restore-drill.service \
  learncoding-restore-drill-reminder.service \
  learncoding-restore-drill-reminder.timer; do
  [[ -f "$systemd/$name" ]] || fail "missing $name"
done

require_exact "$systemd/learncoding-backup.timer" 'OnCalendar=*-*-* 02:15:00'
require_exact "$systemd/learncoding-offsite-sync.timer" 'OnCalendar=*-*-* 04:15:00 UTC'
require_exact "$systemd/learncoding-offsite-retention.timer" 'OnCalendar=*-*-* 05:15:00 UTC'
require_exact "$systemd/learncoding-restore-drill-reminder.timer" 'OnCalendar=*-*-* 06:15:00 UTC'
require_exact "$systemd/learncoding-backup-check.timer" 'OnUnitActiveSec=6h'
for timer in "$systemd"/learncoding-{backup,backup-check,offsite-sync,offsite-retention,restore-drill-reminder}.timer; do
  require_exact "$timer" 'Persistent=true'
done

for service in "$systemd"/learncoding-{backup,backup-check,offsite-sync,offsite-retention,restore-drill,restore-drill-reminder}.service; do
  require_exact "$service" 'OnFailure=learncoding-alert@%n.service'
  tr -d '\r' <"$service" | grep -Eq '^ExecStart=/usr/bin/bash /opt/learncoding/scripts/backup/[a-z-]+\.sh$' \
    || fail "$(basename "$service") does not use an explicit reviewed script path"
  if grep -Eq 'WorkingDirectory=|/bin/sh|-c[[:space:]]' "$service"; then
    fail "$(basename "$service") depends on a working directory or shell command string"
  fi
done

for service in "$systemd"/learncoding-{backup,backup-check}.service; do
  require_exact "$service" 'RequiresMountsFor=/srv/learncoding /mnt/learncoding-backups'
done
for service in "$systemd"/learncoding-{offsite-sync,offsite-retention,restore-drill-reminder}.service; do
  require_exact "$service" 'RequiresMountsFor=/mnt/learncoding-backups'
done
require_exact "$repo_root/infra/env/backup.env.example" 'CHECK_OFFSITE=1'
require_exact "$repo_root/infra/env/backup.env.example" 'MAX_OFFSITE_AGE_HOURS=6'
require_exact "$repo_root/infra/env/backup.env.example" 'MAX_RESTORE_DRILL_AGE_HOURS=2160'
if grep -Eq '^(CHECK_OFFSITE=0|MAX_OFFSITE_AGE_HOURS=36)$' "$repo_root/infra/env/backup.env.example"; then
  fail "production backup defaults permit an unmonitored or stale offsite recovery point"
fi
for service in "$systemd"/learncoding-{offsite-sync,offsite-retention}.service; do
  for directive in \
    NoNewPrivileges=true PrivateDevices=true PrivateTmp=true ProtectClock=true \
    ProtectControlGroups=true ProtectHome=true ProtectHostname=true ProtectKernelLogs=true \
    ProtectKernelModules=true ProtectKernelTunables=true ProtectSystem=full \
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' RestrictNamespaces=true \
    LockPersonality=true MemoryDenyWriteExecute=true SystemCallArchitectures=native \
    UMask=0077 TimeoutStopSec=2m; do
    require_exact "$service" "$directive"
  done
done
require_exact "$systemd/learncoding-offsite-sync.service" 'TimeoutStartSec=4h'
require_exact "$systemd/learncoding-offsite-retention.service" 'TimeoutStartSec=1h'
for directive in \
  NoNewPrivileges=true PrivateDevices=true PrivateTmp=true ProtectClock=true \
  ProtectControlGroups=true ProtectHome=true ProtectHostname=true ProtectKernelLogs=true \
  ProtectKernelModules=true ProtectKernelTunables=true ProtectSystem=full \
  RestrictAddressFamilies=AF_UNIX RestrictNamespaces=true LockPersonality=true \
  MemoryDenyWriteExecute=true SystemCallArchitectures=native UMask=0077 \
  TimeoutStopSec=2m; do
  require_exact "$systemd/learncoding-restore-drill-reminder.service" "$directive"
done
require_exact "$systemd/learncoding-restore-drill-reminder.service" 'TimeoutStartSec=5m'
grep -Fq 'check-restore-drill.sh' "$systemd/learncoding-restore-drill-reminder.service" \
  || fail "restore drill reminder does not use the reviewed read-only checker"

grep -Fq 'offsite-sync.sh' "$systemd/learncoding-offsite-sync.service"
grep -Fq 'prune-offsite.sh' "$systemd/learncoding-offsite-retention.service"
if grep -Eq '(sync|purge|cleanup|delete)[[:space:]]' "$systemd/learncoding-offsite-retention.service"; then
  fail "retention unit contains a broad or permanent-delete command"
fi
[[ ! -e "$systemd/learncoding-restore-drill.timer" ]] \
  || fail "restore drill must remain manual"
if grep -R -Eq 'enable .*learncoding-restore-drill\.(service|timer)([[:space:]]|$)' \
  "$systemd" "$repo_root/infra/ops/install-systemd.sh"; then
  fail "restore drill execution is enabled automatically"
fi

backup_runbook="$repo_root/docs/runbooks/backup-and-restore.md"
BACKUP_RUNBOOK="$backup_runbook" python3 - <<'PY' \
  || fail 'backup runbook must preserve the exact fail-safe fstab transaction and reject contract mutations'
import os
from pathlib import Path

runbook = Path(os.environ["BACKUP_RUNBOOK"]).read_text(encoding="utf-8")
canonical_append = "printf 'UUID=%s /mnt/learncoding-backups ext4 rw,nodev,nosuid,noexec,nofail,x-systemd.automount,x-systemd.device-timeout=10s 0 2\\n' \"$backup_uuid\" " + "\\"
procedure = "\n".join(
    (
        "set -Eeuo pipefail",
        "sudo lsblk --fs --output NAME,SIZE,FSTYPE,UUID,MOUNTPOINTS",
        "backup_uuid='REPLACE_WITH_THE_2TB_EXT4_UUID'",
        '[[ "$backup_uuid" =~ ^[0-9A-Fa-f-]{8,}$ ]]',
        'backup_device="/dev/disk/by-uuid/$backup_uuid"',
        'sudo test -b "$backup_device"',
        '[[ "$(lsblk -dnro FSTYPE "$backup_device")" == ext4 ]]',
        "if sudo grep -nE '[[:space:]]/mnt/learncoding-backups[[:space:]]' /etc/fstab; then",
        "  echo 'An /mnt/learncoding-backups entry already exists; stop and reconcile it.' >&2",
        "  exit 1",
        "fi",
        "sudo install -d -o root -g root -m 0755 /mnt/learncoding-backups",
        "sudo install -o root -g root -m 0600 /etc/fstab /etc/fstab.codestead-before-backup-disk",
        canonical_append,
        "  | sudo tee -a /etc/fstab >/dev/null",
        "if ! sudo findmnt --verify --verbose; then",
        "  sudo install -o root -g root -m 0644 \\",
        "    /etc/fstab.codestead-before-backup-disk /etc/fstab",
        "  sudo systemctl daemon-reload",
        "  exit 1",
        "fi",
        "sudo systemctl daemon-reload",
        'sudo systemctl start "$(systemd-escape --path --suffix=automount /mnt/learncoding-backups)"',
        "sudo stat /mnt/learncoding-backups >/dev/null",
        "findmnt --target /mnt/learncoding-backups --output SOURCE,FSTYPE,OPTIONS",
    )
)

def valid(value: str) -> bool:
    return value.count(procedure) == 1

if not valid(runbook):
    raise SystemExit("canonical fail-closed backup mount procedure is absent, duplicated, or reordered")
mutations = (
    (
        "x-systemd.device-timeout=10s",
        "x-systemd.device-timeout=90s",
        "device timeout mutation",
    ),
    (
        "if ! sudo findmnt --verify --verbose; then",
        "if sudo findmnt --verify --verbose; then",
        "fstab verification removal",
    ),
    (
        "  sudo install -o root -g root -m 0644 \\",
        "  sudo true # skipped fstab rollback",
        "fstab rollback removal",
    ),
    (
        "  exit 1\nfi\nsudo systemctl daemon-reload",
        "  true # continued after invalid fstab\nfi\nsudo systemctl daemon-reload",
        "fail-closed exit removal",
    ),
)
for old, new, label in mutations:
    if old not in runbook:
        raise SystemExit(f"mutation fixture is absent: {label}")
    if valid(runbook.replace(old, new, 1)):
        raise SystemExit(f"validator accepted {label}")
PY

echo systemd-backup-tests-ok
