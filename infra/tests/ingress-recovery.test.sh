#!/usr/bin/bash
# shellcheck disable=SC2016  # Mutation snippets are intentionally expanded by eval later.
set -Eeuo pipefail
umask 077
readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || fail 'ingress recovery tests require Linux root'
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
subject="$repo_root/infra/ops/recover-production-ingress.sh"
service="$repo_root/infra/systemd/learncoding-ingress-recovery.service"
[[ -f "$subject" && -f "$service" ]] || fail 'ingress recovery artifacts are missing'

work="$(mktemp -d /root/codestead-ingress-recovery.XXXXXX)"
lock_holder_pid=
cleanup() {
  if [[ -n "$lock_holder_pid" ]]; then
    kill "$lock_holder_pid" 2>/dev/null || true
    wait "$lock_holder_pid" 2>/dev/null || true
  fi
  [[ "$work" == /root/codestead-ingress-recovery.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM
chmod 0700 "$work"
mkdir -m 0700 "$work/bin" "$work/repo" "$work/repo/infra" "$work/repo/infra/ops" "$work/config" "$work/run"
touch "$work/repo/compose.yaml" "$work/config/compose.env" "$work/trace"
: >"$work/run/codestead-release.lock"
chmod 0600 "$work/run/codestead-release.lock"
printf '0\n' >"$work/discovery-count"
printf '0\n' >"$work/stop-count"
chmod 0644 "$work/repo/compose.yaml" "$work/config/compose.env"
cp "$repo_root/infra/ops/ingress-control.py" "$work/repo/infra/ops/ingress-control.py"
chmod 0644 "$work/repo/infra/ops/ingress-control.py"

cat >"$work/bin/date" <<'EOF'
#!/usr/bin/bash
[[ "$*" == +%s ]] || exit 64
if [[ "${FAKE_RECOVERY_SCENARIO:-}" == lock-path-swap && ! -e "$FAKE_ROOT/lock-swap.done" ]]; then
  : >"$FAKE_ROOT/lock-swap.done"
  mv -- "$FAKE_ROOT/run/codestead-release.lock" "$FAKE_ROOT/run/codestead-release.lock.detached"
  : >"$FAKE_ROOT/run/codestead-release.lock"
  chmod 0600 "$FAKE_ROOT/run/codestead-release.lock"
fi
if [[ "${FAKE_NEXT_NOW:-$FAKE_NOW}" == "$FAKE_NOW" ]]; then
  printf '%s\n' "$FAKE_NOW"
  exit 0
fi
date_count="$(<"$FAKE_ROOT/date-count")"
if (( date_count == 0 )); then
  printf '%s\n' "$FAKE_NOW"
else
  printf '%s\n' "$FAKE_NEXT_NOW"
fi
printf '%s\n' "$((date_count + 1))" >"$FAKE_ROOT/date-count"
EOF
cat >"$work/bin/python3.12" <<'EOF'
#!/usr/bin/bash
printf 'control:%s\n' "${4:-missing}" >>"$FAKE_TRACE"
[[ "${5:-}" != --now ]] || printf 'control-now:%s:%s\n' "${4:-missing}" "${6:-missing}" >>"$FAKE_TRACE"
exec /usr/bin/python3.12 "$@"
EOF
cat >"$work/bin/timeout" <<'EOF'
#!/usr/bin/bash
if [[ "${FAKE_TIMEOUT_TRACE:-false}" == true ]]; then
  deadline=missing
  kill_after=0
  for argument in "$@"; do
    case "$argument" in
      --kill-after=*) kill_after="${argument#--kill-after=}"; kill_after="${kill_after%s}" ;;
      [0-9]*s) deadline="${argument%s}"; break ;;
    esac
  done
  [[ "$deadline" =~ ^[0-9]+$ && "$kill_after" =~ ^[0-9]+$ ]] || exit 97
  printf 'timeout:%s:kill-after:%s\n' "$deadline" "$kill_after" >>"$FAKE_TRACE"
fi
exec /usr/bin/timeout "$@"
EOF
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock ]] || exit 96
[[ "${COMPOSE_PROFILES+x}" == x && -z "$COMPOSE_PROFILES" ]] || exit 96
for ambient_name in DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG \
  DOCKER_API_VERSION BUILDKIT_HOST COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME; do
  [[ -z "${!ambient_name-}" ]] || exit 96
