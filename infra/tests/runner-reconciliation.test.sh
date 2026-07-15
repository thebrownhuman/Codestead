#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash_bin="$(command -v bash)"
sh_bin="$(command -v sh)"
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
chmod 0440 "$work/secret"
printf '#!%s\n' "$bash_bin" >"$work/docker"
cat >>"$work/docker" <<'EOF'
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
  RUNNER_MAX_QUEUE_DEPTH=100 \
  RUNNER_STATE_ROOT="$work/state" \
  RUNNER_TEMP_ROOT="$work/tmp" \
  TEST_DOCKER_LOG="$work/docker.log" \
  "$sh_bin" "$launcher" >/dev/null 2>&1; then
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

assert_rejected_before_reconciliation() {
  local label="$1"
  local state_path="$2"
  local temp_path="$3"
  shift 3
  assert_rejected_before_docker "$label" "$@"
  [[ ! -e "$state_path" && ! -e "$temp_path" ]] || {
    echo "$label created state/temp before rejecting unsafe configuration" >&2
    exit 1
  }
}

assert_directory_empty() {
  local directory="$1"
  local -a entries=()
  shopt -s nullglob dotglob
  entries=("$directory"/*)
  shopt -u nullglob dotglob
  (( ${#entries[@]} == 0 )) || {
    echo "unsafe configuration wrote beneath $directory before rejection" >&2
    exit 1
  }
}

make_stat_ownership_override() {
  local bin_dir="$1"
  local target_path="$2"
  local override_kind="$3"
  local actual_uid
  local actual_gid
  actual_uid="$(id -u)"
  actual_gid="$(id -g)"
  mkdir -m 0700 "$bin_dir"
  printf '#!%s\n' "$bash_bin" >"$bin_dir/stat"
  cat >>"$bin_dir/stat" <<EOF
set -Eeuo pipefail
target="\${!#}"
[[ "\$#" == 4 && "\${1:-}" == -c && "\${3:-}" == -- && "\$target" == "$work"/* ]] || exit 97
if [[ "\$target" != "$target_path" ]]; then exec /usr/bin/stat "\$@"; fi
case "$override_kind:\${2:-}" in
  owner:%u) printf '%s\\n' 999999 ;;
  owner:%g) printf '%s\\n' "$actual_gid" ;;
  owner:%u:%g:%a) printf '%s\\n' "999999:$actual_gid:\$(/usr/bin/stat -c '%a' -- \"\$target\")" ;;
  group:%u) printf '%s\\n' "$actual_uid" ;;
  group:%g) printf '%s\\n' 999999 ;;
  group:%u:%g:%a) printf '%s\\n' "$actual_uid:999999:\$(/usr/bin/stat -c '%a' -- \"\$target\")" ;;
  *) exec /usr/bin/stat "\$@" ;;
esac
EOF
  chmod 0755 "$bin_dir/stat"
}

assert_rejected_before_reconciliation \
  'missing runner secret' \
  "$work/missing-secret-state" "$work/missing-secret-tmp" \
  env RUNNER_SHARED_SECRET_FILE="$work/missing-secret" RUNNER_STATE_ROOT="$work/missing-secret-state" \
    RUNNER_TEMP_ROOT="$work/missing-secret-tmp" RUNNER_MAX_QUEUE_DEPTH=100 "$sh_bin" "$launcher" >/dev/null 2>&1

printf '%s' short >"$work/short-secret"
chmod 0440 "$work/short-secret"
assert_rejected_before_reconciliation \
  'short runner secret' \
  "$work/short-secret-state" "$work/short-secret-tmp" \
  env RUNNER_SHARED_SECRET_FILE="$work/short-secret" RUNNER_STATE_ROOT="$work/short-secret-state" \
    RUNNER_TEMP_ROOT="$work/short-secret-tmp" RUNNER_MAX_QUEUE_DEPTH=100 "$sh_bin" "$launcher" >/dev/null 2>&1

cp "$work/secret" "$work/secret-bad-mode"
chmod 0640 "$work/secret-bad-mode"
assert_rejected_before_reconciliation \
  'secret mode must be exact 0440' \
  "$work/secret-mode-state" "$work/secret-mode-tmp" \
  env RUNNER_SHARED_SECRET_FILE="$work/secret-bad-mode" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-mode-state" RUNNER_TEMP_ROOT="$work/secret-mode-tmp" \
    "$sh_bin" "$launcher" >/dev/null 2>&1

cp "$work/secret" "$work/secret-bad-owner"
chmod 0440 "$work/secret-bad-owner"
make_stat_ownership_override "$work/secret-owner-bin" "$work/secret-bad-owner" owner
assert_rejected_before_reconciliation \
  'secret owner must match the runner ownership contract' \
  "$work/secret-owner-state" "$work/secret-owner-tmp" \
  env PATH="$work/secret-owner-bin:$PATH" RUNNER_SHARED_SECRET_FILE="$work/secret-bad-owner" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-owner-state" RUNNER_TEMP_ROOT="$work/secret-owner-tmp" \
    "$sh_bin" "$launcher" >/dev/null 2>&1

cp "$work/secret" "$work/secret-bad-group"
chmod 0440 "$work/secret-bad-group"
make_stat_ownership_override "$work/secret-group-bin" "$work/secret-bad-group" group
assert_rejected_before_reconciliation \
  'secret ownership group must match the runner' \
  "$work/secret-group-state" "$work/secret-group-tmp" \
  env PATH="$work/secret-group-bin:$PATH" RUNNER_SHARED_SECRET_FILE="$work/secret-bad-group" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-group-state" RUNNER_TEMP_ROOT="$work/secret-group-tmp" \
    "$sh_bin" "$launcher" >/dev/null 2>&1

cp "$work/secret" "$work/secret-target"
chmod 0440 "$work/secret-target"
[[ "$(stat -c '%u:%g:%a' -- "$work/secret-target")" == "$(stat -c '%u:%g:%a' -- "$work/secret")" ]]
ln -s "$work/secret-target" "$work/secret-symlink"
assert_rejected_before_reconciliation \
  'secret symlink must be rejected' \
  "$work/secret-symlink-state" "$work/secret-symlink-tmp" \
  env RUNNER_SHARED_SECRET_FILE="$work/secret-symlink" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-symlink-state" RUNNER_TEMP_ROOT="$work/secret-symlink-tmp" \
    "$sh_bin" "$launcher" >/dev/null 2>&1

assert_rejected_before_reconciliation \
  'wrong runner concurrency' \
  "$work/concurrency-state" "$work/concurrency-tmp" \
  env RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_MAX_CONCURRENCY=3 RUNNER_STATE_ROOT="$work/concurrency-state" \
    RUNNER_TEMP_ROOT="$work/concurrency-tmp" RUNNER_MAX_QUEUE_DEPTH=100 "$sh_bin" "$launcher" >/dev/null 2>&1

while IFS='|' read -r queue_label queue_value; do
  queue_state="$work/queue-$queue_label-state"
  queue_temp="$work/queue-$queue_label-tmp"
  if [[ "$queue_label" == missing ]]; then
    assert_rejected_before_reconciliation \
      'queue depth missing' "$queue_state" "$queue_temp" \
      env -u RUNNER_MAX_QUEUE_DEPTH RUNNER_SHARED_SECRET_FILE="$work/secret" \
        RUNNER_STATE_ROOT="$queue_state" RUNNER_TEMP_ROOT="$queue_temp" "$sh_bin" "$launcher" >/dev/null 2>&1
  else
    assert_rejected_before_reconciliation \
      "queue depth $queue_label" "$queue_state" "$queue_temp" \
      env RUNNER_MAX_QUEUE_DEPTH="$queue_value" RUNNER_SHARED_SECRET_FILE="$work/secret" \
        RUNNER_STATE_ROOT="$queue_state" RUNNER_TEMP_ROOT="$queue_temp" "$sh_bin" "$launcher" >/dev/null 2>&1
  fi
done <<'EOF'
missing|
zero|0
negative|-1
unbounded|unbounded
wrong|99
upper-bound|101
oversized|2147483647
EOF

mkdir -m 0755 "$work/bad-mode-state"
assert_rejected_before_docker \
  'unsafe runner state mode' \
  env RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-mode-state" \
    RUNNER_TEMP_ROOT="$work/bad-mode-tmp" RUNNER_MAX_QUEUE_DEPTH=100 "$sh_bin" "$launcher" >/dev/null 2>&1
[[ ! -e "$work/bad-mode-state/.runner-process.lock" && ! -e "$work/bad-mode-tmp" ]]

mkdir -m 0700 "$work/bad-temp-state"
mkdir -m 0755 "$work/bad-mode-tmp"
assert_rejected_before_docker \
  'unsafe runner temp mode' \
  env RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-temp-state" \
    RUNNER_TEMP_ROOT="$work/bad-mode-tmp" RUNNER_MAX_QUEUE_DEPTH=100 "$sh_bin" "$launcher" >/dev/null 2>&1
assert_directory_empty "$work/bad-mode-tmp"

mkdir -m 0700 "$work/bad-owner-temp-state" "$work/bad-owner-tmp"
make_stat_ownership_override "$work/temp-owner-bin" "$work/bad-owner-tmp" owner
assert_rejected_before_docker \
  'unsafe runner temp owner' \
  env PATH="$work/temp-owner-bin:$PATH" RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-owner-temp-state" \
    RUNNER_TEMP_ROOT="$work/bad-owner-tmp" RUNNER_MAX_QUEUE_DEPTH=100 "$sh_bin" "$launcher" >/dev/null 2>&1
assert_directory_empty "$work/bad-owner-tmp"

mkdir -m 0700 "$work/owner-state"
make_stat_ownership_override "$work/owner-bin" "$work/owner-state" owner
: >"$work/rejected-docker.log"
if PATH="$work/owner-bin:$PATH" TEST_DOCKER_LOG="$work/rejected-docker.log" RUNNER_DOCKER_BINARY="$work/docker" \
  RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/owner-state" \
  RUNNER_TEMP_ROOT="$work/owner-tmp" RUNNER_MAX_QUEUE_DEPTH=100 "$sh_bin" "$launcher" >/dev/null 2>&1; then
  echo 'unsafe runner state owner unexpectedly succeeded' >&2
  exit 1
fi
[[ ! -s "$work/rejected-docker.log" ]]
[[ ! -e "$work/owner-state/.runner-process.lock" && ! -e "$work/owner-tmp" ]]

printf '#!%s\n' "$bash_bin" >"$work/docker-invalid"
cat >>"$work/docker-invalid" <<'EOF'
set -eu
if [[ "${1:-}" == "ps" ]]; then printf '%s\n' 'not-a-container-id'; exit 0; fi
exit 91
EOF
chmod 0755 "$work/docker-invalid"
if RUNNER_SHARED_SECRET_FILE="$work/secret" \
  RUNNER_DOCKER_BINARY="$work/docker-invalid" \
  RUNNER_MAX_QUEUE_DEPTH=100 \
  RUNNER_STATE_ROOT="$work/invalid-state" \
  RUNNER_TEMP_ROOT="$work/invalid-tmp" \
  "$sh_bin" "$launcher" >/dev/null 2>&1; then
  echo "runner launcher accepted an invalid Docker container id" >&2
  exit 1
fi
[[ -d "$work/invalid-tmp" ]]

mkdir -m 0700 "$work/locked-state"
: >"$work/locked-docker.log"
printf '%s' 'state-must-remain-unchanged' >"$work/locked-state/state-sentinel"
/usr/bin/flock --exclusive --no-fork "$work/locked-state/.runner-process.lock" \
  "$sh_bin" -c 'touch "$1"; exec sleep 30' _ "$work/lock-ready" &
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
      RUNNER_MAX_QUEUE_DEPTH=100 \
      RUNNER_STATE_ROOT="$work/locked-state" \
      RUNNER_TEMP_ROOT="$work/locked-tmp" \
      TEST_DOCKER_LOG="$work/locked-docker.log" \
      "$sh_bin" "$launcher" >/dev/null 2>&1; then
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
  RUNNER_MAX_QUEUE_DEPTH=100 \
  RUNNER_STATE_ROOT="$work/locked-state" \
  RUNNER_TEMP_ROOT="$work/locked-tmp" \
  TEST_DOCKER_LOG="$work/locked-docker.log" \
  "$sh_bin" "$launcher" >/dev/null 2>&1; then
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
