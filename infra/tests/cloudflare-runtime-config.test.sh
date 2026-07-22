#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
validator="$repo_root/infra/ops/validate-runtime.sh"
work="$(mktemp -d)"
cleanup() {
  [[ -d "$work" && ! -L "$work" ]] && rm -rf -- "$work"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

contract="$work/cloudflare-contract.sh"
sed -n '/^# BEGIN CLOUDFLARE CONFIG CONTRACT$/,/^# END CLOUDFLARE CONFIG CONTRACT$/p' \
  "$validator" >"$contract"
grep -Fqx '# BEGIN CLOUDFLARE CONFIG CONTRACT' "$contract" ||
  fail 'runtime validator does not expose the reviewed Cloudflare config contract'
grep -Fqx '# END CLOUDFLARE CONFIG CONTRACT' "$contract" ||
  fail 'runtime validator Cloudflare config contract is incomplete'

trusted_stat_bin=/usr/bin/stat
trusted_realpath_bin=/usr/bin/realpath
fatal() { printf 'fatal: Cloudflare config rejected\n' >&2; exit 1; }
# shellcheck disable=SC1090
source "$contract"

readonly hostname=pilot.example.test
readonly tunnel_id=11111111-1111-4111-8111-111111111111
readonly credentials_path=/run/secrets/cloudflare_tunnel_credentials

write_config() {
  local content="$1"
  printf '%s\n' "$content" >"$work/config.yml"
  chown 0:0 "$work/config.yml"
  chmod 0640 "$work/config.yml"
}

valid_config="$(cat <<EOF
tunnel: $tunnel_id
credentials-file: $credentials_path

originRequest:
  connectTimeout: 10s
  tcpKeepAlive: 30s
  noHappyEyeballs: false

ingress:
  - hostname: $hostname
    service: http://app:3000
    originRequest:
      httpHostHeader: $hostname
  - service: http_status:404
EOF
)"

write_config "$valid_config"
validate_cloudflare_config_contract "$work/config.yml" "$hostname" "$tunnel_id" "$credentials_path" ||
  fail 'canonical Cloudflare config was rejected'

expect_rejected() {
  local label="$1" content="$2"
  write_config "$content"
  if (validate_cloudflare_config_contract "$work/config.yml" "$hostname" "$tunnel_id" "$credentials_path") \
    >"$work/$label.stdout" 2>"$work/$label.stderr"; then
    fail "$label was accepted"
  fi
  [[ ! -s "$work/$label.stdout" ]] || fail "$label wrote unexpected standard output"
  if grep -Fq "$hostname" "$work/$label.stderr"; then fail "$label disclosed the configured hostname"; fi
  if grep -Fq "$tunnel_id" "$work/$label.stderr"; then fail "$label disclosed tunnel metadata"; fi
  return 0
}

expect_rejected wrong-hostname "${valid_config/$hostname/other.example.test}"
expect_rejected wrong-upstream "${valid_config/http:\/\/app:3000/http:\/\/app:3001}"
expect_rejected wrong-credentials-path "${valid_config/$credentials_path//tmp/tunnel.json}"
expect_rejected wrong-tunnel-id "${valid_config/$tunnel_id/22222222-2222-4222-8222-222222222222}"
expect_rejected duplicate-catch-all "$valid_config
  - service: http_status:404"
expect_rejected early-catch-all "tunnel: $tunnel_id
credentials-file: $credentials_path
ingress:
  - service: http_status:404
  - hostname: $hostname
    service: http://app:3000"
expect_rejected extra-rule "${valid_config/  - service: http_status:404/  - hostname: extra.example.test
    service: http:\/\/app:3000
  - service: http_status:404}"
expect_rejected malformed-structure "tunnel: $tunnel_id
credentials-file: $credentials_path
ingress: []
  - hostname: $hostname
    service: http://app:3000
  - service: http_status:404"

write_config "$valid_config"
chmod 0644 "$work/config.yml"
if (validate_cloudflare_config_contract "$work/config.yml" "$hostname" "$tunnel_id" "$credentials_path") >/dev/null 2>&1; then
  fail 'group/world-readable Cloudflare config was accepted'
fi

write_config "$valid_config"
ln "$work/config.yml" "$work/config-hardlink.yml"
if (validate_cloudflare_config_contract "$work/config.yml" "$hostname" "$tunnel_id" "$credentials_path") >/dev/null 2>&1; then
  fail 'hard-linked Cloudflare config was accepted'
fi
rm -f -- "$work/config-hardlink.yml"

write_config "$valid_config"
ln -s "$work/config.yml" "$work/config-symlink.yml"
if (validate_cloudflare_config_contract "$work/config-symlink.yml" "$hostname" "$tunnel_id" "$credentials_path") >/dev/null 2>&1; then
  fail 'symlinked Cloudflare config was accepted'
fi

printf 'cloudflare runtime config contract tests passed\n'
