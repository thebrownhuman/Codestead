#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || fail 'guarded-start tests require Linux root'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
subject="$repo_root/infra/ops/start-production-stack.sh"
[[ -f "$subject" ]] || fail 'start-production-stack.sh is missing'

work="$(mktemp -d /tmp/codestead-ingress-start.XXXXXX)"
cleanup() { [[ "$work" == /tmp/codestead-ingress-start.* ]] && rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM
chmod 0700 "$work"
mkdir -m 0700 "$work/core-bin" "$work/runtime-bin" "$work/repo" "$work/repo/infra" "$work/repo/infra/ops" "$work/config" "$work/run"
: >"$work/run/codestead-release.lock"
chmod 0600 "$work/run/codestead-release.lock"
touch "$work/repo/compose.yaml" "$work/config/compose.env" "$work/trace" "$work/tunnels"
chmod 0644 "$work/repo/compose.yaml"
chmod 0640 "$work/config/compose.env"
printf '%s\n' '1000.00 0.00' >"$work/monotonic"
chmod 0600 "$work/monotonic"

cp "$repo_root/infra/ops/ingress-control.py" "$work/repo/infra/ops/ingress-control.py"
chmod 0644 "$work/repo/infra/ops/ingress-control.py"

cat >"$work/repo/infra/ops/validate-runtime.sh" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
if [[ "${1:-}" == --pre-privileged ]]; then
  printf '%s\n' validate:pre-privileged >>"$FAKE_TRACE"
  [[ "${FAKE_FAIL_STAGE:-}" != pre-validate ]]
elif [[ "$#" == 0 ]]; then
  printf '%s\n' validate:full >>"$FAKE_TRACE"
  [[ "${FAKE_FAIL_STAGE:-}" != full-validate ]]
else
  exit 64
fi
EOF

cat >"$work/repo/infra/ops/prepare-postgres-control-socket.sh" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf '%s\n' prepare:postgres >>"$FAKE_TRACE"
[[ "${FAKE_FAIL_STAGE:-}" != postgres-prepare ]]
EOF

cat >"$work/repo/infra/ops/prepare-object-storage.mjs" <<'EOF'
// The harness node wrapper records this invocation without executing JavaScript.
EOF

cat >"$work/repo/infra/ops/smoke-production.sh" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
[[ "${1:-}" == --phase && ( "${2:-}" == internal || "${2:-}" == public ) && "${3:-}" == --startup-wait && "${4:-}" =~ ^[1-9][0-9]*$ && "$#" == 4 ]] || exit 64
printf 'smoke:%s\n' "$2" >>"$FAKE_TRACE"
[[ "${FAKE_FAIL_STAGE:-}" != "$2-smoke" ]]
EOF
chmod 0755 "$work/repo/infra/ops/validate-runtime.sh" "$work/repo/infra/ops/prepare-postgres-control-socket.sh" "$work/repo/infra/ops/smoke-production.sh"
chmod 0644 "$work/repo/infra/ops/prepare-object-storage.mjs"

cat >"$work/core-bin/date" <<'EOF'
#!/usr/bin/bash
[[ "$#" == 1 && "$1" == +%s ]] || exit 64
printf '%s\n' 100
EOF

cat >"$work/core-bin/flock" <<'EOF'
#!/usr/bin/bash
set +e
/usr/bin/flock "$@"
result=$?
set -e
if (( result == 0 )); then printf '%s\n' flock:acquired >>"$FAKE_TRACE"; fi
exit "$result"
EOF

cat >"$work/core-bin/timeout" <<'EOF'
#!/usr/bin/bash
[[ "${1:-}" == --signal=KILL && "${2:-}" =~ ^[1-9][0-9]*s$ && "$#" -ge 3 ]] || exit 64
shift 2
exec "$@"
EOF

cat >"$work/runtime-bin/node" <<'EOF'
#!/usr/bin/bash
[[ "$#" == 1 && "$1" == "$FAKE_REPO/infra/ops/prepare-object-storage.mjs" ]] || exit 64
printf '%s\n' prepare:objects >>"$FAKE_TRACE"
[[ "${FAKE_FAIL_STAGE:-}" != object-prepare ]]
EOF

cat >"$work/runtime-bin/python3.12" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
[[ "$1" == "$FAKE_REPO/infra/ops/ingress-control.py" && "$2" == --test-harness-root && "$3" == "$FAKE_ROOT" ]] || exit 64
[[ "$4" != status ]] || printf '%s\n' control:status >>"$FAKE_TRACE"
exec /usr/bin/python3.12 "$@"
EOF

cat >"$work/core-bin/docker" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
if [[ "${1:-}" == ps && "$#" == 7 && "$2" == --quiet && "$3" == --no-trunc && "$4" == --filter && "$5" == label=com.docker.compose.project=learncoding && "$6" == --filter && "$7" == label=com.docker.compose.service=cloudflared ]]; then
  cat "$FAKE_TUNNELS"
  exit 0
fi
if [[ "${1:-}" == stop && "${2:-}" == --time && "${3:-}" == 10 && "$#" -ge 4 ]]; then
  printf '%s\n' docker:stop:cloudflared >>"$FAKE_TRACE"
  : >"$FAKE_TUNNELS"
  exit 0
fi
[[ "${1:-}" == compose && "${2:-}" == --env-file && "${3:-}" == "$FAKE_ROOT/config/compose.env" && "${4:-}" == -f && "${5:-}" == "$FAKE_REPO/compose.yaml" ]] || exit 64
shift 5
if [[ "$*" == 'stop --timeout 10 cloudflared' ]]; then
  printf '%s\n' docker:compose-stop:cloudflared >>"$FAKE_TRACE"
  : >"$FAKE_TUNNELS"
  exit 0
fi
if [[ "${1:-}" == up && "${2:-}" == -d && "${3:-}" == --no-build && "${4:-}" == --pull && "${5:-}" == never && "${6:-}" == --no-deps ]]; then
  shift 6
  if [[ "$*" == cloudflared ]]; then
    printf '%s\n' docker:up:cloudflared:no-deps >>"$FAKE_TRACE"
    printf '%s\n' ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff >"$FAKE_TUNNELS"
    [[ "${FAKE_FAIL_STAGE:-}" != tunnel-start ]]
    exit
  fi
  printf 'docker:up:internal:%s\n' "$*" >>"$FAKE_TRACE"
  [[ "${FAKE_FAIL_STAGE:-}" != internal-start ]]
  exit
fi
exit 64
EOF
chmod 0755 "$work/core-bin/date" "$work/core-bin/flock" "$work/core-bin/timeout" "$work/core-bin/docker" "$work/runtime-bin/node" "$work/runtime-bin/python3.12"

export FAKE_ROOT="$work" FAKE_REPO="$work/repo" FAKE_TRACE="$work/trace" FAKE_TUNNELS="$work/tunnels"
old_tunnel=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

run_subject() {
  : >"$work/trace"
  printf '%s\n' "$old_tunnel" >"$work/tunnels"
  set +e
  FAKE_FAIL_STAGE="${1:-}" UPLOADS_ENABLED="${2:-false}" \
    "$subject" --test-harness-root "$work" --startup-wait 60 >"$work/stdout" 2>"$work/stderr"
  result=$?
  set -e
}

assert_line() { grep -Fxq -- "$1" "$work/trace" || fail "missing trace: $1"; }
assert_last() { [[ "$(tail -n 1 "$work/trace")" == "$1" ]] || fail "last trace is not $1"; }

internal='postgres app runner-egress-gateway mail-worker reward-worker regrade-worker exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker file-erasure-worker'
run_subject
(( result == 0 )) || fail "canonical start failed: $(<"$work/stderr")"
expected="$(printf '%s\n' flock:acquired docker:stop:cloudflared docker:compose-stop:cloudflared control:status validate:pre-privileged prepare:objects prepare:postgres validate:full "docker:up:internal:$internal" smoke:internal control:status docker:up:cloudflared:no-deps smoke:public)"
[[ "$(<"$work/trace")" == "$expected" ]] || fail 'canonical guarded-start order drifted'

for stage in pre-validate object-prepare postgres-prepare full-validate internal-start internal-smoke tunnel-start public-smoke; do
  run_subject "$stage"
  (( result != 0 )) || fail "$stage failure was accepted"
  [[ ! -s "$work/tunnels" ]] || fail "$stage left public ingress running"
  assert_last docker:compose-stop:cloudflared
done

/usr/bin/python3.12 "$work/repo/infra/ops/ingress-control.py" --test-harness-root "$work" quarantine-create
run_subject
(( result != 0 )) || fail 'release quarantine was accepted'
assert_line control:status
[[ ! -s "$work/tunnels" ]] || fail 'release quarantine left ingress running'
/usr/bin/python3.12 "$work/repo/infra/ops/ingress-control.py" --test-harness-root "$work" quarantine-clear

run_subject '' true
(( result == 0 )) || fail 'uploads start failed'
assert_line "docker:up:internal:$internal clamav scan-worker"

printf '%s\n' start-production-stack-tests-ok