done
if [[ "$*" == info ]]; then
  printf '%s\n' docker:info >>"$FAKE_TRACE"
  [[ "${FAKE_DOCKER_AVAILABLE:-true}" == true ]]
  exit
fi
if [[ "$1" == ps ]]; then
  [[ "$*" == "ps --filter label=com.docker.compose.project=learncoding --filter label=com.docker.compose.service=cloudflared --format {{.ID}}" ]] || exit 64
  printf '%s\n' docker:discover:tunnel >>"$FAKE_TRACE"
  if [[ "${FAKE_NO_COUNT:-false}" == true ]]; then
    count=1
  else
    count="$(( $(<"$FAKE_ROOT/discovery-count") + 1 ))"
    printf '%s\n' "$count" >"$FAKE_ROOT/discovery-count"
    (( count > ${FAKE_DISCOVERY_FAILURES:-0} )) || exit 70
  fi
  case "${FAKE_TUNNEL_SET:-zero}" in
    zero) ;;
    one) printf '%s\n' aaaaaaaaaaaa ;;
    multiple) printf '%s\n' aaaaaaaaaaaa bbbbbbbbbbbb ;;
    invalid) printf '%s\n' not-a-container ;;
    *) exit 64 ;;
  esac
  exit
fi
if [[ "$1" == stop && "$2" == --time && "$3" == 2 ]]; then
  shift 3
  printf 'docker:stop:%s\n' "$*" >>"$FAKE_TRACE"
  count="$(( $(<"$FAKE_ROOT/stop-count") + 1 ))"
  printf '%s\n' "$count" >"$FAKE_ROOT/stop-count"
  if [[ "${FAKE_RECOVERY_SCENARIO:-}" == repeated-signal-cleanup && -e "$FAKE_ROOT/repeated-signal.triggered" && "$count" == 1 ]]; then
    timeout_parent="$PPID"
    recovery_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    recovery_pid="${recovery_pid//[[:space:]]/}"
    [[ "$recovery_pid" =~ ^[1-9][0-9]*$ ]] || exit 71
    /bin/kill -HUP "$recovery_pid"
    /bin/kill -INT "$recovery_pid"
    exit 70
  fi
  (( count > ${FAKE_STOP_FAILURES:-0} ))
  exit
fi
[[ "$1" == compose && "$2" == --project-name && "$3" == learncoding && "$4" == --env-file && "$5" == "$FAKE_ROOT/config/compose.env" && "$6" == -f && "$7" == "$FAKE_REPO/compose.yaml" ]] || exit 64
shift 7
if [[ "$*" == 'ps --services --status running cloudflared' ]]; then
  printf '%s\n' docker:probe:tunnel >>"$FAKE_TRACE"
  [[ "${FAKE_PROBE_SUCCEEDS:-true}" == true ]] || exit 70
  [[ "${FAKE_TUNNEL_RUNNING:-false}" == true ]] && printf '%s\n' cloudflared
  exit
fi
exit 64
EOF
cat >"$work/repo/infra/ops/smoke-production.sh" <<'EOF'
#!/usr/bin/bash
[[ "$1" == --phase && ( "$2" == internal || "$2" == public || "$2" == full ) && "$3" == --startup-wait && ( "$4" == 1 || "$4" == 2 || "$4" == 5 ) && "$#" == 4 ]] || exit 64
case "$2" in
  full)
    printf '%s\n' smoke:internal smoke:public >>"$FAKE_TRACE"
    ;;
  *)
    printf 'smoke:%s\n' "$2" >>"$FAKE_TRACE"
    ;;
esac
[[ "${FAKE_HEALTHY:-false}" == true ]]
EOF
cat >"$work/repo/infra/ops/start-production-stack.sh" <<'EOF'
#!/usr/bin/bash
[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock ]] || exit 96
[[ "${COMPOSE_PROFILES+x}" == x && -z "$COMPOSE_PROFILES" ]] || exit 96
for ambient_name in DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG \
  DOCKER_API_VERSION BUILDKIT_HOST COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME; do
  [[ -z "${!ambient_name-}" ]] || exit 96
done
printf '%s\n' guarded:start >>"$FAKE_TRACE"
[[ "$*" == *'--recover-if-needed'* && "$*" == *'--startup-wait 5'* ]] || exit 64
if [[ "${FAKE_RECOVERY_SCENARIO:-}" == repeated-signal-cleanup ]]; then
  timeout_parent="$PPID"
  recovery_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
  recovery_pid="${recovery_pid//[[:space:]]/}"
  [[ "$recovery_pid" =~ ^[1-9][0-9]*$ ]] || exit 71
  /bin/kill -TERM "$recovery_pid"
  : >"$FAKE_ROOT/repeated-signal.triggered"
  exit 1
