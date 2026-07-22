#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID:-$(/usr/bin/id -u)}" -eq 0 ]] || {
  echo '{"event":"runner_power_rehearsal_control.failed","code":"ROOT_REQUIRED"}' >&2
  exit 77
}

case "${1:-}" in
  arm|status|release|abort) ;;
  *)
    echo '{"event":"runner_power_rehearsal_control.failed","code":"INVALID_ARGUMENTS"}' >&2
    exit 64
    ;;
esac

readonly repo_root="/opt/learncoding"
readonly compose_file="${repo_root}/compose.yaml"
readonly compose_env="/etc/learncoding/compose.env"

[[ -r "$compose_file" && -r "$compose_env" ]] || {
  echo '{"event":"runner_power_rehearsal_control.failed","code":"PRODUCTION_CONFIG_UNAVAILABLE"}' >&2
  exit 66
}

exec /usr/bin/docker compose \
  --env-file "$compose_env" \
  -f "$compose_file" \
  --profile operations \
  run --rm --no-deps --user 0:0 \
  platform-seed \
  node --import tsx /app/scripts/runner-power-rehearsal.ts \
  "$@"
