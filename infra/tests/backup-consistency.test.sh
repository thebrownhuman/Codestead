#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common="$repo_root/scripts/backup/common.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

fake_bin="$work/fake-bin"
mkdir -p "$fake_bin" "$work/repo"
touch "$work/compose.env" "$work/repo/compose.yaml"
cat >"$fake_bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${1:-}" == "compose" ]] || exit 90
shift
[[ "${1:-}" == "--env-file" && "${2:-}" == "$FAKE_COMPOSE_ENV" ]] || exit 91
shift 2
[[ "${1:-}" == "-f" && "${2:-}" == "$FAKE_COMPOSE_FILE" ]] || exit 92
shift 2

case "${1:-}" in
  ps)
    shift
    [[ "${1:-}" == "--status" && "${2:-}" == "running" && "${3:-}" == "--services" && "$#" -eq 3 ]] || exit 93
    printf '%s\n' "argv=ps --status running --services" >>"$FAKE_DOCKER_LOG"
    [[ "${FAKE_DOCKER_FAIL_PS:-0}" != "1" ]] || exit 99
    cat "$FAKE_DOCKER_RUNNING"
    ;;
  stop)
    shift
    [[ "${1:-}" == "--timeout" && "${2:-}" == "60" ]] || exit 94
    shift 2
    (( $# > 0 )) || exit 95
    printf '%s\n' "argv=stop --timeout 60 $*" >>"$FAKE_DOCKER_LOG"
    for service in "$@"; do
      printf 'event=stop service=%s\n' "$service" >>"$FAKE_DOCKER_LOG"
    done
    ;;
  up)
    shift
    [[ "${1:-}" == "-d" && "${2:-}" == "--no-deps" && "${3:-}" == "--no-build" && "${4:-}" == "--pull" && "${5:-}" == "never" ]] || exit 96
    shift 5
    (( $# > 0 )) || exit 97
    printf '%s\n' "argv=up -d --no-deps --no-build --pull never $*" >>"$FAKE_DOCKER_LOG"
    for service in "$@"; do
      printf 'event=up service=%s\n' "$service" >>"$FAKE_DOCKER_LOG"
    done
    ;;
  *)
    exit 98
    ;;
esac
FAKE_DOCKER
chmod 0700 "$fake_bin/docker"

export PATH="$fake_bin:$PATH"
export FAKE_DOCKER_LOG="$work/docker.log"
export FAKE_DOCKER_RUNNING="$work/running-services"
export FAKE_COMPOSE_ENV="$work/compose.env"
export FAKE_COMPOSE_FILE="$work/repo/compose.yaml"
export COMPOSE_ENV_FILE="$FAKE_COMPOSE_ENV"
export REPO_ROOT="$work/repo"

# shellcheck source=../../scripts/backup/common.sh
source "$common"

for interface in capture_running_mutators quiesce_mutators resume_mutators; do
  declare -F "$interface" >/dev/null || fail "required backup interface is missing: $interface"
done

cat >"$FAKE_DOCKER_RUNNING" <<'RUNNING'
app
postgres
unknown-future-worker
cloudflared
clamav
scan-worker
migrate
app

RUNNING

captured=()
capture_running_mutators captured || fail "running mutators could not be captured"
expected=(cloudflared app scan-worker)
[[ "${captured[*]}" == "${expected[*]}" ]] \
  || fail "captured services did not match the fixed allowlisted intersection"

: >"$FAKE_DOCKER_LOG"
quiesce_mutators captured || fail "captured mutators could not be quiesced"
resume_mutators captured || fail "captured mutators could not be resumed"

grep -Fqx 'argv=stop --timeout 60 cloudflared app scan-worker' "$FAKE_DOCKER_LOG" \
  || fail "quiesce command did not stop exactly the captured set with a bounded grace period"
grep -Fqx 'argv=up -d --no-deps --no-build --pull never app scan-worker' "$FAKE_DOCKER_LOG" \
  || fail "non-tunnel mutators were not resumed with the bounded no-build command"
grep -Fqx 'argv=up -d --no-deps --no-build --pull never cloudflared' "$FAKE_DOCKER_LOG" \
  || fail "cloudflared was not resumed separately"
[[ "$(grep '^event=up ' "$FAKE_DOCKER_LOG" | tail -n 1)" == 'event=up service=cloudflared' ]] \
  || fail "cloudflared was not the final resumed service"
if grep -Eq 'service=(postgres|clamav|unknown-future-worker|migrate|mail-worker)$' "$FAKE_DOCKER_LOG"; then
  fail "a noncaptured or forbidden service was mutated"
fi

empty=()
before_empty="$(sha256sum "$FAKE_DOCKER_LOG" | awk '{print $1}')"
quiesce_mutators empty || fail "empty quiesce was not a successful no-op"
resume_mutators empty || fail "empty resume was not a successful no-op"
after_empty="$(sha256sum "$FAKE_DOCKER_LOG" | awk '{print $1}')"
[[ "$after_empty" == "$before_empty" ]] || fail "empty mutator arrays invoked Docker"

unsafe=(app postgres)
before_unsafe="$(sha256sum "$FAKE_DOCKER_LOG" | awk '{print $1}')"
if quiesce_mutators unsafe; then
  fail "quiesce accepted a service outside the fixed allowlist"
fi
after_unsafe="$(sha256sum "$FAKE_DOCKER_LOG" | awk '{print $1}')"
[[ "$after_unsafe" == "$before_unsafe" ]] || fail "unsafe mutator array reached Docker"
if resume_mutators unsafe; then
  fail "resume accepted a service outside the fixed allowlist"
fi
after_unsafe_resume="$(sha256sum "$FAKE_DOCKER_LOG" | awk '{print $1}')"
[[ "$after_unsafe_resume" == "$before_unsafe" ]] || fail "unsafe resume array reached Docker"

stale_capture=(app)
export FAKE_DOCKER_FAIL_PS=1
if capture_running_mutators stale_capture; then
  fail "failed running-service discovery was reported as successful"
fi
unset FAKE_DOCKER_FAIL_PS
[[ "${#stale_capture[@]}" -eq 0 ]] || fail "failed capture retained a stale running set"

cat >"$FAKE_DOCKER_RUNNING" <<'RUNNING_FOR_CLEANUP'
mail-worker
cloudflared
postgres
RUNNING_FOR_CLEANUP
: >"$FAKE_DOCKER_LOG"
set +e
PATH="$PATH" \
FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
FAKE_DOCKER_RUNNING="$FAKE_DOCKER_RUNNING" \
FAKE_COMPOSE_ENV="$FAKE_COMPOSE_ENV" \
FAKE_COMPOSE_FILE="$FAKE_COMPOSE_FILE" \
COMPOSE_ENV_FILE="$COMPOSE_ENV_FILE" \
REPO_ROOT="$REPO_ROOT" \
bash -Eeuo pipefail -c '
  source "$1"
  captured_for_cleanup=()
  cleanup() {
    local status=$?
    trap - EXIT
    resume_mutators captured_for_cleanup || true
    exit "$status"
  }
  trap cleanup EXIT
  capture_running_mutators captured_for_cleanup
  quiesce_mutators captured_for_cleanup
  false
' _ "$common"
cleanup_status=$?
set -e
[[ "$cleanup_status" -ne 0 ]] || fail "synthetic post-quiesce failure lost its exit status"
grep -Fqx 'event=stop service=mail-worker' "$FAKE_DOCKER_LOG" \
  || fail "synthetic cleanup harness did not quiesce the captured worker"
grep -Fqx 'event=up service=mail-worker' "$FAKE_DOCKER_LOG" \
  || fail "EXIT cleanup did not resume the captured worker"
if grep -Fqx 'event=up service=postgres' "$FAKE_DOCKER_LOG"; then
  fail "EXIT cleanup resumed PostgreSQL"
fi
[[ "$(grep '^event=up ' "$FAKE_DOCKER_LOG" | tail -n 1)" == 'event=up service=cloudflared' ]] \
  || fail "EXIT cleanup did not expose cloudflared last"

echo "backup-consistency-tests-ok"
