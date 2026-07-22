#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/scripts/backup/validate-restore-metrics.sh"
[[ -f "$validator" ]] || {
  echo "restore-chronology-test-failed: validator missing" >&2
  exit 1
}

expect_preflight_failure() {
  local output
  if output="$(bash "$validator" preflight "$@")"; then
    echo "restore-chronology-test-failed: invalid chronology passed: $*" >&2
    exit 1
  fi
  if [[ -n "$output" ]]; then
    grep -Eq '^chronology_valid=false$|^rpo_within_24h=false$' <<<"$output"
  fi
}

good="$(bash "$validator" preflight \
  20260719T120000Z 20260720T110000Z 20260720T113000Z 20260720T113100Z)"
grep -Fxq chronology_valid=true <<<"$good"
grep -Fxq rpo_seconds=82800 <<<"$good"
grep -Fxq rpo_within_24h=true <<<"$good"

expect_preflight_failure 20260719T110000Z 20260720T120001Z 20260720T120100Z 20260720T120200Z
expect_preflight_failure 20260720T120100Z 20260720T120000Z 20260720T120100Z 20260720T120200Z
expect_preflight_failure 20260720T110000Z 20260720T120200Z 20260720T120100Z 20260720T120300Z
expect_preflight_failure 20260720T110000Z 20260720T120000Z 20260720T121000Z 20260720T120000Z
expect_preflight_failure 20260230T120000Z 20260720T120000Z 20260720T120100Z 20260720T120200Z

fast="$(bash "$validator" complete 1000000000 14401000000000)"
grep -Fxq rto_seconds=14400 <<<"$fast"
grep -Fxq rto_within_4h=true <<<"$fast"
if slow="$(bash "$validator" complete 1000000000 14402000000000)"; then
  echo "restore-chronology-test-failed: RTO above four hours passed" >&2
  exit 1
fi
grep -Fxq rto_within_4h=false <<<"$slow"
if backwards="$(bash "$validator" complete 2000000000 1000000000)"; then
  echo "restore-chronology-test-failed: negative monotonic RTO passed" >&2
  exit 1
fi
grep -Fxq rto_seconds=-1 <<<"$backwards"

echo restore-chronology-tests-ok