fi
if [[ "${FAKE_START_EXIT:-1}" == 75 ]]; then
  exit 75
fi
printf '%s\n' guarded:quarantine >>"$FAKE_TRACE"
if [[ "${FAKE_START_STATE_CHANGE:-false}" == true ]]; then
  "$FAKE_ROOT/bin/python3.12" "$FAKE_REPO/infra/ops/ingress-control.py" --test-harness-root "$FAKE_ROOT" record-failure --now "$FAKE_NOW" >/dev/null
fi
if [[ "${FAKE_START_SUCCEEDS:-false}" == true ]]; then
  "$FAKE_ROOT/bin/python3.12" "$FAKE_REPO/infra/ops/ingress-control.py" --test-harness-root "$FAKE_ROOT" record-success
  exit 0
fi
exit "${FAKE_START_EXIT:-1}"
EOF
chmod 0755 "$work/bin/date" "$work/bin/python3.12" "$work/bin/timeout" "$work/bin/docker" "$work/repo/infra/ops/smoke-production.sh" "$work/repo/infra/ops/start-production-stack.sh"
export FAKE_ROOT="$work" FAKE_REPO="$work/repo" FAKE_TRACE="$work/trace"

control() {
  /usr/bin/python3.12 "$work/repo/infra/ops/ingress-control.py" --test-harness-root "$work" "$@"
}
reset_control() {
  control reset-recovery >/dev/null
}
run_recovery() {
  local ambient_mode="${12:-clean}"
  local -a bounded_environment=(COMPOSE_PROFILES=)
  case "$ambient_mode" in
    clean) ;;
    hostile-authority)
      bounded_environment=(DOCKER_HOST=tcp://attacker.invalid:2375 DOCKER_CONTEXT=attacker \
        DOCKER_TLS=1 COMPOSE_FILE=/attacker/compose.yaml COMPOSE_PROJECT_NAME=attacker COMPOSE_PROFILES=)
      ;;
    hostile-profiles) bounded_environment=(COMPOSE_PROFILES=uploads) ;;
    *) fail "unknown ambient test mode: $ambient_mode" ;;
  esac
  : >"$work/trace"
  printf '0\n' >"$work/discovery-count"
  printf '0\n' >"$work/stop-count"
  printf '0\n' >"$work/date-count"
  rm -f "$work/lock-swap.done" "$work/repeated-signal.triggered"
  set +e
  env "${bounded_environment[@]}" FAKE_NOW="$1" FAKE_NEXT_NOW="${14:-$1}" FAKE_DOCKER_AVAILABLE="${2:-true}" FAKE_TUNNEL_SET="${3:-one}" \
    FAKE_TUNNEL_RUNNING="${4:-false}" FAKE_HEALTHY="${5:-false}" \
    FAKE_START_SUCCEEDS="${6:-false}" FAKE_PROBE_SUCCEEDS="${7:-true}" \
    FAKE_DISCOVERY_FAILURES="${8:-0}" FAKE_STOP_FAILURES="${9:-0}" \
    FAKE_START_EXIT="${10:-1}" FAKE_START_STATE_CHANGE="${11:-false}" \
    FAKE_RECOVERY_SCENARIO="${15:-}" \
    FAKE_TIMEOUT_TRACE="${13:-false}" "$subject" --test-harness-root "$work" \
    >"$work/stdout" 2>"$work/stderr"
  result=$?
  set -e
}
trace_count() { grep -Fxc -- "$1" "$work/trace" 2>/dev/null || true; }
assert_stopped() { grep -Fq 'docker:stop:' "$work/trace" || fail "$1 did not quarantine the tunnel"; }

reset_control
run_recovery 50 false one
(( result != 0 )) || fail 'Docker unavailability must fail closed when a tunnel cannot be proven down'
[[ "$(trace_count control:record-failure)" == 0 ]] || fail 'Docker deferral mutated recovery state'
assert_stopped 'Docker unavailability cleanup'

