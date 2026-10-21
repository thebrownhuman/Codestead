#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
validator="$repo_root/infra/ops/validate-runtime.sh"

parser_block="$(
  awk '
    /^  if \[\[ "\$current_section" == networks && \( "\$current_network" == runner-egress \|\| "\$current_network" == runner-client \) \]\]; then$/ { capture = 1 }
    capture && /^done <<<"\$rendered_content"$/ { exit }
    capture { print }
  ' "$validator"
)"

[[ -n "$parser_block" ]] || {
  echo 'FAIL: rendered network parser could not be extracted' >&2
  exit 1
}
[[ "$(grep -Fc '"$current_network" == runner-egress' <<<"$parser_block")" == 1 ]] || {
  echo 'FAIL: focused parser must contain exactly one retired runner-egress branch' >&2
  exit 1
}
[[ "$(grep -Fc '"$current_network" == runner-client' <<<"$parser_block")" == 1 ]] || {
  echo 'FAIL: focused parser must contain exactly one retired runner-client branch' >&2
  exit 1
}
[[ "$(grep -Fc '"$current_network" == piston' <<<"$parser_block")" == 1 ]] || {
  echo 'FAIL: focused parser must contain exactly one piston branch' >&2
  exit 1
}

run_fixture() (
  set -euo pipefail
  local rendered_content="$1"
  current_section=
  current_network=
  piston_network_internal_seen=false

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

  [[ "$piston_network_internal_seen" == true ]] || fatal 'piston network must be internal'
)

valid_fixture='networks:
  piston:
    driver: bridge
    internal: true'

run_fixture "$valid_fixture" || {
  echo 'FAIL: the real validator parser rejected the canonical piston network fixture' >&2
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
  'non-internal piston' \
  'fatal: piston network must be internal' \
  "${valid_fixture/internal: true/internal: false}"
# The legacy native runner networks are retired; any remnant fails closed.
for retired in runner-client runner-egress; do
  expect_rejected \
    "retired $retired" \
    'fatal: retired legacy runner networks must not be rendered' \
    "$valid_fixture
  $retired:
    driver: bridge"
done

echo 'runtime-validator-network-fixture-tests-ok'
