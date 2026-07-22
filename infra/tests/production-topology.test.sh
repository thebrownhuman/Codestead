#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_dir
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
readonly repo_root
readonly overlay="$script_dir/fixtures/production-topology.compose.yaml"
readonly expected_engine_version="29.6.1"
readonly expected_compose_version="5.3.1"
readonly postgres_image="postgres:17-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394"
workdir=""
workdir_marker_created=0

topology_early_cleanup() {
  # Capturing the incoming trap status in the declaration is intentional.
  # shellcheck disable=SC2155
  local status=$?
  local candidate cleanup_failed=0 resolved=""
  trap - EXIT
  set +e
  candidate="${workdir:-}"
  if [[ -z "$candidate" || ! -e "$candidate" ]]; then
    exit "$status"
  fi
  if [[ -L "$candidate" ]]; then
    echo "Refusing to remove a symlinked early topology work directory: $candidate" >&2
    cleanup_failed=1
  elif ! resolved="$(realpath -e -- "$candidate" 2>/dev/null)"; then
    echo "Unable to resolve the early topology work directory: $candidate" >&2
    cleanup_failed=1
  fi
  if [[ -n "$resolved" ]]; then
    case "$resolved" in
      "${RUNNER_TEMP:-/tmp}"/codestead-topology.*|/tmp/codestead-topology.*) ;;
      *)
        echo "Refusing to remove an unsafe early topology work directory: $resolved" >&2
        cleanup_failed=1
        resolved=""
        ;;
    esac
  fi
  if [[ -n "$resolved" ]]; then
    if [[ "${workdir_marker_created:-0}" == 1 && ! -f "$resolved/.codestead-topology-owned" ]]; then
      echo "Refusing to remove an early work directory whose ownership marker disappeared: $resolved" >&2
      cleanup_failed=1
    elif [[ "${workdir_marker_created:-0}" != 0 && "${workdir_marker_created:-0}" != 1 ]]; then
      echo "Invalid early work directory marker state: ${workdir_marker_created:-unset}" >&2
      cleanup_failed=1
    elif ! rm -rf -- "$resolved"; then
      echo "Unable to remove the early topology work directory: $resolved" >&2
      cleanup_failed=1
    fi
  fi
  if [[ -n "$resolved" && -e "$resolved" ]]; then
    echo "Early topology work directory remains after teardown: $resolved" >&2
    cleanup_failed=1
  fi
  if (( status == 0 && cleanup_failed != 0 )); then
    status=1
  fi
  exit "$status"
}

run_topology_early_cleanup_self_test() {
  local mode="${CODESTEAD_TOPOLOGY_EARLY_CLEANUP_SELF_TEST:-}"
  local probe="${CODESTEAD_TOPOLOGY_EARLY_CLEANUP_PROBE:-}"
  [[ -n "$probe" ]] || { echo "The early-cleanup self-test requires a probe path." >&2; exit 64; }
  [[ "$mode" == before-marker || "$mode" == after-marker ]] || {
    echo "Unknown early-cleanup self-test mode: $mode" >&2
    exit 64
  }
  workdir_marker_created=0
  workdir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/codestead-topology.XXXXXX")"
  trap topology_early_cleanup EXIT
  printf '%s\n' "$workdir" >"$probe"
  if [[ "$mode" == before-marker ]]; then
    exit 91
  fi
  touch "$workdir/.codestead-topology-owned"
  workdir_marker_created=1
  exit 92
}

if [[ -n "${CODESTEAD_TOPOLOGY_EARLY_CLEANUP_SELF_TEST:-}" ]]; then
  run_topology_early_cleanup_self_test
fi

if [[ "${CODESTEAD_DISPOSABLE_HOST:-}" != 1 ]]; then
  echo "Set CODESTEAD_DISPOSABLE_HOST=1 only on a disposable Linux Docker host." >&2
  exit 64
