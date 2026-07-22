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
phase="${FAKE_SMOKE_PHASE:?}"

if [[ "$#" == 2 && "$1" == "config" && "$2" == "--services" ]]; then
  case "$scenario" in
    missing-file-erasure)
      printf '%s\n' reward-worker app postgres cloudflared mail-worker regrade-worker runner-egress-gateway \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker
      ;;
    missing-reward)
      printf '%s\n' file-erasure-worker app postgres cloudflared mail-worker regrade-worker runner-egress-gateway \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker
      ;;
    forbidden-clamav)
      printf '%s\n' reward-worker file-erasure-worker app postgres cloudflared mail-worker regrade-worker runner-egress-gateway \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker clamav
      ;;
    forbidden-scan-worker)
      printf '%s\n' reward-worker file-erasure-worker app postgres cloudflared mail-worker regrade-worker runner-egress-gateway \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker scan-worker
      ;;
    *)
      printf '%s\n' reward-worker file-erasure-worker app postgres cloudflared mail-worker regrade-worker runner-egress-gateway \
        exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker
      ;;
  esac
  exit 0
fi

if [[ "$#" == 3 && "$1" == "ps" && "$2" == "--all" && "$3" == "--services" ]]; then
  printf '%s\n' reward-worker file-erasure-worker app postgres cloudflared mail-worker regrade-worker runner-egress-gateway \
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
    printf '%s\n' cloudflared file-erasure-worker postgres app mail-worker regrade-worker runner-egress-gateway \
      exam-finalization-worker project-review-correction-worker practice-runner-recovery-worker
  elif [[ "$scenario" == "stopped-file-erasure" ]]; then
    printf '%s\n' cloudflared reward-worker postgres app mail-worker regrade-worker runner-egress-gateway \
      exam-finalization-worker project-review-correction-worker practice-runner-recovery-worker
  elif [[ "$phase" == "internal" ]]; then
    printf '%s\n' reward-worker file-erasure-worker postgres app mail-worker regrade-worker runner-egress-gateway \
      exam-finalization-worker project-review-correction-worker practice-runner-recovery-worker
  else
    printf '%s\n' cloudflared reward-worker file-erasure-worker postgres app mail-worker regrade-worker runner-egress-gateway \
      exam-finalization-worker project-review-correction-worker practice-runner-recovery-worker
  fi
  exit 0
fi

if [[ "$#" -ge 5 && "$1" == "ps" && "$2" == "--all" && "$3" == "--format" && \
  "$4" == '{{.Service}}|{{.Health}}' ]]; then
  shift 4
  for service in "$@"; do
    health=healthy
    if [[ "$scenario" == "worker-unhealthy" && "$service" == "reward-worker" ]]; then
      health=unhealthy
    elif [[ "$scenario" == "worker-starting" && "$service" == "mail-worker" ]]; then
      health=starting
    elif [[ "$scenario" == "worker-missing-health" && "$service" == "regrade-worker" ]]; then
      continue
    fi
    printf '%s|%s\n' "$service" "$health"
  done
  if [[ "$scenario" == "worker-extra-health" ]]; then
    printf '%s\n' 'unexpected-worker|healthy'
  fi
  exit 0
fi

if [[ "$#" == 8 && "$1" == "exec" && "$2" == "-T" && "$4" == "ip" && \
  "$5" == "-4" && "$6" == "route" && "$7" == "get" ]]; then
  if [[ "$3" == "app" && "$8" == "172.29.41.2" ]]; then
    if [[ "$scenario" == "app-route-drift" ]]; then
      printf '%s\n' '172.29.41.2 via 172.29.10.1 dev frontend src 172.29.10.10'
    else
      printf '%s\n' '172.29.41.2 dev runner-client src 172.29.41.3'
    fi
    exit 0
  fi
  if [[ "$3" == "runner-egress-gateway" && "$8" == "192.168.122.12" ]]; then
    if [[ "$scenario" == "gateway-route-drift" ]]; then
      printf '%s\n' '192.168.122.12 via 172.29.41.1 dev runner-client src 172.29.41.2'
    else
      printf '%s\n' '192.168.122.12 via 172.29.40.1 dev runner-egress src 172.29.40.2'
    fi
    exit 0
  fi
  unknown
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

