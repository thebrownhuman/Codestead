#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/infra/ops/check-postgres.sh"
unit="$repo_root/infra/systemd/learncoding-postgres-check.service"
timer="$repo_root/infra/systemd/learncoding-postgres-check.timer"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
fail() { printf 'postgres-check-test-failed: %s\n' "$*" >&2; exit 1; }

cat >"$work/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$STUB_ARGS"
exit "$STUB_EXIT"
STUB
chmod 0755 "$work/docker"
export POSTGRES_CHECK_DOCKER="$work/docker" STUB_ARGS="$work/args"

STUB_EXIT=0 bash "$checker" >/dev/null 2>&1 || fail "healthy postgres reported down"
grep -q 'compose -p learncoding ' "$work/args" || fail "checker does not pin compose project"
grep -qx 'Documentation=file:/opt/learncoding/docs/runbooks/logs-and-monitoring.md' "$unit" || fail "Documentation must be a file: URI"
grep -q 'exec -T postgres' "$work/args" || fail "checker does not exec into postgres service"
grep -q 'pg_isready' "$work/args" || fail "checker does not use pg_isready"

if out="$(STUB_EXIT=2 bash "$checker" 2>&1)"; then fail "down postgres reported healthy"; fi
[[ "$out" == *'event=postgres_down'* ]] || fail "missing postgres_down event"

grep -qx 'OnFailure=learncoding-alert@%n.service' "$unit" || fail "service lacks OnFailure alert"
grep -qx 'ExecStart=/usr/bin/bash /opt/learncoding/infra/ops/check-postgres.sh' "$unit" || fail "service ExecStart wrong"
grep -qx 'Unit=learncoding-postgres-check.service' "$timer" || fail "timer unit wrong"
grep -qx 'WantedBy=timers.target' "$timer" || fail "timer not installable"
grep -q 'learncoding-postgres-check.timer' "$repo_root/docs/runbooks/logs-and-monitoring.md" || fail "runbook missing postgres alert"
