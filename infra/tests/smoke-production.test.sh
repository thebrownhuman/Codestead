#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
smoke="$repo_root/infra/ops/smoke-production.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
compose_env="$work/compose.env"
compose_file="$work/compose.yaml"
touch "$compose_env" "$compose_file"

cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

{
  printf '%s' "${1:-}"
  shift || true
  printf '\t%s' "$@"
  printf '\n'
} >>"$FAKE_DOCKER_LOG"

unknown() {
  echo "fake docker rejected unknown command" >&2
  exit 64
}

[[ "${1:-}" == "--env-file" ]] || unknown
[[ "${2:-}" == "$EXPECTED_COMPOSE_ENV" ]] || unknown
[[ "${3:-}" == "-f" ]] || unknown
[[ "${4:-}" == "$EXPECTED_COMPOSE_FILE" ]] || unknown
shift 4

scenario="${FAKE_SCENARIO:?}"

if [[ "$#" == 2 && "$1" == "config" && "$2" == "--services" ]]; then
  case "$scenario" in
    missing-reward)
      printf '%s\n' app postgres cloudflared migrate mail-worker regrade-worker \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker
      ;;
    forbidden-clamav)
      printf '%s\n' reward-worker app postgres cloudflared migrate mail-worker regrade-worker \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker clamav
      ;;
    forbidden-scan-worker)
      printf '%s\n' reward-worker app postgres cloudflared migrate mail-worker regrade-worker \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker scan-worker
      ;;
    *)
      printf '%s\n' reward-worker app postgres cloudflared migrate mail-worker regrade-worker \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker
      ;;
  esac
  exit 0
fi

if [[ "$#" == 3 && "$1" == "ps" && "$2" == "--all" && "$3" == "--services" ]]; then
  printf '%s\n' reward-worker app postgres cloudflared migrate mail-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker
  case "$scenario" in
    stopped-clamav) printf '%s\n' clamav ;;
    stopped-scan-worker) printf '%s\n' scan-worker ;;
    stopped-extra) printf '%s\n' stale-worker ;;
  esac
  exit 0
fi

if [[ "$#" == 4 && "$1" == "ps" && "$2" == "--services" && "$3" == "--status" && "$4" == "running" ]]; then
  if [[ "$scenario" == "stopped-reward" ]]; then
    printf '%s\n' cloudflared postgres app mail-worker regrade-worker \
      exam-finalization-worker project-review-correction-worker practice-runner-recovery-worker
  else
    printf '%s\n' cloudflared reward-worker postgres app mail-worker regrade-worker \
      exam-finalization-worker project-review-correction-worker practice-runner-recovery-worker
  fi
  exit 0
fi

if [[ "$#" == 5 && "$1" == "ps" && "$2" == "--all" && "$3" == "--format" && \
  "$4" == '{{.State}} {{.ExitCode}}' && "$5" == "migrate" ]]; then
  case "$scenario" in
    migration-nonzero) printf '%s\n' 'exited 17' ;;
    migration-running) printf '%s\n' 'running 0' ;;
    *) printf '%s\n' 'exited 0' ;;
  esac
  exit 0
fi

if [[ "$#" == 6 && "$1" == "exec" && "$2" == "-T" && "$3" == "app" && \
  "$4" == "node" && "$5" == "-e" ]]; then
  node_program="$6"
  if [[ "$node_program" == *"/health/ready"* ]]; then
    [[ "$node_program" == *"redirect"* && "$node_program" == *"manual"* ]] || unknown
    [[ "$node_program" == *"status !== 200"* ]] || unknown
    case "$scenario" in
      readiness-failure) exit 23 ;;
      readiness-hangs)
        sleep 10 &
        child_pid="$!"
        printf '%s\n' "$child_pid" >"$FAKE_HANG_PID_FILE"
        wait "$child_pid"
        exit 0
        ;;
      *) exit 0 ;;
    esac
  fi
  if [[ "$node_program" == *"process.env.UPLOADS_ENABLED"* ]]; then
    [[ "$node_program" == *"false"* ]] || unknown
    [[ "$scenario" == "uploads-enabled" ]] && exit 24
    exit 0
  fi
  unknown
fi

if [[ "$#" == 6 && "$1" == "exec" && "$2" == "-T" && "$3" == "postgres" && \
  "$4" == "sh" && "$5" == "-ceu" ]]; then
  psql_program="$6"
  for required in \
    'exec psql' \
    '--no-psqlrc' \
    '--tuples-only' \
    '--no-align' \
    'ON_ERROR_STOP=1' \
    'show fsync;' \
    'show synchronous_commit;' \
    'show full_page_writes;'; do
    [[ "$psql_program" == *"$required"* ]] || unknown
  done
  if [[ "$scenario" == "durability-drift" ]]; then
    printf '%s\n' on off on
  else
    printf '%s\n' on on on
  fi
  exit 0
