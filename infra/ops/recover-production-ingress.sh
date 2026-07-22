#!/usr/bin/bash
set -Eeuo pipefail
umask 077

fatal() { printf 'fatal: %s\n' "$*" >&2; exit 1; }

test_harness_root=
if (($# > 0)); then
  [[ "$#" == 2 && "$1" == --test-harness-root && "$2" == /* ]] || fatal 'usage: recover-production-ingress.sh [--test-harness-root ABSOLUTE_PATH]'
  test_harness_root="$2"
fi

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
(( EUID == 0 )) || fatal 'ingress recovery requires root'

# Do not let an EnvironmentFile or interactive parent redirect Docker/Compose
# authority away from the reviewed local production project.
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_API_VERSION \
  BUILDKIT_HOST COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME
DOCKER_HOST=unix:///var/run/docker.sock
export DOCKER_HOST

readonly bash_bin=/usr/bin/bash
readonly flock_bin=/usr/bin/flock
readonly realpath_bin=/usr/bin/realpath
readonly stat_bin=/usr/bin/stat

readonly control_deadline_seconds=2
readonly docker_deadline_seconds=2
readonly health_smoke_deadline_seconds=3
readonly fast_compose_deadline_seconds=1
readonly fast_smoke_deadline_seconds=2
readonly quarantine_stop_deadline_seconds=3
readonly guarded_start_deadline_seconds=25
readonly guarded_start_kill_grace_seconds=5
readonly recovery_attempt_budget_seconds=60
readonly recovery_cleanup_budget_seconds=10
readonly systemd_deadline_seconds=90
readonly recovery_worst_case_seconds=$((
  control_deadline_seconds + docker_deadline_seconds
  + docker_deadline_seconds + docker_deadline_seconds + health_smoke_deadline_seconds
  + guarded_start_deadline_seconds + guarded_start_kill_grace_seconds
  + control_deadline_seconds
  + docker_deadline_seconds + fast_compose_deadline_seconds + fast_smoke_deadline_seconds
  + (2 * (docker_deadline_seconds + quarantine_stop_deadline_seconds))
  + control_deadline_seconds
))
(( recovery_worst_case_seconds == recovery_attempt_budget_seconds
  && recovery_attempt_budget_seconds + recovery_cleanup_budget_seconds < systemd_deadline_seconds )) \
  || fatal 'ingress recovery deadlines exceed their safety envelope'

if [[ -n "$test_harness_root" ]]; then
  [[ -d "$test_harness_root" && ! -L "$test_harness_root" ]] || fatal 'test harness root must be a real directory'
  test_harness_root="$("$realpath_bin" -e -- "$test_harness_root")"
  [[ "$("$stat_bin" -Lc '%u:%g:%a' -- "$test_harness_root")" == 0:0:700 ]] || fatal 'test harness root must be root:root mode 0700'
  readonly repo_root="$test_harness_root/repo"
  readonly compose_env="$test_harness_root/config/compose.env"
  readonly compose_file="$repo_root/compose.yaml"
  readonly release_lock_file="$test_harness_root/run/codestead-release.lock"
  readonly docker_bin="$test_harness_root/bin/docker"
  readonly date_bin="$test_harness_root/bin/date"
  readonly python_bin="$test_harness_root/bin/python3.12"
  readonly timeout_bin="$test_harness_root/bin/timeout"
  readonly -a control=("$python_bin" "$repo_root/infra/ops/ingress-control.py" --test-harness-root "$test_harness_root")
  readonly -a guarded_start=("$bash_bin" "$repo_root/infra/ops/start-production-stack.sh" --test-harness-root "$test_harness_root")
else
  readonly repo_root=/opt/learncoding
  readonly compose_env=/etc/learncoding/compose.env
  readonly compose_file=/opt/learncoding/compose.yaml
  readonly release_lock_file=/run/lock/codestead-release.lock
  readonly docker_bin=/usr/bin/docker
  readonly date_bin=/usr/bin/date
  readonly python_bin=/usr/bin/python3.12
  readonly timeout_bin=/usr/bin/timeout
  readonly -a control=("$python_bin" /opt/learncoding/infra/ops/ingress-control.py)
  readonly -a guarded_start=("$bash_bin" /opt/learncoding/infra/ops/start-production-stack.sh)
fi
readonly release_lock_parent="${release_lock_file%/*}"
readonly smoke="$repo_root/infra/ops/smoke-production.sh"

assert_trusted_ancestry() {
  local path="$1" label="$2" current metadata kind owner group mode extra
  [[ "$path" == /* ]] || fatal "$label must be absolute: $path"
  current="${path%/*}"
  [[ -n "$current" ]] || current=/
  while :; do
    [[ -d "$current" && ! -L "$current" ]] || fatal "$label ancestry is not a real directory: $current"
    metadata="$("$stat_bin" -Lc '%F:%u:%g:%a' -- "$current")" || fatal "cannot inspect $label ancestry: $current"
    IFS=: read -r kind owner group mode extra <<<"$metadata"
    [[ "$kind" == directory && "$owner" == 0 && "$group" == 0 && -z "$extra" ]] \
      || fatal "$label ancestry identity is unsafe: $current"
    if [[ "$current" != "$release_lock_parent" || "$mode" != 1777 ]]; then
      (( (8#$mode & 8#022) == 0 )) || fatal "$label ancestry is group/world writable: $current"
    fi
    [[ "$current" == / ]] && break
    current="${current%/*}"
    [[ -n "$current" ]] || current=/
  done
}

assert_trusted_file() {
  local path="$1" label="$2" executable="${3:-false}" metadata owner group mode links extra
  assert_trusted_ancestry "$path" "$label"
  [[ -f "$path" && ! -L "$path" ]] || fatal "$label is unavailable: $path"
  [[ "$("$realpath_bin" -e -- "$path")" == "$path" ]] || fatal "$label is not canonical: $path"
  metadata="$("$stat_bin" -Lc '%u:%g:%a:%h' -- "$path")" || fatal "cannot inspect $label: $path"
  IFS=: read -r owner group mode links extra <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$links" == 1 && -z "$extra" ]] || fatal "$label identity is unsafe: $path"
  (( (8#$mode & 8#022) == 0 )) || fatal "$label is group/world writable: $path"
  [[ "$executable" != true || -x "$path" ]] || fatal "$label is not executable: $path"
}

for command in "$bash_bin" "$flock_bin" "$realpath_bin" "$stat_bin" "$timeout_bin" "$docker_bin"; do
  assert_trusted_file "$command" 'recovery bootstrap command' true
done

discover_tunnel_ids() {
  local discovered container_id
  local -a tunnel_ids=()
  discovered="$("$timeout_bin" --signal=KILL "${docker_deadline_seconds}s" "$docker_bin" ps \
    --filter label=com.docker.compose.project=learncoding \
    --filter label=com.docker.compose.service=cloudflared \
    --format '{{.ID}}')" || return 1
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    tunnel_ids+=("$container_id")
  done <<<"$discovered"
  for container_id in "${tunnel_ids[@]}"; do
    printf '%s\n' "$container_id"
  done
}

quarantine_tunnel() {
  local discovered container_id invalid=false
  local -a tunnel_ids=()
  discovered="$("$timeout_bin" --signal=KILL "${docker_deadline_seconds}s" "$docker_bin" ps \
    --filter label=com.docker.compose.project=learncoding \
    --filter label=com.docker.compose.service=cloudflared \
    --format '{{.ID}}')" || return 1
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    if [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]]; then
      tunnel_ids+=("$container_id")
    else
      invalid=true
    fi
  done <<<"$discovered"
  if ((${#tunnel_ids[@]} > 0)); then
    "$timeout_bin" --signal=KILL "${quarantine_stop_deadline_seconds}s" \
      "$docker_bin" stop --time 2 "${tunnel_ids[@]}" >/dev/null || return 1
  fi
  [[ "$invalid" == false ]]
}

enforce_quarantine() { quarantine_tunnel || quarantine_tunnel; }

release_lock_ready=false
release_lock_held=false
quarantine_required=true
# shellcheck disable=SC2317  # Invoked indirectly by the EXIT trap below.
cleanup_on_exit() {
  local status="$?"
  trap '' HUP INT TERM
  trap - EXIT
  set +e
  if [[ "$quarantine_required" == true ]]; then
    if [[ "$release_lock_ready" != true ]]; then
      printf '%s\n' 'fatal: unable to enforce ingress quarantine without a trusted release lock' >&2
      (( status != 0 )) || status=1
    elif [[ "$release_lock_held" == true ]] || acquire_release_lock_nonblocking; then
      if ! enforce_quarantine >/dev/null 2>&1; then
        printf '%s\n' 'fatal: unable to enforce fail-closed ingress quarantine during cleanup' >&2
        (( status != 0 )) || status=1
      fi
    else
      printf '%s\n' 'warning: ingress cleanup deferred to the active release transaction' >&2
      (( status != 0 )) || status=1
    fi
  fi
  trap - EXIT
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'trap "" HUP INT TERM; exit 129' HUP
trap 'trap "" HUP INT TERM; exit 130' INT
trap 'trap "" HUP INT TERM; exit 143' TERM

acquire_release_lock_nonblocking() {
  "$flock_bin" --exclusive --nonblock 8 || return 1
  release_lock_held=true
  if [[ "$("$stat_bin" -Lc '%u:%g:%a:%h:%d:%i' -- "$release_lock_file")" != "$release_lock_identity" ]]; then
    release_lock_ready=false
    release_lock_held=false
    exec 8>&-
    fatal 'release lock changed while acquiring'
  fi
}

release_release_lock() {
  if ! "$flock_bin" --unlock 8; then
    release_lock_ready=false
    release_lock_held=false
    exec 8>&-
    fatal 'unable to release the production release lock'
  fi
  release_lock_held=false
}

assert_trusted_file "$release_lock_file" 'release lock'
release_lock_identity="$("$stat_bin" -Lc '%u:%g:%a:%h:%d:%i' -- "$release_lock_file")" || fatal 'cannot inspect release lock'
[[ "$release_lock_identity" == 0:0:600:1:* ]] || fatal 'release lock identity is unsafe'
exec 8<"$release_lock_file"
[[ "$("$stat_bin" -Lc '%u:%g:%a:%h:%d:%i' -- "/proc/$$/fd/8")" == "$release_lock_identity" ]] \
  || fatal 'release lock changed while opening'
release_lock_ready=true

for command in "$date_bin" "$python_bin"; do
  assert_trusted_file "$command" 'recovery command' true
done
for file in "$compose_env" "$compose_file" "$repo_root/infra/ops/ingress-control.py"; do
  assert_trusted_file "$file" 'recovery input'
done
for file in "$repo_root/infra/ops/start-production-stack.sh" "$smoke"; do
  assert_trusted_file "$file" 'recovery executable input' true
done

ambient_compose_profiles="${COMPOSE_PROFILES-}"
COMPOSE_PROFILES=
export COMPOSE_PROFILES
[[ -z "$ambient_compose_profiles" ]] || fatal 'ambient COMPOSE_PROFILES must be empty during ingress recovery'

readonly -a compose=("$docker_bin" compose --project-name learncoding --env-file "$compose_env" -f "$compose_file")
now="$("$date_bin" +%s)" || fatal 'unable to read recovery clock'
[[ "$now" =~ ^(0|[1-9][0-9]*)$ ]] || fatal 'recovery clock is non-canonical'
control_status="$("$timeout_bin" --signal=KILL "${control_deadline_seconds}s" "${control[@]}" status --now "$now")" || fatal 'ingress control state is invalid'
case "$control_status" in
  release-quarantined|recovery-exhausted|recovery-wait:*)
    if ! acquire_release_lock_nonblocking; then
      quarantine_required=false
      exit 0
    fi
    enforce_quarantine || fatal 'unable to enforce deferred ingress quarantine'
    release_release_lock
    quarantine_required=false
    exit 0
    ;;
  clear|recovery-ready:[1-4]) ;;
  *) fatal "unexpected ingress control status: $control_status" ;;
esac

"$timeout_bin" --signal=KILL "${docker_deadline_seconds}s" "$docker_bin" info >/dev/null 2>&1 || fatal 'Docker is unavailable during ingress recovery'

probe_healthy_tunnel() {
  local discovered_tunnels tunnel_running
  local -a tunnel_ids=()
  discovered_tunnels="$(discover_tunnel_ids)" || return 1
  [[ -z "$discovered_tunnels" ]] || mapfile -t tunnel_ids <<<"$discovered_tunnels"
  ((${#tunnel_ids[@]} == 1)) || return 1
  tunnel_running="$("$timeout_bin" --signal=KILL "${docker_deadline_seconds}s" "${compose[@]}" ps --services --status running cloudflared 2>/dev/null)" || return 1
  [[ "$tunnel_running" == cloudflared ]] || return 1
  "$timeout_bin" --signal=KILL "${health_smoke_deadline_seconds}s" "$bash_bin" "$smoke" --phase full --startup-wait 2
}

probe_healthy_tunnel_fast() {
  local discovered_tunnels tunnel_running
  local -a tunnel_ids=()
  discovered_tunnels="$(discover_tunnel_ids)" || return 1
  [[ -z "$discovered_tunnels" ]] || mapfile -t tunnel_ids <<<"$discovered_tunnels"
  ((${#tunnel_ids[@]} == 1)) || return 1
  tunnel_running="$("$timeout_bin" --signal=KILL "${fast_compose_deadline_seconds}s" "${compose[@]}" ps --services --status running cloudflared 2>/dev/null)" || return 1
  [[ "$tunnel_running" == cloudflared ]] || return 1
  "$timeout_bin" --signal=KILL "${fast_smoke_deadline_seconds}s" "$bash_bin" "$smoke" --phase full --startup-wait 1
}

persist_eligible_failure() {
  local latest_now latest_status outcome
  if ! acquire_release_lock_nonblocking; then
    quarantine_required=false
    exit 0
  fi
  latest_now="$("$date_bin" +%s)" || fatal 'unable to re-read recovery clock under the release lock'
  [[ "$latest_now" =~ ^(0|[1-9][0-9]*)$ ]] \
    || fatal 'recovery clock is non-canonical under the release lock'
  (( latest_now >= now )) || fatal 'recovery clock regressed under the release lock'
  latest_status="$("$timeout_bin" --signal=KILL "${control_deadline_seconds}s" "${control[@]}" status --now "$latest_now")" \
    || fatal 'unable to re-read ingress control state under the release lock'
  if [[ "$latest_status" != "$control_status" ]]; then
    release_release_lock
    quarantine_required=false
    exit 0
  fi
  if [[ "$latest_status" == clear ]] && probe_healthy_tunnel_fast; then
    release_release_lock
    quarantine_required=false
    exit 0
  fi
  enforce_quarantine || fatal 'unable to quarantine ingress after a failed readiness proof'
  outcome="$("$timeout_bin" --signal=KILL "${control_deadline_seconds}s" "${control[@]}" record-failure --now "$latest_now")" \
    || fatal 'unable to persist ingress recovery failure'
  release_release_lock
  case "$outcome" in
    recovery-wait:*)
      quarantine_required=false
      exit 0
      ;;
    recovery-exhausted) fatal 'ingress recovery exhausted after five failed attempts' ;;
    *) fatal "unexpected recovery failure result: $outcome" ;;
  esac
}

if [[ "$control_status" == clear ]] && probe_healthy_tunnel; then
  quarantine_required=false
  exit 0
fi

# Do not interfere with a normal release/start transaction that already owns
# the shared lock. The guarded start owns quarantine after this preflight.
if ! acquire_release_lock_nonblocking; then
  quarantine_required=false
  exit 0
fi
release_release_lock

set +e
"$timeout_bin" --signal=TERM --kill-after="${guarded_start_kill_grace_seconds}s" "${guarded_start_deadline_seconds}s" \
  "${guarded_start[@]}" --recover-if-needed --startup-wait 5
start_result=$?
set -e
case "$start_result" in
  0)
    quarantine_required=false
    exit 0
    ;;
  75)
    quarantine_required=false
    exit 0
    ;;
esac
persist_eligible_failure
