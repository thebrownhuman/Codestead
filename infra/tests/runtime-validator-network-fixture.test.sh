#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
validator="$repo_root/infra/ops/validate-runtime.sh"

parser_block="$(
  awk '
    /^  if \[\[ "\$current_section" == networks && "\$current_network" == runner-egress \]\]; then$/ { capture = 1 }
    capture && /^done <<<"\$rendered_content"$/ { exit }
    capture { print }
  ' "$validator"
)"

[[ -n "$parser_block" ]] || {
  echo 'FAIL: rendered runner-network parser could not be extracted' >&2
  exit 1
}
[[ "$(grep -Fc '"$current_network" == runner-egress' <<<"$parser_block")" == 1 ]] || {
  echo 'FAIL: focused parser must contain exactly one runner-egress branch' >&2
  exit 1
}
[[ "$(grep -Fc '"$current_network" == runner-client' <<<"$parser_block")" == 1 ]] || {
  echo 'FAIL: focused parser must contain exactly one runner-client branch' >&2
  exit 1
}

run_fixture() (
  set -euo pipefail
  local rendered_content="$1"
  current_section=
  current_network=
  runner_client_internal_seen=false
  runner_client_subnet_seen=false
  runner_subnet_seen=false
  runner_bridge_seen=false

  fatal() {
    echo "fatal: $*" >&2
    exit 1
  }

  while IFS= read -r line; do
    case "$line" in
      networks:)
        current_section=networks
        current_network=
        continue
        ;;
    esac
    if [[ "$current_section" == networks && "$line" =~ ^[[:space:]]{2}([a-z0-9-]+):$ ]]; then
      current_network="${BASH_REMATCH[1]}"
      continue
    fi
    eval "$parser_block"
  done <<<"$rendered_content"

  [[ "$runner_client_internal_seen" == true ]] || fatal 'runner-client network must be internal'
  [[ "$runner_client_subnet_seen" == true ]] || fatal 'runner-client subnet must be exactly 172.29.41.0/24'
  [[ "$runner_subnet_seen" == true ]] || fatal 'runner-egress subnet must be exactly 172.29.40.0/24'
  [[ "$runner_bridge_seen" == true ]] || fatal 'runner-egress bridge must be exactly cdst-run0'
)

valid_fixture='networks:
  runner-client:
    driver: bridge
    internal: true
    ipam:
      config:
        - subnet: 172.29.41.0/24
  runner-egress:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: cdst-run0
    ipam:
      config:
        - subnet: 172.29.40.0/24'

run_fixture "$valid_fixture" || {
  echo 'FAIL: the real validator parser rejected the canonical runner network fixture' >&2
  exit 1
}

expect_rejected() {
  local name="$1"
  local expected="$2"
  local fixture="$3"
  local output
  if output="$(run_fixture "$fixture" 2>&1)"; then
    echo "FAIL: $name fixture was accepted" >&2
    exit 1
  fi
  grep -Fq "$expected" <<<"$output" || {
    echo "FAIL: $name fixture failed for the wrong reason: $output" >&2
    exit 1
  }
}

expect_rejected \
  'non-internal runner-client' \
  'fatal: runner-client network must be internal' \
  "${valid_fixture/internal: true/internal: false}"
expect_rejected \
  'wrong runner-client subnet' \
  'fatal: runner-client subnet must be exactly 172.29.41.0/24' \
  "${valid_fixture/172.29.41.0\/24/172.29.44.0\/24}"
expect_rejected \
  'wrong runner-egress bridge' \
  'fatal: runner-egress bridge must be exactly cdst-run0' \
  "${valid_fixture/cdst-run0/cdst-run9}"
expect_rejected \
  'wrong runner-egress subnet' \
  'fatal: runner-egress subnet must be exactly 172.29.40.0/24' \
  "${valid_fixture/172.29.40.0\/24/172.29.45.0\/24}"

echo 'runtime-validator-network-fixture-tests-ok'
