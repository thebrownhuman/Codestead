#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash_bin="$(command -v bash)"
env_bin="$(command -v env)"
compose="$repo_root/compose.yaml"
compose_unit="$repo_root/infra/systemd/learncoding-compose.service"
retention_unit="$repo_root/infra/systemd/learncoding-retention.service"
recovery_service="$repo_root/infra/systemd/learncoding-recovery-check.service"
recovery_timer="$repo_root/infra/systemd/learncoding-recovery-check.timer"
firewall_service="$repo_root/infra/systemd/learncoding-runner-firewall.service"
installer="$repo_root/infra/ops/install-systemd.sh"
package_json="$repo_root/package.json"
failures=()

fail() {
  failures+=("$1")
}

systemd_syntax_is_canonical() {
  local file="$1"
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" ]]; then
      continue
    fi
    if [[ "$line" =~ ^[[:space:]] || "$line" =~ [[:space:]]$ ]]; then
      return 1
    fi
    if [[ "$line" == *\\* ]]; then
      return 1
    fi
    if [[ "$line" == \#* || "$line" == \;* ]]; then
      continue
    fi
    case "$line" in
      '[Unit]'|'[Service]'|'[Install]'|'[Timer]') continue ;;
    esac
    if [[ ! "$line" =~ ^[A-Za-z][A-Za-z0-9]*=([^[:space:]].*)?$ ]]; then
      return 1
    fi
  done <"$file"
}

directive_is_exact() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local section=
  local line
  local parsed_key
  local parsed_value
  local matches=0
  local correct=0

  if ! systemd_syntax_is_canonical "$file"; then
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" == \#* || "$line" == \;* ]]; then
      continue
    fi
    case "$line" in
      '[Unit]') section=Unit; continue ;;
      '[Service]') section=Service; continue ;;
      '[Install]') section=Install; continue ;;
      '[Timer]') section=Timer; continue ;;
    esac
    parsed_key="${line%%=*}"
    parsed_value="${line#*=}"
    if [[ "$parsed_key" == "$key" ]]; then
      matches=$((matches + 1))
      if [[ "$section" == "$expected_section" && "$parsed_value" == "$expected_value" ]]; then
        correct=$((correct + 1))
      fi
    fi
  done <"$file"

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

directive_contains_tokens() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  shift 3
  local -a required_tokens=("$@")
  local section=
  local line
  local parsed_key
  local parsed_value
  local token
  local required
  local matches=0

  systemd_syntax_is_canonical "$file" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -n "$line" && "$line" != \#* && "$line" != \;* ]] || continue
    case "$line" in
      '[Unit]') section=Unit; continue ;;
      '[Service]') section=Service; continue ;;
      '[Install]') section=Install; continue ;;
      '[Timer]') section=Timer; continue ;;
    esac
    parsed_key="${line%%=*}"
    parsed_value="${line#*=}"
    if [[ "$parsed_key" == "$key" ]]; then
      matches=$((matches + 1))
      [[ "$section" == "$expected_section" ]] || return 1
      for required in "${required_tokens[@]}"; do
        local found=false
        for token in $parsed_value; do
          if [[ "$token" == "$required" ]]; then found=true; break; fi
        done
        [[ "$found" == true ]] || return 1
      done
    fi
  done <"$file"

  (( matches == 1 ))
}

expect_directive_tokens() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local label="$4"
  shift 4

  if ! directive_contains_tokens "$file" "$expected_section" "$key" "$@"; then
    fail "$label"
  fi
}

expect_required_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    fail "Required later-task production asset is missing: ${file#"$repo_root/"}"
    return 1
  fi
}

expect_canonical_systemd_file() {
  local file="$1"

  if ! systemd_syntax_is_canonical "$file"; then
    fail "Owned systemd file must use canonical physical syntax: ${file#"$repo_root/"}"
  fi
}

expect_canonical_systemd_file "$compose_unit"
expect_canonical_systemd_file "$retention_unit"
for canonical_timer in \
  "$repo_root/infra/systemd/learncoding-backup.timer" \
  "$repo_root/infra/systemd/learncoding-backup-check.timer" \
  "$repo_root/infra/systemd/learncoding-retention.timer"; do
  expect_canonical_systemd_file "$canonical_timer"
done

