#!/usr/bin/env bash
# Exit non-zero when the production PostgreSQL container does not accept
# connections. The systemd unit's OnFailure= hook then runs alert.sh.
set -Eeuo pipefail
umask 077

compose_env="${POSTGRES_CHECK_COMPOSE_ENV:-/etc/learncoding/compose.env}"
compose_file="${POSTGRES_CHECK_COMPOSE_FILE:-/opt/learncoding/compose.yaml}"
docker_bin="${POSTGRES_CHECK_DOCKER:-docker}"
timeout_seconds="${POSTGRES_CHECK_TIMEOUT_SECONDS:-20}"

if timeout --signal=KILL "${timeout_seconds}s" \
  "$docker_bin" compose -p "${POSTGRES_CHECK_COMPOSE_PROJECT:-learncoding}" --env-file "$compose_env" -f "$compose_file" \
  exec -T postgres sh -c 'pg_isready -q -h /run/learncoding-postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  >/dev/null 2>&1; then
  exit 0
fi

logger -p daemon.err -t learncoding-postgres-check -- "postgres_down: pg_isready failed inside the postgres container" 2>/dev/null || true
printf '%s severity=critical event=postgres_down\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
exit 1
