#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose="$repo_root/compose.yaml"
compose_unit="$repo_root/infra/systemd/learncoding-compose.service"
retention_unit="$repo_root/infra/systemd/learncoding-retention.service"
package_json="$repo_root/package.json"
failures=()

fail() {
  failures+=("$1")
}

expect_directive() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local label="$5"
  local section=
  local line
  local matches=0
  local correct=0

  while IFS= read -r line; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^\[([^]]+)\]$ ]]; then
      section="${BASH_REMATCH[1]}"
      continue
    fi
    if [[ "$line" == "${key}="* ]]; then
      matches=$((matches + 1))
      if [[ "$section" == "$expected_section" && "$line" == "$key=$expected_value" ]]; then
        correct=$((correct + 1))
      fi
    fi
  done <"$file"

  if (( matches != 1 || correct != 1 )); then
    fail "$label"
  fi
}

expect_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if ! grep -Fq -- "$expected" "$file"; then
    fail "$label"
  fi
}

expect_directive \
  "$compose_unit" \
  Unit \
  RequiresMountsFor \
  '/opt/learncoding /etc/learncoding /srv/learncoding' \
  'Compose startup must require exactly the application, configuration, and primary data mounts'
expect_directive \
  "$compose_unit" Unit After 'docker.service network-online.target local-fs.target' \
  'Compose startup ordering must retain Docker, network-online, and local filesystems'
expect_directive "$compose_unit" Unit Requires docker.service 'Compose startup must require Docker'
expect_directive "$compose_unit" Unit Wants network-online.target 'Compose startup must want network-online.target'
expect_directive \
  "$compose_unit" \
  Service \
  ExecStartPre \
  '/usr/bin/bash /opt/learncoding/infra/ops/validate-runtime.sh' \
  'Compose startup must retain runtime preflight'
expect_directive \
  "$compose_unit" \
  Service \
  ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'Compose startup must use explicit inputs without building or pulling'
expect_directive \
  "$compose_unit" \
  Service \
  ExecStartPost \
  '/usr/bin/bash /opt/learncoding/infra/ops/smoke-production.sh --startup-wait 600' \
  'Compose startup must run the bounded production smoke check'
expect_directive \
  "$compose_unit" \
  Service \
  ExecReload \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'Compose reload must use explicit inputs without building or pulling'
expect_directive \
  "$compose_unit" \
  Service \
  ExecStop \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --remove-orphans' \
  'Compose stop must preserve durable volumes'
expect_directive "$compose_unit" Service Type oneshot 'Compose unit must remain Type=oneshot'
expect_directive "$compose_unit" Service RemainAfterExit yes 'Compose unit must remain active after startup'
expect_directive "$compose_unit" Service Restart on-failure 'Compose startup must retry transient failures'
expect_directive "$compose_unit" Service RestartSec 30s 'Compose startup must use the Task 6 retry delay'
expect_directive \
  "$compose_unit" \
  Unit \
  OnFailure \
  'learncoding-alert@%n.service' \
  'Compose startup exhaustion must trigger the existing alert unit'
expect_directive \
  "$compose_unit" \
  Unit \
  StartLimitIntervalSec \
  15min \
  'Compose startup retries must use the basic 15-minute limit window'
expect_directive "$compose_unit" Unit StartLimitBurst 5 'Compose startup retries must be bounded to five attempts'
expect_directive "$compose_unit" Install WantedBy multi-user.target 'Compose unit must remain enabled at normal boot'

while IFS= read -r line; do
  line="${line%$'\r'}"
  if [[ "$line" =~ ^Exec(Start|Reload)= ]] && [[ "$line" =~ (^|[[:space:]])--build($|[[:space:]]) ]]; then
    fail 'Compose ExecStart and ExecReload must never use the --build token'
  fi
done <"$compose_unit"

expect_directive \
  "$retention_unit" \
  Unit \
  After \
  learncoding-compose.service \
  'Retention must run after the trusted Compose stack'
expect_directive \
  "$retention_unit" \
  Unit \
  Requires \
  learncoding-compose.service \
  'Retention must require the trusted Compose stack'
expect_directive \
  "$retention_unit" \
  Service \
  ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile operations run --rm --no-deps lifecycle' \
  'Retention must use explicit Compose inputs and the isolated lifecycle invocation'
if grep -Fq -- '2026-07-14.v4' "$retention_unit"; then
  fail 'Retention systemd unit must consume the versioned Compose lifecycle command instead of duplicating its token'
fi

command_items() {
  awk '
    $0 == "    command:" { in_command = 1; next }
    in_command && /^      - / { sub(/^      - /, ""); print; next }
    in_command { exit }
  '
}

expect_sequence() {
  local label="$1"
  local actual_name="$2"
  shift 2
  local -n actual="$actual_name"
  local -a expected=("$@")
  local index

  if (( ${#actual[@]} != ${#expected[@]} )); then
    fail "$label"
    return
  fi
  for index in "${!expected[@]}"; do
    if [[ "${actual[$index]}" != "${expected[$index]}" ]]; then
      fail "$label"
      return
    fi
  done
}

postgres_section="$(sed -n '/^  postgres:/,/^  migrate:/p' "$compose" | tr -d '\r')"
mapfile -t postgres_command < <(command_items <<<"$postgres_section")
expect_sequence \
  'PostgreSQL command must contain only the three enabled durability settings' \
  postgres_command \
  postgres -c fsync=on -c synchronous_commit=on -c full_page_writes=on

lifecycle_section="$(sed -n '/^  lifecycle:/,/^  platform-seed:/p' "$compose" | tr -d '\r')"
mapfile -t lifecycle_command < <(command_items <<<"$lifecycle_section")
expect_sequence \
  'Compose lifecycle command must be the exact canonical v4 apply command' \
  lifecycle_command \
  node --import tsx /app/scripts/data-lifecycle.ts retention --apply --confirm 2026-07-14.v4
expect_contains \
  "$package_json" \
  '"worker:retention": "tsx scripts/data-lifecycle.ts retention --apply --confirm 2026-07-14.v4"' \
  'package.json worker:retention must use canonical retention version 2026-07-14.v4'

for timer in \
  "$repo_root/infra/systemd/learncoding-backup.timer" \
  "$repo_root/infra/systemd/learncoding-backup-check.timer" \
  "$repo_root/infra/systemd/learncoding-retention.timer"; do
  if [[ ! -f "$timer" ]]; then
    fail "Required persistent timer is missing: ${timer#"$repo_root/"}"
    continue
  fi
  expect_directive \
    "$timer" Timer Persistent true \
    "Timer must contain exactly one effective Persistent=true in [Timer]: ${timer#"$repo_root/"}"
done

if (( ${#failures[@]} > 0 )); then
  echo 'systemd recovery contract failed:' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

echo 'systemd-recovery-tests-ok'