expect_directive \
  "$compose_unit" \
  Unit \
  RequiresMountsFor \
  '/opt/learncoding /etc/learncoding /srv/learncoding' \
  'Compose startup must require exactly the application, configuration, and primary data mounts'
expect_directive_tokens \
  "$compose_unit" Unit After \
  'Compose startup ordering must include Docker, network-online, local filesystems, libvirt, and the runner firewall' \
  docker.service network-online.target local-fs.target libvirtd.service learncoding-runner-firewall.service
expect_directive "$compose_unit" Unit Requires docker.service 'Compose startup must require Docker'
expect_directive_tokens \
  "$compose_unit" Unit Wants \
  'Compose startup must want network-online, libvirt, and the runner firewall' \
  network-online.target libvirtd.service learncoding-runner-firewall.service
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
expect_directive "$compose_unit" Service RestartSec 15s 'Compose startup must use the final 15-second recovery retry delay'
expect_directive "$compose_unit" Service TimeoutStartSec 15min 'Compose startup must retain its 15-minute start budget'
expect_directive "$compose_unit" Service TimeoutStopSec 5min 'Compose shutdown must use the final five-minute stop budget'
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

if expect_required_file "$firewall_service"; then
  expect_canonical_systemd_file "$firewall_service"
fi
if expect_required_file "$recovery_service"; then
  expect_canonical_systemd_file "$recovery_service"
  expect_directive_tokens \
    "$recovery_service" Unit After \
    'Recovery checker must run after the trusted Compose unit' \
    learncoding-compose.service
  expect_directive_tokens \
    "$recovery_service" Unit Wants \
    'Recovery checker must want Compose so it can still report Compose failure' \
    learncoding-compose.service
  if directive_contains_tokens "$recovery_service" Unit Requires learncoding-compose.service; then
    fail 'Recovery checker must not require Compose'
  fi
  expect_directive \
    "$recovery_service" Unit OnFailure 'learncoding-alert@%n.service' \
    'Recovery checker failure must trigger the existing alert unit'
  expect_directive "$recovery_service" Service Type oneshot 'Recovery checker must be a oneshot service'
  expect_directive "$recovery_service" Service User root 'Recovery checker must run explicitly as root'
  expect_directive "$recovery_service" Service Group root 'Recovery checker must run with the root group'
  expect_directive \
    "$recovery_service" Service ExecStart \
    '/usr/bin/bash /opt/learncoding/infra/ops/check-recovery.sh' \
    'Recovery checker must invoke the reviewed root script'
fi
if expect_required_file "$recovery_timer"; then
  expect_canonical_systemd_file "$recovery_timer"
  expect_directive "$recovery_timer" Timer OnBootSec 2m 'Recovery timer must first run two minutes after boot'
  expect_directive "$recovery_timer" Timer OnUnitActiveSec 15m 'Recovery timer must repeat every fifteen minutes'
  expect_directive "$recovery_timer" Timer Persistent true 'Recovery timer must remain persistent'
  expect_directive \
    "$recovery_timer" Timer Unit learncoding-recovery-check.service \
    'Recovery timer must explicitly activate the recovery service'
  expect_directive "$recovery_timer" Install WantedBy timers.target 'Recovery timer must be installable at boot'
fi

