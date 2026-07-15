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

trim_systemd_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

systemd_logical_lines() {
  local file="$1"
  local line
  local pending=
  local physical_trimmed
  local right_trimmed
  local continuing=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    physical_trimmed="$(trim_systemd_whitespace "$line")"
    if [[ "$physical_trimmed" == \#* || "$physical_trimmed" == \;* ]]; then
      continue
    fi
    if (( continuing )); then
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    pending+="$line"
    right_trimmed="${pending%"${pending##*[![:space:]]}"}"
    if [[ "${right_trimmed: -1}" == '\' ]]; then
      pending="${right_trimmed::-1} "
      continuing=1
      continue
    fi
    printf '%s\n' "$pending"
    pending=
    continuing=0
  done <"$file"

  if (( continuing )) || [[ -n "$pending" ]]; then
    printf '%s\n' "$pending"
  fi
}

directive_is_exact() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local section=
  local line
  local normalized
  local parsed_key
  local parsed_value
  local matches=0
  local correct=0

  expected_section="$(trim_systemd_whitespace "$expected_section")"
  key="$(trim_systemd_whitespace "$key")"
  expected_value="$(trim_systemd_whitespace "$expected_value")"
  while IFS= read -r line; do
    normalized="$(trim_systemd_whitespace "$line")"
    if [[ -z "$normalized" || "$normalized" == \#* || "$normalized" == \;* ]]; then
      continue
    fi
    if [[ "$normalized" =~ ^\[([^]]+)\]$ ]]; then
      section="$(trim_systemd_whitespace "${BASH_REMATCH[1]}")"
      continue
    fi
    if [[ "$normalized" != *"="* ]]; then
      continue
    fi
    parsed_key="$(trim_systemd_whitespace "${normalized%%=*}")"
    parsed_value="$(trim_systemd_whitespace "${normalized#*=}")"
    if [[ "$parsed_key" == "$key" ]]; then
      matches=$((matches + 1))
      if [[ "$section" == "$expected_section" && "$parsed_value" == "$expected_value" ]]; then
        correct=$((correct + 1))
      fi
    fi
  done < <(systemd_logical_lines "$file")

  (( matches == 1 && correct == 1 ))
}

expect_directive() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local label="$5"

  if ! directive_is_exact "$file" "$expected_section" "$key" "$expected_value"; then
    fail "$label"
  fi
}

expect_mutation_rejected() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local label="$5"

  if directive_is_exact "$file" "$expected_section" "$key" "$expected_value"; then
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

parser_work="$(mktemp -d)"
trap 'rm -rf "$parser_work"' EXIT
mutated_compose_unit="$parser_work/learncoding-compose.service"
mutated_timer="$parser_work/learncoding-backup.timer"
comment_mutated_compose_unit="$parser_work/comment-override-compose.service"
comment_mutated_timer="$parser_work/comment-override-backup.timer"
continued_comment_unit="$parser_work/continued-comment.service"
cp "$compose_unit" "$mutated_compose_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$mutated_timer"
cp "$compose_unit" "$comment_mutated_compose_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$comment_mutated_timer"
printf '%s\n' \
  '' \
  ' [Service]' \
  ' ExecStart = /usr/bin/docker compose \' \
  '   --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' \
  ' ExecReload = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' \
  ' ExecStop = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --volumes' \
  ' Restart = no' >>"$mutated_compose_unit"
printf '%s\n' '' ' [Timer]' ' Persistent = false' >>"$mutated_timer"
printf '%s\n' \
  '' \
  ' [Service]' \
  '# harmless recovery comment \' \
  ' ExecReload = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' \
  ' ; harmless restart comment \' \
  ' Restart = no' >>"$comment_mutated_compose_unit"
printf '%s\n' \
  '' \
  ' [Timer]' \
  '# harmless timer comment \' \
  ' Persistent = false' >>"$comment_mutated_timer"
printf '%s\n' \
  ' [Service]' \
  ' ExecStart = /usr/bin/docker compose \' \
  ' # ignored comment while the directive is continued' \
  ' ; ignored continued comment \' \
  ' --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' >"$continued_comment_unit"

expect_mutation_rejected \
  "$mutated_compose_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted a whitespace-indented continued ExecStart build override'
expect_mutation_rejected \
  "$mutated_compose_unit" Service ExecReload \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted a whitespace-around-equals ExecReload build override'
expect_mutation_rejected \
  "$mutated_compose_unit" Service ExecStop \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --remove-orphans' \
  'systemd parser accepted a whitespace-around-equals volume-removing ExecStop override'
expect_mutation_rejected \
  "$mutated_compose_unit" Service Restart on-failure \
  'systemd parser accepted a whitespace-around-equals Restart override'
expect_mutation_rejected \
  "$mutated_timer" Timer Persistent true \
  'systemd parser accepted a whitespace-around-equals Persistent override'
expect_mutation_rejected \
  "$comment_mutated_compose_unit" Service ExecReload \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted an ExecReload build override after a backslash comment'
expect_mutation_rejected \
  "$comment_mutated_compose_unit" Service Restart on-failure \
  'systemd parser accepted a Restart override after a backslash semicolon comment'
expect_mutation_rejected \
  "$comment_mutated_timer" Timer Persistent true \
  'systemd parser accepted a Persistent override after a backslash comment'
expect_directive \
  "$continued_comment_unit" Service ExecStart \
  '/usr/bin/docker compose  --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' \
  'systemd parser did not preserve a continued directive across a comment block'

if (( ${#failures[@]} > 0 )); then
  echo 'systemd recovery contract failed:' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

echo 'systemd-recovery-tests-ok'
