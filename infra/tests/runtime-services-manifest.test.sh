#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="$repo_root/infra/ops/runtime-services.tsv"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$manifest" && ! -L "$manifest" ]] || fail "canonical runtime service manifest is missing or unsafe"
[[ "$(tail -c 1 "$manifest" | od -An -t x1 | tr -d ' \n')" == 0a ]] || {
  fail "runtime service manifest is not newline terminated"
}
if LC_ALL=C grep -q $'\r' "$manifest"; then
  fail "runtime service manifest contains a carriage return"
fi

mapfile -t lines <"$manifest"
[[ "${lines[0]:-}" == 'SCHEMA_VERSION=1' ]] || fail "runtime service schema version is not canonical"
[[ "${lines[1]:-}" == 'OPERATIONS_CONFIG_COMPATIBILITY_VERSION=1' ]] || {
  fail "operations compatibility version is not canonical"
}
[[ "${lines[2]:-}" == $'service\timage_policy\trelease_phase\trollback_phase\tsmoke_role\tdatabase_mutator' ]] || {
  fail "runtime service manifest header is not canonical"
}

expected_rows=(
  $'postgres\tretain\tcore\tretained\tdatabase\tfalse'
  $'app\trestore\tcore\tcore\tapplication\ttrue'
  $'runner-egress-gateway\trestore\tcore\tcore\tgateway\tfalse'
  $'mail-worker\trestore\tcore\tcore\tworker\ttrue'
  $'reward-worker\trestore\tcore\tcore\tworker\ttrue'
  $'regrade-worker\trestore\tcore\tcore\tworker\ttrue'
  $'exam-finalization-worker\trestore\tcore\tcore\tworker\ttrue'
  $'file-erasure-worker\trestore\tcore\tcore\tworker\ttrue'
  $'practice-runner-recovery-worker\trestore\tcore\tcore\tworker\ttrue'
  $'project-review-correction-worker\trestore\tcore\tcore\tworker\ttrue'
  $'cloudflared\trestore\ttunnel\ttunnel\ttunnel\tfalse'
)

[[ "${#lines[@]}" == "$((3 + ${#expected_rows[@]}))" ]] || {
  fail "runtime service manifest has unexpected rows"
}
for index in "${!expected_rows[@]}"; do
  [[ "${lines[$((index + 3))]}" == "${expected_rows[$index]}" ]] || {
    fail "runtime service manifest row $((index + 1)) is not canonical"
  }
done

restore_count="$(printf '%s\n' "${lines[@]:3}" | awk -F '\t' '$2 == "restore" { count++ } END { print count + 0 }')"
managed_count="$(printf '%s\n' "${lines[@]:3}" | awk -F '\t' 'NF { count++ } END { print count + 0 }')"
[[ "$restore_count" == 10 ]] || fail "runtime service manifest does not define ten restorable services"
[[ "$managed_count" == 11 ]] || fail "runtime service manifest does not define eleven managed services"

echo "runtime-services-manifest-tests-ok"
