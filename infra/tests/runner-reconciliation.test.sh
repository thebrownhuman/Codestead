#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="$repo_root/infra/runner/run-runner.sh"
work="$(mktemp -d)"
lock_holder=""
cleanup() {
  if [[ -n "$lock_holder" ]]; then
    kill "$lock_holder" 2>/dev/null || true
    wait "$lock_holder" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

printf '%s' 'runner-test-secret-is-at-least-thirty-two-bytes' >"$work/secret"
chmod 0600 "$work/secret"
cat >"$work/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
case "${1:-}" in
  ps)
    printf '%s\n' abc123 def456
    ;;
  rm)
    printf '%s\n' "$*" >>"$TEST_DOCKER_LOG"
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0755 "$work/docker"

if RUNNER_SHARED_SECRET_FILE="$work/secret" \
  RUNNER_DOCKER_BINARY="$work/docker" \
  RUNNER_STATE_ROOT="$work/state" \
  RUNNER_TEMP_ROOT="$work/tmp" \
  TEST_DOCKER_LOG="$work/docker.log" \
  sh "$launcher" >/dev/null 2>&1; then
  echo "test launcher unexpectedly reached a runnable production Node entrypoint" >&2
  exit 1
fi

[[ -d "$work/tmp" ]]
[[ "$(wc -l <"$work/docker.log" | tr -d ' ')" == "2" ]]
grep -Fxq 'rm --force abc123' "$work/docker.log"
grep -Fxq 'rm --force def456' "$work/docker.log"

cat >"$work/docker-invalid" <<'EOF'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "ps" ]]; then printf '%s\n' 'not-a-container-id'; exit 0; fi
exit 91
EOF
chmod 0755 "$work/docker-invalid"
if RUNNER_SHARED_SECRET_FILE="$work/secret" \
  RUNNER_DOCKER_BINARY="$work/docker-invalid" \
  RUNNER_STATE_ROOT="$work/invalid-state" \
  RUNNER_TEMP_ROOT="$work/invalid-tmp" \
  sh "$launcher" >/dev/null 2>&1; then
  echo "runner launcher accepted an invalid Docker container id" >&2
  exit 1
fi
[[ -d "$work/invalid-tmp" ]]

mkdir -m 0700 "$work/locked-state"
: >"$work/locked-docker.log"
printf '%s' 'state-must-remain-unchanged' >"$work/locked-state/state-sentinel"
/usr/bin/flock --exclusive --no-fork "$work/locked-state/.runner-process.lock" \
  sh -c 'touch "$1"; exec sleep 30' _ "$work/lock-ready" &
lock_holder=$!
for _ in $(seq 1 100); do
  [[ -f "$work/lock-ready" ]] && break
  sleep 0.01
done
[[ -f "$work/lock-ready" ]]

contenders=()
for _ in $(seq 1 12); do
  (
    if RUNNER_SHARED_SECRET_FILE="$work/secret" \
      RUNNER_DOCKER_BINARY="$work/docker" \
      RUNNER_STATE_ROOT="$work/locked-state" \
      RUNNER_TEMP_ROOT="$work/locked-tmp" \
      TEST_DOCKER_LOG="$work/locked-docker.log" \
      sh "$launcher" >/dev/null 2>&1; then
      echo "duplicate runner launcher unexpectedly acquired the process lock" >&2
      exit 1
    fi
  ) &
  contenders+=("$!")
done
for contender in "${contenders[@]}"; do wait "$contender"; done
[[ ! -s "$work/locked-docker.log" ]]
[[ ! -d "$work/locked-tmp" ]]
[[ "$(cat "$work/locked-state/state-sentinel")" == "state-must-remain-unchanged" ]]
kill "$lock_holder"
wait "$lock_holder" 2>/dev/null || true
lock_holder=""

if RUNNER_SHARED_SECRET_FILE="$work/secret" \
  RUNNER_DOCKER_BINARY="$work/docker" \
  RUNNER_STATE_ROOT="$work/locked-state" \
  RUNNER_TEMP_ROOT="$work/locked-tmp" \
  TEST_DOCKER_LOG="$work/locked-docker.log" \
  sh "$launcher" >/dev/null 2>&1; then
  echo "test launcher unexpectedly reached a runnable production Node entrypoint" >&2
  exit 1
fi
[[ "$(wc -l <"$work/locked-docker.log" | tr -d ' ')" == "2" ]]
[[ "$(cat "$work/locked-state/state-sentinel")" == "state-must-remain-unchanged" ]]

echo "runner-reconciliation-tests-ok"