if [[ "$#" == 5 && "$1" == "exec" && "$2" == "-T" && "$3" == "app" && \
  "$4" == "node" && "$5" == "-" ]]; then
  program="$(cat)"
  if [[ "$program" == *"production authenticated smoke passed"* ]]; then
    printf '%s' "$program" >"$FAKE_AUTH_PROGRAM"
    [[ "$phase" != "public" ]] || unknown
    [[ "$scenario" != "authenticated-smoke-failure" ]] || exit 25
    exit 0
  fi
  if [[ "$program" == *"production public smoke passed"* ]]; then
    printf '%s' "$program" >"$FAKE_PUBLIC_PROGRAM"
    [[ "$phase" != "internal" ]] || unknown
    [[ "$scenario" != "public-origin-failure" ]] || exit 26
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
  [[ "$phase" != "internal" ]] || unknown
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
  local phase="${2:-full}"
  local startup_wait="${3:-1}"

  : >"$work/docker.log"
  : >"$work/hang.pid"
  : >"$work/stdout"
  : >"$work/stderr"
  : >"$work/auth-program.mjs"
  : >"$work/public-program.mjs"

  PATH="$work/bin:/usr/bin:/bin" \
    COMPOSE_ENV_FILE="$compose_env" \
    COMPOSE_FILE_PATH="$compose_file" \
    EXPECTED_COMPOSE_ENV="$compose_env" \
    EXPECTED_COMPOSE_FILE="$compose_file" \
    FAKE_DOCKER_LOG="$work/docker.log" \
    FAKE_HANG_PID_FILE="$work/hang.pid" \
    FAKE_AUTH_PROGRAM="$work/auth-program.mjs" \
    FAKE_PUBLIC_PROGRAM="$work/public-program.mjs" \
    FAKE_SMOKE_PHASE="$phase" \
    FAKE_SCENARIO="$scenario" \
    bash "$smoke" --phase "$phase" --startup-wait "$startup_wait" >"$work/stdout" 2>"$work/stderr"
}

if ! run_scenario success full 2; then
  cat "$work/stderr" >&2
  fail "shuffled healthy pilot was rejected"
fi
[[ "$(cat "$work/stdout")" == "production smoke passed" ]] || {
  fail "success stdout must be exactly production smoke passed"
}
[[ ! -s "$work/stderr" ]] || fail "successful smoke wrote diagnostics"
grep -Fq $'config\t--services' "$work/docker.log" || fail "pilot inventory was not checked"
grep -Fq $'ps\t--services\t--status\trunning' "$work/docker.log" || fail "running services were not checked"
grep -Fq $'ps\t--all\t--format\t{{.Service}}|{{.Health}}' "$work/docker.log" \
  || fail "recent worker health was not checked"
grep -Fq $'exec\t-T\tapp\tip\t-4\troute\tget\t172.29.41.2' "$work/docker.log" \
  || fail "app-to-gateway route was not proved"
grep -Fq $'exec\t-T\trunner-egress-gateway\tip\t-4\troute\tget\t192.168.122.12' "$work/docker.log" \
  || fail "gateway-to-runner route was not proved"
app_route_line="$(grep -Fn -m1 $'exec\t-T\tapp\tip\t-4\troute\tget\t172.29.41.2' "$work/docker.log" | cut -d: -f1)"
gateway_route_line="$(grep -Fn -m1 $'exec\t-T\trunner-egress-gateway\tip\t-4\troute\tget\t192.168.122.12' "$work/docker.log" | cut -d: -f1)"
authenticated_line="$(grep -n -m1 $'exec\t-T\tapp\tnode\t-$' "$work/docker.log" | cut -d: -f1)"
[[ -n "$app_route_line" && -n "$gateway_route_line" && -n "$authenticated_line" ]] || \
  fail "runner-route ordering evidence is incomplete"
(( app_route_line < gateway_route_line && gateway_route_line < authenticated_line )) || \
  fail "runner route was not proved before the authenticated runner smoke"
grep -Fq '/health/ready' "$work/docker.log" || fail "readiness endpoint was not checked inside app"
grep -Fq 'process.env.UPLOADS_ENABLED' "$work/docker.log" || fail "pilot upload flag was not checked"
for required in \
  'drizzle.__drizzle_migrations' \
  'provider_policy' \
  'achievement' \
  'module_project_template' \
  '/api/auth/get-session' \
  '/api/files' \
  'UPLOADS_DISABLED' \
  '/api/code/run' \
  'codestead-production-smoke' \
  'makeSignature' \
  'pg_advisory_lock' \
  'pg_advisory_unlock' \
  'cleanupSyntheticFixtures' \
  'Production smoke learner' \
  'production-smoke-%@invalid.example' \
  'DELETE FROM runner_job' \
  'DELETE FROM code_submission'; do
  grep -Fq "$required" "$work/auth-program.mjs" || fail "authenticated smoke omitted: $required"
done
if grep -Fq '.catch(() => undefined)' "$work/auth-program.mjs"; then
  fail "authenticated smoke suppresses a cleanup or shutdown failure"
