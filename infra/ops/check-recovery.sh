#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Recovery output is deliberately delegated to the descriptor-safe helper.
# Its fixed contract verifies x-runner-response-signature over the exact body,
# observed status, per-probe request challenge, and concurrency=2 envelope.
readonly production_checker='/opt/learncoding/infra/ops/check-recovery.sh'
readonly production_helper='/opt/learncoding/infra/ops/recovery-checker.py'
readonly production_baseline_helper='/opt/learncoding/infra/ops/existing_container_baseline.py'
readonly production_baseline_helper_sha256='62be75b9e8be5f2b5baf002eb57133d152135ad95c3c3f952f22af317dc045d2'
readonly production_baseline_cache_dir='/opt/learncoding/infra/ops/__pycache__'
readonly production_baseline_legacy_cache='/opt/learncoding/infra/ops/existing_container_baseline.pyc'
readonly production_python='/usr/bin/python3'
readonly production_env='/usr/bin/env'
readonly production_sha256='/usr/bin/sha256sum'
readonly production_baseline='/etc/learncoding/existing-containers.txt'
readonly recovery_limit_seconds=900

test_mode=false
helper="$production_helper"
baseline_helper="$production_baseline_helper"
python="$production_python"
declare -a helper_arguments=()
declare -a launcher=()

if [[ "${BASH_SOURCE[0]}" != "$production_checker" ]]; then
  test_mode=true
  test_root="${RECOVERY_CHECK_TEST_ROOT:-}"
  test_helper="${RECOVERY_CHECK_TEST_HELPER:-}"
  test_command_root="${RECOVERY_CHECK_TEST_COMMAND_ROOT:-}"
  if [[ -z "$test_root" || "$test_root" != /* || "$test_root" == / || -L "$test_root" || \
    -z "$test_helper" || "$test_helper" != /* || -L "$test_helper" || \
    -z "$test_command_root" || "$test_command_root" != /* || -L "$test_command_root" ]]; then
    printf '%s\n' 'recovery-test-path-contract-rejected' >&2
    printf '%s\n' '{"appHealthy":false,"cloudflaredHealthy":false,"dockerHealthy":false,"elapsedSeconds":0,"existingContainersExpected":0,"existingContainersRunning":0,"firewallHealthy":false,"libvirtHealthy":false,"postgresDurable":false,"postgresHealthy":false,"publicHttpsHealthy":false,"recovered":false,"runnerHealthy":false,"schemaVersion":1,"timedOut":false,"timersHealthy":false,"workersHealthy":false}'
    exit 1
  fi
  helper="$test_helper"
  baseline_helper="${test_helper%/*}/existing_container_baseline.py"
  helper_arguments+=(--test-mode)
else
  # Production never consumes endpoint, secret-path, command, clock, or helper
  # overrides from the ambient service-manager environment.
  launcher=("$production_env" -i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)
fi

if [[ ! -f "$python" || ! -x "$python" || -L "$helper" || ! -f "$helper" || \
  -L "$baseline_helper" || ! -f "$baseline_helper" || \
  "$test_mode" == false && ( ! -f "$production_env" || ! -x "$production_env" || \
    ! -f "$production_sha256" || ! -x "$production_sha256" ) ]]; then
  if [[ "$test_mode" == true ]]; then
    printf '%s\n' 'recovery-test-runtime-file-contract-rejected' >&2
  fi
  printf '%s\n' '{"appHealthy":false,"cloudflaredHealthy":false,"dockerHealthy":false,"elapsedSeconds":0,"existingContainersExpected":0,"existingContainersRunning":0,"firewallHealthy":false,"libvirtHealthy":false,"postgresDurable":false,"postgresHealthy":false,"publicHttpsHealthy":false,"recovered":false,"runnerHealthy":false,"schemaVersion":1,"timedOut":false,"timersHealthy":false,"workersHealthy":false}'
  exit 1
fi
if [[ "$test_mode" == false ]]; then
  baseline_digest_line="$("$production_sha256" -- "$baseline_helper" 2>/dev/null)" || {
    printf '%s\n' '{"appHealthy":false,"cloudflaredHealthy":false,"dockerHealthy":false,"elapsedSeconds":0,"existingContainersExpected":0,"existingContainersRunning":0,"firewallHealthy":false,"libvirtHealthy":false,"postgresDurable":false,"postgresHealthy":false,"publicHttpsHealthy":false,"recovered":false,"runnerHealthy":false,"schemaVersion":1,"timedOut":false,"timersHealthy":false,"workersHealthy":false}'
    exit 1
  }
  if [[ -L "$production_baseline_cache_dir" || -e "$production_baseline_legacy_cache" || \
    -L "$production_baseline_legacy_cache" ]]; then
    printf '%s\n' '{"appHealthy":false,"cloudflaredHealthy":false,"dockerHealthy":false,"elapsedSeconds":0,"existingContainersExpected":0,"existingContainersRunning":0,"firewallHealthy":false,"libvirtHealthy":false,"postgresDurable":false,"postgresHealthy":false,"publicHttpsHealthy":false,"recovered":false,"runnerHealthy":false,"schemaVersion":1,"timedOut":false,"timersHealthy":false,"workersHealthy":false}'
    exit 1
  fi
  declare -a baseline_bytecode_candidates=()
  shopt -s nullglob
  baseline_bytecode_candidates=(
    "$production_baseline_cache_dir"/existing_container_baseline.*.pyc
  )
  shopt -u nullglob
  if (( ${#baseline_bytecode_candidates[@]} != 0 )); then
    printf '%s\n' '{"appHealthy":false,"cloudflaredHealthy":false,"dockerHealthy":false,"elapsedSeconds":0,"existingContainersExpected":0,"existingContainersRunning":0,"firewallHealthy":false,"libvirtHealthy":false,"postgresDurable":false,"postgresHealthy":false,"publicHttpsHealthy":false,"recovered":false,"runnerHealthy":false,"schemaVersion":1,"timedOut":false,"timersHealthy":false,"workersHealthy":false}'
    exit 1
  fi
  if [[ "${baseline_digest_line%% *}" != "$production_baseline_helper_sha256" ]]; then
    printf '%s\n' '{"appHealthy":false,"cloudflaredHealthy":false,"dockerHealthy":false,"elapsedSeconds":0,"existingContainersExpected":0,"existingContainersRunning":0,"firewallHealthy":false,"libvirtHealthy":false,"postgresDurable":false,"postgresHealthy":false,"publicHttpsHealthy":false,"recovered":false,"runnerHealthy":false,"schemaVersion":1,"timedOut":false,"timersHealthy":false,"workersHealthy":false}'
    exit 1
  fi
fi


if [[ "$test_mode" == true ]]; then
  exec "$python" -B "$helper" "${helper_arguments[@]}"
fi

exec "${launcher[@]}" "$python" -B "$helper" "${helper_arguments[@]}" 2>/dev/null
