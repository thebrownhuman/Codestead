#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/infra/ops/validate-runtime.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/secrets" "$work/data/postgres" "$work/data/next-cache" "$work/data/app-data"
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then exit 0; fi
if [[ "${1:-}" == "info" ]]; then exit 0; fi
if [[ "${1:-}" == "compose" ]]; then
  printf '%s\n' 'services:' '  app:' '    environment:' '      RUNNER_BASE_URL: http://10.20.0.12:4100'
  exit 0
fi
exit 64
EOF
chmod 0755 "$work/bin/docker"

cat >"$work/cloudflare.yml" <<'EOF'
tunnel: 11111111-1111-1111-1111-111111111111
ingress:
  - hostname: pilot.example.test
    service: http://app:3000
  - service: http_status:404
EOF

config="$work/compose.env"
cat >"$config" <<EOF
APP_URL=https://pilot.example.test
SOURCE_CODE_URL=https://code.example.test/learncoding
DEPLOY_PLATFORM=linux/amd64
POSTGRES_IMAGE=postgres@sha256:$(printf 'a%.0s' {1..64})
CLOUDFLARED_IMAGE=cloudflared@sha256:$(printf 'b%.0s' {1..64})
CLAMAV_IMAGE=clamav@sha256:$(printf 'c%.0s' {1..64})
MAIL_ADAPTER=console
SECRETS_DIR=$work/secrets
CLOUDFLARE_CONFIG_FILE=$work/cloudflare.yml
LEARN_DATA_ROOT=$work/data
EOF
chmod 0600 "$config"

printf postgres >"$work/secrets/postgres_password"
printf 'postgresql://learncoding:password@postgres/learncoding' >"$work/secrets/database_url"
printf 'better-auth-secret-at-least-thirty-two-bytes' >"$work/secrets/better_auth_secret"
printf 'deletion-tombstone-key-at-least-thirty-two-bytes' >"$work/secrets/deletion_tombstone_key"
head -c 32 /dev/zero | base64 >"$work/secrets/credential_master_key"
printf 'runner-shared-secret-at-least-thirty-two-bytes' >"$work/secrets/runner_shared_secret"
printf '{}' >"$work/secrets/cloudflare_tunnel_credentials.json"
touch "$work/secrets/google_client_secret" "$work/secrets/gmail_client_id" "$work/secrets/gmail_client_secret" "$work/secrets/gmail_refresh_token"
chmod 0700 "$work/secrets"
chmod 0600 "$work/secrets"/* "$work/cloudflare.yml"

PATH="$work/bin:$PATH" REPO_ROOT="$repo_root" COMPOSE_ENV_FILE="$config" bash "$validator" | grep -Fxq 'runtime validation passed'

rm "$work/secrets/deletion_tombstone_key"
if PATH="$work/bin:$PATH" REPO_ROOT="$repo_root" COMPOSE_ENV_FILE="$config" bash "$validator" >/dev/null 2>&1; then
  echo "runtime validation accepted a missing deletion tombstone key" >&2
  exit 1
fi
printf 'deletion-tombstone-key-at-least-thirty-two-bytes' >"$work/secrets/deletion_tombstone_key"
chmod 0600 "$work/secrets/deletion_tombstone_key"

sed -i 's#SOURCE_CODE_URL=https://code.example.test/learncoding#SOURCE_CODE_URL=http://code.example.test/learncoding#' "$config"
if PATH="$work/bin:$PATH" REPO_ROOT="$repo_root" COMPOSE_ENV_FILE="$config" bash "$validator" >/dev/null 2>&1; then
  echo "runtime validation accepted a non-HTTPS source URL" >&2
  exit 1
fi

echo "runtime-config-tests-ok"
