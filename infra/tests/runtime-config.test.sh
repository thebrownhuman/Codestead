#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash_bin="$(command -v bash)"
env_bin="$(command -v env)"
validator="$repo_root/infra/ops/validate-runtime.sh"

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    exec sudo -n "$bash_bin" "$repo_root/infra/tests/runtime-config.test.sh"
  fi

  echo "sudo bash infra/tests/runtime-config.test.sh" >&2
  exit 1
fi

tmp_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
work="$(mktemp -d "$tmp_base/runtime-config.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'runtime config fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
cleanup() {
  if [[ -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

readonly secrets_gid=2000
readonly secret_canary='RUNTIME_SECRET_CANARY_4f5de90a_DO_NOT_PRINT'
readonly database_canary='RUNTIME_DATABASE_CANARY_8b172e3c_DO_NOT_PRINT'
readonly digest_a='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly digest_b='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly digest_c='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
readonly digest_d='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
readonly digest_e='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
readonly digest_f='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
readonly digest_1='1111111111111111111111111111111111111111111111111111111111111111'
readonly digest_2='2222222222222222222222222222222222222222222222222222222222222222'
readonly digest_3='3333333333333333333333333333333333333333333333333333333333333333'
readonly pilot_clamav='clamav/clamav:pilot-disabled'
readonly postgres_probe_sql="SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes');"

trusted_stat_assignment_count="$(grep -Fxc 'readonly trusted_stat_bin="/usr/bin/stat"' "$validator" || true)"
trusted_realpath_assignment_count="$(grep -Fxc 'readonly trusted_realpath_bin="/usr/bin/realpath"' "$validator" || true)"
if [[ "$trusted_stat_assignment_count" != 1 || "$trusted_realpath_assignment_count" != 1 ]]; then
  echo 'FAIL: runtime validator trusted metadata-tool boundary changed unexpectedly' >&2
  exit 1
fi
unexpected_absolute_commands="$(tail -n +2 "$validator" | \
  grep -E '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+' | \
  grep -Fv 'readonly trusted_stat_bin="/usr/bin/stat"' | \
  grep -Fv 'readonly trusted_realpath_bin="/usr/bin/realpath"' || true)"
if [[ -n "$unexpected_absolute_commands" ]]; then
  echo 'FAIL: runtime validator can bypass the isolated command root with an absolute executable' >&2
  exit 1
fi
if tail -n +2 "$validator" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  echo 'FAIL: runtime validator can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH' >&2
  exit 1
fi
if tail -n +2 "$validator" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  echo 'FAIL: runtime validator can bypass fake command lookup' >&2
  exit 1
fi
unsafe_absolute_redirects="$(tail -n +2 "$validator" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  echo 'FAIL: runtime validator redirects output to an absolute path other than /dev/null' >&2
  exit 1
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -z "$redirect_prefix_probe" ]]; then
  echo 'FAIL: runtime redirect guard accepted a /dev/null prefix sibling' >&2
  exit 1
fi
if tail -n +2 "$validator" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])eval([;&|()[:space:]]|$)'; then
  echo 'FAIL: runtime validator can spawn an uninstrumented shell command' >&2
  exit 1
fi
runtime_source_count="$(grep -Fxc 'source "$compose_env"' "$validator" || true)"
all_runtime_source_count="$(tail -n +2 "$validator" | grep -Ec '(^|[;&|()[:space:]])source([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/' || true)"
if [[ "$runtime_source_count" != 1 || "$all_runtime_source_count" != 1 ]]; then
  echo 'FAIL: runtime validator may source only the already-validated Compose environment file' >&2
  exit 1
fi
runtime_input_redirects="$(tail -n +2 "$validator" | grep -E '(^|[^<])<[[:space:]]*([^<(&]|$)' || true)"
expected_runtime_input_redirects="$(printf '%s\n' \
  '  tr -d '\''[:space:]'\'' <"$file" | wc -c' \
  'decoded_key_bytes="$(tr -d '\''\r\n '\'' <"$secrets_dir/credential_master_key" | base64 --decode 2>/dev/null | wc -c)" || {')"
if [[ "$runtime_input_redirects" != "$expected_runtime_input_redirects" ]]; then
  echo 'FAIL: runtime validator contains an uninstrumented input redirection outside the two validated secret reads' >&2
  exit 1
fi

case_number=0
case_dir=
config=
secrets=
fake_stat_target=
fake_runner_url=
fake_runner_subnet=
fake_runner_bridge=
fake_app_image=
fake_long_restart=
fake_oneshot_restart=
fake_postgres_fsync=
fake_postgres_sync_commit=
fake_postgres_full_page_writes=
fake_host_port=false
fake_live_fsync=
fake_live_sync_commit=
fake_live_full_page_writes=
fake_docker_log=
fake_mutate_service=
fake_mutate_field=
fake_mutate_value=
validator_under_test=

