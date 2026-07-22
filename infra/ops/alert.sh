#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

unit="${1:-unknown-unit}"
event="service_failed"
message="systemd unit failed: $unit; inspect local journal logs"
logger -p daemon.err -t learncoding-alert -- "$message"
printf '%s severity=critical event=%s message=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$message" >&2

hook="/etc/learncoding/alert-hook"
if [[ -r /etc/learncoding/backup.env ]]; then
  configured_hook="$(sed -n 's/^ALERT_HOOK=//p' /etc/learncoding/backup.env | tail -n 1)"
  [[ -n "$configured_hook" ]] && hook="$configured_hook"
fi
if [[ -x "$hook" ]]; then
  "$hook" critical "$event" "$message" || logger -p daemon.err -t learncoding-alert -- "alert hook failed"
fi