run_recovery 100 true one false false false
(( result == 0 )) || fail 'first setup failure was not timer-safe'
[[ "$(control status --now 130)" == recovery-ready:1 ]] || fail 'setup failure did not become eligible'
run_recovery 130 false one
(( result != 0 )) || fail 'Docker unavailability during an eligible retry did not fail closed'
[[ "$(control status --now 130)" == recovery-ready:1 ]] || fail 'Docker unavailability consumed an application recovery attempt'
[[ "$(trace_count control:record-failure)" == 0 ]] || fail 'Docker unavailability persisted a false application failure'
reset_control

attempt_times=(100 130 190 310)
expected_waits=(30 60 120 240)
for index in 0 1 2 3; do
  run_recovery "${attempt_times[$index]}" true one false false false
  (( result == 0 )) || fail "failure $((index + 1)) must be timer-safe"
  [[ "$(trace_count control:record-failure)" == 1 ]] || fail "failure $((index + 1)) was not persisted exactly once"
  assert_stopped "failure $((index + 1))"
  status="$(control status --now "${attempt_times[$index]}")"
  [[ "$status" == "recovery-wait:${expected_waits[$index]}" ]] || fail "failure $((index + 1)) backoff drifted: $status"
  if (( index == 0 )); then
    run_recovery 101 true one false false true
    (( result == 0 )) || fail 'backoff invocation failed'
    [[ "$(trace_count guarded:start)" == 0 && "$(trace_count control:record-failure)" == 0 ]] || fail 'backoff performed an eligible attempt'
    assert_stopped backoff
  fi
done

run_recovery 550 true one false false false
(( result != 0 )) || fail 'fifth failure did not terminal-alert'
[[ "$(trace_count control:record-failure)" == 1 ]] || fail 'fifth failure was not persisted exactly once'
[[ "$(control status --now 550)" == recovery-exhausted ]] || fail 'fifth failure did not exhaust recovery'
assert_stopped 'fifth failure'

run_recovery 800 true one false false true
(( result == 0 )) || fail 'post-exhaustion invocation must be a no-op'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count control:record-failure)" == 0 ]] || fail 'post-exhaustion invocation attempted recovery'
assert_stopped post-exhaustion

reset_control
[[ "$(control status --now 900)" == clear ]] || fail 'explicit reset did not clear exhaustion'
run_recovery 900 true zero false false true
(( result == 0 )) || fail 'successful guarded recovery failed after reset'
[[ "$(trace_count guarded:start)" == 1 && "$(trace_count control:record-success)" == 1 ]] || fail 'successful guarded recovery evidence drifted'

reset_control
run_recovery 950 true one false false false true 0 0 75 false
(( result == 0 )) || fail 'guarded-start lock contention was not timer-neutral'
[[ "$(trace_count guarded:start)" == 1 && "$(trace_count control:record-failure)" == 0 ]] || fail 'guarded-start lock contention mutated recovery evidence'
[[ "$(control status --now 950)" == clear ]] || fail 'guarded-start lock contention changed recovery state'
[[ "$(trace_count guarded:quarantine)" == 0 && "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'guarded-start lock contention interfered with the winning release'

reset_control
run_recovery 975 true one false false false true 0 0 1 true
(( result == 0 )) || fail 'state change before recovery persistence was not timer-neutral'
[[ "$(trace_count guarded:start)" == 1 && "$(trace_count control:record-failure)" == 1 ]] || fail 'state-change race double-counted or lost recovery evidence'
[[ "$(control status --now 975)" == recovery-wait:30 ]] || fail 'state-change race did not preserve the winning transaction state'
[[ "$(trace_count guarded:quarantine)" == 1 ]] || fail 'the winning guarded transaction did not own quarantine'

reset_control
run_recovery 980 true one false false false true 0 0 1 false clean false 1010
(( result == 0 )) || fail 'advancing-clock recovery attempt was not timer-neutral'
[[ "$(trace_count control:record-failure)" == 1 ]] || fail 'advancing-clock failure was not persisted exactly once'
[[ "$(trace_count control-now:status:1010)" == 1 ]] || fail 'final control status did not use a fresh trusted clock under the release lock'
[[ "$(trace_count control-now:record-failure:1010)" == 1 ]] || fail 'failure backoff was anchored to the fresh trusted clock'
[[ "$(control status --now 1010)" == recovery-wait:30 ]] || fail 'failure backoff elapsed during the guarded attempt instead of starting after it'

reset_control
run_recovery 1050 true one false false false true 0 0 1 false clean false 1049
(( result != 0 )) || fail 'regressing recovery clock was accepted'
grep -Fq 'recovery clock regressed under the release lock' "$work/stderr" \
  || fail 'regressing recovery clock did not fail with the reviewed diagnostic'
[[ "$(trace_count control:record-failure)" == 0 ]] || fail 'regressing recovery clock mutated backoff state'
[[ "$(control status --now 1050)" == clear ]] || fail 'regressing recovery clock changed recovery evidence'
assert_stopped 'regressing recovery clock cleanup'

reset_control
run_recovery 1000 true one true true false
(( result == 0 )) || fail 'healthy fast path failed'
[[ "$(trace_count smoke:internal)" == 1 && "$(trace_count smoke:public)" == 1 ]] || fail 'healthy path did not prove both phases'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count control:record-success)" == 0 && "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'healthy path was not a true no-op'
run_recovery 1001 true one true true false
(( result == 0 )) || fail 'repeated healthy timer tick failed'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count control:record-success)" == 0 && "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'repeated healthy timer tick restarted or mutated the stack'

