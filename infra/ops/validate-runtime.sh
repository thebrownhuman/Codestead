#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

readonly repo_root="${REPO_ROOT:-/opt/learncoding}"
readonly compose_env="${COMPOSE_ENV_FILE:-/etc/learncoding/compose.env}"
readonly validation_mode="${VALIDATION_MODE:-pilot}"

[[ -f "$repo_root/compose.yaml" ]] || fatal "compose.yaml missing"
[[ ! -L "$compose_env" ]] || fatal "compose environment file must not be a symlink: $compose_env"
[[ -f "$compose_env" ]] || fatal "compose environment file missing"

readonly trusted_stat_bin="/usr/bin/stat"
[[ -x "$trusted_stat_bin" ]] || fatal "trusted stat is missing: $trusted_stat_bin"

compose_env_metadata="$("$trusted_stat_bin" -c '%u:%g:%a' -- "$compose_env")"
[[ "$compose_env_metadata" == "0:0:640" ]] || {
  fatal "compose environment file must be owned by root:root with mode 640: $compose_env"
}

resolved_docker_bin="$(type -P docker || true)"
[[ -n "$resolved_docker_bin" ]] || fatal "docker is missing"
readonly resolved_docker_bin
"$resolved_docker_bin" compose version >/dev/null
"$resolved_docker_bin" info >/dev/null

set -a
# shellcheck disable=SC1090
source "$compose_env"
set +a

[[ "$validation_mode" == "pilot" || "$validation_mode" == "operations" ]] || {
  fatal "VALIDATION_MODE must be pilot or operations"
}
[[ "${SECRETS_GID:-}" == "2000" ]] || fatal "SECRETS_GID must be 2000"
[[ "${DEPLOY_PLATFORM:-linux/amd64}" == "linux/amd64" ]] || {
  fatal "this NUC deployment is reviewed for linux/amd64 only"
}

image_is_digest_pinned() {
  local image="$1"
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-fA-F]{64}$ ]]
}

readonly -a immutable_image_variables=(
  POSTGRES_IMAGE
  CLOUDFLARED_IMAGE
  APP_RUNTIME_IMAGE
  APP_TOOLING_IMAGE
  APP_WORKER_IMAGE
  APP_REGRADE_WORKER_IMAGE
  APP_PROJECT_REVIEW_WORKER_IMAGE
  APP_SCANNER_WORKER_IMAGE
  APP_OPERATIONS_IMAGE
)
for image_variable in "${immutable_image_variables[@]}"; do
  image_value="${!image_variable:-}"
  image_is_digest_pinned "$image_value" || {
    fatal "$image_variable must be pinned by sha256 digest"
  }
done

[[ "${APP_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
  fatal "APP_URL must be one HTTPS origin without a path"
}
[[ "$APP_URL" != "https://learn.example.com" ]] || {
  fatal "APP_URL still contains the example hostname"
}
[[ "${SOURCE_CODE_URL:-}" =~ ^https://[^[:space:]]+$ ]] || {
  fatal "SOURCE_CODE_URL must be an HTTPS URL"
}
[[ "$SOURCE_CODE_URL" != "https://github.com/your-account/learncoding" ]] || {
  fatal "SOURCE_CODE_URL still contains the example repository"
}
[[ "${MAIL_ADAPTER:-console}" == "console" || "${MAIL_ADAPTER:-}" == "gmail" ]] || {
  fatal "MAIL_ADAPTER must be console or gmail"
}

profile_is_enabled() {
  local requested="$1"
  local profile
  local -a configured_profiles=()
  IFS=',' read -r -a configured_profiles <<<"${COMPOSE_PROFILES:-}"
  for profile in "${configured_profiles[@]}"; do
    [[ "$profile" == "$requested" ]] && return 0
  done
  return 1
}

case "${UPLOADS_ENABLED:-}" in
  true)
    profile_is_enabled uploads || fatal "UPLOADS_ENABLED=true requires the uploads profile"
    image_is_digest_pinned "${CLAMAV_IMAGE:-}" || {
      fatal "CLAMAV_IMAGE must be pinned by sha256 digest when uploads are enabled"
    }
    ;;
  false)
    ! profile_is_enabled uploads || fatal "UPLOADS_ENABLED=false forbids the uploads profile"
    ;;
  *)
    fatal "UPLOADS_ENABLED must be literal true or false"
    ;;
esac

secrets_dir="${SECRETS_DIR:-/etc/learncoding/secrets}"
while [[ "$secrets_dir" != "/" && "$secrets_dir" == */ ]]; do
  secrets_dir="${secrets_dir%/}"
done
readonly secrets_dir
[[ ! -L "$secrets_dir" ]] || fatal "secrets directory must not be a symlink: $secrets_dir"
[[ -d "$secrets_dir" ]] || fatal "secrets directory missing: $secrets_dir"

secrets_dir_metadata="$("$trusted_stat_bin" -c '%u:%g:%a' -- "$secrets_dir")"
[[ "$secrets_dir_metadata" == "0:2000:750" ]] || {
  fatal "secrets directory must be owned by root:2000 with mode 750: $secrets_dir"
}

