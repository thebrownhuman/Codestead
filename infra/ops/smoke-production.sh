#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

startup_wait=600
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --startup-wait)
      [[ "$#" -ge 2 ]] || fatal "--startup-wait requires a positive integer"
      startup_wait="$2"
      shift 2
      ;;
    *)
      fatal "unknown argument: $1"
      ;;
  esac
done

[[ "$startup_wait" =~ ^[1-9][0-9]*$ ]] || fatal "--startup-wait requires a positive integer"

readonly compose_env="${COMPOSE_ENV_FILE:-/etc/learncoding/compose.env}"
readonly compose_file="${COMPOSE_FILE_PATH:-/opt/learncoding/compose.yaml}"

docker_bin="$(command -v docker || true)"
[[ -n "$docker_bin" ]] || fatal "docker is missing"
readonly docker_bin

timeout_bin="$(command -v timeout || true)"
[[ -n "$timeout_bin" ]] || fatal "GNU timeout is missing"
timeout_version="$($timeout_bin --version 2>/dev/null || true)"
[[ "$timeout_version" == *"GNU coreutils"* ]] || fatal "GNU timeout is required"
readonly timeout_bin

readonly deadline="$((SECONDS + startup_wait))"

run_compose() {
  local remaining="$((deadline - SECONDS))"
  (( remaining > 0 )) || return 124

  "$timeout_bin" --signal=KILL "${remaining}s" \
    "$docker_bin" compose --env-file "$compose_env" -f "$compose_file" "$@"
}

matches_exact_lines() {
  local actual="$1"
  shift
  local expected

  actual="$(printf '%s\n' "$actual" | tr -d '\r' | sed '/^[[:space:]]*$/d' | LC_ALL=C sort)"
  expected="$(printf '%s\n' "$@" | LC_ALL=C sort)"
  [[ "$actual" == "$expected" ]]
}

readonly -a pilot_services=(
  app
  cloudflared
  exam-finalization-worker
  mail-worker
  migrate
  postgres
  practice-runner-recovery-worker
  project-review-correction-worker
  regrade-worker
  reward-worker
)
readonly -a running_services=(
  app
  cloudflared
  exam-finalization-worker
  mail-worker
  postgres
  practice-runner-recovery-worker
  project-review-correction-worker
  regrade-worker
  reward-worker
)

configured_services="$(run_compose config --services)" || {
  fatal "unable to resolve the pilot service inventory"
}
matches_exact_lines "$configured_services" "${pilot_services[@]}" || {
  fatal "pilot service inventory drifted"
}

probe_once() {
  local active_services
  local migration_state
  local durability
  local tunnel_health

  active_services="$(run_compose ps --services --status running 2>/dev/null)" || return 1
  matches_exact_lines "$active_services" "${running_services[@]}" || return 1

  migration_state="$(run_compose ps --all --format '{{.State}} {{.ExitCode}}' migrate 2>/dev/null)" || return 1
  migration_state="$(printf '%s\n' "$migration_state" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/[[:space:]][[:space:]]*/ /g')"
  [[ "$migration_state" == "exited 0" ]] || return 1

  run_compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/health/ready', { redirect: 'manual' }).then((response) => { if (response.status !== 200) process.exit(1); }).catch(() => process.exit(1));" \
    >/dev/null 2>&1 || return 1

  run_compose exec -T app node -e \
    'if (process.env.UPLOADS_ENABLED !== "false") process.exit(1);' \
    >/dev/null 2>&1 || return 1

  durability="$(run_compose exec -T postgres sh -ceu \
    'exec psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "show fsync; show synchronous_commit; show full_page_writes;"' \
    2>/dev/null)" || return 1
  durability="$(printf '%s\n' "$durability" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d')"
  [[ "$durability" == $'on\non\non' ]] || return 1

  tunnel_health="$(run_compose ps --all --format '{{.Health}}' cloudflared 2>/dev/null)" || return 1
  tunnel_health="$(printf '%s\n' "$tunnel_health" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ "$tunnel_health" == "healthy" ]] || return 1
}

while (( SECONDS < deadline )); do
  if probe_once; then
    printf '%s\n' "production smoke passed"
    exit 0
  fi

  remaining="$((deadline - SECONDS))"
  (( remaining > 0 )) || break
  sleep 1
done

fatal "production smoke failed before the startup deadline"