reset_control
run_recovery 1005 true one true true false true 0 0 1 false hostile-authority
(( result == 0 )) || fail 'reviewed local Docker/Compose authority was not restored from hostile ambient values'
[[ "$(trace_count smoke:internal)" == 1 && "$(trace_count smoke:public)" == 1 ]] || fail 'authority binding did not reach both healthy probes'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'authority binding changed healthy no-op behavior'

reset_control
run_recovery 1010 true one false false false true 0 0 1 false hostile-profiles
(( result != 0 )) || fail 'non-empty ambient COMPOSE_PROFILES was accepted'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count control:record-failure)" == 0 ]] || fail 'hostile profiles reached recovery mutation'
assert_stopped 'hostile profiles cleanup'

reset_control
: >"$work/trace"
printf '0\n' >"$work/discovery-count"
printf '0\n' >"$work/stop-count"
lock_ready="$work/lock-ready"
lock_release="$work/lock-release"
mkfifo "$lock_release"
(
  trap - EXIT HUP INT TERM
  exec 9<>"$work/run/codestead-release.lock"
  /usr/bin/flock --exclusive 9
  : >"$lock_ready"
  IFS= read -r _ <"$lock_release" || true
) &
lock_holder_pid=$!
for _ in {1..100}; do
  [[ -e "$lock_ready" ]] && break
  /usr/bin/sleep 0.01
done
[[ -e "$lock_ready" ]] || fail 'normal-start lock holder did not become ready'
concurrent_pids=()
for tick in 1 2 3 4 5; do
  FAKE_NOW=1050 FAKE_DOCKER_AVAILABLE=true FAKE_TUNNEL_SET=zero \
    FAKE_TUNNEL_RUNNING=false FAKE_HEALTHY=false FAKE_START_SUCCEEDS=false \
    FAKE_PROBE_SUCCEEDS=true FAKE_DISCOVERY_FAILURES=0 FAKE_STOP_FAILURES=0 \
    FAKE_START_EXIT=1 FAKE_START_STATE_CHANGE=false FAKE_NO_COUNT=true \
    "$subject" --test-harness-root "$work" >"$work/concurrent-$tick.stdout" 2>"$work/concurrent-$tick.stderr" &
  concurrent_pids+=("$!")
done
concurrent_result=0
for pid in "${concurrent_pids[@]}"; do
  wait "$pid" || concurrent_result=1
done
printf '%s\n' release >"$lock_release"
wait "$lock_holder_pid" || fail 'normal-start lock holder failed'
lock_holder_pid=
(( concurrent_result == 0 )) || fail 'concurrent timer tick failed during a normal start'
[[ "$(trace_count docker:discover:tunnel)" == 5 ]] || fail 'five concurrent timer ticks did not reach the serialized decision point'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count control:record-failure)" == 0 && "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'concurrent timer ticks interfered with the normal start transaction'
[[ "$(control status --now 1050)" == clear ]] || fail 'concurrent timer ticks mutated recovery state'

reset_control
run_recovery 1100 true one true false false
(( result == 0 )) || fail 'first failed fast-path proof must be timer-safe'
[[ "$(trace_count control:record-failure)" == 1 && "$(trace_count guarded:start)" == 1 ]] || fail 'failed readiness proof was not recorded exactly once'
assert_stopped 'failed readiness proof'