validate_secret_entry() {
  local file="$1"
  local metadata

  [[ ! -L "$file" ]] || fatal "secret must not be a symlink: $file"
  [[ -f "$file" ]] || fatal "secret entry must be a regular file: $file"
  metadata="$("$trusted_stat_bin" -c '%u:%g:%a' -- "$file")"
  [[ "$metadata" == "0:2000:440" ]] || {
    fatal "secret must be owned by root:2000 with mode 440: $file"
  }
}

shopt -s nullglob dotglob
secret_entries=("$secrets_dir"/*)
shopt -u nullglob dotglob
for file in "${secret_entries[@]}"; do
  validate_secret_entry "$file"
done

readonly -a required_secrets=(
  postgres_password
  database_url
  better_auth_secret
  lost_device_proof_key
  deletion_tombstone_key
  credential_master_key
  runner_shared_secret
  cloudflare_tunnel_credentials.json
)
readonly -a provider_placeholder_secrets=(
  google_client_secret
  gmail_client_id
  gmail_client_secret
  gmail_refresh_token
)

require_secret_file() {
  local name="$1"
  local file="$secrets_dir/$name"

  [[ ! -L "$file" ]] || fatal "secret must not be a symlink: $file"
  [[ -f "$file" ]] || fatal "required secret is missing: $file"
}

require_nonempty_secret() {
  local name="$1"
  local file="$secrets_dir/$name"

  require_secret_file "$name"
  [[ -s "$file" ]] || fatal "required secret is empty: $file"
}

for name in "${required_secrets[@]}"; do
  require_nonempty_secret "$name"
done
for name in "${provider_placeholder_secrets[@]}"; do
  require_secret_file "$name"
done

secret_non_whitespace_count() {
  local file="$1"
  tr -d '[:space:]' <"$file" | wc -c
}

for name in better_auth_secret lost_device_proof_key deletion_tombstone_key runner_shared_secret; do
  meaningful_characters="$(secret_non_whitespace_count "$secrets_dir/$name")"
  [[ "$meaningful_characters" -ge 32 ]] || {
    fatal "$name must contain at least 32 non-whitespace characters"
  }
done

decoded_key_bytes="$(tr -d '\r\n ' <"$secrets_dir/credential_master_key" | base64 --decode 2>/dev/null | wc -c)" || {
  fatal "credential_master_key is not valid base64"
}
[[ "$decoded_key_bytes" -eq 32 ]] || fatal "credential_master_key must decode to 32 bytes"

if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  require_nonempty_secret google_client_secret
elif [[ -s "$secrets_dir/google_client_secret" ]]; then
  fatal "google_client_secret must be empty when GOOGLE_CLIENT_ID is empty"
fi

if [[ "${MAIL_ADAPTER:-console}" == "gmail" ]]; then
  for name in gmail_client_id gmail_client_secret gmail_refresh_token; do
    require_nonempty_secret "$name"
  done
else
  for name in gmail_client_id gmail_client_secret gmail_refresh_token; do
    [[ ! -s "$secrets_dir/$name" ]] || {
      fatal "$name must be empty when Gmail delivery is disabled"
    }
  done
fi

if [[ "$validation_mode" == "operations" ]]; then
  require_nonempty_secret bootstrap_admin_password
  bootstrap_characters="$(secret_non_whitespace_count "$secrets_dir/bootstrap_admin_password")"
  [[ "$bootstrap_characters" -ge 16 ]] || {
    fatal "bootstrap_admin_password must contain at least 16 non-whitespace characters"
  }
fi

cloudflare_config="${CLOUDFLARE_CONFIG_FILE:-/etc/learncoding/cloudflare/config.yml}"
[[ -f "$cloudflare_config" ]] || fatal "Cloudflare tunnel config missing"
grep -Eq '^[[:space:]]*-[[:space:]]+service:[[:space:]]+http_status:404[[:space:]]*$' "$cloudflare_config" || {
  fatal "Cloudflare ingress must end in a 404 catch-all"
}
if grep -Eq '00000000-0000-0000-0000-000000000000|learn\.example\.com' "$cloudflare_config"; then
  fatal "Cloudflare config still contains example placeholders"
fi

rendered="$(mktemp)"
trap 'rm -f -- "$rendered"' EXIT
"$resolved_docker_bin" compose --env-file "$compose_env" -f "$repo_root/compose.yaml" config >"$rendered"
if grep -Eq '^[[:space:]]+ports:' "$rendered"; then
  fatal "trusted Compose stack must not publish host ports"
fi
grep -Eq 'RUNNER_BASE_URL: http://(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' "$rendered" || {
  fatal "runner URL must use a private address"
}

for directory in \
  "${LEARN_DATA_ROOT:-/srv/learncoding}/postgres" \
  "${LEARN_DATA_ROOT:-/srv/learncoding}/next-cache" \
  "${LEARN_DATA_ROOT:-/srv/learncoding}/app-data"; do
  [[ -d "$directory" ]] || fatal "data directory missing: $directory"
done

echo "runtime validation passed"
