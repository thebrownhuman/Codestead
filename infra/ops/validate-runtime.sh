#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="${REPO_ROOT:-/opt/learncoding}"
compose_env="${COMPOSE_ENV_FILE:-/etc/learncoding/compose.env}"
[[ -f "$repo_root/compose.yaml" ]] || { echo "fatal: compose.yaml missing" >&2; exit 1; }
[[ -f "$compose_env" ]] || { echo "fatal: compose environment file missing" >&2; exit 1; }
command -v docker >/dev/null || { echo "fatal: docker is missing" >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null

file_mode_is_private() {
  local file="$1" mode
  mode="$(stat -c %a "$file")"
  (( (8#$mode & 0022) == 0 ))
}

file_mode_is_private "$compose_env" || { echo "fatal: compose environment file is group/world writable" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$compose_env"
set +a

[[ "${DEPLOY_PLATFORM:-linux/amd64}" == "linux/amd64" ]] || { echo "fatal: this NUC deployment is reviewed for linux/amd64 only" >&2; exit 1; }
[[ "${POSTGRES_IMAGE:-}" =~ @sha256:[0-9a-fA-F]{64}$ ]] || { echo "fatal: POSTGRES_IMAGE must be pinned by sha256 digest" >&2; exit 1; }
[[ "${CLOUDFLARED_IMAGE:-}" =~ @sha256:[0-9a-fA-F]{64}$ ]] || { echo "fatal: CLOUDFLARED_IMAGE must be pinned by sha256 digest" >&2; exit 1; }
[[ "${CLAMAV_IMAGE:-}" =~ @sha256:[0-9a-fA-F]{64}$ ]] || { echo "fatal: CLAMAV_IMAGE must be pinned by sha256 digest" >&2; exit 1; }
[[ "${APP_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "fatal: APP_URL must be one HTTPS origin without a path" >&2; exit 1; }
[[ "$APP_URL" != "https://learn.example.com" ]] || { echo "fatal: APP_URL still contains the example hostname" >&2; exit 1; }
[[ "${SOURCE_CODE_URL:-}" =~ ^https://[^[:space:]]+$ ]] || { echo "fatal: SOURCE_CODE_URL must be an HTTPS URL" >&2; exit 1; }
[[ "$SOURCE_CODE_URL" != "https://github.com/your-account/learncoding" ]] || { echo "fatal: SOURCE_CODE_URL still contains the example repository" >&2; exit 1; }
[[ "${MAIL_ADAPTER:-console}" == "console" || "${MAIL_ADAPTER:-}" == "gmail" ]] || { echo "fatal: MAIL_ADAPTER must be console or gmail" >&2; exit 1; }

secrets_dir="${SECRETS_DIR:-/etc/learncoding/secrets}"
[[ -d "$secrets_dir" ]] || { echo "fatal: secrets directory missing" >&2; exit 1; }
file_mode_is_private "$secrets_dir" || { echo "fatal: secrets directory is group/world writable" >&2; exit 1; }

required_secrets=(postgres_password database_url better_auth_secret deletion_tombstone_key credential_master_key runner_shared_secret cloudflare_tunnel_credentials.json)
for name in "${required_secrets[@]}"; do
  file="$secrets_dir/$name"
  [[ -f "$file" && -r "$file" && -s "$file" ]] || { echo "fatal: required secret file is missing or empty: $name" >&2; exit 1; }
  file_mode_is_private "$file" || { echo "fatal: secret file is group/world writable: $name" >&2; exit 1; }
done
[[ -f "$secrets_dir/google_client_secret" ]] || { echo "fatal: create google_client_secret (it may be empty while disabled)" >&2; exit 1; }
file_mode_is_private "$secrets_dir/google_client_secret" || { echo "fatal: google_client_secret is group/world writable" >&2; exit 1; }
for name in gmail_client_id gmail_client_secret gmail_refresh_token; do
  file="$secrets_dir/$name"
  [[ -f "$file" ]] || { echo "fatal: create $name (it may be empty while console mail is enabled)" >&2; exit 1; }
  file_mode_is_private "$file" || { echo "fatal: $name is group/world writable" >&2; exit 1; }
done
if [[ "${MAIL_ADAPTER:-console}" == "gmail" ]]; then
  for name in gmail_client_id gmail_client_secret gmail_refresh_token; do
    [[ -s "$secrets_dir/$name" ]] || { echo "fatal: $name must be populated when Gmail delivery is enabled" >&2; exit 1; }
  done
fi

[[ "$(wc -c <"$secrets_dir/better_auth_secret")" -ge 32 ]] || { echo "fatal: better_auth_secret is too short" >&2; exit 1; }
[[ "$(wc -c <"$secrets_dir/runner_shared_secret")" -ge 32 ]] || { echo "fatal: runner_shared_secret is too short" >&2; exit 1; }
decoded_key_bytes="$(tr -d '\r\n ' <"$secrets_dir/credential_master_key" | base64 --decode 2>/dev/null | wc -c)" || {
  echo "fatal: credential_master_key is not valid base64" >&2; exit 1;
}
[[ "$decoded_key_bytes" -eq 32 ]] || { echo "fatal: credential_master_key must decode to 32 bytes" >&2; exit 1; }

cloudflare_config="${CLOUDFLARE_CONFIG_FILE:-/etc/learncoding/cloudflare/config.yml}"
[[ -f "$cloudflare_config" ]] || { echo "fatal: Cloudflare tunnel config missing" >&2; exit 1; }
grep -Eq '^[[:space:]]*-[[:space:]]+service:[[:space:]]+http_status:404[[:space:]]*$' "$cloudflare_config" || {
  echo "fatal: Cloudflare ingress must end in a 404 catch-all" >&2; exit 1;
}
if grep -Eq '00000000-0000-0000-0000-000000000000|learn\.example\.com' "$cloudflare_config"; then
  echo "fatal: Cloudflare config still contains example placeholders" >&2
  exit 1
fi

rendered="$(mktemp)"
trap 'rm -f -- "$rendered"' EXIT
docker compose --env-file "$compose_env" -f "$repo_root/compose.yaml" config >"$rendered"
if grep -Eq '^[[:space:]]+ports:' "$rendered"; then
  echo "fatal: trusted Compose stack must not publish host ports" >&2
  exit 1
fi
grep -Eq 'RUNNER_BASE_URL: http://(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' "$rendered" || {
  echo "fatal: runner URL must use a private address" >&2; exit 1;
}

for directory in "${LEARN_DATA_ROOT:-/srv/learncoding}/postgres" "${LEARN_DATA_ROOT:-/srv/learncoding}/next-cache" "${LEARN_DATA_ROOT:-/srv/learncoding}/app-data"; do
  [[ -d "$directory" ]] || { echo "fatal: data directory missing: $directory" >&2; exit 1; }
done

echo "runtime validation passed"
