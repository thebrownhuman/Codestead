#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/infra/ops/validate-runtime.sh"

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    exec sudo -n bash "$repo_root/infra/tests/runtime-config.test.sh"
  fi

  echo "sudo bash infra/tests/runtime-config.test.sh" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

readonly secrets_gid=2000
readonly secret_canary='RUNTIME_SECRET_CANARY_4f5de90a_DO_NOT_PRINT'
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

make_fixture() {
  local label="$1"
  case_number=$((case_number + 1))
  case_dir="$work/$case_number-$label"
  config="$case_dir/compose.env"
  secrets="$case_dir/secrets"
  fake_stat_target=

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
set -eu

if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi

if [[ "${1:-}" == "info" ]]; then
  exit 0
fi

if [[ "${1:-}" == "compose" ]]; then
  printf '%s\n' \
    'services:' \
    '  app:' \
    '    environment:' \
    '      RUNNER_BASE_URL: http://10.20.0.12:4100'
  exit 0
fi

exit 64
EOF
  chmod 0755 "$case_dir/bin/docker"

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
EOF
  chown 0:0 "$config"
  chmod 0640 "$config"

  printf '%s' "postgres-$secret_canary" >"$secrets/postgres_password"
  printf '%s' 'postgresql://learncoding:password@postgres/learncoding' >"$secrets/database_url"
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
  PATH="$case_dir/bin:$PATH" \
    REPO_ROOT="$repo_root" \
    COMPOSE_ENV_FILE="$config" \
    VALIDATION_MODE="$validation_mode" \
    FAKE_STAT_TARGET="$fake_stat_target" \
    bash "$validator"
}

assert_canary_absent() {
  local label="$1"
  local output="$2"

  if [[ "$output" == *"$secret_canary"* ]]; then
    echo "FAIL: $label printed secret contents" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

expect_success() {
  local label="$1"
  local validation_mode="${2:-pilot}"
  local output
  local status

  set +e
  output="$(run_validator "$validation_mode" 2>&1)"
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
  local output
  local status
  local -a fatal_lines=()

  set +e
  output="$(run_validator "$validation_mode" 2>&1)"
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

make_fixture directory-symlink-dot-alias
mv "$secrets" "$case_dir/secrets.real"
ln -s "$case_dir/secrets.real" "$secrets"
set_config SECRETS_DIR "$secrets/."
expect_failure \
  'symlinked secrets directory with a dot alias' \
  "fatal: secrets directory must not be a symlink: $secrets"

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
canonical_parent_alias_secrets_dir="$case_dir/path-alias/secrets"
set_config SECRETS_DIR "$parent_alias_secrets_dir"
expect_failure \
  'parent alias cannot hide a symlinked path component' \
  "fatal: secrets directory must not be a symlink: $canonical_parent_alias_secrets_dir"

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

echo 'runtime-config-tests-ok'
