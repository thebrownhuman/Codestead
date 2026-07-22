#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || fail 'ingress-control authority tests require Linux'
(( EUID == 0 )) || fail 'ingress-control authority tests require root; invoke with sudo -n'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
python_bin=/usr/bin/python3.12
[[ -x "$python_bin" && ! -L "$python_bin" ]] || fail 'trusted Python is unavailable'

"$python_bin" "$repo_root/infra/tests/ingress-control.test.py" -v
"$python_bin" "$repo_root/infra/tests/ingress-control-cli.test.py" -v

printf '%s\n' 'ingress-control-linux-tests-ok'