fi

if [[ "$#" == 5 && "$1" == "ps" && "$2" == "--all" && "$3" == "--format" && \
  "$4" == '{{.Health}}' && "$5" == "cloudflared" ]]; then
  if [[ "$scenario" == "tunnel-unhealthy" ]]; then
    printf '%s\n' unhealthy
  else
    printf '%s\n' healthy
  fi
  exit 0
fi

unknown
EOF
chmod 0755 "$work/bin/docker"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$smoke" ]] || fail "smoke-production.sh is missing"

run_scenario() {
  local scenario="$1"
  local startup_wait="${2:-1}"

  : >"$work/docker.log"
  : >"$work/hang.pid"
  : >"$work/stdout"
  : >"$work/stderr"

  PATH="$work/bin:/usr/bin:/bin" \
    COMPOSE_ENV_FILE="$compose_env" \
    COMPOSE_FILE_PATH="$compose_file" \
    EXPECTED_COMPOSE_ENV="$compose_env" \
    EXPECTED_COMPOSE_FILE="$compose_file" \
    FAKE_DOCKER_LOG="$work/docker.log" \
    FAKE_HANG_PID_FILE="$work/hang.pid" \
    FAKE_SCENARIO="$scenario" \
    bash "$smoke" --startup-wait "$startup_wait" >"$work/stdout" 2>"$work/stderr"
}

if ! run_scenario success 2; then
  cat "$work/stderr" >&2
  fail "shuffled healthy pilot was rejected"
fi
[[ "$(cat "$work/stdout")" == "production smoke passed" ]] || {
  fail "success stdout must be exactly production smoke passed"
}
[[ ! -s "$work/stderr" ]] || fail "successful smoke wrote diagnostics"
grep -Fq $'config\t--services' "$work/docker.log" || fail "pilot inventory was not checked"
grep -Fq $'ps\t--services\t--status\trunning' "$work/docker.log" || fail "running services were not checked"
grep -Fq '/health/ready' "$work/docker.log" || fail "readiness endpoint was not checked inside app"
grep -Fq 'process.env.UPLOADS_ENABLED' "$work/docker.log" || fail "pilot upload flag was not checked"
[[ "$(grep -Fc $'exec\t-T\tpostgres' "$work/docker.log")" == "1" ]] || {
  fail "durability settings must use one PostgreSQL exec"
}
for setting in 'show fsync;' 'show synchronous_commit;' 'show full_page_writes;'; do
  grep -Fq "$setting" "$work/docker.log" || fail "missing durability query: $setting"
done
echo "ok - shuffled healthy pilot"

expect_failure() {
  local scenario="$1"
  local label="$2"
  local startup_wait="${3:-1}"

  if run_scenario "$scenario" "$startup_wait"; then
    fail "$label was accepted"
  fi
  if grep -Fxq 'production smoke passed' "$work/stdout"; then
    fail "$label printed the success marker"
  fi
  echo "ok - $label"
}

expect_failure missing-reward "missing reward-worker"
expect_failure stopped-reward "stopped reward-worker"
expect_failure forbidden-clamav "forbidden clamav service"
expect_failure forbidden-scan-worker "forbidden scan-worker service"
expect_failure stopped-clamav "stopped clamav container"
expect_failure stopped-scan-worker "stopped scan-worker container"
expect_failure stopped-extra "arbitrary stopped extra container"
expect_failure migration-nonzero "nonzero migration"
expect_failure migration-running "still-running migration"
expect_failure uploads-enabled "enabled uploads in pilot"
expect_failure readiness-failure "failed app readiness"
expect_failure durability-drift "PostgreSQL durability drift"
expect_failure tunnel-unhealthy "unhealthy cloudflared"

started="$SECONDS"
expect_failure readiness-hangs "hanging app readiness" 2
elapsed="$((SECONDS - started))"
(( elapsed <= 4 )) || fail "hanging readiness exceeded the startup deadline: ${elapsed}s"
hang_pid="$(cat "$work/hang.pid")"
[[ "$hang_pid" =~ ^[1-9][0-9]*$ ]] || fail "hanging readiness did not record its descendant PID"
for _ in {1..20}; do
  kill -0 "$hang_pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$hang_pid" 2>/dev/null; then
  kill -KILL "$hang_pid" 2>/dev/null || true
  fail "hanging readiness descendant survived the startup deadline: PID $hang_pid"
fi

if PATH="$work/bin:/usr/bin:/bin" bash "$smoke" --startup-wait invalid >/dev/null 2>&1; then
  fail "non-numeric startup wait was accepted"
fi

echo "smoke-production-tests-ok"
