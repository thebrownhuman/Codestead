#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

(( EUID == 0 )) || fail 'entry contract requires Linux root'
command -v bwrap >/dev/null || fail 'Bubblewrap is required'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
collector="$repo_root/infra/ops/capture-recovery-evidence.sh"
helper="$repo_root/infra/ops/recovery-evidence.py"
[[ -f "$collector" && -f "$helper" ]] || fail 'production evidence entry assets are missing'

work="$(mktemp -d /tmp/codestead-evidence-entry.XXXXXX)"
cleanup() {
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/codestead-evidence-entry.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM
mkdir -m 0700 "$work/output"

{
  printf '%s\n' '#!/usr/bin/bash' 'set -Eeuo pipefail'
  printf 'printf '\''%%s\\n'\'' "$@" > %q\n' "$work/output/argv"
  printf '/usr/bin/env | /usr/bin/sort > %q\n' "$work/output/environment"
} >"$work/python3"
chmod 0555 "$work/python3"

set +e
/usr/bin/env -i \
  PATH=/attacker/bin \
  HOME=/attacker/home \
  BASH_ENV=/attacker/bash-env \
  ENV=/attacker/env \
  GIT_CONFIG_SYSTEM=/attacker/git-system \
  GIT_CONFIG_GLOBAL=/attacker/git-global \
  DOCKER_CONFIG=/attacker/docker \
  COMPOSE_FILE=/attacker/compose.yaml \
  COMPOSE_PROFILES=attacker \
  CURL_HOME=/attacker/curl \
  http_proxy=http://attacker.invalid \
  HTTPS_PROXY=http://attacker.invalid \
  NO_PROXY=attacker.invalid \
  /usr/bin/bwrap --die-with-parent --new-session --unshare-pid --unshare-net --unshare-ipc --unshare-uts \
    --ro-bind / / --tmpfs /opt \
    --dir /opt/learncoding --dir /opt/learncoding/infra --dir /opt/learncoding/infra/ops \
    --ro-bind "$collector" /opt/learncoding/infra/ops/capture-recovery-evidence.sh \
    --ro-bind "$helper" /opt/learncoding/infra/ops/recovery-evidence.py \
    --ro-bind "$work/python3" /usr/bin/python3.12 \
    --bind "$work/output" "$work/output" \
    --proc /proc --dev /dev --chdir / -- \
    /opt/learncoding/infra/ops/capture-recovery-evidence.sh post \
      /var/lib/learncoding/recovery-evidence/power-20260719.post.json \
      2026-07-19T12:00:00Z \
      2026-07-19T12:10:00Z \
    >"$work/stdout" 2>"$work/stderr"
status=$?
set -e

(( status == 0 )) || fail "production entry rejected the canonical fake helper: $(<"$work/stderr")"
[[ ! -s "$work/stdout" && ! -s "$work/stderr" ]] || fail 'production entry emitted output'
mapfile -t arguments <"$work/output/argv"
[[ "${arguments[*]}" == "/opt/learncoding/infra/ops/recovery-evidence.py post /var/lib/learncoding/recovery-evidence/power-20260719.post.json 2026-07-19T12:00:00Z 2026-07-19T12:10:00Z" ]] ||
  fail 'production entry did not execute the fixed helper with exact post-recovery observations'

for expected in \
  'HOME=/nonexistent' \
  'LANG=C' \
  'LC_ALL=C' \
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin' \
  'PYTHONHASHSEED=0'; do
  grep -Fxq -- "$expected" "$work/output/environment" || fail "sealed environment is missing: $expected"
done
if grep -Eiq 'attacker|BASH_ENV=|ENV=|GIT_CONFIG_|DOCKER_CONFIG=|COMPOSE_|CURL_HOME=|(^|_)(http|https|all)_proxy=|NO_PROXY=' \
  "$work/output/environment"; then
  fail 'production entry forwarded a poisoned shell, Git, Docker, Compose, curl, proxy, or home value'
fi

grep -Fxq '#!/usr/bin/bash -p' "$collector" || fail 'collector does not use a fixed privileged-mode shebang'
grep -Fq '[[ "$-" == *p* ]]' "$collector" || fail 'collector does not assert privileged shell mode'
grep -Fq '[[ "${EUID:-1}" == 0 && "${UID:-1}" == 0 ]]' "$collector" || fail 'collector does not require real root'
! grep -Fq 'RECOVERY_EVIDENCE_TEST_ROOT' "$collector" || fail 'production collector retains a test-root seam'

printf '%s\n' 'recovery-evidence-entry-tests-ok'
