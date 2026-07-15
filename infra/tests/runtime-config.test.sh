#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/infra/ops/validate-runtime.sh"

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    exec sudo -n bash "$repo_root/infra/tests/runtime-config.test.sh"
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

  mkdir -p \
    "$case_dir/bin" \
    "$secrets" \
    "$case_dir/data/postgres" \
    "$case_dir/data/next-cache" \
    "$case_dir/data/app-data" \
    "$case_dir/data/uploads" \
    "$case_dir/data/clamav"

  cat >"$case_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

{
  printf 'docker'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"

if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi

if [[ "${1:-}" == "info" ]]; then
  exit 0
fi

is_exec=false
for argument in "$@"; do
  if [[ "$argument" == exec ]]; then is_exec=true; fi
done
if [[ "$is_exec" == true ]]; then
  printf '%s|%s\n' \
    fsync "$FAKE_LIVE_FSYNC" \
    synchronous_commit "$FAKE_LIVE_SYNC_COMMIT" \
    full_page_writes "$FAKE_LIVE_FULL_PAGE_WRITES"
  exit 0
fi

if [[ "${1:-}" == "compose" ]]; then
  printf '%s\n' \
    'services:' \
    '  postgres:' \
    '    image: registry.example.test/postgres@sha256:2222222222222222222222222222222222222222222222222222222222222222' \
    '    restart: unless-stopped' \
    '    stop_grace_period: 2m' \
    '    environment:' \
    '      POSTGRES_INITDB_ARGS: --data-checksums' \
    '    command:' \
    '      - postgres' \
    '      - -c' \
    "      - fsync=$FAKE_POSTGRES_FSYNC" \
    '      - -c' \
    "      - synchronous_commit=$FAKE_POSTGRES_SYNC_COMMIT" \
    '      - -c' \
    "      - full_page_writes=$FAKE_POSTGRES_FULL_PAGE_WRITES" \
    '  app:' \
    "    image: $FAKE_APP_IMAGE" \
    "    restart: $FAKE_LONG_RESTART" \
    '    stop_grace_period: 1m' \
    '    environment:' \
    "      RUNNER_BASE_URL: $FAKE_RUNNER_URL" \
    '    networks:' \
    '      - data' \
    '      - frontend' \
    '      - runner-egress'
  if [[ "$FAKE_HOST_PORT" == true ]]; then
    printf '%s\n' '    ports:' '      - 127.0.0.1:3000:3000'
  fi
  for service in mail-worker reward-worker regrade-worker exam-finalization-worker \
    practice-runner-recovery-worker project-review-correction-worker scan-worker; do
    printf '%s\n' \
      "  $service:" \
      '    image: registry.example.test/worker@sha256:3333333333333333333333333333333333333333333333333333333333333333' \
      '    restart: unless-stopped' \
      '    stop_grace_period: 1m'
  done
  printf '%s\n' \
    '  cloudflared:' \
    '    image: registry.example.test/cloudflared@sha256:3333333333333333333333333333333333333333333333333333333333333333' \
    '    restart: unless-stopped' \
    '    stop_grace_period: 30s'
  for service in migrate lifecycle platform-seed admin-bootstrap; do
    printf '%s\n' \
      "  $service:" \
      '    profiles:' \
      '      - operations' \
      '    image: registry.example.test/operations@sha256:1111111111111111111111111111111111111111111111111111111111111111' \
      "    restart: $FAKE_ONESHOT_RESTART"
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
  cat >"$case_dir/bin/timeout" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
{
  printf 'timeout'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"
duration="${1:-}"
[[ "$duration" =~ ^([1-9]|[12][0-9]|30)s$ ]] || exit 64
shift
exec "$@"
EOF
  chmod 0755 "$case_dir/bin/timeout"
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
  shift || true
  PATH="$case_dir/bin:$PATH" \
    REPO_ROOT="$repo_root" \
    COMPOSE_ENV_FILE="$config" \
    VALIDATION_MODE="$validation_mode" \
    FAKE_STAT_TARGET="$fake_stat_target" \
    FAKE_DOCKER_LOG="$fake_docker_log" \
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
    bash "$validator" "$@"
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

make_fixture rendered-host-port
fake_host_port=true
expect_failure \
  'rendered Compose host port' \
  'fatal: trusted Compose stack must not publish host ports'

make_fixture rendered-mutable-image
fake_app_image='registry.example.test/codestead/runtime:latest'
expect_failure \
  'rendered mutable application image' \
  'fatal: rendered Compose services must use immutable sha256 image references'

make_fixture wrong-long-running-restart
fake_long_restart='always'
expect_failure \
  'wrong long-running restart class' \
  'fatal: rendered long-running services must restart unless-stopped'

make_fixture wrong-one-shot-restart
fake_oneshot_restart='on-failure'
expect_failure \
  'wrong one-shot restart class' \
  'fatal: rendered one-shot services must use restart no'

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
if [[ "$postgres_event" != *fsync* || "$postgres_event" != *synchronous_commit* || "$postgres_event" != *full_page_writes* ]]; then
  echo 'FAIL: post-start validation must query all three durability settings together' >&2
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
cat >"$case_dir/bin/stat" <<'EOF'
#!/usr/bin/env bash
set -eu

target="${!#}"
if [[ "$target" == "$FAKE_STAT_TARGET" ]]; then
  printf '%s\n' '0:2000:440'
  exit 0
fi

exec /usr/bin/stat "$@"
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
