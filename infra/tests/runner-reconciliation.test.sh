#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="$repo_root/infra/runner/run-runner.sh"
runner_unit="$repo_root/infra/runner/learncoding-runner.service.example"
runner_env="$repo_root/infra/env/runner.env.example"
tmp_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
work="$(mktemp -d "$tmp_base/runner-reconciliation.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'runner reconciliation fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
lock_holder=""
cleanup() {
  if [[ -n "$lock_holder" ]]; then
    kill "$lock_holder" 2>/dev/null || true
    wait "$lock_holder" 2>/dev/null || true
  fi
  if [[ -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
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
    {
      printf '%q' "$1"
      shift
      for argument in "$@"; do printf ' %q' "$argument"; done
      printf '\n'
    } >>"$TEST_DOCKER_LOG"
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

contract_failures=()
expect_exact_line() {
  local file="$1"
  local expected="$2"
  local label="$3"
  local count
  count="$(grep -Fxc -- "$expected" "$file" || true)"
  if [[ "$count" != 1 ]]; then contract_failures+=("$label"); fi
}

expect_exact_line "$runner_unit" 'Restart=on-failure' 'runner unit must restart only on failure'
expect_exact_line "$runner_unit" 'RestartSec=5s' 'runner unit must use a five-second restart delay'
expect_exact_line "$runner_unit" 'StateDirectoryMode=0700' 'runner unit must retain a mode-0700 state directory'
expect_exact_line "$runner_unit" 'LimitCORE=0' 'runner unit must disable learner-memory core dumps'
expect_exact_line "$runner_env" 'RUNNER_HOST=10.20.0.12' 'runner must bind only to the fixed private guest address'
expect_exact_line "$runner_env" 'RUNNER_MAX_CONCURRENCY=2' 'runner must expose exactly two concurrent slots'

start_limit_lines="$(grep -Ec '^StartLimitBurst=([1-9]|10)$' "$runner_unit" || true)"
all_start_limit_lines="$(grep -Ec '^StartLimitBurst=' "$runner_unit" || true)"
if [[ "$start_limit_lines" != 1 || "$all_start_limit_lines" != 1 ]]; then
  contract_failures+=('runner unit must set one nonzero bounded StartLimitBurst no greater than 10')
fi
if grep -Eiq '(^|[=:[:space:]])(0\.0\.0\.0|\[?::\]?)(:|$)|RUNNER_HOST=(localhost|127\.0\.0\.1)' "$runner_env"; then
  contract_failures+=('runner environment must not contain a wildcard, localhost, or public bind')
fi

if (( ${#contract_failures[@]} > 0 )); then
  echo 'runner unit/environment contract failed:' >&2
  for failure in "${contract_failures[@]}"; do printf -- '- %s\n' "$failure" >&2; done
  exit 1
fi

echo "runner-reconciliation-tests-ok"
