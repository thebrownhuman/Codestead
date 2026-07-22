#!/usr/bin/bash
set -Eeuo pipefail
umask 077

fatal() { printf 'fatal: %s\n' "$*" >&2; exit 1; }
tempfail() { printf 'temporary failure: %s\n' "$*" >&2; exit 75; }

startup_wait=600
lock_timeout=120
test_harness_root=
recover_if_needed=false
while (($# > 0)); do
  case "$1" in
    --startup-wait)
      (($# >= 2)) || fatal '--startup-wait requires a positive integer'
      startup_wait="$2"; shift 2 ;;
    --lock-timeout)
      (($# >= 2)) || fatal '--lock-timeout requires a positive integer'
      lock_timeout="$2"; shift 2 ;;
    --recover-if-needed)
      recover_if_needed=true; shift ;;
    --test-harness-root)
      (($# >= 2)) || fatal '--test-harness-root requires an absolute path'
      test_harness_root="$2"; shift 2 ;;
    *) fatal "unknown argument: $1" ;;
  esac
done
[[ "$startup_wait" =~ ^[1-9][0-9]*$ && "$lock_timeout" =~ ^[1-9][0-9]*$ ]] || fatal 'timeouts must be positive integers'
(( startup_wait <= 1200 && lock_timeout <= 300 )) || fatal 'timeout exceeds its safety bound'

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG
unset DOCKER_API_VERSION BUILDKIT_HOST
unset COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES
readonly DOCKER_HOST=unix:///var/run/docker.sock
readonly COMPOSE_PROJECT_NAME=learncoding
export DOCKER_HOST COMPOSE_PROJECT_NAME

(( EUID == 0 )) || fatal 'guarded production startup requires root'

readonly bash_bin=/usr/bin/bash
readonly realpath_bin=/usr/bin/realpath
readonly stat_bin=/usr/bin/stat
readonly overall_budget_seconds=780
readonly cleanup_budget_seconds=50
readonly systemd_timeout_seconds=900
(( overall_budget_seconds + cleanup_budget_seconds < systemd_timeout_seconds )) || fatal 'startup and cleanup budgets exceed the systemd deadline'

if [[ -n "$test_harness_root" ]]; then
  [[ "$test_harness_root" == /* && -d "$test_harness_root" && ! -L "$test_harness_root" ]] || fatal 'test harness root must be an absolute real directory'
  test_harness_root="$($realpath_bin -e -- "$test_harness_root")"
  [[ "$($stat_bin -Lc '%u:%g:%a' -- "$test_harness_root")" == 0:0:700 ]] || fatal 'test harness root must be root:root mode 0700'
  readonly trust_boundary="$test_harness_root"
  readonly repo_root="$test_harness_root/repo"
  readonly compose_env="$test_harness_root/config/compose.env"
  readonly compose_file="$repo_root/compose.yaml"
  readonly release_lock_file="$test_harness_root/run/codestead-release.lock"
  readonly docker_bin="$test_harness_root/core-bin/docker"
  readonly date_bin="$test_harness_root/core-bin/date"
  readonly flock_bin="$test_harness_root/core-bin/flock"
  readonly timeout_bin="$test_harness_root/core-bin/timeout"
  readonly node_bin="$test_harness_root/runtime-bin/node"
  readonly python_bin="$test_harness_root/runtime-bin/python3.12"
  readonly monotonic_source="$test_harness_root/monotonic"
  readonly -a control_prefix=("$python_bin" "$repo_root/infra/ops/ingress-control.py" --test-harness-root "$test_harness_root")
else
  readonly trust_boundary=/
  readonly repo_root=/opt/learncoding
  readonly compose_env=/etc/learncoding/compose.env
  readonly compose_file=/opt/learncoding/compose.yaml
  readonly release_lock_file=/run/lock/codestead-release.lock
  readonly docker_bin=/usr/bin/docker
  readonly date_bin=/usr/bin/date
  readonly flock_bin=/usr/bin/flock
  readonly timeout_bin=/usr/bin/timeout
  readonly node_bin=/usr/bin/node
  readonly python_bin=/usr/bin/python3.12
  readonly monotonic_source=/proc/uptime
  readonly -a control_prefix=("$python_bin" /opt/learncoding/infra/ops/ingress-control.py)
fi
readonly test_harness_root trust_boundary repo_root compose_env compose_file release_lock_file
readonly docker_bin date_bin flock_bin timeout_bin node_bin python_bin monotonic_source

readonly validator="$repo_root/infra/ops/validate-runtime.sh"
readonly postgres_preparer="$repo_root/infra/ops/prepare-postgres-control-socket.sh"
readonly object_preparer="$repo_root/infra/ops/prepare-object-storage.mjs"
readonly smoke="$repo_root/infra/ops/smoke-production.sh"
readonly control_helper="$repo_root/infra/ops/ingress-control.py"

secure_directory() {
  local directory="$1" metadata owner group mode links extra
  [[ -d "$directory" && ! -L "$directory" ]] || fatal "trusted directory is unavailable: $directory"
  [[ "$($realpath_bin -e -- "$directory")" == "$directory" ]] || fatal "trusted directory is not canonical: $directory"
  metadata="$($stat_bin -Lc '%u:%g:%a:%h' -- "$directory")" || fatal "cannot inspect trusted directory: $directory"
  IFS=: read -r owner group mode links extra <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$links" -ge 1 && -z "$extra" ]] || fatal "trusted directory identity is unsafe: $directory"
  if [[ "$directory" == /run/lock && "$mode" == 1777 ]]; then
    return 0
  fi
  (( (8#$mode & 8#022) == 0 )) || fatal "trusted directory is group/world writable: $directory"
}

secure_ancestor_chain() {
  local path="$1" boundary="$2" directory next
  [[ "$boundary" == / || "$path" == "$boundary" || "$path" == "$boundary/"* ]] || fatal "trusted path escapes its boundary: $path"
  directory="${path%/*}"
  [[ -n "$directory" ]] || directory=/
  while :; do
    secure_directory "$directory"
    [[ "$directory" == "$boundary" ]] && break
    [[ "$directory" != / ]] || fatal "trusted path escaped its boundary: $path"
    next="${directory%/*}"
    [[ -n "$next" ]] || next=/
    directory="$next"
  done
}

secure_regular_file() {
  local path="$1" expected_mode="$2" boundary="$3" metadata owner group mode links extra
  [[ -f "$path" && ! -L "$path" ]] || fatal "trusted file is unavailable: $path"
  [[ "$($realpath_bin -e -- "$path")" == "$path" ]] || fatal "trusted file is not canonical: $path"
  secure_ancestor_chain "$path" "$boundary"
  metadata="$($stat_bin -Lc '%u:%g:%a:%h' -- "$path")" || fatal "cannot inspect trusted file: $path"
  IFS=: read -r owner group mode links extra <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" == "$expected_mode" && "$links" == 1 && -z "$extra" ]] || fatal "trusted file identity is unsafe: $path"
  if [[ "$expected_mode" == 755 ]]; then
    [[ -x "$path" ]] || fatal "trusted command is not executable: $path"
  fi
}

secure_core_runtime() {
  secure_regular_file "$bash_bin" 755 /
  secure_regular_file "$realpath_bin" 755 /
  secure_regular_file "$stat_bin" 755 /
  secure_regular_file "$docker_bin" 755 "$trust_boundary"
  secure_regular_file "$date_bin" 755 "$trust_boundary"
  secure_regular_file "$flock_bin" 755 "$trust_boundary"
  secure_regular_file "$timeout_bin" 755 "$trust_boundary"
  if [[ -n "$test_harness_root" ]]; then
    secure_regular_file "$monotonic_source" 600 "$trust_boundary"
  else
    secure_regular_file "$monotonic_source" 444 /
  fi
}

monotonic_seconds() {
  local uptime idle extra
  IFS=' ' read -r uptime idle extra <"$monotonic_source" || return 1
  [[ "$uptime" =~ ^(0|[1-9][0-9]*)\.[0-9]+$ && "$idle" =~ ^(0|[1-9][0-9]*)\.[0-9]+$ && -z "${extra:-}" ]] || return 1
  printf '%s\n' "${uptime%%.*}"
}

remaining_timeout_seconds() {
  local requested="$1" current remaining
  current="$(monotonic_seconds)" || return 1
  remaining=$((overall_deadline_epoch - current))
  (( remaining > 0 )) || return 1
  if (( requested < remaining )); then
    printf '%s\n' "$requested"
  else
    printf '%s\n' "$remaining"
  fi
}

run_with_deadline() {
  local requested="$1" allowance
  shift
  allowance="$(remaining_timeout_seconds "$requested")" || return 124
  "$timeout_bin" --signal=KILL "${allowance}s" "$@"
}

acquire_release_lock() {
  local path_identity descriptor_identity wait_seconds
  secure_ancestor_chain "$release_lock_file" "$trust_boundary"
  [[ -f "$release_lock_file" && ! -L "$release_lock_file" ]] || fatal 'release lock must be a pre-provisioned regular file'
  [[ "$($realpath_bin -e -- "$release_lock_file")" == "$release_lock_file" ]] || fatal 'release lock is not canonical'
  path_identity="$($stat_bin -Lc '%u:%g:%a:%h:%d:%i' -- "$release_lock_file")" || fatal 'cannot inspect release lock'
  [[ "$path_identity" == 0:0:600:1:* ]] || fatal 'release lock identity is unsafe'
  exec 9<"$release_lock_file"
  descriptor_identity="$($stat_bin -Lc '%u:%g:%a:%h:%d:%i' -- "/proc/$$/fd/9")" || fatal 'cannot inspect release lock descriptor'
  [[ "$descriptor_identity" == "$path_identity" ]] || fatal 'release lock changed while opening'
  wait_seconds="$(remaining_timeout_seconds "$lock_timeout")" || fatal 'overall startup deadline exhausted before release lock'
  "$flock_bin" --exclusive --wait "$wait_seconds" 9 || tempfail 'production release lock is busy'
  [[ "$($stat_bin -Lc '%u:%g:%a:%h:%d:%i' -- "$release_lock_file")" == "$descriptor_identity" ]] || fatal 'release lock changed while acquiring'
}

declare -a discovered_tunnels=()
discover_public_tunnels() {
  local raw line
  local -A seen=()
  raw="$("$timeout_bin" --signal=KILL 5s "$docker_bin" ps --quiet --no-trunc \
    --filter label=com.docker.compose.project=learncoding \
    --filter label=com.docker.compose.service=cloudflared)" || return 1
  discovered_tunnels=()
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    [[ "$line" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    [[ -z "${seen[$line]:-}" ]] || return 1
    seen["$line"]=1
    discovered_tunnels+=("$line")
  done <<<"$raw"
}

quarantine_public_ingress() {
  discover_public_tunnels || return 1
  if ((${#discovered_tunnels[@]} > 0)); then
    "$timeout_bin" --signal=KILL 20s "$docker_bin" stop --time 10 "${discovered_tunnels[@]}" >/dev/null || return 1
  fi
  discover_public_tunnels || return 1
  ((${#discovered_tunnels[@]} == 0))
}

secure_core_runtime
overall_started_epoch="$(monotonic_seconds)" || fatal 'monotonic startup clock is unavailable'
readonly overall_started_epoch
readonly overall_deadline_epoch=$((overall_started_epoch + overall_budget_seconds))
acquire_release_lock

cleanup_required=true
compose_ready=false
declare -a compose=()
stop_compose_tunnel() {
  [[ "$compose_ready" == true ]] || return 0
  "$timeout_bin" --signal=KILL 20s "${compose[@]}" stop --timeout 10 cloudflared
}
cleanup_on_exit() {
  local status=$?
  trap '' HUP INT TERM
  trap - EXIT
  set +e
  if [[ "$cleanup_required" == true ]]; then
    quarantine_public_ingress >/dev/null 2>&1 || quarantine_public_ingress >/dev/null 2>&1 || true
    stop_compose_tunnel >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap cleanup_on_exit EXIT
trap 'trap "" HUP INT TERM; exit 129' HUP
trap 'trap "" HUP INT TERM; exit 130' INT
trap 'trap "" HUP INT TERM; exit 143' TERM

quarantine_public_ingress || fatal 'unable to quarantine public ingress'

secure_regular_file "$node_bin" 755 "$trust_boundary"
secure_regular_file "$python_bin" 755 "$trust_boundary"
secure_regular_file "$compose_env" 640 "$trust_boundary"
secure_regular_file "$compose_file" 644 "$trust_boundary"
secure_regular_file "$validator" 755 "$trust_boundary"
secure_regular_file "$object_preparer" 644 "$trust_boundary"
secure_regular_file "$postgres_preparer" 755 "$trust_boundary"
secure_regular_file "$smoke" 755 "$trust_boundary"
secure_regular_file "$control_helper" 644 "$trust_boundary"

compose=("$docker_bin" compose --env-file "$compose_env" -f "$compose_file")
compose_ready=true
stop_compose_tunnel || fatal 'unable to confirm Compose ingress quarantine'

authorize_ingress_state() {
  local checkpoint="$1" now control_status
  now="$("$date_bin" +%s)" || fatal "unable to read the $checkpoint recovery clock"
  [[ "$now" =~ ^(0|[1-9][0-9]*)$ ]] || fatal "$checkpoint recovery clock is non-canonical"
  control_status="$(run_with_deadline 15 "${control_prefix[@]}" status --now "$now")" || fatal "$checkpoint ingress control state is invalid or startup deadline exhausted"
  if [[ "$recover_if_needed" == true ]]; then
    case "$control_status" in
      clear|recovery-ready:[1-4]) ;;
      *) fatal "ingress control blocks $checkpoint recovery: $control_status" ;;
    esac
  else
    [[ "$control_status" == clear ]] || fatal "ingress control blocks $checkpoint startup: $control_status"
  fi
}

authorize_ingress_state initial

run_with_deadline 120 "$bash_bin" "$validator" --pre-privileged || fatal 'pre-privileged runtime validation failed or startup deadline exhausted'
NODE_OPTIONS='' run_with_deadline 120 "$node_bin" "$object_preparer" || fatal 'object storage preparation failed or startup deadline exhausted'
run_with_deadline 120 "$bash_bin" "$postgres_preparer" || fatal 'PostgreSQL control preparation failed or startup deadline exhausted'
run_with_deadline 120 "$bash_bin" "$validator" || fatal 'full runtime validation failed or startup deadline exhausted'

readonly -a internal_services=(
  postgres app runner-egress-gateway mail-worker reward-worker regrade-worker
  exam-finalization-worker practice-runner-recovery-worker
  project-review-correction-worker file-erasure-worker
)
case "${UPLOADS_ENABLED:-}" in
  false) selected_internal_services=("${internal_services[@]}") ;;
  true) selected_internal_services=("${internal_services[@]}" clamav scan-worker) ;;
  *) fatal 'UPLOADS_ENABLED must be literal true or false' ;;
esac
readonly -a selected_internal_services

run_with_deadline 120 "${compose[@]}" up -d --no-build --pull never --no-deps "${selected_internal_services[@]}" || fatal 'internal service startup failed or startup deadline exhausted'
run_with_deadline "$((startup_wait + 15))" "$bash_bin" "$smoke" --phase internal --startup-wait "$startup_wait" || fatal 'internal smoke failed or startup deadline exhausted'
authorize_ingress_state final-pre-exposure
run_with_deadline 120 "${compose[@]}" up -d --no-build --pull never --no-deps cloudflared || fatal 'public tunnel startup failed or startup deadline exhausted'
run_with_deadline "$((startup_wait + 15))" "$bash_bin" "$smoke" --phase public --startup-wait "$startup_wait" || fatal 'public smoke failed or startup deadline exhausted'

if [[ "$recover_if_needed" == true ]]; then
  run_with_deadline 15 "${control_prefix[@]}" record-success || fatal 'unable to record successful ingress recovery'
fi

cleanup_required=false
trap - EXIT HUP INT TERM
exit 0