tmp_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
parser_work="$(mktemp -d "$tmp_base/systemd-recovery-parser.XXXXXX")"
parser_work="$(cd "$parser_work" && pwd -P)"
if [[ -L "$parser_work" || "$parser_work" != "$tmp_base"/* ]]; then
  echo 'FAIL: systemd parser fixture escaped its verified temporary root' >&2
  exit 1
fi
chmod 0700 "$parser_work"
cleanup_parser_work() {
  if [[ -d "$parser_work" && ! -L "$parser_work" && "$parser_work" == "$tmp_base"/* ]]; then
    rm -rf -- "$parser_work"
  fi
}
trap cleanup_parser_work EXIT

installer_root="$parser_work/installer-root"
installer_fake_bin="$parser_work/installer-bin"
installer_events="$parser_work/installer-events.log"
installer_under_test="$parser_work/install-systemd.sh"
mkdir -m 0700 -p "$installer_root/infra/systemd" "$installer_fake_bin"
cp "$compose" "$installer_root/compose.yaml"
cp "$repo_root"/infra/systemd/* "$installer_root/infra/systemd/"

installer_root_guard='[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }'
if [[ "$(grep -Fxc -- "$installer_root_guard" "$installer" || true)" != 1 ]]; then
  fail 'Systemd installer must retain one explicit root execution guard'
fi
if tail -n +2 "$installer" | grep -Eq '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+'; then
  fail 'Systemd installer hard-codes an executable path and can bypass the isolated fake PATH'
fi
if tail -n +2 "$installer" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  fail 'Systemd installer can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH'
fi
if tail -n +2 "$installer" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  fail 'Systemd installer can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$installer" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  fail 'Systemd installer redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || fail 'Systemd redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$installer" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  fail 'Systemd installer can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$installer" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  fail 'Systemd installer contains an uninstrumented shell file read'
fi
while IFS= read -r installer_line || [[ -n "$installer_line" ]]; do
  if [[ "$installer_line" == '#!/usr/bin/env bash' ]]; then
    printf '#!%s\n' "$bash_bin"
  elif [[ "$installer_line" == "$installer_root_guard" ]]; then
    printf '%s\n' ': # root guard verified above; behavior runs in a fake-only command root'
  else
    printf '%s\n' "$installer_line"
  fi
done <"$installer" >"$installer_under_test"
chmod 0700 "$installer_under_test"

printf '#!%s\n' "$bash_bin" >"$installer_fake_bin/fake-installer-command"
cat >>"$installer_fake_bin/fake-installer-command" <<'FAKE'
set -Eeuo pipefail

command_name="${0##*/}"
{
  printf '%q' "$command_name"
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$INSTALLER_EVENTS"

unit_source_is_exact() {
  local source="$1"
  local name="${source##*/}"
  [[ "$source" == "$INSTALLER_ROOT/infra/systemd/$name" && -f "$source" && ! -L "$source" &&
    "$name" =~ ^learncoding-[A-Za-z0-9@_.-]+\.(service|timer)$ ]]
}

case "$command_name" in
  basename)
    [[ "$#" == 2 && "$1" == -- ]] || exit 64
    unit_source_is_exact "$2" || exit 97
    printf '%s\n' "${2##*/}"
    ;;
  install)
    [[ "$#" == 8 && "$1" == -o && "$2" == root && "$3" == -g && "$4" == root &&
      "$5" == -m && "$6" == 0644 ]] || exit 64
    unit_source_is_exact "$7" || exit 97
    [[ "$8" == "/etc/systemd/system/${7##*/}" ]] || exit 97
    ;;
  systemctl)
    if [[ "$#" == 1 && "$1" == daemon-reload ]]; then :
    elif [[ "$#" == 3 && "$1" == enable && "$2" == --now &&
      ( "$3" == learncoding-runner-firewall.service || "$3" == learncoding-compose.service ||
        "$3" == learncoding-recovery-check.timer ) ]]; then :
    elif [[ "$#" == 5 && "$1" == enable && "$2" == --now &&
      "$3" == learncoding-backup.timer && "$4" == learncoding-backup-check.timer &&
      "$5" == learncoding-retention.timer ]]; then :
    else
      exit 64
    fi
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0755 "$installer_fake_bin/fake-installer-command"
for command_name in basename install systemctl; do
  cp "$installer_fake_bin/fake-installer-command" "$installer_fake_bin/$command_name"
done

: >"$installer_events"
installer_outside_sentinel="$parser_work/installer-outside.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$installer_outside_sentinel"
set +e
for rejected_installer_action in \
  'disable --now learncoding-compose.service' \
  'mask learncoding-compose.service' \
  'enable --now learncoding-restore-drill.service'; do
  read -r -a rejected_installer_argv <<<"$rejected_installer_action"
  "$env_bin" -i PATH="$installer_fake_bin" INSTALLER_EVENTS="$installer_events" \
    INSTALLER_ROOT="$installer_root" "$installer_fake_bin/systemctl" "${rejected_installer_argv[@]}" \
    >"$parser_work/rejected-installer.stdout" 2>"$parser_work/rejected-installer.stderr"
  rejected_installer_status=$?
  if (( rejected_installer_status == 0 )); then
    set -e
    fail "Systemd installer fake accepted unsafe action: $rejected_installer_action"
    break
  fi