make_fixture() {
  local label="$1"
  case_number=$((case_number + 1))
  case_dir="$work/$case_number-$label"
  config="$case_dir/compose.env"
  secrets="$case_dir/secrets"
  fake_stat_target=
  fake_runner_url='http://10.20.0.12:4100'
  fake_runner_subnet='172.29.40.0/24'
  fake_runner_bridge='cdst-run0'
  fake_app_image="registry.example.test/codestead/runtime@sha256:$digest_a"
  fake_long_restart='unless-stopped'
  fake_oneshot_restart='no'
  fake_postgres_fsync='on'
  fake_postgres_sync_commit='on'
  fake_postgres_full_page_writes='on'
  fake_host_port=false
  fake_live_fsync='on'
  fake_live_sync_commit='on'
  fake_live_full_page_writes='on'
  fake_docker_log="$case_dir/docker.log"
  fake_mutate_service=
  fake_mutate_field=
  fake_mutate_value=
  validator_under_test="$case_dir/validate-runtime.sh"

  mkdir -p \
    "$case_dir/bin" \
    "$secrets" \
    "$case_dir/data/postgres" \
    "$case_dir/data/next-cache" \
    "$case_dir/data/app-data" \
    "$case_dir/data/uploads" \
    "$case_dir/data/clamav"

  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/docker"
  cat >>"$case_dir/bin/docker" <<'EOF'
set -Eeuo pipefail

{
  printf 'docker'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"

if [[ "$#" == 2 && "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi

if [[ "$#" == 1 && "${1:-}" == "info" ]]; then
  exit 0
fi

if [[ "$#" == 16 && "$1" == compose && "$2" == --env-file && "$3" == "$FAKE_EXPECTED_COMPOSE_ENV" && \
  "$4" == -f && "$5" == "$FAKE_EXPECTED_COMPOSE_FILE" && "$6" == exec && "$7" == -T && \
  "$8" == postgres && "$9" == psql && "${10}" == --username=learncoding && \
  "${11}" == --dbname=learncoding && "${12}" == --no-align && "${13}" == --tuples-only && \
  "${14}" == '--field-separator=|' && "${15}" == --command && "${16}" == "$FAKE_EXPECTED_POSTGRES_SQL" ]]; then
  printf '%s|%s\n' \
    fsync "$FAKE_LIVE_FSYNC" \
    synchronous_commit "$FAKE_LIVE_SYNC_COMMIT" \
    full_page_writes "$FAKE_LIVE_FULL_PAGE_WRITES"
  exit 0
fi

value_for() {
  local service="$1"
  local field="$2"
  local default="$3"
  if [[ "$FAKE_MUTATE_SERVICE" == "$service" && "$FAKE_MUTATE_FIELD" == "$field" ]]; then
    printf '%s' "$FAKE_MUTATE_VALUE"
  else
    printf '%s' "$default"
  fi
}

emit_host_port() {
  local service="$1"
  if [[ "$FAKE_HOST_PORT" == true && "$service" == app ]] ||
    [[ "$FAKE_MUTATE_SERVICE" == "$service" && "$FAKE_MUTATE_FIELD" == host-port ]]; then
    printf '%s\n' '    ports:' '      - 127.0.0.1:3000:3000'
  fi
}

if [[ "${1:-}" == "compose" ]]; then
  [[ "$#" == 6 && "${2:-}" == --env-file && "${3:-}" == "$FAKE_EXPECTED_COMPOSE_ENV" &&
    "${4:-}" == -f && "${5:-}" == "$FAKE_EXPECTED_COMPOSE_FILE" && "${6:-}" == config ]] || exit 64
  postgres_image="$(value_for postgres image 'registry.example.test/postgres@sha256:2222222222222222222222222222222222222222222222222222222222222222')"
  postgres_restart="$(value_for postgres restart unless-stopped)"
  postgres_stop="$(value_for postgres stop-grace 2m)"
  printf '%s\n' 'services:' '  postgres:' \
    "    image: $postgres_image" \
    "    restart: $postgres_restart" \
    "    stop_grace_period: $postgres_stop" \
    '    environment:' \
    '      POSTGRES_INITDB_ARGS: --data-checksums' \
    '    command:' \
    '      - postgres' \
    '      - -c' \
    "      - fsync=$FAKE_POSTGRES_FSYNC" \
    '      - -c' \
    "      - synchronous_commit=$FAKE_POSTGRES_SYNC_COMMIT" \
    '      - -c' \
    "      - full_page_writes=$FAKE_POSTGRES_FULL_PAGE_WRITES"
  emit_host_port postgres
  app_image="$(value_for app image "$FAKE_APP_IMAGE")"
  app_restart="$(value_for app restart "$FAKE_LONG_RESTART")"
  app_stop="$(value_for app stop-grace 1m)"
  printf '%s\n' '  app:' \
    "    image: $app_image" \
    "    restart: $app_restart" \
    "    stop_grace_period: $app_stop" \
    '    environment:' \
    "      RUNNER_BASE_URL: $FAKE_RUNNER_URL" \
    '    networks:' \
    '      - data' \
    '      - frontend' \
    '      - runner-egress'
  emit_host_port app
  for service in mail-worker reward-worker regrade-worker exam-finalization-worker \
    practice-runner-recovery-worker project-review-correction-worker scan-worker; do
    service_image="$(value_for "$service" image 'registry.example.test/worker@sha256:3333333333333333333333333333333333333333333333333333333333333333')"
    service_restart="$(value_for "$service" restart unless-stopped)"
    service_stop="$(value_for "$service" stop-grace 1m)"
    printf '%s\n' \
      "  $service:" \
      "    image: $service_image" \
      "    restart: $service_restart" \
      "    stop_grace_period: $service_stop"
    emit_host_port "$service"
  done
  cloudflared_image="$(value_for cloudflared image 'registry.example.test/cloudflared@sha256:3333333333333333333333333333333333333333333333333333333333333333')"
  cloudflared_restart="$(value_for cloudflared restart unless-stopped)"
  cloudflared_stop="$(value_for cloudflared stop-grace 30s)"
  printf '%s\n' \
    '  cloudflared:' \
    "    image: $cloudflared_image" \
    "    restart: $cloudflared_restart" \
    "    stop_grace_period: $cloudflared_stop"
  emit_host_port cloudflared
  for service in migrate lifecycle platform-seed admin-bootstrap; do
    service_image="$(value_for "$service" image 'registry.example.test/operations@sha256:1111111111111111111111111111111111111111111111111111111111111111')"
    service_restart="$(value_for "$service" restart "$FAKE_ONESHOT_RESTART")"
    printf '%s\n' \
      "  $service:" \
      '    profiles:' \
      '      - operations' \
      "    image: $service_image" \
      "    restart: $service_restart"
    emit_host_port "$service"
  done
  printf '%s\n' \
    'networks:' \
    '  runner-egress:' \
    '    driver: bridge' \
    '    driver_opts:' \
    "      com.docker.network.bridge.name: $FAKE_RUNNER_BRIDGE" \
    '    ipam:' \
    '      config:' \
    "        - subnet: $FAKE_RUNNER_SUBNET"
  exit 0
fi

exit 64
EOF
  chmod 0755 "$case_dir/bin/docker"
  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/timeout"
  cat >>"$case_dir/bin/timeout" <<'EOF'
set -Eeuo pipefail
{
  printf 'timeout'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"
[[ "$#" == 18 && "${1:-}" == 30s ]] || exit 64
shift
[[ "${1:-}" == "$FAKE_DOCKER_BINARY" ]] || exit 64
shift
exec "$FAKE_DOCKER_BINARY" "$@"
EOF
  chmod 0755 "$case_dir/bin/timeout"
  mkdir -m 0700 "$case_dir/tmp"
  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/fake-safe-command"
  cat >>"$case_dir/bin/fake-safe-command" <<'EOF'
set -Eeuo pipefail

command_name="${0##*/}"
has_fixture_prefix() {
  local candidate="$1"
  [[ "$candidate" == "$FAKE_CASE_ROOT" || "$candidate" == "$FAKE_CASE_ROOT"/* ]]
}
contained_fixture_path() {
  local candidate="$1"
  local relative
  local cursor="$FAKE_CASE_ROOT"
  local component
  local resolved
  local -a components=()
  has_fixture_prefix "$candidate" || return 1
  relative="${candidate#"$FAKE_CASE_ROOT"}"
  relative="${relative#/}"
  [[ "/$relative/" != *'/../'* && "/$relative/" != *'/./'* && "$relative" != *'//'* ]] || return 1
  [[ ! -L "$cursor" ]] || return 1
  [[ -n "$relative" ]] || return 0
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    cursor="$cursor/$component"
    if [[ -L "$cursor" ]]; then
      resolved="$(/usr/bin/realpath --canonicalize-missing -- "$cursor")" || return 1
      has_fixture_prefix "$resolved" || return 1
    fi
  done
}
safe_fixture_path() {
  local candidate="$1"
  local relative
  local cursor="$FAKE_CASE_ROOT"
  local component
  local -a components=()
  contained_fixture_path "$candidate" || return 1
  relative="${candidate#"$FAKE_CASE_ROOT"}"
  relative="${relative#/}"
  [[ -n "$relative" ]] || return 0
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    cursor="$cursor/$component"
    [[ ! -L "$cursor" ]] || return 1
  done
}
realpath_input_is_contained() {
  local candidate="$1"
  local resolved
  has_fixture_prefix "$candidate" || return 1
  resolved="$(/usr/bin/realpath --canonicalize-missing -- "$candidate")" || return 1
  has_fixture_prefix "$resolved"
}

case "$command_name" in
  trusted-stat)
    [[ "$#" == 4 && "$1" == -c && "$3" == -- && ( "$2" == '%u:%g:%a' || "$2" == '%a' || "$2" == '%u' ) ]] || exit 64
    safe_fixture_path "$4" || exit 97
    exec /usr/bin/stat -c "$2" -- "$4"
    ;;
  trusted-realpath)
    [[ "$#" == 4 && "$1" == --canonicalize-missing && "$2" == --no-symlinks && "$3" == -- ]] || exit 64
    realpath_input_is_contained "$4" || exit 97
    resolved="$(/usr/bin/realpath --canonicalize-missing --no-symlinks -- "$4")" || exit 97
    has_fixture_prefix "$resolved" || exit 97
    printf '%s\n' "$resolved"
    ;;
  grep)
    [[ "$#" == 3 && "$1" == -Eq ]] || exit 64
    safe_fixture_path "$3" || exit 97
    exec /usr/bin/grep -Eq -- "$2" "$3"
    ;;
  mktemp)
    [[ "$#" == 0 ]] || exit 64
    exec /usr/bin/mktemp "$FAKE_TMPDIR/runtime-render.XXXXXX"
    ;;
  rm)
    [[ "$#" == 3 && "$1" == -f && "$2" == -- ]] || exit 64
    safe_fixture_path "$3" || exit 97
    exec /usr/bin/rm -f -- "$3"
    ;;
  tr)
    [[ "$#" == 2 && "$1" == -d && ( "$2" == '[:space:]' || "$2" == $'\r\n ' ) ]] || exit 64
    exec /usr/bin/tr -d "$2"
    ;;
  wc)
    [[ "$#" == 1 && "$1" == -c ]] || exit 64
    exec /usr/bin/wc -c
    ;;
  base64)
    [[ "$#" == 1 && "$1" == --decode ]] || exit 64
    exec /usr/bin/base64 --decode
    ;;
  *) exit 64 ;;
esac
EOF
  chmod 0755 "$case_dir/bin/fake-safe-command"
  for command_name in trusted-stat trusted-realpath grep mktemp rm tr wc base64; do
    cp "$case_dir/bin/fake-safe-command" "$case_dir/bin/$command_name"
  done

  /usr/bin/sed \
    -e "s#readonly trusted_stat_bin=\"/usr/bin/stat\"#readonly trusted_stat_bin=\"$case_dir/bin/trusted-stat\"#" \
    -e "s#readonly trusted_realpath_bin=\"/usr/bin/realpath\"#readonly trusted_realpath_bin=\"$case_dir/bin/trusted-realpath\"#" \
    "$validator" >"$validator_under_test"
  chmod 0600 "$validator_under_test"
  grep -Fq "readonly trusted_stat_bin=\"$case_dir/bin/trusted-stat\"" "$validator_under_test" || {
    echo 'FAIL: runtime test did not instrument trusted stat' >&2
    exit 1
  }
  grep -Fq "readonly trusted_realpath_bin=\"$case_dir/bin/trusted-realpath\"" "$validator_under_test" || {
    echo 'FAIL: runtime test did not instrument trusted realpath' >&2
    exit 1
  }
  : >"$fake_docker_log"

  cat >"$case_dir/cloudflare.yml" <<'EOF'
tunnel: 11111111-1111-1111-1111-111111111111
ingress:
  - hostname: pilot.example.test
    service: http://app:3000
  - service: http_status:404
EOF
  chown 0:0 "$case_dir/cloudflare.yml"
  chmod 0600 "$case_dir/cloudflare.yml"

  cat >"$config" <<EOF
APP_URL=https://pilot.example.test
SOURCE_CODE_URL=https://code.example.test/learncoding
APP_RUNTIME_IMAGE=registry.example.test/codestead/runtime@sha256:$digest_a
APP_TOOLING_IMAGE=registry.example.test/codestead/tooling@sha256:$digest_b
APP_WORKER_IMAGE=registry.example.test/codestead/worker@sha256:$digest_c
APP_REGRADE_WORKER_IMAGE=registry.example.test/codestead/regrade-worker@sha256:$digest_d
APP_PROJECT_REVIEW_WORKER_IMAGE=registry.example.test/codestead/project-review-worker@sha256:$digest_e
APP_SCANNER_WORKER_IMAGE=registry.example.test/codestead/scanner-worker@sha256:$digest_f
APP_OPERATIONS_IMAGE=registry.example.test/codestead/operations@sha256:$digest_1
DEPLOY_PLATFORM=linux/amd64
UPLOADS_ENABLED=false
COMPOSE_PROFILES=
SECRETS_GID=$secrets_gid
POSTGRES_IMAGE=postgres:17-bookworm@sha256:$digest_2
CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.0@sha256:$digest_3
CLAMAV_IMAGE=$pilot_clamav
MAIL_ADAPTER=console
MAIL_FROM=
GOOGLE_CLIENT_ID=
SECRETS_DIR=$secrets
CLOUDFLARE_CONFIG_FILE=$case_dir/cloudflare.yml
LEARN_DATA_ROOT=$case_dir/data
VALIDATION_MODE=pilot
RUNNER_BASE_URL=http://10.20.0.12:4100
EOF
  chown 0:0 "$config"
  chmod 0640 "$config"

  printf '%s' "postgres-$secret_canary" >"$secrets/postgres_password"
  printf '%s' "postgresql://learncoding:$database_canary@postgres/learncoding" >"$secrets/database_url"
  printf '%s' 'better-auth-secret-at-least-thirty-two-bytes' >"$secrets/better_auth_secret"
  printf '%s' 'lost-device-proof-key-at-least-thirty-two-bytes' >"$secrets/lost_device_proof_key"
  printf '%s' 'deletion-tombstone-key-at-least-thirty-two-bytes' >"$secrets/deletion_tombstone_key"
  printf '%s' 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=' >"$secrets/credential_master_key"
  printf '%s' 'runner-shared-secret-at-least-thirty-two-bytes' >"$secrets/runner_shared_secret"
  printf '%s' '{"AccountTag":"fixture","TunnelSecret":"fixture"}' >"$secrets/cloudflare_tunnel_credentials.json"
  : >"$secrets/google_client_secret"
  : >"$secrets/gmail_client_id"
  : >"$secrets/gmail_client_secret"
  : >"$secrets/gmail_refresh_token"

  chown 0:"$secrets_gid" "$secrets"
  chmod 0750 "$secrets"
  chown 0:"$secrets_gid" "$secrets"/*
  chmod 0440 "$secrets"/*
}

set_config() {
  local key="$1"
  local value="$2"
  sed -i "s|^${key}=.*$|${key}=${value}|" "$config"
  chown 0:0 "$config"
  chmod 0640 "$config"
}

add_bootstrap_secret() {
  printf '%s' 'temporary-admin-password-123' >"$secrets/bootstrap_admin_password"
  chown 0:"$secrets_gid" "$secrets/bootstrap_admin_password"
  chmod 0440 "$secrets/bootstrap_admin_password"
}

run_validator() {
  local validation_mode="${1:-pilot}"
  local validator_status
  shift || true
  "$env_bin" -i \
    HOME="$case_dir" \
    PATH="$case_dir/bin" \
    TMPDIR="$case_dir/tmp" \
    REPO_ROOT="$repo_root" \
    COMPOSE_ENV_FILE="$config" \
    VALIDATION_MODE="$validation_mode" \
    FAKE_STAT_TARGET="$fake_stat_target" \
    FAKE_DOCKER_LOG="$fake_docker_log" \
    FAKE_DOCKER_BINARY="$case_dir/bin/docker" \
    FAKE_CASE_ROOT="$case_dir" \
    FAKE_TMPDIR="$case_dir/tmp" \
    FAKE_EXPECTED_COMPOSE_ENV="$config" \
    FAKE_EXPECTED_COMPOSE_FILE="$repo_root/compose.yaml" \
    FAKE_RUNNER_URL="$fake_runner_url" \
    FAKE_RUNNER_SUBNET="$fake_runner_subnet" \
    FAKE_RUNNER_BRIDGE="$fake_runner_bridge" \
    FAKE_APP_IMAGE="$fake_app_image" \
    FAKE_LONG_RESTART="$fake_long_restart" \
    FAKE_ONESHOT_RESTART="$fake_oneshot_restart" \
    FAKE_POSTGRES_FSYNC="$fake_postgres_fsync" \
    FAKE_POSTGRES_SYNC_COMMIT="$fake_postgres_sync_commit" \
    FAKE_POSTGRES_FULL_PAGE_WRITES="$fake_postgres_full_page_writes" \
    FAKE_HOST_PORT="$fake_host_port" \
    FAKE_LIVE_FSYNC="$fake_live_fsync" \
    FAKE_LIVE_SYNC_COMMIT="$fake_live_sync_commit" \
    FAKE_LIVE_FULL_PAGE_WRITES="$fake_live_full_page_writes" \
    FAKE_MUTATE_SERVICE="$fake_mutate_service" \
    FAKE_MUTATE_FIELD="$fake_mutate_field" \
    FAKE_MUTATE_VALUE="$fake_mutate_value" \
    FAKE_EXPECTED_POSTGRES_SQL="$postgres_probe_sql" \
    "$bash_bin" "$validator_under_test" "$@"
  validator_status=$?
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] || {
    echo 'FAIL: runtime validator modified the outside-fixture sentinel' >&2
    return 97
  }
  return "$validator_status"
}

assert_canary_absent() {
  local label="$1"
  local output="$2"

  if [[ "$output" == *"$secret_canary"* || "$output" == *"$database_canary"* ]]; then
    echo "FAIL: $label printed secret contents" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

expect_success() {
  local label="$1"
  local validation_mode="${2:-pilot}"
  local -a selector_args=("${@:3}")
  local output
  local status

  set +e
  if (( ${#selector_args[@]} > 0 )); then
    output="$(run_validator "$validation_mode" "${selector_args[@]}" 2>&1)"
  else
    output="$(run_validator "$validation_mode" 2>&1)"
  fi
  status=$?
  set -e

  assert_canary_absent "$label" "$output"
  if (( status != 0 )) || [[ "$output" != 'runtime validation passed' ]]; then
    echo "FAIL: $label expected runtime validation success" >&2
    printf 'status: %s\noutput:\n%s\n' "$status" "$output" >&2
    exit 1
  fi

  echo "ok - $label"
}

expect_failure() {
  local label="$1"
  local expected="$2"
  local validation_mode="${3:-pilot}"
  local -a selector_args=("${@:4}")
  local output
  local status
  local -a fatal_lines=()

  set +e
  if (( ${#selector_args[@]} > 0 )); then
    output="$(run_validator "$validation_mode" "${selector_args[@]}" 2>&1)"
  else
    output="$(run_validator "$validation_mode" 2>&1)"
  fi
  status=$?
  set -e

  assert_canary_absent "$label" "$output"
  if (( status == 0 )); then
    echo "FAIL: $label expected runtime validation failure" >&2
    printf 'output:\n%s\n' "$output" >&2
    exit 1
  fi

  mapfile -t fatal_lines < <(printf '%s\n' "$output" | grep '^fatal:' || true)
  if (( ${#fatal_lines[@]} != 1 )) || [[ "${fatal_lines[0]:-}" != "$expected" ]]; then
    echo "FAIL: $label expected exactly one fatal line" >&2
    printf 'expected: %s\nactual output:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi

  echo "ok - $label"
}

run_fake_docker_contract() {
  "$env_bin" -i \
    PATH="$case_dir/bin" \
    FAKE_DOCKER_LOG="$fake_docker_log" \
    FAKE_EXPECTED_COMPOSE_ENV="$config" \
    FAKE_EXPECTED_COMPOSE_FILE="$repo_root/compose.yaml" \
    FAKE_EXPECTED_POSTGRES_SQL="$postgres_probe_sql" \
    FAKE_LIVE_FSYNC=on \
    FAKE_LIVE_SYNC_COMMIT=on \
    FAKE_LIVE_FULL_PAGE_WRITES=on \
    "$case_dir/bin/docker" "$@"
}

expect_fake_probe_rejected() {
  local label="$1"
  shift
  set +e
  run_fake_docker_contract "$@" >"$case_dir/$label.stdout" 2>"$case_dir/$label.stderr"
  local status=$?
  set -e
  (( status != 0 )) || {
    echo "FAIL: exact PostgreSQL fake accepted $label" >&2
    exit 1
  }
}

make_fixture exact-postgres-probe-fake
postgres_probe_argv=(
  compose --env-file "$config" -f "$repo_root/compose.yaml" exec -T postgres
  psql --username=learncoding --dbname=learncoding --no-align --tuples-only '--field-separator=|'
  --command "$postgres_probe_sql"
)
run_fake_docker_contract "${postgres_probe_argv[@]}" >/dev/null || {
  echo 'FAIL: exact PostgreSQL fake rejected the canonical probe' >&2
  exit 1
}
expect_fake_probe_rejected extra-compose-command \
  compose --env-file "$config" -f "$repo_root/compose.yaml" --profile operations exec -T postgres \
  psql --username=learncoding --dbname=learncoding --no-align --tuples-only '--field-separator=|' \
  --command "$postgres_probe_sql"
expect_fake_probe_rejected extra-psql-command \
  compose --env-file "$config" -f "$repo_root/compose.yaml" exec -T postgres \
  psql --username=learncoding --dbname=learncoding --no-align --tuples-only '--field-separator=|' --list \
  --command "$postgres_probe_sql"
expect_fake_probe_rejected extra-sql-command \
  compose --env-file "$config" -f "$repo_root/compose.yaml" exec -T postgres \
  psql --username=learncoding --dbname=learncoding --no-align --tuples-only '--field-separator=|' \
  --command "$postgres_probe_sql SELECT 1;"

outside_sentinel="$work/outside-runtime-case.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$outside_sentinel"
outside_sentinel_link="$case_dir/outside-sentinel-link"
ln -s "$outside_sentinel" "$outside_sentinel_link"
set +e
"$env_bin" -i PATH="$case_dir/bin" FAKE_CASE_ROOT="$case_dir" FAKE_TMPDIR="$case_dir/tmp" \
  "$case_dir/bin/grep" -Eq sentinel "$outside_sentinel" >"$case_dir/outside-read.stdout" 2>"$case_dir/outside-read.stderr"
outside_read_status=$?
"$env_bin" -i PATH="$case_dir/bin" FAKE_CASE_ROOT="$case_dir" FAKE_TMPDIR="$case_dir/tmp" \
  "$case_dir/bin/grep" -Eq sentinel "$outside_sentinel_link" \
  >"$case_dir/symlink-read.stdout" 2>"$case_dir/symlink-read.stderr"
symlink_read_status=$?
"$env_bin" -i PATH="$case_dir/bin" FAKE_CASE_ROOT="$case_dir" FAKE_TMPDIR="$case_dir/tmp" \
  "$case_dir/bin/trusted-realpath" --canonicalize-missing --no-symlinks -- "$outside_sentinel_link" \
  >"$case_dir/symlink-realpath.stdout" 2>"$case_dir/symlink-realpath.stderr"
symlink_realpath_status=$?
PATH="$case_dir/bin" cp -- "$config" "$outside_sentinel" >"$case_dir/outside-write.stdout" 2>"$case_dir/outside-write.stderr"
outside_write_status=$?
PATH="$case_dir/bin" runtime-contract-unknown-command >"$case_dir/outside-unknown.stdout" 2>"$case_dir/outside-unknown.stderr"
outside_unknown_status=$?
set -e
rm -- "$outside_sentinel_link"
(( outside_read_status != 0 && symlink_read_status != 0 && symlink_realpath_status != 0 &&
   outside_write_status != 0 && outside_unknown_status != 0 )) || {
  echo 'FAIL: fake-only runtime PATH allowed an unknown, direct/symlink outside read, or outside write command' >&2
  exit 1
}
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] || {
  echo 'FAIL: outside-fixture runtime sentinel was modified' >&2
  exit 1
}

make_fixture valid-pilot
expect_success 'valid pilot fixture'
if grep -Eq '(^|[[:space:]])exec([[:space:]]|$)' "$fake_docker_log"; then
  echo 'FAIL: zero-argument preflight contacted the live PostgreSQL container' >&2
  exit 1
fi

while IFS='|' read -r label alternate_url; do
  make_fixture "runner-url-$label"
  fake_runner_url="$alternate_url"
  expect_failure \
    "runner URL $label" \
    'fatal: runner URL must be exactly http://10.20.0.12:4100'
done <<'EOF'
other-rfc1918|http://10.20.0.13:4100
other-rfc1918-172|http://172.29.40.12:4100
other-rfc1918-192|http://192.168.1.12:4100
localhost|http://127.0.0.1:4100
wildcard|http://0.0.0.0:4100
hostname|http://runner.internal:4100
public-https|https://runner.example.test
wrong-port|http://10.20.0.12:4101
userinfo|http://operator@10.20.0.12:4100
path|http://10.20.0.12:4100/healthz
query|http://10.20.0.12:4100?verbose=true
fragment|http://10.20.0.12:4100#runner
EOF

make_fixture wrong-runner-subnet
fake_runner_subnet='172.29.41.0/24'
expect_failure \
  'wrong runner-egress subnet' \
  'fatal: runner-egress subnet must be exactly 172.29.40.0/24'

make_fixture wrong-runner-bridge
fake_runner_bridge='bridge0'
expect_failure \
  'wrong runner-egress bridge' \
  'fatal: runner-egress bridge must be exactly cdst-run0'

all_rendered_services=(
  postgres app mail-worker reward-worker regrade-worker exam-finalization-worker
  practice-runner-recovery-worker project-review-correction-worker scan-worker cloudflared
  migrate lifecycle platform-seed admin-bootstrap
)
long_running_services=(
  postgres app mail-worker reward-worker regrade-worker exam-finalization-worker
  practice-runner-recovery-worker project-review-correction-worker scan-worker cloudflared
)
one_shot_services=(migrate lifecycle platform-seed admin-bootstrap)

for service in "${all_rendered_services[@]}"; do
  make_fixture "host-port-$service"
  fake_mutate_service="$service"
  fake_mutate_field=host-port
  expect_failure \
    "rendered Compose host port on $service" \
    'fatal: trusted Compose stack must not publish host ports'

  make_fixture "mutable-image-$service"
  fake_mutate_service="$service"
  fake_mutate_field=image
  fake_mutate_value='registry.example.test/codestead/mutable:latest'
  expect_failure \
    "rendered mutable image on $service" \
    'fatal: rendered Compose services must use immutable sha256 image references'
done

for service in "${long_running_services[@]}"; do
  make_fixture "wrong-long-restart-$service"
  fake_mutate_service="$service"
  fake_mutate_field=restart
  fake_mutate_value=always
  expect_failure \
    "wrong long-running restart class on $service" \
    'fatal: rendered long-running services must restart unless-stopped'
done

for service in "${one_shot_services[@]}"; do
  make_fixture "wrong-one-shot-restart-$service"
  fake_mutate_service="$service"
  fake_mutate_field=restart
  fake_mutate_value=on-failure
  expect_failure \
    "wrong one-shot restart class on $service" \
    'fatal: rendered one-shot services must use restart no'
done

for setting in fsync synchronous_commit full_page_writes; do
  make_fixture "rendered-postgres-$setting-off"
  case "$setting" in
    fsync) fake_postgres_fsync=off ;;
    synchronous_commit) fake_postgres_sync_commit=off ;;
    full_page_writes) fake_postgres_full_page_writes=off ;;
  esac
  expect_failure \
    "rendered PostgreSQL $setting disabled" \
    'fatal: rendered PostgreSQL command must enforce fsync=on, synchronous_commit=on, and full_page_writes=on'
done

make_fixture invalid-selector
expect_failure \
  'unsupported runtime validation selector' \
  'fatal: usage: validate-runtime.sh [--post-start]' \
  pilot \
  --unexpected

make_fixture invalid-bare-post-start-selector
expect_failure \
  'bare post-start selector' \
  'fatal: usage: validate-runtime.sh [--post-start]' \
  pilot \
  post-start

make_fixture post-start-extra-argument
expect_failure \
  'post-start selector with an extra argument' \
  'fatal: usage: validate-runtime.sh [--post-start]' \
  pilot \
  --post-start \
  extra

make_fixture valid-post-start
expect_success 'valid post-start PostgreSQL durability fixture' pilot --post-start
postgres_invocations="$(grep -Ec '^docker .* exec([[:space:]]|$)' "$fake_docker_log" || true)"
if [[ "$postgres_invocations" != 1 ]]; then
  echo 'FAIL: post-start validation must use exactly one bounded fake-Docker PostgreSQL invocation' >&2
  exit 1
fi
timeout_invocations="$(grep -c '^timeout ' "$fake_docker_log" || true)"
if [[ "$timeout_invocations" != 1 ]]; then
  echo 'FAIL: post-start PostgreSQL validation must be bounded by one 1-30 second timeout' >&2
  exit 1
fi
postgres_event="$(grep -E '^docker .* exec([[:space:]]|$)' "$fake_docker_log")"
current_postgres_probe_argv=(
  compose --env-file "$config" -f "$repo_root/compose.yaml" exec -T postgres
  psql --username=learncoding --dbname=learncoding --no-align --tuples-only '--field-separator=|'
  --command "$postgres_probe_sql"
)
expected_postgres_event=docker
for argument in "${current_postgres_probe_argv[@]}"; do
  printf -v escaped_argument '%q' "$argument"
  expected_postgres_event+=" $escaped_argument"
done
if [[ "$postgres_event" != "$expected_postgres_event" ]]; then
  echo 'FAIL: post-start validation must use the exact canonical read-only PostgreSQL argv and SQL' >&2
  exit 1
fi
timeout_event="$(grep '^timeout ' "$fake_docker_log")"
printf -v escaped_duration '%q' 30s
printf -v escaped_docker_path '%q' "$case_dir/bin/docker"
expected_timeout_event="timeout $escaped_duration $escaped_docker_path"
for argument in "${current_postgres_probe_argv[@]}"; do
  printf -v escaped_argument '%q' "$argument"
  expected_timeout_event+=" $escaped_argument"
done
if [[ "$timeout_event" != "$expected_timeout_event" ]]; then
  echo 'FAIL: post-start timeout must wrap only the exact fake-Docker Compose invocation' >&2
  exit 1
fi

for setting in fsync synchronous_commit full_page_writes; do
  make_fixture "live-postgres-$setting-off"
  case "$setting" in
    fsync) fake_live_fsync=off ;;
    synchronous_commit) fake_live_sync_commit=off ;;
    full_page_writes) fake_live_full_page_writes=off ;;
  esac
  expect_failure \
    "live PostgreSQL $setting disabled" \
    'fatal: live PostgreSQL durability settings must be exactly on/on/on' \
    pilot \
    --post-start
done

make_fixture valid-operations
add_bootstrap_secret
expect_success 'caller operations mode overrides sourced pilot value' operations

make_fixture valid-uploads
set_config UPLOADS_ENABLED true
set_config COMPOSE_PROFILES operations,uploads
set_config CLAMAV_IMAGE "clamav/clamav:1.4.3_base@sha256:$digest_c"
expect_success 'uploads profile accepts an immutable ClamAV digest without operations validation'

make_fixture exact-profile-token
set_config COMPOSE_PROFILES operations-notuploads
expect_success 'profile matching does not use uploads as a substring'

make_fixture valid-repeated-trailing-slashes
set_config SECRETS_DIR "$case_dir//secrets///"
expect_success 'valid secrets directory accepts repeated and trailing slashes'

make_fixture config-symlink
mv "$config" "$case_dir/compose.env.real"
ln -s "$case_dir/compose.env.real" "$config"
expect_failure \
  'symlinked compose environment file' \
  "fatal: compose environment file must not be a symlink: $config"

make_fixture config-mode
chmod 0600 "$config"
expect_failure \
  'compose environment mode 0600' \
  "fatal: compose environment file must be owned by root:root with mode 640: $config"

make_fixture directory-symlink
mv "$secrets" "$case_dir/secrets.real"
ln -s "$case_dir/secrets.real" "$secrets"
expect_failure \
  'symlinked secrets directory' \
  "fatal: secrets directory must not be a symlink: $secrets"

make_fixture directory-symlink-trailing-slash
mv "$secrets" "$case_dir/secrets.real"
ln -s "$case_dir/secrets.real" "$secrets"
set_config SECRETS_DIR "$secrets/"
expect_failure \
  'symlinked secrets directory with a trailing slash' \
  "fatal: secrets directory must not be a symlink: $secrets"

make_fixture directory-symlink-before-parent
mkdir -p "$case_dir/a" "$case_dir/x/y"
mv "$secrets" "$case_dir/a/secrets"
ln -s "$case_dir/x/y" "$case_dir/a/link"
symlink_before_parent_dir="$case_dir/a/link/../secrets"
set_config SECRETS_DIR "$symlink_before_parent_dir"
expect_failure \
  'symlink before a parent path component' \
  'fatal: secrets directory path must be canonical'

make_fixture directory-symlink-dot-alias
mv "$secrets" "$case_dir/secrets.real"
ln -s "$case_dir/secrets.real" "$secrets"
set_config SECRETS_DIR "$secrets/."
expect_failure \
  'symlinked secrets directory with a dot alias' \
  'fatal: secrets directory path must be canonical'

make_fixture directory-nested-symlink
ln -s "$case_dir" "$case_dir/path-alias"
nested_secrets_dir="$case_dir/path-alias/secrets"
set_config SECRETS_DIR "$nested_secrets_dir"
expect_failure \
  'secrets directory below a symlinked path component' \
  "fatal: secrets directory must not be a symlink: $nested_secrets_dir"

make_fixture directory-parent-alias
mkdir "$case_dir/path-segment"
ln -s "$case_dir" "$case_dir/path-alias"
parent_alias_secrets_dir="$case_dir/path-segment/../path-alias/secrets"
set_config SECRETS_DIR "$parent_alias_secrets_dir"
expect_failure \
  'parent alias cannot hide a symlinked path component' \
  'fatal: secrets directory path must be canonical'

make_fixture directory-relative-path
set_config SECRETS_DIR relative/secrets
expect_failure \
  'relative secrets directory path' \
  'fatal: secrets directory path must be absolute'

make_fixture directory-mode
chmod 0700 "$secrets"
expect_failure \
  'secrets directory mode 0700' \
  "fatal: secrets directory must be owned by root:2000 with mode 750: $secrets"

for bad_mode in 0400 0444; do
  make_fixture "secret-mode-$bad_mode"
  chmod "$bad_mode" "$secrets/postgres_password"
  expect_failure \
    "secret mode $bad_mode" \
    "fatal: secret must be owned by root:2000 with mode 440: $secrets/postgres_password"
done

make_fixture untrusted-path-stat
chmod 0400 "$secrets/postgres_password"
fake_stat_target="$secrets/postgres_password"
printf '#!%s\n' "$bash_bin" >"$case_dir/bin/stat"
cat >>"$case_dir/bin/stat" <<'EOF'
set -eu

target="${!#}"
if [[ "$target" == "$FAKE_STAT_TARGET" ]]; then
  printf '%s\n' '0:2000:440'
  exit 0
fi

exit 97
EOF
chmod 0755 "$case_dir/bin/stat"
expect_failure \
  'caller PATH cannot forge secret metadata' \
  "fatal: secret must be owned by root:2000 with mode 440: $secrets/postgres_password"

make_fixture secret-symlink
rm "$secrets/postgres_password"
ln -s "$secrets/database_url" "$secrets/postgres_password"
expect_failure \
  'symlinked secret' \
  "fatal: secret must not be a symlink: $secrets/postgres_password"

for missing_secret in lost_device_proof_key deletion_tombstone_key; do
  make_fixture "missing-$missing_secret"
  rm "$secrets/$missing_secret"
  expect_failure \
    "missing $missing_secret" \
    "fatal: required secret is missing: $secrets/$missing_secret"
done

make_fixture invalid-uploads-boolean
set_config UPLOADS_ENABLED yes
expect_failure \
  'non-literal uploads boolean' \
  'fatal: UPLOADS_ENABLED must be literal true or false'

make_fixture uploads-without-profile
set_config UPLOADS_ENABLED true
expect_failure \
  'uploads enabled without uploads profile' \
  'fatal: UPLOADS_ENABLED=true requires the uploads profile'

make_fixture disabled-with-uploads-profile
set_config COMPOSE_PROFILES operations,uploads
expect_failure \
  'uploads profile while uploads are disabled' \
  'fatal: UPLOADS_ENABLED=false forbids the uploads profile'

make_fixture uploads-without-digest
set_config UPLOADS_ENABLED true
set_config COMPOSE_PROFILES uploads
expect_failure \
  'uploads profile without immutable ClamAV digest' \
  'fatal: CLAMAV_IMAGE must be pinned by sha256 digest when uploads are enabled'

make_fixture operations-without-bootstrap
expect_failure \
  'operations validation without bootstrap password' \
  "fatal: required secret is missing: $secrets/bootstrap_admin_password" \
  operations

make_fixture short-bootstrap
printf '%s' 'short password' >"$secrets/bootstrap_admin_password"
chown 0:"$secrets_gid" "$secrets/bootstrap_admin_password"
chmod 0440 "$secrets/bootstrap_admin_password"
expect_failure \
  'operations validation with short bootstrap password' \
  "fatal: bootstrap_admin_password must contain at least 16 non-whitespace characters" \
  operations

for image_variable in \
  APP_RUNTIME_IMAGE \
  APP_TOOLING_IMAGE \
  APP_WORKER_IMAGE \
  APP_REGRADE_WORKER_IMAGE \
  APP_PROJECT_REVIEW_WORKER_IMAGE \
  APP_SCANNER_WORKER_IMAGE \
  APP_OPERATIONS_IMAGE \
  POSTGRES_IMAGE \
  CLOUDFLARED_IMAGE; do
  make_fixture "non-digest-$image_variable"
  set_config "$image_variable" 'registry.example.test/codestead/image:latest'
  expect_failure \
    "non-digest $image_variable reference" \
    "fatal: $image_variable must be pinned by sha256 digest"
done

make_fixture digest-trailing-data
set_config APP_RUNTIME_IMAGE "registry.example.test/runtime@sha256:${digest_a}trailing"
expect_failure \
  'digest reference with trailing data' \
  'fatal: APP_RUNTIME_IMAGE must be pinned by sha256 digest'

make_fixture digest-empty-name
set_config APP_RUNTIME_IMAGE "@sha256:$digest_a"
expect_failure \
  'digest reference with an empty image name' \
  'fatal: APP_RUNTIME_IMAGE must be pinned by sha256 digest'

make_fixture invalid-validation-mode
expect_failure \
  'invalid caller validation mode' \
  'fatal: VALIDATION_MODE must be pilot or operations' \
  release

make_fixture google-secret-required
set_config GOOGLE_CLIENT_ID google-client-id.apps.example.test
expect_failure \
  'Google client ID without Google client secret' \
  "fatal: required secret is empty: $secrets/google_client_secret"

make_fixture gmail-secrets-required
set_config MAIL_ADAPTER gmail
set_config MAIL_FROM noreply@example.test
expect_failure \
  'Gmail adapter without Gmail client ID' \
  "fatal: required secret is empty: $secrets/gmail_client_id"

if grep -R -F -l --include='docker.log' "$secret_canary" "$work" >/dev/null 2>&1 ||
  grep -R -F -l --include='docker.log' "$database_canary" "$work" >/dev/null 2>&1; then
  echo 'FAIL: fake-Docker event logs captured secret or database connection material' >&2
  exit 1
fi

echo 'runtime-config-tests-ok'
