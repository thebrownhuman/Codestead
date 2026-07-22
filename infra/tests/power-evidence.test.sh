#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

(( EUID == 0 )) || fail 'power evidence behavior requires Linux root'
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
readonly python=/usr/bin/python3
readonly bash=/usr/bin/bash

[[ -x "$python" && -x "$bash" ]] || fail 'fixed Python and Bash runtimes are required'

for test_file in \
  recovery-evidence-helper.test.py \
  recovery-evidence-provenance.test.py \
  recovery-evidence-storage-health.test.py \
  recovery-evidence-atomic.test.py \
  recovery-evidence-collection.test.py; do
  "$python" "$repo_root/infra/tests/$test_file"
done

for test_file in \
  recovery-evidence-entry.test.sh \
  recovery-evidence-main.test.sh; do
  "$bash" "$repo_root/infra/tests/$test_file"
done

printf '%s\n' 'power-evidence-tests-ok'