fi
if [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo "Refusing a self-hosted GitHub runner." >&2
  exit 64
fi
if [[ "$(docker info --format '{{.OSType}}' 2>/dev/null)" != linux ]]; then
  echo "A reachable Linux Docker engine is required." >&2
  exit 69
fi
actual_client_version="$(docker version --format '{{.Client.Version}}' 2>/dev/null || true)"
actual_engine_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
actual_compose_version="$(docker compose version --short 2>/dev/null || true)"
actual_compose_version="${actual_compose_version#v}"
if [[ "$actual_client_version" != "$expected_engine_version" ]]; then
  echo "Docker CLI version drift: expected $expected_engine_version, found ${actual_client_version:-unavailable}." >&2
  exit 69
fi
if [[ "$actual_engine_version" != "$expected_engine_version" ]]; then
  echo "Docker Engine version drift: expected $expected_engine_version, found ${actual_engine_version:-unavailable}." >&2
  exit 69
fi
if [[ "$actual_compose_version" != "$expected_compose_version" ]]; then
  echo "Docker Compose version drift: expected $expected_compose_version, found ${actual_compose_version:-unavailable}." >&2
  exit 69
fi

assert_disposable_daemon_scope() {
  local mode="$1" context_name context_endpoint effective_endpoint container_id container_ids project_label
  context_name="$(docker context show 2>/dev/null)" || {
    echo "Unable to identify the current Docker context." >&2
    return 1
  }
  context_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' "$context_name" 2>/dev/null)" || {
    echo "Unable to inspect the current Docker context." >&2
    return 1
  }
  effective_endpoint="${DOCKER_HOST:-$context_endpoint}"
  if [[ "$context_endpoint" != unix:///var/run/docker.sock || "$effective_endpoint" != unix:///var/run/docker.sock || ! -S /var/run/docker.sock ]]; then
    echo "Docker-daemon restart requires the local system socket unix:///var/run/docker.sock." >&2
    return 1
  fi
  if [[ "$mode" != empty && "$mode" != project-only ]]; then
    echo "Unknown Docker-daemon scope mode: $mode" >&2
    return 1
  fi
  if ! container_ids="$(docker ps -aq)"; then
    echo "Unable to enumerate Docker containers before the daemon restart." >&2
    return 1
  fi
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    if [[ "$mode" == empty ]]; then
      echo "Docker-daemon restart host contains a pre-existing container: $container_id" >&2
      return 1
    fi
    project_label="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id" 2>/dev/null || true)"
    if [[ -z "${COMPOSE_PROJECT_NAME:-}" || "$project_label" != "$COMPOSE_PROJECT_NAME" ]]; then
      echo "Docker-daemon restart host contains a foreign container: $container_id" >&2
      return 1
    fi
  done <<<"$container_ids"
}

assert_disposable_daemon_scope empty
if [[ "${CODESTEAD_TOPOLOGY_RESTART_DOCKER:-0}" == 1 ]]; then
  if [[ "${CODESTEAD_DISPOSABLE_DOCKER_DAEMON:-}" != 1 || "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
    echo "Docker-daemon restart requires the disposable github-hosted acknowledgements." >&2
    exit 64
  fi
fi
command -v timeout >/dev/null || { echo "GNU timeout is required." >&2; exit 69; }

run_id="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}-${RANDOM}"
run_id="${run_id//[^a-zA-Z0-9_.-]/-}"
run_id="${run_id,,}"
readonly COMPOSE_PROJECT_NAME="codestead-topology-$run_id"
export COMPOSE_PROJECT_NAME
workdir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/codestead-topology.XXXXXX")"
trap topology_early_cleanup EXIT
readonly workdir
workdir_real="$(realpath -e -- "$workdir")"
readonly workdir_real
case "$workdir_real" in
  "${RUNNER_TEMP:-/tmp}"/codestead-topology.*|/tmp/codestead-topology.*) ;;
  *) echo "Unsafe disposable work directory: $workdir_real" >&2; exit 70 ;;
esac
touch "$workdir/.codestead-topology-owned"
workdir_marker_created=1
chmod 0755 "$workdir"

readonly secrets_dir="$workdir/secrets"
readonly data_root="$workdir/data"
readonly cloudflare_config="$workdir/cloudflared.yml"
readonly postgres_socket_dir="$workdir/postgres-socket"
mkdir -p "$secrets_dir" "$data_root/postgres" "$data_root/next-cache" "$data_root/app-data" "$postgres_socket_dir"
chmod 0755 "$secrets_dir"
chmod 0777 "$data_root/next-cache" "$data_root/app-data"

readonly runtime_image="codestead-topology-runtime:$run_id"
readonly tooling_image="codestead-topology-tooling:$run_id"
readonly worker_image="codestead-topology-worker:$run_id"
readonly regrade_image="codestead-topology-regrade:$run_id"
readonly project_review_image="codestead-topology-project-review:$run_id"
readonly operations_image="codestead-topology-operations:$run_id"
readonly image_label="io.codestead.fixture=production-topology-v1"
bridge_suffix="$(printf '%s' "$run_id" | sha256sum | cut -c1-8)"
readonly bridge_suffix
network_octet=$((16#${bridge_suffix:0:2}))
readonly network_octet
export TOPOLOGY_RUNNER_CLIENT_SUBNET="172.29.41.0/24"
export TOPOLOGY_RUNNER_CLIENT_RANGE="172.29.41.128/25"
export TOPOLOGY_RUNNER_CLIENT_GATEWAY="172.29.41.1"
export TOPOLOGY_RUNNER_CLIENT_IP="172.29.41.2"
export TOPOLOGY_RUNNER_EGRESS_SUBNET="10.251.$network_octet.0/24"
export TOPOLOGY_RUNNER_EGRESS_RANGE="10.251.$network_octet.128/25"
export TOPOLOGY_RUNNER_EGRESS_GATEWAY="10.251.$network_octet.1"
export TOPOLOGY_RUNNER_EGRESS_IP="10.251.$network_octet.2"


export APP_NAME="Codestead topology test"
export APP_URL="https://codestead.invalid"
export SOURCE_CODE_URL="https://example.invalid/codestead"
export APP_RUNTIME_IMAGE="$runtime_image"
export APP_TOOLING_IMAGE="$tooling_image"
export APP_WORKER_IMAGE="$worker_image"
export APP_REGRADE_WORKER_IMAGE="$regrade_image"
export APP_PROJECT_REVIEW_WORKER_IMAGE="$project_review_image"
export APP_SCANNER_WORKER_IMAGE="$worker_image"
export APP_OPERATIONS_IMAGE="$operations_image"
export POSTGRES_IMAGE="$postgres_image"
export CLOUDFLARED_IMAGE="$runtime_image"
export CLAMAV_IMAGE="$runtime_image"
export DEPLOY_PLATFORM="linux/amd64"
export UPLOADS_ENABLED=false
export COMPOSE_PROFILES=""
SECRETS_GID="$(id -g)"
export SECRETS_GID
export SECRETS_DIR="$secrets_dir"
export LEARN_DATA_ROOT="$data_root"
export CLOUDFLARE_CONFIG_FILE="$cloudflare_config"
export POSTGRES_DB=learncoding
export POSTGRES_USER=learncoding
export RUNNER_BASE_URL="http://192.168.122.12:4100"
export BOOTSTRAP_ADMIN_EMAIL="topology-admin@example.invalid"
export MAIL_ADAPTER=outbox
export MAIL_FROM="Codestead topology <noreply@example.invalid>"
export TOPOLOGY_POSTGRES_DIR="$data_root/postgres"
export TOPOLOGY_POSTGRES_SOCKET_DIR="$postgres_socket_dir"
export TOPOLOGY_NEXT_CACHE_DIR="$data_root/next-cache"
export TOPOLOGY_APP_DATA_DIR="$data_root/app-data"
export TOPOLOGY_RUNNER_BRIDGE="cdstt$bridge_suffix"

# No real provider credentials are read or passed to any fixture container.
unset NVIDIA_API_KEY NVIDIA_NIM_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY \
  GEMINI_API_KEY GOOGLE_API_KEY DEEPSEEK_API_KEY OPENROUTER_API_KEY \
  CLOUDFLARE_API_TOKEN CLOUDFLARE_TUNNEL_TOKEN

printf '%s' 'TopologyFixturePostgresPassword-00000001' >"$secrets_dir/postgres_password"
printf '%s' 'postgresql://learncoding:TopologyFixturePostgresPassword-00000001@postgres:5432/learncoding' >"$secrets_dir/database_bootstrap_url"
printf '%s' 'postgresql://learncoding_app:TopologyFixtureApplicationPassword-00000002@postgres:5432/learncoding' >"$secrets_dir/database_url"
printf '%s' 'postgresql://learncoding_migrator:TopologyFixtureMigratorPassword-00000003@postgres:5432/learncoding' >"$secrets_dir/database_migrator_url"
printf '%s' 'postgresql://learncoding_worker:TopologyFixtureWorkerPassword-0000000004@postgres:5432/learncoding' >"$secrets_dir/database_worker_url"
printf '%s' 'postgresql://learncoding_ops:TopologyFixtureOperationsPassword-00000005@postgres:5432/learncoding' >"$secrets_dir/database_ops_url"
printf '%s' 'topology-better-auth-secret-000000000000000000000000' >"$secrets_dir/better_auth_secret"
printf '%s' 'TopologyBootstrapPassword-Only-For-CI-42' >"$secrets_dir/bootstrap_admin_password"
printf '%s' 'topology-lost-device-proof-0000000000000000000000' >"$secrets_dir/lost_device_proof_key"
printf '%s' 'topology-deletion-tombstone-000000000000000000000' >"$secrets_dir/deletion_tombstone_key"
printf '%s' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' >"$secrets_dir/credential_master_key"
printf '%s' 'topology-runner-shared-secret-00000000000000000000' >"$secrets_dir/runner_shared_secret"
: >"$secrets_dir/google_client_secret"
: >"$secrets_dir/gmail_client_id"
: >"$secrets_dir/gmail_client_secret"
: >"$secrets_dir/gmail_refresh_token"
printf '%s' '{"AccountTag":"fixture","TunnelSecret":"fixture","TunnelID":"00000000-0000-0000-0000-000000000000"}' >"$secrets_dir/cloudflare_tunnel_credentials.json"
chmod 0440 "$secrets_dir"/*
cat >"$cloudflare_config" <<'EOF'
tunnel: 00000000-0000-0000-0000-000000000000
credentials-file: /run/secrets/cloudflare_tunnel_credentials
ingress:
  - service: http_status:404
EOF
chmod 0444 "$cloudflare_config"

compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$repo_root/compose.yaml" -f "$overlay")
images=("$runtime_image" "$tooling_image" "$worker_image" "$regrade_image" "$project_review_image" "$operations_image")
long_running_services=(postgres app runner-stub runner-egress-gateway mail-worker reward-worker regrade-worker exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker file-erasure-worker cloudflared)
policy_recovered_services=(postgres app runner-stub runner-egress-gateway mail-worker reward-worker regrade-worker exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker file-erasure-worker)
declare -A daemon_container_before=()
declare -A daemon_started_before=()

capture_daemon_restart_baseline() {
  local service container_id started_at
  for service in "${long_running_services[@]}"; do
    container_id="$("${compose[@]}" ps --quiet "$service")"
    started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container_id")"
    if [[ -z "$container_id" || -z "$started_at" ]]; then
      echo "Unable to capture the Docker-daemon restart generation for $service." >&2
      return 1
    fi
    daemon_container_before["$service"]="$container_id"
    daemon_started_before["$service"]="$started_at"
  done
}

assert_policy_recovered_generations_changed() {
  local service container_id started_at
  for service in "${policy_recovered_services[@]}"; do
    container_id="$("${compose[@]}" ps --quiet "$service")"
    started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container_id")"
    if [[ -z "$container_id" || -z "$started_at" ]]; then
      echo "Unable to inspect the recovered Docker-daemon generation for $service." >&2
      return 1
    fi
    if [[ "$started_at" == "${daemon_started_before[$service]}" ]]; then
      echo "Docker-daemon restart did not change StartedAt for $service (${daemon_container_before[$service]})." >&2
      return 1
    fi
    if [[ "$container_id|$started_at" == "${daemon_container_before[$service]}|${daemon_started_before[$service]}" ]]; then
      echo "Docker-daemon restart did not change the container generation for $service." >&2
      return 1
    fi
  done
}

assert_cloudflared_quarantined_after_daemon_restart() {
  local container_id runtime_contract
  container_id="$("${compose[@]}" ps --all --quiet cloudflared)"
  [[ -n "$container_id" ]] || {
    echo "The quarantined cloudflared container identity is unavailable after Docker restart." >&2
    return 1
  }
  runtime_contract="$(docker inspect --format '{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "$container_id")"
  [[ "$runtime_contract" == 'false|on-failure|5' ]] || {
    echo "cloudflared bypassed guarded ingress recovery or its restart policy drifted: $runtime_contract" >&2
    return 1
  }
}

recover_ingress_after_daemon_restart() {
  # This fixture models the production ingress-recovery timer's sole activation
  # step only after the internal application stack has proved ready. The actual
  # host script additionally validates release evidence and the public endpoint.
  timeout 120 "${compose[@]}" up --detach --no-build --pull never --no-deps cloudflared
}

assert_cloudflared_generation_changed_after_guarded_recovery() {
  local container_id started_at
  container_id="$("${compose[@]}" ps --quiet cloudflared)"
  started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container_id")"
  if [[ -z "$container_id" || -z "$started_at" ]]; then
    echo "Unable to inspect cloudflared after guarded ingress recovery." >&2
    return 1
  fi
  if [[ "$started_at" == "${daemon_started_before[cloudflared]}" ]]; then
    echo "Guarded ingress recovery did not start a new cloudflared generation (${daemon_container_before[cloudflared]})." >&2
    return 1
  fi
}

cleanup_started=0
readonly runner_client_network="${COMPOSE_PROJECT_NAME}_runner-client"
runner_client_reserved=0

project_resources() {
  {
    docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
    docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
    docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
  } | sed '/^$/d'
}

reserve_runner_client_network() {
  local compose_version
  compose_version="$(docker compose version --short)"
  if ! timeout 30 docker network create \
    --driver bridge \
    --internal \
    --subnet "$TOPOLOGY_RUNNER_CLIENT_SUBNET" \
    --gateway "$TOPOLOGY_RUNNER_CLIENT_GATEWAY" \
    --ip-range "$TOPOLOGY_RUNNER_CLIENT_RANGE" \
    --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --label "com.docker.compose.network=runner-client" \
    --label "com.docker.compose.version=$compose_version" \
    --label "io.codestead.fixture=production-topology-v1" \
    "$runner_client_network" >/dev/null; then
    echo "Unable to reserve the reviewed runner-client subnet before image builds." >&2
    return 1
  fi
  runner_client_reserved=1
}

cleanup() {
  status=$?
  local cleanup_failed=0 diagnostic_log fixture_images image remnants runner_labels
  trap - EXIT
  set +e
  if (( cleanup_started == 0 )); then
    cleanup_started=1
    if (( status != 0 )); then
      "${compose[@]}" ps >&2
      "${compose[@]}" logs --no-color --tail=120 >&2
      for diagnostic_log in "$workdir"/*.log; do
        [[ -f "$diagnostic_log" ]] || continue
        printf '\n--- %s (tail) ---\n' "$(basename -- "$diagnostic_log")" >&2
        tail -n 120 -- "$diagnostic_log" >&2
      done
    fi

    if ! timeout 120 "${compose[@]}" down --volumes --remove-orphans --timeout 30 >/dev/null 2>&1; then
      echo "Disposable Compose teardown failed." >&2
      cleanup_failed=1
    fi
    if (( runner_client_reserved == 1 )); then
      if docker network inspect "$runner_client_network" >/dev/null 2>&1; then
        runner_labels="$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}} {{index .Labels "io.codestead.fixture"}}' "$runner_client_network" 2>/dev/null)"
        if [[ "$runner_labels" != "$COMPOSE_PROJECT_NAME production-topology-v1" ]]; then
          echo "Refusing to remove an unowned fallback network: $runner_client_network" >&2
          cleanup_failed=1
        elif ! docker network rm "$runner_client_network" >/dev/null 2>&1; then
          echo "Unable to remove fallback network: $runner_client_network" >&2
          cleanup_failed=1
        fi
      fi
    fi

    if ! remnants="$(project_resources)"; then
      echo "Unable to query disposable Compose resources after teardown." >&2
      cleanup_failed=1
    elif [[ -n "$remnants" ]]; then
      echo "Disposable Compose resources remain after teardown: $remnants" >&2
      cleanup_failed=1
    fi

    for image in "${images[@]}"; do
      if docker image inspect "$image" >/dev/null 2>&1; then
        if ! docker image rm --force "$image" >/dev/null 2>&1; then
          echo "Unable to remove disposable image: $image" >&2
          cleanup_failed=1
        fi
      fi
      if docker image inspect "$image" >/dev/null 2>&1; then
        echo "Disposable image remains after teardown: $image" >&2
        cleanup_failed=1
      fi
    done
    if ! fixture_images="$(docker image ls --quiet --filter "label=$image_label")"; then
      echo "Unable to query fixture-labeled images after teardown." >&2
      cleanup_failed=1
    elif [[ -n "$fixture_images" ]]; then
      echo "Fixture-labeled images remain after teardown: $fixture_images" >&2
      cleanup_failed=1
    fi
    if ! docker info >/dev/null 2>&1; then
      echo "Unable to prove disposable image absence because the Docker daemon is unavailable." >&2
      cleanup_failed=1
    fi

    if [[ -e "$workdir_real" ]]; then
      if [[ ! -f "$workdir/.codestead-topology-owned" ]]; then
        echo "Refusing to remove a work directory without its ownership marker: $workdir_real" >&2
        cleanup_failed=1
      elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
        if ! sudo rm -rf -- "$workdir_real"; then
          echo "Unable to remove disposable work directory: $workdir_real" >&2
          cleanup_failed=1
        fi
      elif ! rm -rf -- "$workdir_real"; then
        echo "Unable to remove disposable work directory: $workdir_real" >&2
        cleanup_failed=1
      fi
    fi
    if [[ ! -e "$workdir_real" ]]; then
      :
    else
      echo "Disposable work directory remains after teardown: $workdir_real" >&2
      cleanup_failed=1
    fi
  fi
  if (( status == 0 && cleanup_failed != 0 )); then
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

psql_query() {
  timeout 30 "${compose[@]}" exec -T postgres \
    psql --no-psqlrc --set ON_ERROR_STOP=1 --host /run/learncoding-postgres --username learncoding --dbname learncoding \
    --tuples-only --no-align --command "$1" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

wait_for_query() {
  local expected="$1" query="$2" actual=""
  for _ in $(seq 1 80); do
    actual="$(psql_query "$query" 2>/dev/null || true)"
    if [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for a PostgreSQL state transition: expected <$expected>; last observed <$actual>; query: $query" >&2
  return 1
}

wait_for_database_admin_contenders() {
  local observation=""
  local lock_query='select pg_try_advisory_lock(hashtextextended($1, 0)) acquired'
  local holder_identity='learncoding:codestead-topology-lock-holder'
  local bootstrap_identity='learncoding:codestead-topology-role-bootstrap'
  local migrate_identity='learncoding_migrator:codestead-topology-migrate'
  for _ in $(seq 1 100); do
    kill -0 "$lock_holder_pid" "$bootstrap_pid" "$migrate_pid" || {
      echo "A database-administration process exited before deterministic lock observation." >&2
      return 1
    }
    observation="$(psql_query "select
      (exists(
        select 1 from pg_stat_activity activity
        join pg_locks held_lock on held_lock.pid = activity.pid
        where activity.datname = current_database()
          and activity.usename || ':' || activity.application_name = '$holder_identity'
          and held_lock.locktype = 'advisory'
          and held_lock.granted
      ))::int::text || ':' ||
      (exists(
        select 1 from pg_stat_activity activity
        where activity.datname = current_database()
          and activity.usename || ':' || activity.application_name = '$bootstrap_identity'
          and activity.query = '$lock_query'
      ))::int::text || ':' ||
      (exists(
        select 1 from pg_stat_activity activity
        where activity.datname = current_database()
          and activity.usename || ':' || activity.application_name = '$migrate_identity'
          and activity.query = '$lock_query'
      ))::int::text;")"
    if [[ "$observation" == 1:1:1 ]]; then
      return 0
    fi
    sleep 0.1
  done
  echo "Timed out observing holder/bootstrap/migrator administration-lock identities; last state: $observation" >&2
  return 1
}
inspect_postgres_identity() {
  local passwd_identity passwd_uid passwd_gid group_gid inspected_postgres_identity
  local -a inspector=(
    docker run --rm --pull never --user 65534:65534 --network none --read-only --cap-drop ALL
    --security-opt no-new-privileges:true --pids-limit 32 --memory 64m
    --entrypoint awk "$postgres_image"
  )
  passwd_identity="$(timeout 60 "${inspector[@]}" \
    -F: '$1 == "postgres" { printf "%s:%s\n", $3, $4; found=1 } END { if (!found) exit 1 }' /etc/passwd)"
  group_gid="$(timeout 60 "${inspector[@]}" \
    -F: '$1 == "postgres" { print $3; found=1 } END { if (!found) exit 1 }' /etc/group)"
  IFS=':' read -r passwd_uid passwd_gid <<<"$passwd_identity"
  [[ "$passwd_uid" =~ ^[0-9]+$ && "$passwd_gid" =~ ^[0-9]+$ && "$group_gid" =~ ^[0-9]+$ ]] || {
    echo "The pinned PostgreSQL image returned an invalid postgres identity: $passwd_identity:$group_gid" >&2
    return 1
  }
  inspected_postgres_identity="$passwd_uid:$passwd_gid:$group_gid"
  [[ "$inspected_postgres_identity" == 999:999:999 ]] || {
    echo "The pinned PostgreSQL passwd/group identity drifted from reviewed 999:999:999 to $inspected_postgres_identity." >&2
    return 1
  }
  POSTGRES_UID="$passwd_uid"
  POSTGRES_GID="$passwd_gid"
  export POSTGRES_UID POSTGRES_GID
}
prepare_postgres_bind_dirs() {
  sudo -n chown -- "$POSTGRES_UID:$POSTGRES_GID" "$data_root/postgres" "$postgres_socket_dir"
  sudo -n chmod 0700 "$data_root/postgres" "$postgres_socket_dir"
  [[ "$(stat -c '%u:%g %a' "$data_root/postgres")" == "$POSTGRES_UID:$POSTGRES_GID 700" ]] || {
    echo "The disposable PostgreSQL data directory ownership or mode is incorrect." >&2
    return 1
  }
  [[ "$(stat -c '%u:%g %a' "$postgres_socket_dir")" == "$POSTGRES_UID:$POSTGRES_GID 700" ]] || {
    echo "The disposable PostgreSQL socket directory ownership or mode is incorrect." >&2
    return 1
  }
}

assert_postgres_least_privilege() {
  local postgres_id runtime_contract configured_user cap_drop cap_add security_opt process_capabilities process_identity expected_process_identity socket_setting
  postgres_id="$("${compose[@]}" ps --quiet postgres)"
  [[ -n "$postgres_id" ]] || {
    echo "The PostgreSQL container identity is unavailable for the least-privilege proof." >&2
    return 1
  }
  runtime_contract="$(docker inspect --format '{{.Config.User}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.CapAdd}}|{{json .HostConfig.SecurityOpt}}' "$postgres_id")"
  IFS='|' read -r configured_user cap_drop cap_add security_opt <<<"$runtime_contract"
  [[ "$configured_user" == "$POSTGRES_UID:$POSTGRES_GID" ]] || {
    echo "PostgreSQL Config.User drifted: $configured_user" >&2
    return 1
  }
  [[ "$cap_drop" == '["ALL"]' && ( "$cap_add" == null || "$cap_add" == '[]' ) ]] || {
    echo "PostgreSQL retained an unexpected capability configuration: drop=$cap_drop add=$cap_add" >&2
    return 1
  }
  [[ "$security_opt" == '["no-new-privileges:true"]' ]] || {
    echo "PostgreSQL no-new-privileges configuration drifted: $security_opt" >&2
    return 1
  }
  process_capabilities="$("${compose[@]}" exec -T postgres awk '/^(CapEff|CapBnd|NoNewPrivs):/ { print $1 $2 }' /proc/1/status)"
  [[ "$process_capabilities" == $'CapEff:0000000000000000\nCapBnd:0000000000000000\nNoNewPrivs:1' ]] || {
    echo "PostgreSQL PID 1 retained capabilities or lacks NoNewPrivs: $process_capabilities" >&2
    return 1
  }
  process_identity="$("${compose[@]}" exec -T postgres awk '/^(Uid|Gid):/ { print $1 $2 ":" $3 ":" $4 ":" $5 }' /proc/1/status)"
  expected_process_identity="Uid:$POSTGRES_UID:$POSTGRES_UID:$POSTGRES_UID:$POSTGRES_UID
Gid:$POSTGRES_GID:$POSTGRES_GID:$POSTGRES_GID:$POSTGRES_GID"
  [[ "$process_identity" == "$expected_process_identity" ]] || {
    echo "PostgreSQL PID 1 UID/GID fields drifted: $process_identity" >&2
    return 1
  }
  socket_setting="$(psql_query 'show unix_socket_directories;')"
  [[ "$socket_setting" == /run/learncoding-postgres ]] || {
    echo "PostgreSQL is not using the reviewed custom socket directory: $socket_setting" >&2
    return 1
  }
  [[ "$(stat -c '%u:%g %a' "$data_root/postgres")" == "$POSTGRES_UID:$POSTGRES_GID 700" ]] || {
    echo "PostgreSQL data ownership or mode drifted while running." >&2
    return 1
  }
  [[ "$(stat -c '%u:%g %a' "$postgres_socket_dir")" == "$POSTGRES_UID:$POSTGRES_GID 700" ]] || {
    echo "PostgreSQL socket ownership or mode drifted while running." >&2
    return 1
  }
}
network_name() {
  docker network ls \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter "label=com.docker.compose.network=$1" \
    --format '{{.Name}}' | awk 'NF { print; exit }'
}

probe_http() {
  network="$1"
  url="$2"
  status="$3"
  timeout 30 docker run --rm --network "$network" --entrypoint node "$runtime_image" -e \
    "fetch('$url', { redirect: 'manual' }).then((r) => { if (r.status !== $status) process.exit(1); }).catch(() => process.exit(1));"
}

assert_pilot_inventory() {
  local id ids project_ids service port_bindings uploads
  for service in clamav scan-worker; do
    ids="$(docker ps -aq \
      --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
      --filter "label=com.docker.compose.service=$service")"
    if [[ -n "$ids" ]]; then
      echo "ClamAV/scanner services were started in pilot topology" >&2
      return 1
    fi
  done
  if ! project_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"; then
    echo "Unable to enumerate topology containers for the host-port proof." >&2
    return 1
  fi
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$id")"
    if [[ "$port_bindings" != '{}' && "$port_bindings" != null ]]; then
      echo "A topology container published a host port." >&2
      return 1
    fi
  done <<<"$project_ids"
  app_id="$("${compose[@]}" ps --quiet app)"
  uploads="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$app_id" | grep '^UPLOADS_ENABLED=' || true)"
  [[ "$uploads" == 'UPLOADS_ENABLED=false' ]] || {
    echo "UPLOADS_ENABLED=false is not active in the application container." >&2
    return 1
  }
}

wait_for_stack() {
  timeout 360 "${compose[@]}" up --detach --no-build --wait --wait-timeout 330
  probe_http "$(network_name frontend)" 'http://app:3000/health/ready' 200
  probe_http "$(network_name runner-client)" 'http://runner-egress-gateway:4100/health' 200
  assert_pilot_inventory
}
wait_for_policy_recovered_stack() {
  local deadline id service state ready
  deadline=$((SECONDS + 360))
  while (( SECONDS < deadline )); do
    ready=1
    for service in "${policy_recovered_services[@]}"; do
      id="$("${compose[@]}" ps --quiet "$service" 2>/dev/null || true)"
      if [[ -z "$id" ]]; then
        ready=0
        break
      fi
      state="$(docker inspect --format '{{if .State.Running}}running{{else}}stopped{{end}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || true)"
      if [[ "$state" != 'running healthy' && "$state" != 'running none' ]]; then
        ready=0
        break
      fi
    done
    if (( ready == 1 )); then
      probe_http "$(network_name frontend)" 'http://app:3000/health/ready' 200
      probe_http "$(network_name runner-client)" 'http://runner-egress-gateway:4100/health' 200
      assert_pilot_inventory
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for Docker restart policies to recover the internal stack." >&2
  return 1
}
wait_for_existing_stack() {
  local deadline id service state ready
  deadline=$((SECONDS + 360))
  while (( SECONDS < deadline )); do
    ready=1
    for service in "${long_running_services[@]}"; do
      id="$("${compose[@]}" ps --quiet "$service" 2>/dev/null || true)"
      if [[ -z "$id" ]]; then
        ready=0
        break
      fi
      state="$(docker inspect --format '{{if .State.Running}}running{{else}}stopped{{end}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || true)"
      if [[ "$state" != 'running healthy' && "$state" != 'running none' ]]; then
        ready=0
        break
      fi
    done
    if (( ready == 1 )); then
      probe_http "$(network_name frontend)" 'http://app:3000/health/ready' 200
      probe_http "$(network_name runner-client)" 'http://runner-egress-gateway:4100/health' 200
      assert_pilot_inventory
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for restart policies to recover the existing stack." >&2
  return 1
}


build_image() {
  target="$1"
  image="$2"
  timeout 1200 docker build --quiet --pull=false --target "$target" --tag "$image" \
    --label "$image_label" \
    --build-arg SOURCE_REPOSITORY="https://example.invalid/codestead" \
    --build-arg SOURCE_REVISION="production-topology-$run_id" \
    --build-arg SOURCE_DATE_EPOCH=0 \
    --build-arg SOURCE_TREE="production-topology" \
    --build-arg SOURCE_CONTEXT_SHA256="$(printf '%064d' 0)" \
    "$repo_root" >/dev/null
}

for image in "${images[@]}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "Refusing to replace an existing disposable image tag: $image" >&2
    exit 73
  fi
done
reserve_runner_client_network

timeout 300 docker pull "$postgres_image" >/dev/null
inspect_postgres_identity
prepare_postgres_bind_dirs
build_image runtime "$runtime_image"
build_image tooling "$tooling_image"
build_image worker "$worker_image"
build_image regrade-worker "$regrade_image"
build_image project-review-correction-worker "$project_review_image"
build_image operations "$operations_image"

timeout 180 "${compose[@]}" config --quiet
timeout 180 "${compose[@]}" up --detach --no-build --wait --wait-timeout 150 postgres
wait_for_query 1 "select 1;"
assert_postgres_least_privilege

timeout 360 "${compose[@]}" --profile operations run --rm --env PGAPPNAME=codestead-topology-role-bootstrap --no-deps database-role-bootstrap \
  >"$workdir/bootstrap-initial.log" 2>&1
grep -F '"event":"database.roles_bootstrapped"' "$workdir/bootstrap-initial.log" >/dev/null

# Hold the shared database-administration lock, then prove both the idempotent
# role bootstrap and the first migration contend on it before succeeding.
(
  timeout 40 "${compose[@]}" exec -T -e PGAPPNAME=codestead-topology-lock-holder postgres psql --no-psqlrc --set ON_ERROR_STOP=1 \
    --host /run/learncoding-postgres --username learncoding --dbname learncoding --command \
    "select pg_advisory_lock(hashtextextended('codestead:database-administration:v1', 0)); select pg_sleep(15); select pg_advisory_unlock(hashtextextended('codestead:database-administration:v1', 0));" \
    >"$workdir/lock-holder.log"
) &
lock_holder_pid=$!
wait_for_query t "select exists(select 1 from pg_stat_activity activity join pg_locks held_lock on held_lock.pid = activity.pid where activity.datname = current_database() and activity.usename = 'learncoding' and activity.application_name = 'codestead-topology-lock-holder' and held_lock.locktype = 'advisory' and held_lock.granted);"
(
  timeout 360 "${compose[@]}" --profile operations run --rm --env PGAPPNAME=codestead-topology-role-bootstrap --no-deps database-role-bootstrap \
    >"$workdir/bootstrap-contended.log" 2>&1
) &
bootstrap_pid=$!
(
  timeout 360 "${compose[@]}" --profile operations run --rm --env PGAPPNAME=codestead-topology-migrate --no-deps migrate \
    >"$workdir/migrate-one.log" 2>&1
) &
migrate_pid=$!
wait_for_database_admin_contenders
kill -0 "$lock_holder_pid" "$bootstrap_pid" "$migrate_pid" || {
  echo "A database-administration lock contender exited before the held-lock proof." >&2
  exit 1
}
if grep -F '"event":"database.roles_bootstrapped"' "$workdir/bootstrap-contended.log" >/dev/null \
  || grep -F '"event":"database.migrated"' "$workdir/migrate-one.log" >/dev/null; then
  echo "A database-administration contender succeeded while the external lock was still held." >&2
  exit 1
fi
wait "$lock_holder_pid"
wait "$bootstrap_pid"
wait "$migrate_pid"
grep -F '"event":"database.roles_bootstrapped"' "$workdir/bootstrap-contended.log" >/dev/null
grep -F '"event":"database.migrated"' "$workdir/migrate-one.log" >/dev/null

migration_rows_before="$(psql_query 'select count(*) from drizzle.__drizzle_migrations;')"
[[ "$migration_rows_before" =~ ^[1-9][0-9]*$ ]] || {
  echo "The first migration service did not record migrations." >&2
  exit 1
}

# Run two uses the same real one-shot and proves the complete migration set is
# idempotent rather than appending duplicates.
timeout 360 "${compose[@]}" --profile operations run --rm --env PGAPPNAME=codestead-topology-migrate --no-deps migrate \
  >"$workdir/migrate-two.log" 2>&1
grep -F '"event":"database.migrated"' "$workdir/migrate-two.log" >/dev/null
migration_rows_after="$(psql_query 'select count(*) from drizzle.__drizzle_migrations;')"
[[ "$migration_rows_after" == "$migration_rows_before" ]] || {
  echo "The second migration service changed the migration row count." >&2
  exit 1
}
[[ "$(psql_query 'select count(*) = count(distinct hash) from drizzle.__drizzle_migrations;')" == t ]] || {
  echo "Migration hashes were duplicated." >&2
  exit 1
}

timeout 600 "${compose[@]}" --profile operations run --rm --no-deps platform-seed \
  >"$workdir/seed-one.log" 2>&1
grep -F '"event":"platform.seeded"' "$workdir/seed-one.log" >/dev/null
timeout 180 "${compose[@]}" --profile operations run --rm --no-deps admin-bootstrap \
  >"$workdir/bootstrap-one.log" 2>&1
grep -F '"event":"bootstrap_admin.created"' "$workdir/bootstrap-one.log" >/dev/null

readonly marker_hash="b75ab7925a8954e018eedc274eec0a1af06af1fef9c3d322e14aa83b0a7d1609"
psql_query "insert into audit_event (action, resource_type, resource_id, reason, outcome, correlation_id, metadata, event_hash) values ('topology.acknowledged', 'release-gate', 'production-topology-v1', 'disposable restart proof', 'success', 'production-topology-v1', '{\"fixture\":true}'::jsonb, '$marker_hash') on conflict (event_hash) do nothing;" >/dev/null
[[ "$(psql_query "select count(*) from audit_event where event_hash = '$marker_hash';")" == 1 ]] || {
  echo "Acknowledged durable audit marker was not committed exactly once." >&2
  exit 1
}

readonly expected_policy_identities="nvidia_nim:credential_validation:meta/llama-3.1-8b-instruct,nvidia_nim:tutor:meta/llama-3.1-8b-instruct"
readonly expected_achievement_identities="first-independent-skill,mastery-95,project-evidence,retained-one-week,review-rhythm-8"
readonly expected_course_identities="ai,c,cpp,css,dsa,git-tooling,html,java,javascript,programming-foundations,python,react"
readonly expected_curriculum_artifacts=964
readonly expected_module_project_templates=119
readonly expected_artifact_type_counts="assessment_bank:476,authored_lesson:476,course_manifest:12"

assert_seed_contract() {
  local actual
  actual="$(psql_query "select count(*) from \"user\" where role='admin';")"
  [[ "$actual" == 1 ]] || {
    echo "Expected exactly one administrator in total, found $actual." >&2
    return 1
  }
  actual="$(psql_query "select count(*) from \"user\" where role='admin' and lower(email)=lower('$BOOTSTRAP_ADMIN_EMAIL');")"
  [[ "$actual" == 1 ]] || {
    echo "Expected exactly one administrator with the bootstrap email, found $actual." >&2
    return 1
  }
  actual="$(psql_query "select coalesce(string_agg(provider::text || ':' || operation::text || ':' || model, ',' order by provider, operation, model), '') from provider_policy;")"
  [[ "$actual" == "$expected_policy_identities" ]] || {
    echo "Provider policy identities differ from the reviewed seed set: $actual" >&2
    return 1
  }
  [[ "$(psql_query 'select count(*) = count(distinct (provider, operation, model)) from provider_policy;')" == t ]] || {
    echo "Provider policy identities are not unique." >&2
    return 1
  }
  actual="$(psql_query "select coalesce(string_agg(slug, ',' order by slug), '') from achievement;")"
  [[ "$actual" == "$expected_achievement_identities" ]] || {
    echo "Achievement identities differ from the reviewed seed set: $actual" >&2
    return 1
  }
  [[ "$(psql_query 'select count(*) = count(distinct slug) from achievement;')" == t ]] || {
    echo "Achievement identities are not unique." >&2
    return 1
  }
  actual="$(psql_query "select coalesce(string_agg(slug, ',' order by slug), '') from course;")"
  [[ "$actual" == "$expected_course_identities" ]] || {
    echo "Course identities differ from the reviewed seed set: $actual" >&2
    return 1
  }
  [[ "$(psql_query 'select count(*) = count(distinct slug) from course;')" == t ]] || {
    echo "Course identities are not unique." >&2
    return 1
  }
  actual="$(psql_query 'select count(*) from curriculum_artifact;')"
  [[ "$actual" == "$expected_curriculum_artifacts" ]] || {
    echo "Expected $expected_curriculum_artifacts curriculum artifacts, found $actual." >&2
    return 1
  }
  [[ "$(psql_query 'select count(*) = count(distinct (course_version_id, artifact_key)) from curriculum_artifact;')" == t ]] || {
    echo "Curriculum artifact identities are not unique." >&2
    return 1
  }
  actual="$(psql_query "select coalesce(string_agg(artifact_type || ':' || row_count, ',' order by artifact_type), '') from (select artifact_type::text as artifact_type, count(*)::text as row_count from curriculum_artifact group by artifact_type) counts;")"
  [[ "$actual" == "$expected_artifact_type_counts" ]] || {
    echo "Curriculum artifact type identities differ from the reviewed seed set: $actual" >&2
    return 1
  }
  [[ "$(psql_query "select count(*) from curriculum_artifact where artifact_key = '' or content_hash !~ '^[0-9a-f]{64}$';")" == 0 ]] || {
    echo "Curriculum artifacts contain an empty identity or invalid content hash." >&2
    return 1
  }
  actual="$(psql_query 'select count(*) from module_project_template;')"
  [[ "$actual" == "$expected_module_project_templates" ]] || {
    echo "Expected $expected_module_project_templates module project templates, found $actual." >&2
    return 1
  }
  [[ "$(psql_query 'select count(*) = count(distinct template_key) from module_project_template;')" == t ]] || {
    echo "Module project template identities are not unique." >&2
    return 1
  }
  [[ "$(psql_query "select count(*) from module_project_template where template_key = '' or content_hash !~ '^[0-9a-f]{64}$';")" == 0 ]] || {
    echo "Module project templates contain an empty identity or invalid content hash." >&2
    return 1
  }
}

seed_snapshot_query="select jsonb_build_object(
  'admins',(select coalesce(jsonb_agg(jsonb_build_array(id,lower(email),role,status) order by lower(email),id),'[]'::jsonb) from \"user\" where role='admin'),
  'policies',(select coalesce(jsonb_agg(jsonb_build_array(provider,operation,model,priority,max_input_tokens,max_output_tokens,timeout_ms,enabled) order by provider,operation,model),'[]'::jsonb) from provider_policy),
  'achievements',(select coalesce(jsonb_agg(jsonb_build_array(slug,title,description,icon,rule_version,rule) order by slug),'[]'::jsonb) from achievement),
  'courses',(select coalesce(jsonb_agg(jsonb_build_array(slug,title,summary,domain) order by slug),'[]'::jsonb) from course),
  'versions',(select coalesce(jsonb_agg(jsonb_build_array(course.slug,version.version,version.stage,version.scope_statement,version.source_commit,version.content_hash) order by course.slug,version.version),'[]'::jsonb) from course_version version join course on course.id=version.course_id),
  'content',(select jsonb_build_object('rows',count(*),'identityDigest',md5(string_agg(course.slug || ':' || version.version || ':' || artifact.artifact_key || ':' || artifact.artifact_type::text || ':' || artifact.content_hash, ',' order by course.slug,version.version,artifact.artifact_key))) from curriculum_artifact artifact join course_version version on version.id=artifact.course_version_id join course on course.id=version.course_id),
  'templates',(select jsonb_build_object('rows',count(*),'identityDigest',md5(string_agg(course.slug || ':' || version.version || ':' || template.template_key || ':' || template.template_version || ':' || template.source_course_content_hash || ':' || template.content_hash || ':' || template.stage::text, ',' order by course.slug,version.version,template.template_key))) from module_project_template template join course_version version on version.id=template.course_version_id join course on course.id=version.course_id)
)::text;"
assert_seed_contract
seed_snapshot_before="$(psql_query "$seed_snapshot_query")"

wait_for_stack

declare -A started_before=()
for service in "${long_running_services[@]}"; do
  container_id="$("${compose[@]}" ps --quiet "$service")"
  started_before["$service"]="$(docker inspect --format '{{.State.StartedAt}}' "$container_id")"
done

# This exact literal is also asserted by the registration contract.
"${compose[@]}" restart postgres app >/dev/null
"${compose[@]}" restart "${long_running_services[@]:2}" >/dev/null
wait_for_stack
assert_postgres_least_privilege
for service in "${long_running_services[@]}"; do
  container_id="$("${compose[@]}" ps --quiet "$service")"
  started_after="$(docker inspect --format '{{.State.StartedAt}}' "$container_id")"
  [[ "$started_after" != "${started_before[$service]}" ]] || {
    echo "Service did not restart: $service" >&2
    exit 1
  }
done

[[ "$(psql_query "select count(*) from audit_event where event_hash = '$marker_hash';")" == 1 ]] || {
  echo "Acknowledged data was lost or duplicated after service/PostgreSQL restart." >&2
  exit 1
}

timeout 600 "${compose[@]}" --profile operations run --rm --no-deps platform-seed \
  >"$workdir/seed-two.log" 2>&1
grep -F '"event":"platform.seeded"' "$workdir/seed-two.log" >/dev/null
timeout 180 "${compose[@]}" --profile operations run --rm --no-deps admin-bootstrap \
  >"$workdir/bootstrap-two.log" 2>&1
grep -F '"event":"bootstrap_admin.exists"' "$workdir/bootstrap-two.log" >/dev/null
seed_snapshot_after="$(psql_query "$seed_snapshot_query")"
assert_seed_contract
[[ "$seed_snapshot_after" == "$seed_snapshot_before" ]] || {
  echo "Seed/bootstrap semantic snapshot changed after idempotent replay." >&2
  exit 1
}

# Optional, separate host-only tranche. It is intentionally disabled unless an
# operator explicitly confirms that this is a disposable systemd Docker host.
if [[ "${CODESTEAD_TOPOLOGY_RESTART_DOCKER:-0}" == 1 ]]; then
  if [[ "${CODESTEAD_DISPOSABLE_DOCKER_DAEMON:-}" != 1 || "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
    echo "Docker-daemon restart requires the disposable github-hosted acknowledgements." >&2
    exit 64
  fi
  docker_active_before="$(systemctl show docker.service --property ActiveEnterTimestampMonotonic --value)"
  capture_daemon_restart_baseline
  assert_disposable_daemon_scope project-only
  sudo -n systemctl restart docker.service
  for _ in $(seq 1 120); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null
  docker_active_after="$(systemctl show docker.service --property ActiveEnterTimestampMonotonic --value)"
  [[ -n "$docker_active_before" && -n "$docker_active_after" && "$docker_active_after" != "$docker_active_before" ]] || {
    echo "Docker service did not enter a new active generation." >&2
    exit 1
  }
  # Internal services recover by policy. Public ingress remains quarantined
  # until the guarded recovery authority explicitly starts cloudflared.
  wait_for_policy_recovered_stack
  assert_postgres_least_privilege
  assert_policy_recovered_generations_changed
  assert_cloudflared_quarantined_after_daemon_restart
  recover_ingress_after_daemon_restart
  wait_for_existing_stack
  assert_cloudflared_generation_changed_after_guarded_recovery
  [[ "$(psql_query "select count(*) from audit_event where event_hash = '$marker_hash';")" == 1 ]] || {
    echo "Acknowledged data failed the Docker-daemon restart tranche." >&2
    exit 1
  }
fi

echo "production topology passed: locked/idempotent migrations, seed/bootstrap, pilot readiness, restart durability, and clean teardown"
