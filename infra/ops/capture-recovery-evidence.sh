#!/usr/bin/bash -p
set -Eeuo pipefail
umask 077

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$-" == *p* ]] || fail 'invoke recovery evidence through its privileged-mode shebang'
[[ "${EUID:-1}" == 0 && "${UID:-1}" == 0 ]] || fail 'recovery evidence collection requires real root'
case "${1:-}" in
  pre)
    [[ "$#" == 2 ]] || fail 'usage: capture-recovery-evidence.sh pre ABSOLUTE_EVENT_JSON_PATH'
    ;;
  post)
    [[ "$#" == 4 ]] || fail 'usage: capture-recovery-evidence.sh post ABSOLUTE_EVENT_JSON_PATH POWER_RESTORED_UTC PUBLIC_READY_UTC'
    ;;
  *)
    fail 'usage: capture-recovery-evidence.sh pre ABSOLUTE_EVENT_JSON_PATH | post ABSOLUTE_EVENT_JSON_PATH POWER_RESTORED_UTC PUBLIC_READY_UTC'
    ;;
esac

readonly helper=/opt/learncoding/infra/ops/recovery-evidence.py
[[ -f "$helper" && ! -L "$helper" && -x "$helper" ]] || fail 'the fixed recovery-evidence helper is missing or unsafe'
[[ -f /usr/bin/python3.12 && ! -L /usr/bin/python3.12 && -x /usr/bin/python3.12 ]] || fail 'the fixed Python runtime is missing or unsafe'
[[ -f /usr/bin/env && ! -L /usr/bin/env && -x /usr/bin/env ]] || fail 'the fixed environment launcher is missing or unsafe'

exec /usr/bin/env -i \
  HOME=/nonexistent \
  LANG=C \
  LC_ALL=C \
  PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  PYTHONHASHSEED=0 \
  /usr/bin/python3.12 "$helper" "$@"
