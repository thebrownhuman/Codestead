#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="$repo_root/infra/runner/run-runner.sh"
runner_unit="$repo_root/infra/runner/learncoding-runner.service.example"
runner_env="$repo_root/infra/env/runner.env.example"
if [[ ! -x /usr/bin/flock ]]; then
  echo 'FAIL: runner reconciliation contract requires Ubuntu/GNU /usr/bin/flock' >&2
  exit 1
fi
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
{
  printf '%q' "${1:-}"
  for argument in "${@:2}"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$TEST_DOCKER_LOG"
case "${1:-}" in
  ps)
    printf '%s\n' abc123 def456
    ;;
  rm)
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
[[ "$(wc -l <"$work/docker.log" | tr -d ' ')" == "3" ]]
grep -Fxq 'ps --all --quiet --filter label=io.learncoding.runner.job=true' "$work/docker.log"
grep -Fxq 'rm --force abc123' "$work/docker.log"
grep -Fxq 'rm --force def456' "$work/docker.log"

assert_rejected_before_docker() {
  local label="$1"
  shift
  : >"$work/rejected-docker.log"
  if TEST_DOCKER_LOG="$work/rejected-docker.log" RUNNER_DOCKER_BINARY="$work/docker" "$@"; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  [[ ! -s "$work/rejected-docker.log" ]] || {
    echo "$label reached Docker before rejecting unsafe configuration" >&2
    exit 1
  }
}

assert_rejected_before_docker \
  'missing runner secret' \
  env RUNNER_SHARED_SECRET_FILE="$work/missing-secret" RUNNER_STATE_ROOT="$work/missing-secret-state" \
    RUNNER_TEMP_ROOT="$work/missing-secret-tmp" sh "$launcher" >/dev/null 2>&1

printf '%s' short >"$work/short-secret"
chmod 0600 "$work/short-secret"
assert_rejected_before_docker \
  'short runner secret' \
  env RUNNER_SHARED_SECRET_FILE="$work/short-secret" RUNNER_STATE_ROOT="$work/short-secret-state" \
    RUNNER_TEMP_ROOT="$work/short-secret-tmp" sh "$launcher" >/dev/null 2>&1

assert_rejected_before_docker \
  'wrong runner concurrency' \
  env RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_MAX_CONCURRENCY=3 RUNNER_STATE_ROOT="$work/concurrency-state" \
    RUNNER_TEMP_ROOT="$work/concurrency-tmp" sh "$launcher" >/dev/null 2>&1

mkdir -m 0755 "$work/bad-mode-state"
assert_rejected_before_docker \
  'unsafe runner state mode' \
  env RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-mode-state" \
    RUNNER_TEMP_ROOT="$work/bad-mode-tmp" sh "$launcher" >/dev/null 2>&1

mkdir -m 0700 "$work/bad-temp-state"
mkdir -m 0755 "$work/bad-mode-tmp"
assert_rejected_before_docker \
  'unsafe runner temp mode' \
  env RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-temp-state" \
    RUNNER_TEMP_ROOT="$work/bad-mode-tmp" sh "$launcher" >/dev/null 2>&1

mkdir -m 0700 "$work/owner-state" "$work/owner-bin"
cat >"$work/owner-bin/stat" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
target="\${!#}"
[[ "\$#" == 4 && "\${1:-}" == -c && "\${3:-}" == -- && "\$target" == "$work/owner-state" ]] || exit 97
case "\${2:-}" in
  %a) exec /usr/bin/stat -c '%a' -- "$work/owner-state" ;;
  %u) printf '%s\\n' 999999 ;;
  *) exit 64 ;;
esac
EOF
chmod 0755 "$work/owner-bin/stat"
: >"$work/rejected-docker.log"
if PATH="$work/owner-bin:$PATH" TEST_DOCKER_LOG="$work/rejected-docker.log" RUNNER_DOCKER_BINARY="$work/docker" \
  RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/owner-state" \
  RUNNER_TEMP_ROOT="$work/owner-tmp" sh "$launcher" >/dev/null 2>&1; then
  echo 'unsafe runner state owner unexpectedly succeeded' >&2
  exit 1
fi
[[ ! -s "$work/rejected-docker.log" ]]

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
[[ "$(wc -l <"$work/locked-docker.log" | tr -d ' ')" == "3" ]]
grep -Fxq 'ps --all --quiet --filter label=io.learncoding.runner.job=true' "$work/locked-docker.log"
[[ "$(cat "$work/locked-state/state-sentinel")" == "state-must-remain-unchanged" ]]

contract_failures=()
expect_exact_assignment() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local count
  count="$(grep -Ec "^${key}=" "$file" || true)"
  if [[ "$count" != 1 ]] || ! grep -Fxq -- "$expected" "$file"; then contract_failures+=("$label"); fi
}

expect_exact_assignment "$runner_unit" Restart 'Restart=on-failure' 'runner unit must restart only on failure'
expect_exact_assignment "$runner_unit" RestartSec 'RestartSec=5s' 'runner unit must use a five-second restart delay'
expect_exact_assignment "$runner_unit" StateDirectoryMode 'StateDirectoryMode=0700' 'runner unit must retain a mode-0700 state directory'
expect_exact_assignment "$runner_unit" LimitCORE 'LimitCORE=0' 'runner unit must disable learner-memory core dumps'
expect_exact_assignment "$runner_env" RUNNER_HOST 'RUNNER_HOST=10.20.0.12' 'runner must bind only to the fixed private guest address'
expect_exact_assignment "$runner_env" RUNNER_PORT 'RUNNER_PORT=4100' 'runner must expose only the private API port'
expect_exact_assignment "$runner_env" RUNNER_MAX_CONCURRENCY 'RUNNER_MAX_CONCURRENCY=2' 'runner must expose exactly two concurrent slots'
expect_exact_assignment "$runner_env" RUNNER_MAX_QUEUE_DEPTH 'RUNNER_MAX_QUEUE_DEPTH=100' 'runner queue must use the reviewed finite depth'

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
