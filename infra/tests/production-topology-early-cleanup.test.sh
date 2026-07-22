#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_dir
readonly harness="$script_dir/production-topology.test.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/codestead-early-cleanup-test.XXXXXX")"
readonly test_root

cleanup_test_root() {
  # Capturing the incoming trap status in the declaration is intentional.
  # shellcheck disable=SC2155
  local status=$?
  trap - EXIT
  rm -rf -- "$test_root"
  exit "$status"
}
trap cleanup_test_root EXIT

run_case() {
  local mode="$1" expected_status="$2"
  local actual_status output probe workdir_path
  output="$test_root/$mode.log"
  probe="$test_root/$mode.path"
  set +e
  RUNNER_TEMP="$test_root" \
    CODESTEAD_TOPOLOGY_EARLY_CLEANUP_SELF_TEST="$mode" \
    CODESTEAD_TOPOLOGY_EARLY_CLEANUP_PROBE="$probe" \
    bash "$harness" >"$output" 2>&1
  actual_status=$?
  set -e
  if [[ "$actual_status" != "$expected_status" ]]; then
    cat "$output" >&2
    echo "Early cleanup mode $mode returned $actual_status, expected $expected_status." >&2
    return 1
  fi
  [[ -s "$probe" ]] || { echo "Early cleanup mode $mode did not publish its workdir." >&2; return 1; }
  workdir_path="$(<"$probe")"
  case "$workdir_path" in
    "$test_root"/codestead-topology.*) ;;
    *) echo "Early cleanup mode $mode published an unsafe path: $workdir_path" >&2; return 1 ;;
  esac
  [[ ! -e "$workdir_path" ]] || {
    echo "Early cleanup mode $mode leaked its workdir: $workdir_path" >&2
    return 1
  }
}

run_case before-marker 91
run_case after-marker 92
echo "production-topology-early-cleanup-tests-ok"