reset_control
run_recovery 1200 true zero false false false
(( result == 0 )) || fail 'zero-tunnel failure was not timer-safe'
[[ "$(trace_count control:record-failure)" == 1 ]] || fail 'zero-tunnel failure was not persisted exactly once'
(( $(trace_count docker:discover:tunnel) >= 2 )) || fail 'zero-tunnel quarantine evidence drifted'
[[ "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'zero-tunnel case invented a stop target'

reset_control
run_recovery 1300 true multiple false false false
(( result == 0 )) || fail 'multiple-tunnel failure was not timer-safe'
grep -Fxq 'docker:stop:aaaaaaaaaaaa bbbbbbbbbbbb' "$work/trace" || fail 'multiple tunnel IDs were not all stopped'

reset_control
run_recovery 1350 true invalid false false false
(( result != 0 )) || fail 'invalid tunnel identity was silently accepted'
[[ "$(trace_count control:record-failure)" == 0 && "$(control status --now 1350)" == clear ]] || fail 'invalid tunnel identity consumed a recovery attempt'
[[ "$(trace_count docker:stop:not-a-container)" == 0 ]] || fail 'invalid tunnel identity reached docker stop'

reset_control
run_recovery 1400 true one false false false true 1 0
(( result == 0 )) || fail 'one transient discovery failure was not recovered'
(( $(<"$work/discovery-count") >= 2 )) || fail 'discovery cleanup did not retry'
[[ "$(trace_count control:record-failure)" == 1 ]] || fail 'recovered discovery failure was not persisted exactly once'
assert_stopped 'transient discovery failure'

reset_control
run_recovery 1450 true one false false false true 10 0
(( result != 0 )) || fail 'persistent discovery uncertainty was silently accepted'
[[ "$(trace_count control:record-failure)" == 0 && "$(control status --now 1450)" == clear ]] || fail 'persistent discovery uncertainty consumed a recovery attempt'

reset_control
run_recovery 1475 true one false false false true 0 10
(( result != 0 )) || fail 'persistent stop uncertainty was silently accepted'
(( $(<"$work/stop-count") >= 2 )) || fail 'persistent stop uncertainty did not exhaust bounded retries'
[[ "$(trace_count control:record-failure)" == 0 && "$(control status --now 1475)" == clear ]] || fail 'persistent stop uncertainty consumed a recovery attempt'

reset_control
run_recovery 1500 true one false false false true 0 1
(( result == 0 )) || fail 'one transient stop failure was not recovered'
(( $(<"$work/stop-count") >= 2 )) || fail 'stop cleanup did not retry'
[[ "$(trace_count control:record-failure)" == 1 ]] || fail 'stop recovery state persistence drifted'
assert_stopped 'transient stop failure'

reset_control
run_recovery 1600 true one false false false false
(( result == 0 )) || fail 'probe failure should enter timer-safe backoff'
[[ "$(trace_count control:record-failure)" == 1 && "$(trace_count guarded:start)" == 1 ]] || fail 'probe failure state mutation drifted'
assert_stopped 'probe failure'

reset_control
printf '%s\n' malformed >"$work/control/recovery-state.env"
chmod 0600 "$work/control/recovery-state.env"
run_recovery 1700 true one
(( result != 0 )) || fail 'malformed recovery state was accepted'
[[ "$(trace_count control:record-failure)" == 0 ]] || fail 'malformed state was mutated'
assert_stopped 'malformed state'
rm -f -- "$work/control/recovery-state.env"

reset_control
control quarantine-create
run_recovery 1800 true one false false true
(( result == 0 )) || fail 'release quarantine should defer recovery'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count control:record-failure)" == 0 ]] || fail 'release quarantine invoked recovery'
assert_stopped 'release quarantine'
control quarantine-clear

expect_fail_closed_mutation() {
  local label="$1" setup="$2" teardown="$3"
  reset_control
  eval "$setup"
  run_recovery 1900 true one false false true
  eval "$teardown"
  (( result != 0 )) || fail "$label mutation was accepted"
  [[ "$(trace_count control:record-failure)" == 0 ]] || fail "$label mutation changed recovery state"
  assert_stopped "$label mutation"
}

expect_fail_closed_mutation input-writable \
  'chmod 0666 "$work/repo/infra/ops/smoke-production.sh"' \
  'chmod 0755 "$work/repo/infra/ops/smoke-production.sh"'
expect_fail_closed_mutation input-nonexecutable \
  'chmod 0644 "$work/repo/infra/ops/smoke-production.sh"' \
  'chmod 0755 "$work/repo/infra/ops/smoke-production.sh"'
expect_fail_closed_mutation input-hardlink \
  'ln "$work/repo/compose.yaml" "$work/compose-hardlink"' \
  'rm -f -- "$work/compose-hardlink"'
expect_fail_closed_mutation input-symlink \
  'mv "$work/repo/infra/ops/smoke-production.sh" "$work/repo/infra/ops/smoke-production.real"; ln -s smoke-production.real "$work/repo/infra/ops/smoke-production.sh"' \
  'rm -f -- "$work/repo/infra/ops/smoke-production.sh"; mv "$work/repo/infra/ops/smoke-production.real" "$work/repo/infra/ops/smoke-production.sh"'
expect_fail_closed_mutation input-wrong-owner \
  'chown 65534:65534 "$work/config/compose.env"' \
  'chown 0:0 "$work/config/compose.env"'
expect_fail_closed_mutation input-writable-ancestor \
  'chmod 0770 "$work/config"' \
  'chmod 0700 "$work/config"'
expect_fail_closed_mutation command-writable \
  'chmod 0777 "$work/bin/python3.12"' \
  'chmod 0755 "$work/bin/python3.12"'
expect_fail_closed_mutation command-hardlink \
  'ln "$work/bin/python3.12" "$work/python-hardlink"' \
  'rm -f -- "$work/python-hardlink"'
expect_fail_closed_mutation command-symlink \
  'mv "$work/bin/python3.12" "$work/bin/python3.12.real"; ln -s python3.12.real "$work/bin/python3.12"' \
  'rm -f -- "$work/bin/python3.12"; mv "$work/bin/python3.12.real" "$work/bin/python3.12"'
expect_fail_closed_mutation command-wrong-owner \
  'chown 65534:65534 "$work/bin/python3.12"' \
  'chown 0:0 "$work/bin/python3.12"'

reset_control
rm -f "$work/run/codestead-release.lock"
run_recovery 1940 true one true true false
(( result != 0 )) || fail 'missing release lock was created and accepted by recovery'
[[ ! -e "$work/run/codestead-release.lock" && ! -L "$work/run/codestead-release.lock" ]] || fail 'recovery created the missing release lock'
[[ ! -s "$work/trace" ]] || fail 'missing recovery lock reached runtime or control mutation'

mkfifo "$work/run/codestead-release.lock"
run_recovery 1945 true one true true false
(( result != 0 )) || fail 'FIFO release lock was accepted by recovery'
[[ -p "$work/run/codestead-release.lock" ]] || fail 'recovery replaced the FIFO release lock'
[[ ! -s "$work/trace" ]] || fail 'FIFO recovery lock reached runtime or control mutation'
rm "$work/run/codestead-release.lock"

printf '%s' sentinel >"$work/lock-sentinel"
chmod 0600 "$work/lock-sentinel"
ln -s "$work/lock-sentinel" "$work/run/codestead-release.lock"
run_recovery 1946 true one true true false
(( result != 0 )) || fail 'symlink release lock was accepted by recovery'
[[ ! -s "$work/trace" ]] || fail 'symlink recovery lock reached runtime or control mutation'
rm "$work/run/codestead-release.lock" "$work/lock-sentinel"

printf '%s' sentinel >"$work/lock-sentinel"
chmod 0600 "$work/lock-sentinel"
ln "$work/lock-sentinel" "$work/run/codestead-release.lock"
run_recovery 1947 true one true true false
(( result != 0 )) || fail 'hardlinked release lock was accepted by recovery'
[[ ! -s "$work/trace" ]] || fail 'hardlinked recovery lock reached runtime or control mutation'
rm "$work/run/codestead-release.lock" "$work/lock-sentinel"

: >"$work/run/codestead-release.lock"
chmod 0644 "$work/run/codestead-release.lock"
run_recovery 1948 true one true true false
(( result != 0 )) || fail 'wrong-mode release lock was accepted by recovery'
[[ ! -s "$work/trace" ]] || fail 'wrong-mode recovery lock reached runtime or control mutation'

chmod 0600 "$work/run/codestead-release.lock"
chown 65534:65534 "$work/run/codestead-release.lock"
run_recovery 1949 true one true true false
(( result != 0 )) || fail 'wrong-owner release lock was accepted by recovery'
[[ ! -s "$work/trace" ]] || fail 'wrong-owner recovery lock reached runtime or control mutation'
chown 0:0 "$work/run/codestead-release.lock"

run_recovery 1949 true one false false false true 0 0 1 false clean false 1949 lock-path-swap
(( result != 0 )) || fail 'release lock path swap after open was accepted by recovery'
[[ -f "$work/run/codestead-release.lock.detached" ]] || fail 'recovery lock path-swap hook did not execute'
[[ "$(control status --now 1949)" == clear ]] || fail 'recovery lock path swap mutated control state'
rm -f "$work/run/codestead-release.lock" "$work/run/codestead-release.lock.detached"
: >"$work/run/codestead-release.lock"
chmod 0600 "$work/run/codestead-release.lock"

reset_control
run_recovery 1949 true one false false false true 0 0 1 false clean false 1949 repeated-signal-cleanup
(( result == 143 )) || fail "repeated recovery cleanup signals changed the first TERM status: $result"
(( $(<"$work/stop-count") >= 2 )) || fail 'repeated signals aborted bounded recovery quarantine'

rm -f "$work/run/codestead-release.lock"
: >"$work/run/codestead-release.lock"
chmod 0600 "$work/run/codestead-release.lock"

reset_control
chmod 1777 "$work/run"
run_recovery 1950 true one true true false
chmod 0700 "$work/run"
(( result == 0 )) || fail 'the expected root-owned sticky release-lock parent was rejected'
[[ "$(trace_count guarded:start)" == 0 && "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'sticky release-lock parent changed healthy no-op behavior'

reset_control
chmod 0777 "$work/run"
run_recovery 1960 true one true true false
chmod 0700 "$work/run"
(( result != 0 )) || fail 'non-sticky writable release-lock parent was accepted'
[[ "$(trace_count control:record-failure)" == 0 && "$(trace_count docker:stop:aaaaaaaaaaaa)" == 0 ]] || fail 'untrusted release-lock ancestry triggered unsafe mutation'

reset_control
run_recovery 1970 true one true false false true 0 1 1 false clean true
(( result == 0 )) || fail 'forced worst-case eligible failure was not timer-safe'
[[ "$(trace_count control:record-failure)" == 1 ]] || fail 'forced worst-case path did not persist exactly one failure'
mapfile -t actual_deadline_trace < <(grep '^timeout:' "$work/trace")
expected_deadline_trace=(
  timeout:2:kill-after:0
  timeout:2:kill-after:0
  timeout:2:kill-after:0
  timeout:2:kill-after:0
  timeout:3:kill-after:0
  timeout:25:kill-after:5
  timeout:2:kill-after:0
  timeout:2:kill-after:0
  timeout:1:kill-after:0
  timeout:2:kill-after:0
  timeout:2:kill-after:0
  timeout:3:kill-after:0
  timeout:2:kill-after:0
  timeout:3:kill-after:0
  timeout:2:kill-after:0
)
[[ "${actual_deadline_trace[*]}" == "${expected_deadline_trace[*]}" ]] || fail 'forced worst-case deadline trace drifted'
traced_seconds=0
for deadline_entry in "${actual_deadline_trace[@]}"; do
  IFS=: read -r _ deadline _ kill_after <<<"$deadline_entry"
  traced_seconds=$((traced_seconds + deadline + kill_after))
done
(( traced_seconds == 60 )) || fail "forced worst-case trace was ${traced_seconds}s instead of 60s"

grep -Fqx 'TimeoutStartSec=90s' "$service" || fail 'systemd recovery timeout drifted'
grep -Fqx 'readonly recovery_attempt_budget_seconds=60' "$subject" || fail 'recovery attempt budget drifted'
grep -Fqx 'readonly recovery_cleanup_budget_seconds=10' "$subject" || fail 'recovery cleanup budget drifted'
grep -Fqx 'readonly systemd_deadline_seconds=90' "$subject" || fail 'recovery systemd budget drifted'
grep -Fq 'exec 8<"$release_lock_file"' "$subject" || fail 'recovery does not open the release lock without creation'
! grep -Fq 'exec 8<>"$release_lock_file"' "$subject" || fail 'recovery can still create the release lock while opening it'

max_attempt_seconds=$((2 + 2 + (2 + 2 + 3) + (25 + 5) + (2 + 2 + 1 + 2 + (2 * (2 + 3)) + 2)))
cleanup_seconds=$((2 * (2 + 3)))
(( max_attempt_seconds == 60 && max_attempt_seconds + cleanup_seconds < 90 )) || fail 'recovery deadline can preempt quarantine or failure persistence'

printf '%s\n' 'ingress-recovery-tests-ok'