fi
lock_line="$(grep -n -m1 'pg_advisory_lock' "$work/auth-program.mjs" | cut -d: -f1)"
cleanup_line="$(grep -n -m1 'await cleanupSyntheticFixtures' "$work/auth-program.mjs" | cut -d: -f1)"
insert_line="$(grep -n -m1 'INSERT INTO' "$work/auth-program.mjs" | cut -d: -f1)"
[[ -n "$lock_line" && -n "$cleanup_line" && -n "$insert_line" ]] || {
  fail "authenticated smoke does not expose a deterministic fixture lifecycle"
}
(( lock_line < cleanup_line && cleanup_line < insert_line )) || {
  fail "stale fixture reconciliation does not run under the advisory lock before insertion"
}
for required in \
  'process.env.APP_URL' \
  'https:' \
  'strict-transport-security' \
  'content-security-policy' \
  'x-content-type-options' \
  'x-frame-options' \
  'referrer-policy' \
  'permissions-policy'; do
  grep -Fq "$required" "$work/public-program.mjs" || fail "public smoke omitted: $required"
done
[[ "$(grep -Fc $'exec\t-T\tpostgres' "$work/docker.log")" == "1" ]] || {
  fail "durability settings must use one PostgreSQL exec"
}
for setting in 'show fsync;' 'show synchronous_commit;' 'show full_page_writes;'; do
  grep -Fq "$setting" "$work/docker.log" || fail "missing durability query: $setting"
done
node "$repo_root/infra/tests/smoke-fixture-lifecycle.test.mjs" "$work/auth-program.mjs" || \
  fail "authenticated fixture lifecycle failed executable stale/cleanup testing"
echo "ok - shuffled healthy pilot"

expect_failure() {
  local scenario="$1"
  local label="$2"
  local phase="${3:-full}"
  local startup_wait="${4:-1}"

  if run_scenario "$scenario" "$phase" "$startup_wait"; then
    fail "$label was accepted"
  fi
  if grep -Fxq 'production smoke passed' "$work/stdout"; then
    fail "$label printed the success marker"
  fi
  echo "ok - $label"
}

expect_failure missing-file-erasure "missing file-erasure-worker"
expect_failure stopped-file-erasure "stopped file-erasure-worker"
expect_failure missing-reward "missing reward-worker"
expect_failure stopped-reward "stopped reward-worker"
expect_failure forbidden-clamav "forbidden clamav service"
expect_failure forbidden-scan-worker "forbidden scan-worker service"
expect_failure stopped-clamav "stopped clamav container"
expect_failure stopped-scan-worker "stopped scan-worker container"
expect_failure stopped-extra "arbitrary stopped extra container"
expect_failure uploads-enabled "enabled uploads in pilot"
expect_failure readiness-failure "failed app readiness"
expect_failure durability-drift "PostgreSQL durability drift"
expect_failure tunnel-unhealthy "unhealthy cloudflared"
expect_failure worker-unhealthy "unhealthy worker heartbeat"
expect_failure worker-starting "worker without a successful cycle"
expect_failure worker-missing-health "missing worker heartbeat"
expect_failure worker-extra-health "unexpected worker heartbeat"
expect_failure app-route-drift "app route bypassing the runner gateway" internal
expect_failure gateway-route-drift "runner gateway route bypassing runner-egress" internal
expect_failure authenticated-smoke-failure "failed authenticated application smoke" internal
expect_failure public-origin-failure "wrong public origin or headers" public

if ! run_scenario success internal 2; then
  cat "$work/stderr" >&2
  fail "internal phase rejected a healthy stack with the tunnel stopped"
fi
if grep -Fq $'ps\t--all\t--format\t{{.Health}}\tcloudflared' "$work/docker.log"; then
  fail "internal smoke required tunnel health before exposure"
fi
[[ -s "$work/auth-program.mjs" && ! -s "$work/public-program.mjs" ]] || {
  fail "internal phase did not isolate authenticated checks from public exposure"
}

if ! run_scenario success public 2; then
  cat "$work/stderr" >&2
  fail "public phase rejected a healthy tunnel"
fi
[[ ! -s "$work/auth-program.mjs" && -s "$work/public-program.mjs" ]] || {
  fail "public phase reran internal state-mutating checks"
}

started="$SECONDS"
expect_failure readiness-hangs "hanging app readiness" full 2
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
if PATH="$work/bin:/usr/bin:/bin" bash "$smoke" --phase invalid >/dev/null 2>&1; then
  fail "unknown smoke phase was accepted"
fi

echo "smoke-production-tests-ok"