done
set -e
: >"$installer_events"
set +e
"$env_bin" -i HOME="$parser_work" PATH="$installer_fake_bin" REPO_ROOT="$installer_root" \
  INSTALLER_EVENTS="$installer_events" INSTALLER_ROOT="$installer_root" \
  "$bash_bin" "$installer_under_test" --enable \
  >"$parser_work/installer.stdout" 2>"$parser_work/installer.stderr"
installer_status=$?
set -e
[[ "$(<"$installer_outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'Systemd installer modified the outside-fixture sentinel'
if (( installer_status != 0 )); then
  fail "Systemd installer did not execute inside the strict fake root: $(<"$parser_work/installer.stderr")"
else
  expected_installer_events=()
  for unit in "$installer_root"/infra/systemd/*; do
    printf -v basename_event 'basename -- %q' "$unit"
    expected_installer_events+=("$basename_event")
    printf -v install_event 'install -o root -g root -m 0644 %q %q' \
      "$unit" "/etc/systemd/system/${unit##*/}"
    expected_installer_events+=("$install_event")
  done
  expected_installer_events+=(
    'systemctl daemon-reload'
    'systemctl enable --now learncoding-runner-firewall.service'
    'systemctl enable --now learncoding-compose.service'
    'systemctl enable --now learncoding-recovery-check.timer'
    'systemctl enable --now learncoding-backup.timer learncoding-backup-check.timer learncoding-retention.timer'
  )
  mapfile -t actual_installer_events <"$installer_events"
  expect_sequence \
    'Systemd installer must behaviorally publish every mapped unit, reload, and enable only the reviewed ordered automatic set' \
    actual_installer_events "${expected_installer_events[@]}"
  if grep -Eq '^systemctl (disable|mask)|^systemctl .*learncoding-restore-drill\.service' "$installer_events"; then
    fail 'Systemd installer behavior must never disable, mask, or enable the restore drill'
  fi
fi

installer_loop_count="$(grep -Fxc 'for unit in "$repo_root"/infra/systemd/*; do' "$installer" || true)"
installer_publish_count="$(grep -Fxc '  install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename -- "$unit")"' "$installer" || true)"
if [[ "$installer_loop_count" != 1 || "$installer_publish_count" != 1 ]]; then
  fail 'Systemd installer must publish every owned unit exactly once as root:root mode 0644'
fi
required_enable_units=(
  learncoding-runner-firewall.service
  learncoding-compose.service
  learncoding-recovery-check.timer
  learncoding-backup.timer
  learncoding-backup-check.timer
  learncoding-retention.timer
)
actual_enable_units=()
while IFS= read -r enable_line || [[ -n "$enable_line" ]]; do
  enable_line="${enable_line%$'\r'}"
  trimmed_enable_line="${enable_line#"${enable_line%%[![:space:]]*}"}"
  [[ -n "$trimmed_enable_line" && "$trimmed_enable_line" != \#* ]] || continue
  if [[ ! "$trimmed_enable_line" =~ systemctl[[:space:]]+enable([[:space:]]|$) ]]; then continue; fi
  [[ "$enable_line" =~ ^[[:space:]]*systemctl[[:space:]]+enable[[:space:]]+--now[[:space:]]+ ]] || {
    fail 'Systemd installer contains a non-canonical enable command'
    continue
  }
  read -r -a enable_words <<<"$enable_line"
  [[ "${enable_words[0]:-}" == systemctl && "${enable_words[1]:-}" == enable && "${enable_words[2]:-}" == --now ]] || {
    fail 'Systemd installer contains a non-canonical enable command'
    continue
  }
  for enabled_unit in "${enable_words[@]:3}"; do actual_enable_units+=("$enabled_unit"); done
done <"$installer"
if (( ${#actual_enable_units[@]} != ${#required_enable_units[@]} )); then
  fail 'Systemd installer must enable exactly the reviewed automatic units'
else
  for required_unit in "${required_enable_units[@]}"; do
    count=0
    for enabled_unit in "${actual_enable_units[@]}"; do [[ "$enabled_unit" == "$required_unit" ]] && count=$((count + 1)); done
    (( count == 1 )) || fail "Systemd installer must enable exactly once: $required_unit"
  done
fi
for enabled_unit in "${actual_enable_units[@]}"; do
  [[ "$enabled_unit" != learncoding-restore-drill.service ]] || fail 'Systemd installer must never enable the manual restore-drill service'
done

mutated_compose_unit="$parser_work/learncoding-compose.service"
mutated_timer="$parser_work/learncoding-backup.timer"
comment_mutated_compose_unit="$parser_work/comment-override-compose.service"
comment_mutated_timer="$parser_work/comment-override-backup.timer"
spaced_section_unit="$parser_work/spaced-section.service"
padded_assignment_unit="$parser_work/padded-assignment.service"
trailing_whitespace_unit="$parser_work/trailing-whitespace.service"
odd_backslash_unit="$parser_work/odd-backslash.service"
even_backslash_unit="$parser_work/even-backslash.service"
standalone_comment_backslash_unit="$parser_work/standalone-comment-backslash.service"
hidden_exec_unit="$parser_work/hidden-exec.service"
hidden_restart_unit="$parser_work/hidden-restart.service"
hidden_persistent_timer="$parser_work/hidden-persistent.timer"
unterminated_restart_unit="$parser_work/unterminated-restart.service"
unterminated_persistent_timer="$parser_work/unterminated-persistent.timer"
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
  '[ Service ]' \
  'ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' >"$spaced_section_unit"
printf '%s\n' \
  '[Service]' \
  ' ExecStart = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' >"$padded_assignment_unit"
printf '%s\n' \
  '[Service] ' \
  'ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans ' >"$trailing_whitespace_unit"
printf '%s\n' \
  '[Service]' \
  'Restart=on-failure\   ' >"$odd_backslash_unit"
printf '%s\n' \
  '[Service]' \
  'Restart=on-failure\\   ' >"$even_backslash_unit"
printf '%s\n' \
  '[Service]' \
  '# standalone comment backslash \' \
  'Restart=on-failure' >"$standalone_comment_backslash_unit"
cp "$compose_unit" "$hidden_exec_unit"
printf '%s\n' \
  '' \
  '[Service]' \
  'Description=noncanonical continuation \' \
  '# ignored comment block' \
  'ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' >>"$hidden_exec_unit"
cp "$compose_unit" "$hidden_restart_unit"
printf '%s\n' \
  '' \
  '[Service]' \
  'Description=noncanonical continuation \' \
  '; ignored comment block' \
  'Restart=no' >>"$hidden_restart_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$hidden_persistent_timer"
printf '%s\n' \
  '' \
  '[Timer]' \
  'Description=noncanonical continuation \' \
  '# ignored comment block' \
  'Persistent=false' >>"$hidden_persistent_timer"
cp "$compose_unit" "$unterminated_restart_unit"
printf '%s' $'\n[Service]\nRestart=no' >>"$unterminated_restart_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$unterminated_persistent_timer"
printf '%s' $'\n[Timer]\nPersistent=false' >>"$unterminated_persistent_timer"

expect_mutation_rejected \
  "$spaced_section_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted a section header with internal padding'
expect_mutation_rejected \
  "$padded_assignment_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted leading and around-equals assignment whitespace'
expect_mutation_rejected \
  "$trailing_whitespace_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted trailing physical-line whitespace'
expect_mutation_rejected \
  "$odd_backslash_unit" Service Restart on-failure \
  'systemd parser accepted an odd trailing backslash followed by spaces'
expect_mutation_rejected \
  "$even_backslash_unit" Service Restart 'on-failure\' \
  'systemd parser accepted even trailing backslashes followed by spaces'
expect_mutation_rejected \
  "$standalone_comment_backslash_unit" Service Restart on-failure \
  'systemd parser accepted a standalone comment containing a backslash'
expect_mutation_rejected \
  "$hidden_exec_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser hid an unsafe ExecStart after a continuation/comment block'
expect_mutation_rejected \
  "$hidden_restart_unit" Service Restart on-failure \
  'systemd parser hid an unsafe Restart after a continuation/comment block'
expect_mutation_rejected \
  "$hidden_persistent_timer" Timer Persistent true \
  'systemd parser hid an unsafe Persistent value after a continuation/comment block'
expect_mutation_rejected \
  "$unterminated_restart_unit" Service Restart on-failure \
  'systemd parser skipped an unsafe unterminated final Restart directive'
expect_mutation_rejected \
  "$unterminated_persistent_timer" Timer Persistent true \
  'systemd parser skipped an unsafe unterminated final Persistent directive'

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
if (( ${#failures[@]} > 0 )); then
  echo 'systemd recovery contract failed:' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

echo 'systemd-recovery-tests-ok'
