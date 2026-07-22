#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || fail 'guarded-start adversarial tests require Linux root'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
subject="$repo_root/infra/ops/start-production-stack.sh"
control_source="$repo_root/infra/ops/ingress-control.py"
[[ -f "$subject" && -f "$control_source" ]] || fail 'guarded-start subjects are missing'

work="$(mktemp -d /tmp/codestead-guarded-start.XXXXXX)"
slow_pid=
cleanup() {
  [[ -z "$slow_pid" ]] || kill "$slow_pid" >/dev/null 2>&1 || true
  [[ "$work" == /tmp/codestead-guarded-start.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM
chmod 0700 "$work"
mkdir -m 0700 \
  "$work/core-bin" "$work/runtime-bin" "$work/config" "$work/run" \
  "$work/repo" "$work/repo/infra" "$work/repo/infra/ops"
: >"$work/run/codestead-release.lock"
chmod 0600 "$work/run/codestead-release.lock"
touch "$work/repo/compose.yaml" "$work/config/compose.env" "$work/trace" "$work/tunnels" "$work/budget-trace"
chmod 0644 "$work/repo/compose.yaml"
chmod 0640 "$work/config/compose.env"
printf '%s\n' '1000.00 0.00' >"$work/monotonic"
chmod 0600 "$work/monotonic"

cp "$control_source" "$work/repo/infra/ops/ingress-control.py"
chmod 0644 "$work/repo/infra/ops/ingress-control.py"

cat >"$work/repo/infra/ops/validate-runtime.sh" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
if [[ "${1:-}" == --pre-privileged && "$#" == 1 ]]; then
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
chmod 0755 \
  "$work/repo/infra/ops/validate-runtime.sh" \
  "$work/repo/infra/ops/prepare-postgres-control-socket.sh" \
  "$work/repo/infra/ops/smoke-production.sh"
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
if (( result == 0 )); then
  if [[ -n "${FAKE_LOCK_SWAP_PATH:-}" ]]; then
    mv -- "$FAKE_LOCK_SWAP_PATH" "$FAKE_LOCK_SWAP_PATH.detached"
    : >"$FAKE_LOCK_SWAP_PATH"
    chmod 0600 "$FAKE_LOCK_SWAP_PATH"
  fi
  printf '%s\n' flock:acquired >>"$FAKE_TRACE"
fi
exit "$result"
EOF

cat >"$work/core-bin/timeout" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
[[ "${1:-}" == --signal=KILL && "${2:-}" =~ ^[1-9][0-9]*s$ && "$#" -ge 3 ]] || exit 64
duration="${2%s}"
shift 2
printf '%s:%s\n' "$duration" "$*" >>"$FAKE_BUDGET_TRACE"
if [[ "${FAKE_FAIL_STAGE:-}" == hold-internal && "$*" == *'--phase internal'* ]]; then
  : >"$FAKE_ROOT/hold-entered"
  while [[ ! -e "$FAKE_ROOT/hold-release" ]]; do /usr/bin/sleep 0.02; done
fi
if [[ ("${FAKE_FAIL_STAGE:-}" == term-during-internal || "${FAKE_FAIL_STAGE:-}" == repeated-signal-cleanup) && "$*" == *'--phase internal'* ]]; then
  kill -TERM "$PPID"
  if [[ "${FAKE_FAIL_STAGE:-}" == repeated-signal-cleanup ]]; then
    : >"$FAKE_ROOT/repeated-signal.triggered"
    printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >"$FAKE_TUNNELS"
  fi
  exit 143
fi
if [[ "${FAKE_FAIL_STAGE:-}" == public-smoke-timeout && "$*" == *'--phase public'* ]]; then
  exit 124
fi
set +e
"$@"
result=$?
set -e
if [[ "${FAKE_CONSUME_TIMEOUTS:-false}" == true ]]; then
  IFS=' ' read -r current idle <"$FAKE_MONOTONIC"
  current="${current%%.*}"
  printf '%s.00 0.00\n' "$((current + duration))" >"$FAKE_MONOTONIC"
fi
exit "$result"
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
if [[ "$4" == status ]]; then
  printf '%s\n' control:status >>"$FAKE_TRACE"
  [[ "${FAKE_FAIL_STAGE:-}" != status-helper ]] || exit 70
fi
exec /usr/bin/python3.12 "$@"
EOF

cat >"$work/core-bin/docker" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail

[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock ]] || exit 65
[[ "${COMPOSE_PROJECT_NAME:-}" == learncoding ]] || exit 65
for forbidden_control in DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG \
  DOCKER_API_VERSION BUILDKIT_HOST COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES; do
  [[ -z "${!forbidden_control+x}" ]] || exit 65
done

if [[ "${1:-}" == ps && "${FAKE_FAIL_STAGE:-}" == invalid-tunnel-output && ! -e "$FAKE_ROOT/invalid-tunnel.failed" ]]; then
  : >"$FAKE_ROOT/invalid-tunnel.failed"
  printf '%s\n' not-a-container-id
  exit 0
fi
if [[ "${1:-}" == ps && "${FAKE_FAIL_STAGE:-}" == duplicate-tunnel-output && ! -e "$FAKE_ROOT/duplicate-tunnel.failed" ]]; then
  : >"$FAKE_ROOT/duplicate-tunnel.failed"
  first="$(sed -n '1p' "$FAKE_TUNNELS")"
  printf '%s\n%s\n' "$first" "$first"
  exit 0
fi

if [[ "${1:-}" == ps ]]; then
  [[ "$#" == 8 && "$2" == --quiet && "$3" == --no-trunc && "$4" == --filter && "$5" == label=com.docker.compose.project=learncoding && "$6" == --filter && "$7" == label=com.docker.compose.service=cloudflared && -z "${8:-}" ]] && exit 64
fi

if [[ "${1:-}" == ps && "$#" == 7 && "$2" == --quiet && "$3" == --no-trunc && "$4" == --filter && "$5" == label=com.docker.compose.project=learncoding && "$6" == --filter && "$7" == label=com.docker.compose.service=cloudflared ]]; then
  if [[ "${FAKE_FAIL_STAGE:-}" == direct-discovery && ! -e "$FAKE_ROOT/direct-discovery.failed" ]]; then
    : >"$FAKE_ROOT/direct-discovery.failed"
    exit 70
  fi
  cat "$FAKE_TUNNELS"
  exit 0
fi

if [[ "${1:-}" == stop && "${2:-}" == --time && "${3:-}" == 10 && "$#" -ge 4 ]]; then
  shift 3
  printf '%s\n' docker:stop:cloudflared >>"$FAKE_TRACE"
  if [[ "${FAKE_FAIL_STAGE:-}" == repeated-signal-cleanup && -e "$FAKE_ROOT/repeated-signal.triggered" && ! -e "$FAKE_ROOT/repeated-signal.failed" ]]; then
    : >"$FAKE_ROOT/repeated-signal.failed"
    timeout_parent="$PPID"
    start_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    start_pid="${start_pid//[[:space:]]/}"
    [[ "$start_pid" =~ ^[1-9][0-9]*$ ]] || exit 71
    /bin/kill -HUP "$start_pid"
    /bin/kill -INT "$start_pid"
    exit 70
  fi
  if [[ "${FAKE_FAIL_STAGE:-}" == direct-stop && ! -e "$FAKE_ROOT/direct-stop.failed" ]]; then
    : >"$FAKE_ROOT/direct-stop.failed"
    exit 70
  fi
  : >"$FAKE_TUNNELS"
  exit 0
fi

[[ "${1:-}" == compose && "${2:-}" == --env-file && "${3:-}" == "$FAKE_ROOT/config/compose.env" && "${4:-}" == -f && "${5:-}" == "$FAKE_REPO/compose.yaml" ]] || exit 64
shift 5
if [[ "$*" == 'stop --timeout 10 cloudflared' ]]; then
  printf '%s\n' docker:compose-stop:cloudflared >>"$FAKE_TRACE"
  [[ "${FAKE_FAIL_STAGE:-}" != compose-stop ]] || exit 70
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
chmod 0755 "$work/core-bin/date" "$work/core-bin/flock" "$work/core-bin/timeout" "$work/core-bin/docker" \
  "$work/runtime-bin/node" "$work/runtime-bin/python3.12"

export FAKE_ROOT="$work" FAKE_REPO="$work/repo" FAKE_TRACE="$work/trace" FAKE_TUNNELS="$work/tunnels"
export FAKE_BUDGET_TRACE="$work/budget-trace" FAKE_MONOTONIC="$work/monotonic"

seed_tunnels() { printf '%s\n' "$@" >"$work/tunnels"; }
clear_tunnels() { : >"$work/tunnels"; }

run_subject() {
  local stage="${1:-}" uploads="${2:-false}" recover="${3:-false}" lock_wait="${4:-1}" consume="${5:-false}"
  : >"$work/trace"
  : >"$work/budget-trace"
  printf '%s\n' '1000.00 0.00' >"$work/monotonic"
  rm -f "$work/direct-discovery.failed" "$work/direct-stop.failed" \
    "$work/invalid-tunnel.failed" "$work/duplicate-tunnel.failed" \
    "$work/repeated-signal.failed" \
    "$work/repeated-signal.triggered"
  local -a args=(--test-harness-root "$work" --startup-wait 2 --lock-timeout "$lock_wait")
  [[ "$recover" == true ]] && args+=(--recover-if-needed)
  set +e
  DOCKER_HOST=tcp://attacker.invalid:2376 DOCKER_CONTEXT=attacker \
    DOCKER_TLS=1 DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=/attacker/certs \
    DOCKER_CONFIG=/attacker/docker-config DOCKER_API_VERSION=0.1 BUILDKIT_HOST=tcp://attacker.invalid:1234 \
    COMPOSE_FILE=/attacker/compose.yaml COMPOSE_ENV_FILES=/attacker/compose.env COMPOSE_PATH_SEPARATOR=: \
    COMPOSE_PROFILES=uploads COMPOSE_PROJECT_NAME=attacker \
    FAKE_FAIL_STAGE="$stage" FAKE_CONSUME_TIMEOUTS="$consume" UPLOADS_ENABLED="$uploads" \
    FAKE_LOCK_SWAP_PATH="${FAKE_LOCK_SWAP_PATH:-}" \
    "$subject" "${args[@]}" >"$work/stdout" 2>"$work/stderr"
  result=$?
  set -e
}

assert_line() { grep -Fxq -- "$1" "$work/trace" || fail "missing trace: $1"; }
assert_no_start() {
  ! grep -Eq '^docker:up:(internal|cloudflared)' "$work/trace" || fail 'a failed start exposed a service'
}
assert_quarantined() { [[ ! -s "$work/tunnels" ]] || fail 'public tunnel remained after failure'; }
assert_starts_with_quarantine() {
  local first second
  first="$(sed -n '1p' "$work/trace")"
  second="$(sed -n '2p' "$work/trace")"
  [[ "$first" == flock:acquired && "$second" == docker:stop:cloudflared ]] || fail "unsafe pre-quarantine trace: $first / $second"
}

readonly old_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly old_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
readonly internal='postgres app runner-egress-gateway mail-worker reward-worker regrade-worker exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker file-erasure-worker'

seed_tunnels "$old_a"
run_subject
(( result == 0 )) || fail "canonical start failed: $(<"$work/stderr")"
expected="$(printf '%s\n' flock:acquired docker:stop:cloudflared docker:compose-stop:cloudflared control:status validate:pre-privileged prepare:objects prepare:postgres validate:full "docker:up:internal:$internal" smoke:internal control:status docker:up:cloudflared:no-deps smoke:public)"
[[ "$(<"$work/trace")" == "$expected" ]] || fail 'canonical guarded-start order drifted'
[[ "$(<"$work/tunnels")" == ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff ]] || fail 'successful start did not retain the new tunnel'

clear_tunnels
run_subject
(( result == 0 )) || fail 'zero-old-tunnel start failed'

seed_tunnels "$old_a" "$old_b"
run_subject
(( result == 0 )) || fail 'multiple-old-tunnel start failed'
[[ "$(grep -Fc docker:stop:cloudflared "$work/trace")" == 1 ]] || fail 'multiple old tunnels were not stopped atomically'

for stage in compose-stop pre-validate object-prepare postgres-prepare full-validate internal-start internal-smoke tunnel-start public-smoke; do
  seed_tunnels "$old_a"
  run_subject "$stage"
  (( result != 0 )) || fail "$stage failure was accepted"
  assert_quarantined
done

seed_tunnels "$old_a"
run_subject direct-discovery
(( result != 0 )) || fail 'direct discovery failure was accepted'
assert_quarantined
assert_no_start

seed_tunnels "$old_a"
run_subject direct-stop
(( result != 0 )) || fail 'direct stop failure was accepted'
(( "$(grep -Fc docker:stop:cloudflared "$work/trace")" >= 2 )) || fail 'cleanup did not retry bounded tunnel quarantine'
assert_quarantined
assert_no_start

for stage in invalid-tunnel-output duplicate-tunnel-output; do
  seed_tunnels "$old_a"
  run_subject "$stage"
  (( result != 0 )) || fail "$stage was accepted"
  assert_quarantined
  assert_no_start
done

seed_tunnels "$old_a"
run_subject public-smoke-timeout
(( result != 0 )) || fail 'public smoke timeout was accepted'
assert_quarantined

seed_tunnels "$old_a"
run_subject term-during-internal
(( result != 0 )) || fail 'TERM during startup was accepted'
assert_quarantined
! grep -Fq docker:up:cloudflared:no-deps "$work/trace" || fail 'TERM during internal startup exposed public ingress'

seed_tunnels "$old_a"
run_subject repeated-signal-cleanup
(( result == 143 )) || fail "repeated cleanup signals changed the first TERM status: $result"
assert_quarantined
(( "$(grep -Fc docker:stop:cloudflared "$work/trace")" >= 3 )) || fail 'repeated signals aborted bounded guarded-start quarantine'

mv "$work/config/compose.env" "$work/config/compose.env.saved"
seed_tunnels "$old_a"
run_subject
mv "$work/config/compose.env.saved" "$work/config/compose.env"
(( result != 0 )) || fail 'missing compose.env was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

mv "$work/repo/infra/ops/validate-runtime.sh" "$work/repo/infra/ops/validate-runtime.sh.saved"
seed_tunnels "$old_a"
run_subject
mv "$work/repo/infra/ops/validate-runtime.sh.saved" "$work/repo/infra/ops/validate-runtime.sh"
(( result != 0 )) || fail 'missing validator was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

chmod 0666 "$work/repo/infra/ops/validate-runtime.sh"
seed_tunnels "$old_a"
run_subject
chmod 0755 "$work/repo/infra/ops/validate-runtime.sh"
(( result != 0 )) || fail 'writable validator was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

chmod 0777 "$work/repo/infra"
seed_tunnels "$old_a"
run_subject
chmod 0700 "$work/repo/infra"
(( result != 0 )) || fail 'writable input ancestor was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

mv "$work/repo/infra/ops/prepare-object-storage.mjs" "$work/object.saved"
ln -s "$work/object.saved" "$work/repo/infra/ops/prepare-object-storage.mjs"
seed_tunnels "$old_a"
run_subject
rm "$work/repo/infra/ops/prepare-object-storage.mjs"
mv "$work/object.saved" "$work/repo/infra/ops/prepare-object-storage.mjs"
(( result != 0 )) || fail 'symlinked object preparer was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

ln "$work/repo/infra/ops/smoke-production.sh" "$work/smoke-hardlink"
seed_tunnels "$old_a"
run_subject
rm "$work/smoke-hardlink"
(( result != 0 )) || fail 'hardlinked smoke script was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

ln "$work/runtime-bin/node" "$work/runtime-bin/node-hardlink"
seed_tunnels "$old_a"
run_subject
rm "$work/runtime-bin/node-hardlink"
(( result != 0 )) || fail 'hardlinked runtime command was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

chown 1:1 "$work/repo/infra/ops/smoke-production.sh"
seed_tunnels "$old_a"
run_subject
chown 0:0 "$work/repo/infra/ops/smoke-production.sh"
(( result != 0 )) || fail 'non-root smoke script was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

/usr/bin/python3.12 "$work/repo/infra/ops/ingress-control.py" --test-harness-root "$work" quarantine-create
seed_tunnels "$old_a"
run_subject
(( result != 0 )) || fail 'release quarantine was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start
/usr/bin/python3.12 "$work/repo/infra/ops/ingress-control.py" --test-harness-root "$work" quarantine-clear

control_cli() {
  /usr/bin/python3.12 "$work/repo/infra/ops/ingress-control.py" --test-harness-root "$work" "$@"
}
control_cli reset-recovery
control_cli record-failure --now 0 >/dev/null
seed_tunnels "$old_a"
run_subject '' false true
(( result == 0 )) || fail 'recovery-ready state did not permit guarded recovery'
control_cli reset-recovery

control_cli record-failure --now 100 >/dev/null
seed_tunnels "$old_a"
run_subject '' false true
(( result != 0 )) || fail 'recovery-wait state was accepted'
assert_quarantined
assert_no_start
control_cli reset-recovery

control_cli record-failure --now 0 >/dev/null
control_cli record-failure --now 30 >/dev/null
control_cli record-failure --now 90 >/dev/null
control_cli record-failure --now 210 >/dev/null
control_cli record-failure --now 450 >/dev/null
seed_tunnels "$old_a"
run_subject '' false true
(( result != 0 )) || fail 'recovery-exhausted state was accepted'
assert_quarantined
assert_no_start
control_cli reset-recovery

mkdir -p "$work/control"
chmod 0700 "$work/control"
printf '%s\n' 'schema=1' 'failure_count=invalid' 'incident_started_epoch=0' 'next_attempt_epoch=0' >"$work/control/recovery-state.env"
chmod 0600 "$work/control/recovery-state.env"
seed_tunnels "$old_a"
run_subject '' false true
rm -f "$work/control/recovery-state.env"
(( result != 0 )) || fail 'malformed recovery state was accepted'
assert_quarantined
assert_no_start

seed_tunnels "$old_a"
run_subject status-helper
(( result != 0 )) || fail 'status helper failure was accepted'
assert_starts_with_quarantine
assert_quarantined
assert_no_start

seed_tunnels "$old_a"
run_subject '' true
(( result == 0 )) || fail 'uploads start failed'
assert_line "docker:up:internal:$internal clamav scan-worker"

seed_tunnels "$old_a"
run_subject '' invalid
(( result != 0 )) || fail 'invalid UPLOADS_ENABLED was accepted'
assert_quarantined
assert_no_start

overall="$(sed -nE 's/^readonly overall_budget_seconds=([0-9]+)$/\1/p' "$subject")"
cleanup_budget="$(sed -nE 's/^readonly cleanup_budget_seconds=([0-9]+)$/\1/p' "$subject")"
unit_budget="$(sed -nE 's/^readonly systemd_timeout_seconds=([0-9]+)$/\1/p' "$subject")"
[[ "$overall" =~ ^[1-9][0-9]*$ && "$cleanup_budget" =~ ^[1-9][0-9]*$ && "$unit_budget" == 900 ]] || fail 'deadline budget constants are absent or malformed'
(( overall + cleanup_budget < unit_budget )) || fail 'startup plus cleanup budget reaches the 900-second unit deadline'

seed_tunnels "$old_a"
run_subject '' false false 1 true
(( result != 0 )) || fail 'simulated monotonic deadline exhaustion was accepted'
elapsed_before_public=0
public_allowance=
while IFS=: read -r duration command; do
  if [[ "$command" == *' up -d --no-build --pull never --no-deps cloudflared' ]]; then
    public_allowance="$duration"
    break
  fi
  elapsed_before_public=$((elapsed_before_public + duration))
done <"$work/budget-trace"
expected_public_allowance=$((overall - elapsed_before_public))
[[ "$public_allowance" =~ ^[1-9][0-9]*$ ]] || fail 'public phase did not receive a bounded allowance'
(( public_allowance == expected_public_allowance && public_allowance < 120 )) || \
  fail "public phase allowance was not deterministically shrunk: actual=$public_allowance expected=$expected_public_allowance"
! grep -Fq smoke:public "$work/trace" || fail 'deadline exhaustion completed public readiness unexpectedly'
grep -Fq 'startup deadline exhausted' "$work/stderr" || fail 'deadline exhaustion was not diagnosed'
assert_quarantined

control_cli reset-recovery
: >"$work/trace"
: >"$work/budget-trace"
printf '%s\n' '1000.00 0.00' >"$work/monotonic"
rm -f "$work/hold-entered" "$work/hold-release"
seed_tunnels "$old_a"
FAKE_FAIL_STAGE=hold-internal FAKE_CONSUME_TIMEOUTS=false UPLOADS_ENABLED=false \
  "$subject" --test-harness-root "$work" --startup-wait 2 --lock-timeout 1 >"$work/slow.stdout" 2>"$work/slow.stderr" &
slow_pid=$!
for _ in $(seq 1 250); do
  [[ -e "$work/hold-entered" ]] && break
  kill -0 "$slow_pid" 2>/dev/null || fail "slow start exited early: $(<"$work/slow.stderr")"
  /usr/bin/sleep 0.02
done
[[ -e "$work/hold-entered" ]] || fail 'slow start did not reach the internal hold point'
for attempt in 1 2 3 4 5 6; do
  set +e
  FAKE_FAIL_STAGE='' FAKE_CONSUME_TIMEOUTS=false UPLOADS_ENABLED=false \
    "$subject" --test-harness-root "$work" --startup-wait 2 --lock-timeout 1 --recover-if-needed \
    >"$work/contender-$attempt.stdout" 2>"$work/contender-$attempt.stderr"
  contender_result=$?
  set -e
  (( contender_result == 75 )) || fail "recovery contender $attempt returned $contender_result instead of EX_TEMPFAIL 75"
done
[[ ! -e "$work/control/recovery-state.env" && ! -e "$work/control/recovery-exhausted" ]] || fail 'lock contention mutated recovery failure state'
: >"$work/hold-release"
set +e
wait "$slow_pid"
slow_result=$?
set -e
slow_pid=
(( slow_result == 0 )) || fail "serialized slow start failed: $(<"$work/slow.stderr")"

control_cli reset-recovery
: >"$work/trace"
: >"$work/budget-trace"
printf '%s\n' '1000.00 0.00' >"$work/monotonic"
rm -f "$work/hold-entered" "$work/hold-release"
seed_tunnels "$old_a"
FAKE_FAIL_STAGE=hold-internal FAKE_CONSUME_TIMEOUTS=false UPLOADS_ENABLED=false \
  "$subject" --test-harness-root "$work" --startup-wait 2 --lock-timeout 1 --recover-if-needed \
  >"$work/late-state.stdout" 2>"$work/late-state.stderr" &
slow_pid=$!
for _ in $(seq 1 250); do
  [[ -e "$work/hold-entered" ]] && break
  kill -0 "$slow_pid" 2>/dev/null || fail "late-state start exited early: $(<"$work/late-state.stderr")"
  /usr/bin/sleep 0.02
done
[[ -e "$work/hold-entered" ]] || fail 'late-state start did not reach the internal hold point'
control_cli record-failure --now 0 >/dev/null
control_cli record-failure --now 30 >/dev/null
control_cli record-failure --now 90 >/dev/null
control_cli record-failure --now 210 >/dev/null
control_cli record-failure --now 450 >/dev/null
: >"$work/hold-release"
set +e
wait "$slow_pid"
late_state_result=$?
set -e
slow_pid=
(( late_state_result != 0 )) || fail 'late recovery exhaustion was bypassed before public exposure'
! grep -Fq docker:up:cloudflared:no-deps "$work/trace" || fail 'late recovery exhaustion exposed public ingress'
assert_quarantined
control_cli reset-recovery

: >"$work/trace"
: >"$work/budget-trace"
printf '%s\n' '1000.00 0.00' >"$work/monotonic"
rm -f "$work/hold-entered" "$work/hold-release"
seed_tunnels "$old_a"
FAKE_FAIL_STAGE=hold-internal FAKE_CONSUME_TIMEOUTS=false UPLOADS_ENABLED=false \
  "$subject" --test-harness-root "$work" --startup-wait 2 --lock-timeout 1 \
  >"$work/late-quarantine.stdout" 2>"$work/late-quarantine.stderr" &
slow_pid=$!
for _ in $(seq 1 250); do
  [[ -e "$work/hold-entered" ]] && break
  kill -0 "$slow_pid" 2>/dev/null || fail "late-quarantine start exited early: $(<"$work/late-quarantine.stderr")"
  /usr/bin/sleep 0.02
done
[[ -e "$work/hold-entered" ]] || fail 'late-quarantine start did not reach the internal hold point'
control_cli quarantine-create
: >"$work/hold-release"
set +e
wait "$slow_pid"
late_quarantine_result=$?
set -e
slow_pid=
(( late_quarantine_result != 0 )) || fail 'late release quarantine was bypassed before public exposure'
! grep -Fq docker:up:cloudflared:no-deps "$work/trace" || fail 'late release quarantine exposed public ingress'
assert_quarantined
control_cli quarantine-clear

touch "$work/run/codestead-release.lock"
chmod 0600 "$work/run/codestead-release.lock"
exec 8>>"$work/run/codestead-release.lock"
/usr/bin/flock --exclusive 8
seed_tunnels "$old_a"
run_subject '' false false 1
(( result == 75 )) || fail "busy release lock returned $result instead of EX_TEMPFAIL 75"
[[ "$(<"$work/tunnels")" == "$old_a" ]] || fail 'lock-busy contender interfered with active release ingress'
[[ ! -s "$work/trace" ]] || fail 'lock-busy contender crossed the quarantine boundary'
/usr/bin/flock --unlock 8
exec 8>&-

rm -f "$work/run/codestead-release.lock"
seed_tunnels "$old_a"
run_subject
(( result != 0 )) || fail 'missing release lock was created and accepted'
[[ ! -e "$work/run/codestead-release.lock" && ! -L "$work/run/codestead-release.lock" ]] || fail 'guarded start created the missing release lock'
[[ "$(<"$work/tunnels")" == "$old_a" ]] || fail 'missing lock crossed quarantine boundary'
[[ ! -s "$work/trace" ]] || fail 'missing lock reached runtime mutation'

mkfifo "$work/run/codestead-release.lock"
seed_tunnels "$old_a"
run_subject
(( result != 0 )) || fail 'FIFO release lock was accepted'
[[ -p "$work/run/codestead-release.lock" ]] || fail 'guarded start replaced the FIFO release lock'
[[ "$(<"$work/tunnels")" == "$old_a" ]] || fail 'FIFO lock crossed quarantine boundary'
[[ ! -s "$work/trace" ]] || fail 'FIFO lock reached runtime mutation'
rm "$work/run/codestead-release.lock"

printf '%s' sentinel >"$work/lock-sentinel"
chmod 0600 "$work/lock-sentinel"
ln "$work/lock-sentinel" "$work/run/codestead-release.lock"
seed_tunnels "$old_a"
run_subject
rm "$work/run/codestead-release.lock"
[[ "$(<"$work/lock-sentinel")" == sentinel ]] || fail 'unsafe lock mutated its hardlink target'
rm "$work/lock-sentinel"
(( result != 0 )) || fail 'hardlinked release lock was accepted'
[[ "$(<"$work/tunnels")" == "$old_a" ]] || fail 'hardlinked lock crossed quarantine boundary'

printf '%s' sentinel >"$work/lock-sentinel"
chmod 0600 "$work/lock-sentinel"
ln -s "$work/lock-sentinel" "$work/run/codestead-release.lock"
seed_tunnels "$old_a"
run_subject
rm "$work/run/codestead-release.lock" "$work/lock-sentinel"
(( result != 0 )) || fail 'symlinked release lock was accepted'
[[ "$(<"$work/tunnels")" == "$old_a" ]] || fail 'symlinked lock crossed quarantine boundary'

touch "$work/run/codestead-release.lock"
chmod 0666 "$work/run/codestead-release.lock"
seed_tunnels "$old_a"
run_subject
chmod 0600 "$work/run/codestead-release.lock"
(( result != 0 )) || fail 'wrong-mode release lock was accepted'
[[ "$(<"$work/tunnels")" == "$old_a" ]] || fail 'wrong-mode lock crossed quarantine boundary'

chown 1:1 "$work/run/codestead-release.lock"
seed_tunnels "$old_a"
run_subject
chown 0:0 "$work/run/codestead-release.lock"
(( result != 0 )) || fail 'non-root release lock was accepted'
[[ "$(<"$work/tunnels")" == "$old_a" ]] || fail 'non-root lock crossed quarantine boundary'

seed_tunnels "$old_a"
FAKE_LOCK_SWAP_PATH="$work/run/codestead-release.lock"
run_subject
unset FAKE_LOCK_SWAP_PATH
(( result != 0 )) || fail 'release lock path swap after open was accepted'
[[ -f "$work/run/codestead-release.lock.detached" ]] || fail 'guarded-start lock path-swap hook did not execute'
! grep -Eq '^docker:' "$work/trace" || fail 'split guarded-start lock reached Docker mutation'
rm -f "$work/run/codestead-release.lock" "$work/run/codestead-release.lock.detached"
: >"$work/run/codestead-release.lock"
chmod 0600 "$work/run/codestead-release.lock"

# shellcheck disable=SC2016
grep -Fq 'exec 9<"$release_lock_file"' "$subject" || fail 'guarded start does not open the release lock without creation'
! grep -Fq ': >"$release_lock_file"' "$subject" || fail 'guarded start still creates the release lock at runtime'

printf '%s\n' start-production-stack-adversarial-tests-ok
