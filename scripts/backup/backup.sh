#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_backup_config

readonly QUIESCE_BUDGET_SECONDS=600
readonly DEADLINE_KILL_GRACE_SECONDS=15
readonly DEADLINE_GROUP_PROOF_SECONDS=5
readonly DEADLINE_EVENT_MONITOR_STOP_REQUEST_SECONDS=25
readonly DEADLINE_RESUME_RESERVE_SECONDS=5
readonly MAX_EVENT_LOG_BYTES=1048576
readonly MAX_EVENT_LOG_LINES=4096
readonly MAX_CLAMAV_RESTART_EVENTS=32
readonly -a REQUIRED_IMAGE_SERVICES=(
  app cloudflared exam-finalization-worker mail-worker migrate postgres
  practice-runner-recovery-worker project-review-correction-worker
  regrade-worker reward-worker
)
readonly -a OPTIONAL_CREATED_IMAGE_SERVICES=(
  clamav scan-worker lifecycle platform-seed admin-bootstrap
)
readonly -a REPOSITORY_ARCHIVE_PATHS=(
  .dockerignore Dockerfile compose.yaml content docs/deployment.md docs/runbooks
  drizzle infra
)

for command_name in age age-keygen docker find flock git grep gzip head hostname python3 realpath \
  sha256sum sleep stat sync tar; do
  require_command "$command_name"
done
managed_deadline="$SCRIPT_DIR/run-managed-deadline.py"
[[ -f "$managed_deadline" && ! -L "$managed_deadline" ]] \
  || die "managed deadline supervisor is missing or unsafe"

run_fixed_deadline() {
  local duration="$1" grace="$2" status
  shift 2
  [[ "$duration" =~ ^[1-9][0-9]*$ && "$grace" =~ ^[1-9][0-9]*$ ]] \
    || return 125
  if python3 "$managed_deadline" --expected-parent-pid "$BASHPID" \
    "$duration" "$grace" -- "$@"; then
    status=0
  else
    status=$?
  fi
  return "$status"
}

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${AGE_RECIPIENT_FILE:?AGE_RECIPIENT_FILE is required}"
: "${CREDENTIAL_MASTER_KEY_FILE:=/etc/learncoding/secrets/credential_master_key}"
: "${BACKUP_EPHEMERAL_ROOT:=/run}"
for configured_path in "$BACKUP_ROOT" "$REPO_ROOT" "$LEARN_DATA_ROOT" \
  "$COMPOSE_ENV_FILE" "$AGE_RECIPIENT_FILE" "$CREDENTIAL_MASTER_KEY_FILE" \
  "$BACKUP_STAGE_ROOT" "$BACKUP_EPHEMERAL_ROOT" "$BACKUP_LOCK_FILE"; do
  [[ "$configured_path" == /* ]] || die "backup configuration contains a non-absolute path"
done
[[ -z "${EMERGENCY_BACKUP_ROOT:-}" || "$EMERGENCY_BACKUP_ROOT" == /* ]] \
  || die "backup configuration contains a non-absolute path"

secure_directory() {
  local directory="$1" mode="$2" resolved current_mode owner
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || return 1
    resolved="$(realpath -e -- "$directory")" || return 1
    [[ "$resolved" == "$directory" ]] || return 1
    owner="$(stat -c '%u' -- "$directory")" || return 1
    [[ "$owner" == "$(id -u)" ]] || return 1
    current_mode="$(stat -c '%a' -- "$directory")" || return 1
    [[ "$current_mode" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$current_mode & 07022) == 0 )) || return 1
    chmod "$mode" -- "$directory" || return 1
  else
    mkdir -m "$mode" -- "$directory" || return 1
  fi
  resolved="$(realpath -e -- "$directory")" || return 1
  [[ "$resolved" == "$directory" \
    && "$(stat -c '%a' -- "$directory")" == "${mode#0}" \
    && "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]]
}

secure_ephemeral_parent() {
  local directory="$1" mode resolved
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" \
      && "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]] || return 1
    mode="$(stat -c '%a' -- "$directory")" || return 1
    (( (8#$mode & 0022) == 0 )) || return 1
  else
    mkdir -m 0700 -- "$directory" || return 1
  fi
  resolved="$(realpath -e -- "$directory")" || return 1
  [[ "$resolved" == "$directory" ]]
}

read_compose_env_value() {
  local requested="$1" line value="" matches=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* && "$line" != *$'\n'* ]] || return 1
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == "$requested="* ]]; then
      ((matches += 1))
      value="${line#*=}"
    fi
  done <"$COMPOSE_ENV_FILE"
  ((matches == 1)) || return 1
  printf '%s\n' "$value"
}

require_secure_regular_file "$COMPOSE_ENV_FILE" 640 "$(id -u)" \
  || die "Compose environment is missing or unsafe"
require_secure_regular_file "$AGE_RECIPIENT_FILE" 600 "$(id -u)" \
  || die "age recipient file is missing or unsafe"
[[ -s "$AGE_RECIPIENT_FILE" ]] || die "age recipient file is empty"
if grep -Eq 'AGE-SECRET-KEY-|AGE-PLUGIN-.+-' "$AGE_RECIPIENT_FILE"; then
  die "age recipient file contains private identity material"
fi
credential_key_owner="$(id -u)"
[[ "$CREDENTIAL_MASTER_KEY_FILE" != /etc/learncoding/secrets/credential_master_key ]] \
  || credential_key_owner=0
require_secure_regular_file "$CREDENTIAL_MASTER_KEY_FILE" 440 "$credential_key_owner" \
  || die "credential master key is missing or unsafe"
credential_key_real="$(realpath -e -- "$CREDENTIAL_MASTER_KEY_FILE")" \
  || die "credential master key path is invalid"
[[ "$credential_key_real" == "$CREDENTIAL_MASTER_KEY_FILE" ]] \
  || die "credential master key path is not canonical"
credential_key_links="$(stat -c '%h' -- "$CREDENTIAL_MASTER_KEY_FILE")" \
  || die "credential master key link count is unavailable"
[[ "$credential_key_links" == 1 ]] \
  || die "credential master key must have exactly one filesystem link"
credential_key_inode="$(stat -c '%d:%i' -- "$CREDENTIAL_MASTER_KEY_FILE")" \
  || die "credential master key identity is unavailable"

operations_image="$(read_compose_env_value APP_OPERATIONS_IMAGE)" \
  || die "APP_OPERATIONS_IMAGE is missing or ambiguous"
secrets_gid="$(read_compose_env_value SECRETS_GID)" \
  || die "SECRETS_GID is missing or ambiguous"
[[ "$operations_image" =~ ^[^@,[:space:]]+@sha256:[0-9a-f]{64}$ \
  && "$operations_image" != -* ]] \
  || die "APP_OPERATIONS_IMAGE is not an immutable digest"
[[ "$secrets_gid" =~ ^[1-9][0-9]*$ \
  && "$secrets_gid" -le 2147483647 ]] \
  || die "SECRETS_GID is invalid"
for mount_path in "$CREDENTIAL_MASTER_KEY_FILE" "$BACKUP_STAGE_ROOT"; do
  [[ "$mount_path" != *','* && "$mount_path" != *$'\n'* && "$mount_path" != *$'\r'* ]] \
    || die "backup mount path is unsafe"
done

[[ -f "$REPO_ROOT/compose.yaml" && ! -L "$REPO_ROOT/compose.yaml" ]] \
  || die "repository deployment files are missing"
repo_real="$(realpath -e -- "$REPO_ROOT")" || die "repository path is invalid"
[[ "$repo_real" != *'|'* && "$repo_real" != *$'\r'* \
  && "$repo_real" != *$'\n'* ]] \
  || die "repository path is unsafe for canonical Docker event records"
compose_config_json="$(run_fixed_deadline 30 5 \
  docker compose --env-file "$COMPOSE_ENV_FILE" -f "$REPO_ROOT/compose.yaml" \
    config --format json)" \
  || die "Compose project contract could not be resolved"
compose_project_name="$(python3 -c '
import json
import sys
value = json.load(sys.stdin).get("name")
if not isinstance(value, str):
    raise SystemExit(1)
sys.stdout.write(value)
' <<<"$compose_config_json")" || die "Compose project contract is invalid"
unset compose_config_json
[[ "$compose_project_name" == learncoding ]] \
  || die "Compose project name is outside the reviewed release contract"
if path_is_within "$credential_key_real" "$repo_real" \
  || path_is_within "$credential_key_real" "$LEARN_DATA_ROOT"; then
  die "credential master key overlaps a packaged source"
fi
git_top="$(git -C "$repo_real" rev-parse --show-toplevel 2>/dev/null)" \
  || die "installed release Git metadata is unavailable"
[[ "$(realpath -e -- "$git_top")" == "$repo_real" ]] \
  || die "installed release is not the exact Git worktree"
pre_commit="$(git -C "$repo_real" rev-parse --verify HEAD 2>/dev/null)" \
  || die "installed release commit is unavailable"
[[ "$pre_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
  || die "installed release commit is invalid"

require_clean_release() {
  local bounded="$1" status_output ignored_output
  local -a status_command=(
    git -C "$repo_real" status --porcelain=v1 --untracked-files=all
    --ignore-submodules=none
  )
  local -a ignored_command=(
    git -C "$repo_real" ls-files --others --ignored --exclude-standard --
    "${REPOSITORY_ARCHIVE_PATHS[@]}"
  )
  if [[ "$bounded" == true ]]; then
    status_output="$(run_deadline "${status_command[@]}")" || return 1
    ignored_output="$(run_deadline "${ignored_command[@]}")" || return 1
  else
    status_output="$("${status_command[@]}")" || return 1
    ignored_output="$("${ignored_command[@]}")" || return 1
  fi
  [[ -z "$status_output" && -z "$ignored_output" ]]
}

require_clean_release false || die "installed release worktree is not clean"
source_host="$(hostname -s)"
[[ "$source_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] \
  || die "source host name is unsafe"

backup_root="$(validated_root "$BACKUP_ROOT" "$FULL_BACKUP_MAGIC")"
full_dir="$backup_root/full"
state_dir="$backup_root/state"
protected_roots=("$repo_real" "$LEARN_DATA_ROOT" "$backup_root")
[[ -z "${EMERGENCY_BACKUP_ROOT:-}" ]] || protected_roots+=("$EMERGENCY_BACKUP_ROOT")
for protected_root in "${protected_roots[@]}"; do
  if path_is_within "$BACKUP_STAGE_ROOT" "$protected_root" \
    || path_is_within "$protected_root" "$BACKUP_STAGE_ROOT"; then
    die "backup staging root overlaps a protected root"
  fi
  if path_is_within "$BACKUP_EPHEMERAL_ROOT" "$protected_root" \
    || path_is_within "$protected_root" "$BACKUP_EPHEMERAL_ROOT"; then
    die "ephemeral-key root overlaps a protected root"
  fi
done
if path_is_within "$BACKUP_STAGE_ROOT" "$BACKUP_EPHEMERAL_ROOT" \
  || path_is_within "$BACKUP_EPHEMERAL_ROOT" "$BACKUP_STAGE_ROOT"; then
  die "backup staging and ephemeral-key roots overlap"
fi
secure_directory "$full_dir" 0700 || die "full backup directory is unsafe"
secure_directory "$state_dir" 0700 || die "backup state directory is unsafe"
secure_directory "$BACKUP_STAGE_ROOT" 0700 || die "backup staging root is unsafe"
secure_ephemeral_parent "$BACKUP_EPHEMERAL_ROOT" || die "ephemeral-key root is unsafe"
acquire_backup_lock

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="learncoding-full-${timestamp}.tar.gz.age"
final_archive="$full_dir/$filename"
final_checksum="${final_archive}.sha256"
marker="$state_dir/local-last-success.env"
[[ ! -e "$final_archive" && ! -L "$final_archive" \
  && ! -e "$final_checksum" && ! -L "$final_checksum" ]] \
  || die "backup timestamp already exists"

stage=""
verify_dir=""
ephemeral_dir=""
bootstrap_cleanup() {
  local original_status=$? cleanup_failed=0 target parent
  trap - EXIT
  for target in "$ephemeral_dir" "$verify_dir" "$stage"; do
    [[ -n "$target" ]] || continue
    if [[ "$target" == "$ephemeral_dir" ]]; then
      parent="$BACKUP_EPHEMERAL_ROOT"
    else
      parent="$BACKUP_STAGE_ROOT"
    fi
    if [[ ! -d "$target" || -L "$target" || "$target" == "$parent" \
      || "$(stat -c '%u' -- "$target" 2>/dev/null)" != "$(id -u)" ]] \
      || ! path_is_within "$target" "$parent" \
      || ! rmdir -- "$target" 2>/dev/null; then
      cleanup_failed=1
    fi
  done
  ((original_status != 0)) && exit "$original_status"
  ((cleanup_failed == 0)) || exit 1
  exit 0
}
trap bootstrap_cleanup EXIT
stage="$(mktemp -d -- "$BACKUP_STAGE_ROOT/full.${timestamp}.XXXXXX")"
verify_dir="$(mktemp -d -- "$BACKUP_STAGE_ROOT/verify.${timestamp}.XXXXXX")"
ephemeral_dir="$(mktemp -d -- "$BACKUP_EPHEMERAL_ROOT/learncoding-backup.${timestamp}.XXXXXX")"
chmod 0700 -- "$stage" "$verify_dir" "$ephemeral_dir"
identity="$ephemeral_dir/identity.txt"
ephemeral_recipient="$ephemeral_dir/recipient.txt"
combined_recipients="$ephemeral_dir/recipients.txt"
tmp_archive=""
tmp_checksum=""
outer_plain="$stage/.plaintext-envelope.tar.gz"
marker_before="$stage/.marker-before"
marker_before_present=0
phase=preflight
marker_committed=0
marker_published=0
marker_validation_pending=0
publication_commit_uncertain=0
quiesce_started=0
clamav_expected_running=0
resume_attempted=0
resumed=0
deadline_seconds=0
event_monitor_pid=""
event_monitor_supervisor_start=""
event_monitor_control=""
event_monitor_control_device=""
event_monitor_control_inode=""
event_monitor_active=0
event_monitor_closed=0
event_monitor_containment_proven=1
active_event_sentinel=""
event_monitor_boundary=0
event_checkpoint_sequence=0
quiesce_event_phase=0
expected_clamav_id=""
declare -a captured_mutators=()

safe_remove_tree() {
  local target="${1:-}"
  [[ -n "$target" && -d "$target" && ! -L "$target" \
    && "$target" != "$BACKUP_STAGE_ROOT" \
    && "$(stat -c '%u' -- "$target" 2>/dev/null)" == "$(id -u)" ]] || return 1
  path_is_within "$target" "$BACKUP_STAGE_ROOT" || return 1
  find -P "$target" -mindepth 1 -delete 2>/dev/null || return 1
  rmdir -- "$target"
}

remove_ephemeral_material() {
  [[ -n "${ephemeral_dir:-}" && -d "$ephemeral_dir" && ! -L "$ephemeral_dir" \
    && "$ephemeral_dir" != "$BACKUP_EPHEMERAL_ROOT" \
    && "$(stat -c '%u' -- "$ephemeral_dir" 2>/dev/null)" == "$(id -u)" ]] || return 1
  path_is_within "$ephemeral_dir" "$BACKUP_EPHEMERAL_ROOT" || return 1
  rm -f -- "$identity" "$ephemeral_recipient" "$combined_recipients" 2>/dev/null || true
  find -P "$ephemeral_dir" -mindepth 1 -delete 2>/dev/null || return 1
  rmdir -- "$ephemeral_dir"
}

unlink_ephemeral_identity() {
  rm -f -- "$identity" "$ephemeral_recipient" "$combined_recipients" 2>/dev/null
}

resume_captured() {
  resume_attempted=1
  if resume_mutators captured_mutators; then
    resumed=1
    log "backup phase=resuming"
    log "backup phase=resumed"
    return 0
  fi
  emit_alert critical backup_resume_failed \
    "backup publication state is retained but captured services did not resume"
  return 1
}

rollback_unvalidated_marker() {
  local rollback_command
  if ((marker_before_present == 1)); then
    rollback_command='set -Eeuo pipefail
before="$1"
marker="$2"
directory="$3"
[[ -f "$before" && ! -L "$before" && -d "$directory" && ! -L "$directory" ]]
temporary="$(mktemp -- "$directory/.local-last-success.env.rollback.XXXXXX")"
trap '\''rm -f -- "$temporary"'\'' EXIT
cp -- "$before" "$temporary"
chmod 0600 -- "$temporary"
sync -f -- "$temporary"
mv -fT -- "$temporary" "$marker"
temporary=""
sync -f -- "$directory"
cmp -s -- "$before" "$marker"'
    run_fixed_deadline 4 1 bash -c "$rollback_command" _ \
      "$marker_before" "$marker" "$state_dir"
  else
    rollback_command='set -Eeuo pipefail
marker="$1"
directory="$2"
[[ -d "$directory" && ! -L "$directory" ]]
rm -f -- "$marker"
sync -f -- "$directory"
[[ ! -e "$marker" && ! -L "$marker" ]]'
    run_fixed_deadline 4 1 bash -c "$rollback_command" _ \
      "$marker" "$state_dir"
  fi
}

cleanup() {
  local original_status=$? cleanup_failed=0 resume_failed=0
  trap - EXIT

  if ((quiesce_started == 1 && resumed == 0)); then
    resume_captured || resume_failed=1
  fi
  if ((event_monitor_active == 1)); then
    terminate_event_monitor_cleanup || cleanup_failed=1
  fi
  if ((event_monitor_containment_proven == 0)); then
    emit_alert critical backup_monitor_containment_failed \
      "backup monitor containment could not be proved; publication and protected staging were preserved"
    ((original_status != 0)) && exit "$original_status"
    exit 1
  fi

  unlink_ephemeral_identity || cleanup_failed=1

  if ((marker_validation_pending == 1 && marker_committed == 0)); then
    if rollback_unvalidated_marker; then
      marker_published=0
      marker_validation_pending=0
      publication_commit_uncertain=0
    else
      cleanup_failed=1
    fi
  fi

  if ((publication_commit_uncertain == 1 && marker_validation_pending == 0)); then
    if read_success_marker "$marker"; then
      if [[ "$SUCCESS_ARCHIVE" == "$filename" \
        && "$SUCCESS_COMPLETED_UTC" == "${completed_utc:-}" \
        && "$SUCCESS_SHA256" == "${ciphertext_hash:-}" ]]; then
        marker_committed=1
      fi
    fi
    if ((marker_committed == 0 && marker_before_present == 1)) \
      && require_secure_regular_file "$marker" 600 "$(id -u)" \
      && cmp -s -- "$marker_before" "$marker"; then
      publication_commit_uncertain=0
    elif ((marker_committed == 0 && marker_before_present == 0)) \
      && [[ ! -e "$marker" && ! -L "$marker" ]]; then
      publication_commit_uncertain=0
    fi
  fi

  if ((marker_committed == 0 && publication_commit_uncertain == 0)); then
    [[ -z "$tmp_archive" ]] || rm -f -- "$tmp_archive" 2>/dev/null || cleanup_failed=1
    [[ -z "$tmp_checksum" ]] || rm -f -- "$tmp_checksum" 2>/dev/null || cleanup_failed=1
    rm -f -- "$final_archive" "$final_checksum" 2>/dev/null || cleanup_failed=1
  else
    [[ -z "$tmp_archive" ]] || rm -f -- "$tmp_archive" 2>/dev/null || cleanup_failed=1
    [[ -z "$tmp_checksum" ]] || rm -f -- "$tmp_checksum" 2>/dev/null || cleanup_failed=1
  fi

  remove_ephemeral_material || cleanup_failed=1
  safe_remove_tree "$verify_dir" || cleanup_failed=1
  safe_remove_tree "$stage" || cleanup_failed=1

  if ((original_status != 0)); then
    if ((marker_committed == 0)); then
      if ! enqueue_backup_status failure "$timestamp"; then
        emit_alert warning backup_report_not_queued \
          "backup failure status could not be queued; inspect protected operations logs"
      fi
      emit_alert critical backup_failed \
        "nightly encrypted backup failed; inspect protected operations logs"
    elif ((resume_failed == 0)); then
      emit_alert critical backup_post_commit_failed \
        "a verified local recovery point committed but a later operation failed"
    fi
    exit "$original_status"
  fi
  if ((resume_failed != 0 || cleanup_failed != 0)); then
    emit_alert critical backup_cleanup_failed \
      "backup cleanup or captured-service resume failed"
    exit 1
  fi
  exit 0
}
trap cleanup EXIT

remaining_seconds() {
  local remaining=$((deadline_seconds - SECONDS))
  ((remaining > 0)) || return 1
  printf '%s\n' "$remaining"
}

run_deadline() {
  local remaining command_seconds
  remaining="$(remaining_seconds)" || return 124
  ((remaining > DEADLINE_KILL_GRACE_SECONDS + DEADLINE_GROUP_PROOF_SECONDS \
    + DEADLINE_RESUME_RESERVE_SECONDS)) \
    || return 124
  command_seconds=$((remaining - DEADLINE_KILL_GRACE_SECONDS \
    - DEADLINE_GROUP_PROOF_SECONDS - DEADLINE_RESUME_RESERVE_SECONDS))
  run_fixed_deadline "$command_seconds" "$DEADLINE_KILL_GRACE_SECONDS" "$@"
}

PROC_STATE=""
PROC_PARENT=""
PROC_PGID=""
PROC_START=""
readonly PROC_IDENTITY_ABSENT=1
readonly PROC_IDENTITY_ERROR=2
read_linux_process_identity() {
  local pid="$1" raw remainder
  local -a fields=()
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return "$PROC_IDENTITY_ERROR"
  [[ -e "/proc/$pid/stat" ]] || return "$PROC_IDENTITY_ABSENT"
  [[ -r "/proc/$pid/stat" ]] || return "$PROC_IDENTITY_ERROR"
  if ! { IFS= read -r raw <"/proc/$pid/stat"; } 2>/dev/null; then
    [[ ! -e "/proc/$pid/stat" ]] && return "$PROC_IDENTITY_ABSENT"
    return "$PROC_IDENTITY_ERROR"
  fi
  [[ "$raw" == *') '* ]] || return "$PROC_IDENTITY_ERROR"
  remainder="${raw##*) }"
  read -r -a fields <<<"$remainder"
  ((${#fields[@]} >= 20)) || return "$PROC_IDENTITY_ERROR"
  [[ "${fields[0]}" =~ ^[A-Z]$ \
    && "${fields[1]}" =~ ^[0-9]+$ \
    && "${fields[2]}" =~ ^[0-9]+$ \
    && "${fields[19]}" =~ ^[1-9][0-9]*$ ]] || return "$PROC_IDENTITY_ERROR"
  PROC_STATE="${fields[0]}"
  PROC_PARENT="${fields[1]}"
  PROC_PGID="${fields[2]}"
  PROC_START="${fields[19]}"
}

drain_event_monitor_group() {
  local request_timeout monitor_status=0
  event_monitor_containment_proven=0
  [[ "$event_monitor_pid" =~ ^[1-9][0-9]*$ \
    && "$event_monitor_supervisor_start" =~ ^[1-9][0-9]*$ \
    && "$event_monitor_control_device" =~ ^[1-9][0-9]*$ \
    && "$event_monitor_control_inode" =~ ^[1-9][0-9]*$ \
    && -n "$event_monitor_control" ]] || return 1
  request_timeout="$(remaining_seconds)" || return 1
  [[ "$request_timeout" =~ ^[1-9][0-9]*$ ]] || return 1
  ((request_timeout <= DEADLINE_EVENT_MONITOR_STOP_REQUEST_SECONDS)) \
    || request_timeout="$DEADLINE_EVENT_MONITOR_STOP_REQUEST_SECONDS"
  python3 "$managed_deadline" --request-stop "$event_monitor_control" \
    --expected-control-device "$event_monitor_control_device" \
    --expected-control-inode "$event_monitor_control_inode" \
    --expected-supervisor-pid "$event_monitor_pid" \
    --expected-supervisor-start "$event_monitor_supervisor_start" \
    --request-timeout "$request_timeout" || return 1
  wait "$event_monitor_pid" 2>/dev/null || monitor_status=$?
  [[ "$monitor_status" == 143 ]] || return 1
  [[ ! -e "$event_monitor_control" && ! -L "$event_monitor_control" ]] \
    || return 1
  event_monitor_containment_proven=1
}

event_monitor_is_alive() {
  ((event_monitor_active == 1)) \
    && [[ "$event_monitor_pid" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$event_monitor_supervisor_start" =~ ^[1-9][0-9]*$ ]] \
    && [[ -f "$event_monitor_control" && ! -L "$event_monitor_control" ]] \
    && read_linux_process_identity "$event_monitor_pid" \
    && [[ "$PROC_START" == "$event_monitor_supervisor_start" \
      && "$PROC_STATE" != Z ]]
}

wait_for_event_monitor_line() {
  local expected="$1" lower_boundary="$2" snapshot="$stage/.docker-events-wait"
  [[ "$lower_boundary" =~ ^[0-9]+$ ]] || return 1
  run_deadline bash -c '
    set -Eeuo pipefail
    export LC_ALL=C
    output="$1"
    expected="$2"
    monitor_pid="$3"
    snapshot="$4"
    max_bytes="$5"
    max_lines="$6"
    lower="$7"
    trap '\''rm -f -- "$snapshot"'\'' EXIT
    while :; do
      [[ -r "/proc/$monitor_pid/stat" ]] || exit 70
      head -c "$((max_bytes + 1))" -- "$output" >"$snapshot"
      bytes="$(stat -c "%s" -- "$snapshot")"
      [[ "$bytes" =~ ^[0-9]+$ && "$max_lines" =~ ^[1-9][0-9]*$ \
        && "$lower" =~ ^[0-9]+$ ]] || exit 71
      ((bytes <= max_bytes)) || exit 72
      ((lower <= bytes)) || exit 73
      if ((lower > 0)); then
        lower_byte="$(dd if="$snapshot" bs=1 skip=$((lower - 1)) count=1 \
          status=none | od -An -t u1 | tr -d "[:space:]")"
        [[ "$lower_byte" == 10 ]] || exit 74
      fi
      offset=0
      line_count=0
      match_end=""
      while IFS= read -r line; do
        ((line_count += 1))
        ((line_count <= max_lines)) || exit 77
        line_start="$offset"
        offset=$((offset + ${#line} + 1))
        if ((line_start >= lower)) && [[ "$line" == "$expected" ]]; then
          [[ -z "$match_end" ]] || exit 75
          match_end="$offset"
        fi
      done <"$snapshot"
      if [[ -n "$match_end" ]]; then
        ((match_end > lower && match_end <= bytes)) || exit 76
        printf "%s\n" "$match_end"
        exit 0
      fi
      sleep 0.02
    done
  ' event-wait "$event_monitor_output" "$expected" "$event_monitor_pid" \
    "$snapshot" "$MAX_EVENT_LOG_BYTES" "$MAX_EVENT_LOG_LINES" \
    "$lower_boundary"
}

emit_event_monitor_sentinel() {
  local sentinel_phase="$1" sentinel_name sentinel_id removed_id expected_line
  local lower_boundary create_boundary destroy_boundary
  [[ "$sentinel_phase" == start || "$sentinel_phase" == quiesce-open \
    || "$sentinel_phase" == quiesce-close || "$sentinel_phase" == end \
    || "$sentinel_phase" =~ ^checkpoint-[1-9][0-9]*$ ]] \
    || return 1
  event_monitor_is_alive || return 1
  lower_boundary="$event_monitor_boundary"
  [[ "$lower_boundary" =~ ^[0-9]+$ ]] || return 1
  sentinel_name="codestead-backup-monitor-${timestamp}-${sentinel_phase}-$$"
  sentinel_id="$(run_deadline docker create --pull=never \
    --name "$sentinel_name" \
    --label "com.docker.compose.project=$compose_project_name" \
    --label "com.docker.compose.project.working_dir=$repo_real" \
    --label com.docker.compose.service=backup-monitor \
    --label com.centurylinklabs.watchtower.enable=false \
    --label "com.codestead.backup.monitor.token=$event_monitor_token" \
    --label "com.codestead.backup.monitor.phase=$sentinel_phase" \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 16 --memory 32m --cpus 0.1 \
    "$operations_image")" || return 1
  sentinel_id="${sentinel_id//$'\r'/}"
  sentinel_id="${sentinel_id//$'\n'/}"
  [[ "$sentinel_id" =~ ^[0-9a-f]{64}$ ]] || return 1
  active_event_sentinel="$sentinel_id"
  expected_line="create|$sentinel_id|backup-monitor|$repo_real|$event_monitor_token|$sentinel_phase||"
  create_boundary="$(wait_for_event_monitor_line \
    "$expected_line" "$lower_boundary")" || return 1
  [[ "$create_boundary" =~ ^[1-9][0-9]*$ \
    && "$create_boundary" -gt "$lower_boundary" ]] || return 1
  removed_id="$(run_deadline docker rm --force "$sentinel_id")" || return 1
  removed_id="${removed_id//$'\r'/}"
  removed_id="${removed_id//$'\n'/}"
  [[ "$removed_id" == "$sentinel_id" ]] || return 1
  expected_line="destroy|$sentinel_id|backup-monitor|$repo_real|$event_monitor_token|$sentinel_phase||"
  destroy_boundary="$(wait_for_event_monitor_line \
    "$expected_line" "$create_boundary")" || return 1
  [[ "$destroy_boundary" =~ ^[1-9][0-9]*$ \
    && "$destroy_boundary" -gt "$create_boundary" ]] || return 1
  event_monitor_boundary="$destroy_boundary"
  active_event_sentinel=""
}

emit_event_monitor_checkpoint() {
  local next_sequence
  next_sequence=$((event_checkpoint_sequence + 1))
  ((next_sequence > 0)) || return 1
  emit_event_monitor_sentinel "checkpoint-$next_sequence" || return 1
  event_checkpoint_sequence="$next_sequence"
}

audit_event_monitor() {
  local expected_state="$1" requested_boundary="${2:-}"
  local snapshot="$stage/.docker-events-audit"
  local live_snapshot="$stage/.docker-events-live"
  local audit_boundary
  [[ "$expected_state" == active || "$expected_state" == closed ]] || return 1
  [[ -f "$event_monitor_output" && ! -L "$event_monitor_output" ]] || return 1
  [[ -f "$expected_mutator_map" && ! -L "$expected_mutator_map" \
    && "$quiesce_event_phase" =~ ^[012]$ ]] || return 1
  if [[ "$expected_state" == active ]]; then
    [[ -z "$requested_boundary" ]] || return 1
    emit_event_monitor_checkpoint || return 1
    audit_boundary="$event_monitor_boundary"
  else
    [[ "$requested_boundary" =~ ^[1-9][0-9]*$ ]] || return 1
    audit_boundary="$requested_boundary"
  fi
  run_deadline bash -c '
    set -Eeuo pipefail
    export LC_ALL=C
    output="$1"
    snapshot="$2"
    live_snapshot="$3"
    boundary="$4"
    max_bytes="$5"
    max_lines="$6"
    expected_repo="$7"
    expected_token="$8"
    expected_state="$9"
    max_clamav_events="${10}"
    expected_mutator_map="${11}"
    quiesce_phase="${12}"
    expected_clamav_id="${13}"
    expected_checkpoint_sequence="${14}"
    [[ "$max_clamav_events" =~ ^[0-9]+$ \
      && "$quiesce_phase" =~ ^[012]$ \
      && "$boundary" =~ ^[1-9][0-9]*$ \
      && "$expected_checkpoint_sequence" =~ ^[1-9][0-9]*$ \
      && ( -z "$expected_clamav_id" \
        || "$expected_clamav_id" =~ ^[0-9a-f]{64}$ ) \
      && -f "$expected_mutator_map" \
      && ! -L "$expected_mutator_map" ]] || exit 70
    trap '\''rm -f -- "$snapshot" "$live_snapshot"'\'' EXIT
    head -c "$((max_bytes + 1))" -- "$output" >"$live_snapshot"
    live_bytes="$(stat -c "%s" -- "$live_snapshot")"
    [[ "$live_bytes" =~ ^[0-9]+$ ]] || exit 71
    ((live_bytes <= max_bytes && boundary <= live_bytes)) || exit 72
    head -c "$boundary" -- "$output" >"$snapshot"
    bytes="$(stat -c "%s" -- "$snapshot")"
    [[ "$bytes" =~ ^[0-9]+$ && "$bytes" == "$boundary" ]] || exit 71
    terminal_byte="$(tail -c 1 -- "$snapshot" | od -An -t u1 \
      | tr -d "[:space:]")"
    [[ "$terminal_byte" == 10 ]] || exit 72
    start_create=0
    start_destroy=0
    start_id=""
    open_create=0
    open_destroy=0
    open_id=""
    close_create=0
    close_destroy=0
    close_id=""
    end_create=0
    end_destroy=0
    end_id=""
    checkpoint_open=0
    checkpoint_id=""
    checkpoint_number=0
    checkpoint_last=0
    clamav_event_count=0
    clamav_disruptive_count=0
    clamav_recovery_count=0
    clamav_healthy_count=0
    clamav_stop_count=0
    clamav_kill_count=0
    clamav_die_count=0
    clamav_restart_count=0
    clamav_state=idle
    declare -A expected_mutator_ids=()
    declare -A expected_container_ids=()
    declare -A mutator_states=()
    declare -A monitor_sentinel_ids=()
    while IFS="|" read -r expected_service expected_id expected_extra \
      || [[ -n "${expected_service:-}" ]]; do
      [[ -n "${expected_service:-}" ]] || continue
      [[ -z "${expected_extra:-}" \
        && "$expected_service" =~ ^[a-z0-9-]+$ \
        && "$expected_id" =~ ^[0-9a-f]{64}$ \
        && -z "${expected_mutator_ids[$expected_service]+x}" \
        && -z "${expected_container_ids[$expected_id]+x}" ]] || exit 70
      expected_mutator_ids[$expected_service]="$expected_id"
      expected_container_ids[$expected_id]="$expected_service"
      mutator_states[$expected_service]=await-kill
    done <"$expected_mutator_map"
    line_count=0
    while IFS= read -r line; do
      [[ -n "$line" ]] || exit 74
      ((line_count += 1))
      ((line_count <= max_lines)) || exit 73
      pipe_count="${line//[!|]/}"
      ((${#pipe_count} == 7)) || exit 74
      IFS="|" read -r action container_id service event_repo token \
        sentinel_phase event_signal exit_code <<<"$line"
      [[ "$service" =~ ^[a-z0-9-]+$ \
        && "$event_repo" == "$expected_repo" \
        && "$container_id" =~ ^[0-9a-f]{64}$ \
        && "$event_signal" =~ ^[0-9]*$ \
        && "$exit_code" =~ ^[0-9]*$ ]] || exit 74
      case "$service" in
        backup-monitor)
          [[ "$token" == "$expected_token" \
            && "$sentinel_phase" =~ ^(start|quiesce-open|quiesce-close|end|checkpoint-[1-9][0-9]*)$ \
            && "$action" =~ ^(create|destroy)$ \
            && -z "$event_signal" && -z "$exit_code" ]] || exit 75
          if [[ "$action" == create ]]; then
            [[ -z "${monitor_sentinel_ids[$container_id]+x}" ]] || exit 75
            monitor_sentinel_ids[$container_id]=1
          fi
          if [[ "$sentinel_phase" =~ ^checkpoint-[1-9][0-9]*$ ]]; then
            if [[ "$action" == create ]]; then
              next_checkpoint=$((checkpoint_last + 1))
              [[ "$sentinel_phase" == "checkpoint-$next_checkpoint" \
                && "$start_destroy" == 1 && "$end_create" == 0 \
                && "$start_create" == "$start_destroy" \
                && "$open_create" == "$open_destroy" \
                && "$close_create" == "$close_destroy" \
                && "$end_create" == "$end_destroy" \
                && "$checkpoint_open" == 0 ]] || exit 75
              checkpoint_open=1
              checkpoint_id="$container_id"
              checkpoint_number="$next_checkpoint"
            else
              [[ "$checkpoint_open" == 1 \
                && "$sentinel_phase" == "checkpoint-$checkpoint_number" \
                && "$container_id" == "$checkpoint_id" ]] || exit 75
              checkpoint_open=0
              checkpoint_id=""
              checkpoint_last="$checkpoint_number"
              checkpoint_number=0
            fi
          else
            ((checkpoint_open == 0)) || exit 75
            case "$sentinel_phase:$action" in
            start:create)
              ((start_create == 0 && start_destroy == 0 \
                && open_create == 0 && close_create == 0 \
                && end_create == 0)) || exit 75
              start_create=1
              start_id="$container_id"
              ;;
            start:destroy)
              ((start_create == 1 && start_destroy == 0)) || exit 75
              [[ "$container_id" == "$start_id" ]] || exit 75
              start_destroy=1
              ;;
            quiesce-open:create)
              ((quiesce_phase >= 1 && start_destroy == 1 \
                && open_create == 0 && close_create == 0 \
                && end_create == 0)) || exit 75
              open_create=1
              open_id="$container_id"
              ;;
            quiesce-open:destroy)
              ((open_create == 1 && open_destroy == 0)) || exit 75
              [[ "$container_id" == "$open_id" ]] || exit 75
              open_destroy=1
              ;;
            quiesce-close:create)
              ((quiesce_phase == 2 && open_destroy == 1 \
                && close_create == 0 && end_create == 0)) || exit 75
              for expected_service in "${!expected_mutator_ids[@]}"; do
                [[ "${mutator_states[$expected_service]}" == complete ]] \
                  || exit 77
              done
              close_create=1
              close_id="$container_id"
              ;;
            quiesce-close:destroy)
              ((close_create == 1 && close_destroy == 0)) || exit 75
              [[ "$container_id" == "$close_id" ]] || exit 75
              close_destroy=1
              ;;
            end:create)
              [[ "$expected_state" == closed ]] || exit 75
              ((close_destroy == 1 && end_create == 0 \
                && checkpoint_last == expected_checkpoint_sequence)) \
                || exit 75
              end_create=1
              end_id="$container_id"
              ;;
            end:destroy)
              ((end_create == 1 && end_destroy == 0)) || exit 75
              [[ "$container_id" == "$end_id" ]] || exit 75
              end_destroy=1
              ;;
            esac
          fi
          ;;
        clamav)
          ((checkpoint_open == 0)) || exit 76
          [[ -z "$token" && -z "$sentinel_phase" \
            && -n "$expected_clamav_id" \
            && "$container_id" == "$expected_clamav_id" ]] || exit 76
          ((clamav_event_count += 1))
          ((clamav_event_count <= max_clamav_events)) || exit 76
          # ClamAV is read-only with respect to the recovery point, but a
          # restart is accepted only as one bounded lifecycle ending healthy.
          case "$action" in
            stop)
              [[ -z "$event_signal" && -z "$exit_code" ]] || exit 76
              [[ "$clamav_state" == idle || "$clamav_state" == stopping ]] \
                || exit 76
              clamav_state=stopping
              ((clamav_disruptive_count += 1))
              ((clamav_stop_count += 1))
              ((clamav_stop_count <= 1)) || exit 76
              ;;
            kill)
              [[ "$event_signal" =~ ^[1-9][0-9]*$ \
                && -z "$exit_code" ]] || exit 76
              [[ "$clamav_state" == idle || "$clamav_state" == stopping ]] \
                || exit 76
              clamav_state=stopping
              ((clamav_disruptive_count += 1))
              ((clamav_kill_count += 1))
              ((clamav_kill_count <= 1)) || exit 76
              ;;
            die)
              [[ -z "$event_signal" && "$exit_code" =~ ^[0-9]+$ ]] \
                || exit 76
              [[ "$clamav_state" == idle || "$clamav_state" == stopping ]] \
                || exit 76
              clamav_state=stopping
              ((clamav_disruptive_count += 1))
              ((clamav_die_count += 1))
              ((clamav_die_count <= 1)) || exit 76
              ;;
            restart)
              [[ -z "$event_signal" && -z "$exit_code" ]] || exit 76
              [[ "$clamav_state" == idle || "$clamav_state" == stopping \
                || "$clamav_state" == started ]] || exit 76
              ((clamav_restart_count += 1))
              ((clamav_restart_count <= 1)) || exit 76
              ((clamav_disruptive_count += 1))
              [[ "$clamav_state" != idle ]] || clamav_state=stopping
              ;;
            start|unpause)
              [[ -z "$event_signal" && -z "$exit_code" ]] || exit 76
              [[ "$clamav_state" == stopping ]] || exit 76
              ((clamav_recovery_count += 1))
              ((clamav_recovery_count <= 1)) || exit 76
              clamav_state=started
              ;;
            "health_status: starting"|"health_status: unhealthy")
              [[ -z "$event_signal" && -z "$exit_code" ]] || exit 76
              [[ "$clamav_state" == started ]] || exit 76
              ;;
            "health_status: healthy")
              [[ -z "$event_signal" && -z "$exit_code" ]] || exit 76
              [[ "$clamav_state" == started ]] || exit 76
              ((clamav_healthy_count += 1))
              ((clamav_healthy_count == 1)) || exit 76
              clamav_state=healthy
              ;;
            *) exit 76 ;;
          esac
          ;;
        *)
          ((checkpoint_open == 0)) || exit 77
          [[ -z "$token" && -z "$sentinel_phase" \
            && "$start_destroy" == 1 && "$open_destroy" == 1 \
            && "$close_create" == 0 \
            && -n "${expected_mutator_ids[$service]+x}" ]] \
            || exit 77
          [[ "$container_id" == "${expected_mutator_ids[$service]}" ]] \
            || exit 77
          case "${mutator_states[$service]}:$action:$event_signal:$exit_code" in
            await-kill:kill:15:) mutator_states[$service]=await-die ;;
            await-die:die::0|await-die:die::143)
              mutator_states[$service]=await-stop
              ;;
            await-stop:stop::) mutator_states[$service]=complete ;;
            *) exit 77 ;;
          esac
          ;;
      esac
    done <"$snapshot"
    if ((clamav_event_count > 0)); then
      [[ "$clamav_state" == healthy ]] || exit 76
      ((clamav_disruptive_count >= 1 \
        && clamav_recovery_count == 1 \
        && clamav_healthy_count == 1)) || exit 76
    fi
    ((start_create == 1 && start_destroy == 1)) || exit 78
    ((checkpoint_open == 0 \
      && checkpoint_last == expected_checkpoint_sequence)) || exit 78
    for expected_service in "${!expected_mutator_ids[@]}"; do
      if ((quiesce_phase == 2)); then
        [[ "${mutator_states[$expected_service]}" == complete ]] || exit 77
      else
        [[ "${mutator_states[$expected_service]}" == await-kill ]] || exit 77
      fi
    done
    ((quiesce_phase < 1)) \
      || ((open_create == 1 && open_destroy == 1)) || exit 79
    ((quiesce_phase < 2)) \
      || ((close_create == 1 && close_destroy == 1)) || exit 79
    ((quiesce_phase >= 1)) \
      || ((open_create == 0 && open_destroy == 0)) || exit 79
    ((quiesce_phase >= 2)) \
      || ((close_create == 0 && close_destroy == 0)) || exit 79
    if [[ "$expected_state" == active ]]; then
      ((end_create == 0 && end_destroy == 0)) || exit 79
    else
      ((end_create == 1 && end_destroy == 1)) || exit 80
    fi
  ' event-audit "$event_monitor_output" "$snapshot" "$live_snapshot" \
    "$audit_boundary" "$MAX_EVENT_LOG_BYTES" "$MAX_EVENT_LOG_LINES" \
    "$repo_real" "$event_monitor_token" "$expected_state" \
    "$MAX_CLAMAV_RESTART_EVENTS" "$expected_mutator_map" \
    "$quiesce_event_phase" "$expected_clamav_id" \
    "$event_checkpoint_sequence" \
    || return 1
  if [[ "$expected_state" == active ]]; then
    event_monitor_is_alive
  else
    ((event_monitor_closed == 1 && event_monitor_active == 0))
  fi
}

terminate_event_monitor_cleanup() {
  local cleanup_status=0 drain_status=0
  if [[ -n "$active_event_sentinel" ]]; then
    run_fixed_deadline 2 1 \
      docker rm --force "$active_event_sentinel" >/dev/null 2>&1 \
      || cleanup_status=1
    active_event_sentinel=""
  fi
  drain_event_monitor_group || drain_status=$?
  ((event_monitor_containment_proven == 1)) || return 1
  ((drain_status == 0)) || cleanup_status=1
  event_monitor_active=0
  event_monitor_pid=""
  event_monitor_supervisor_start=""
  event_monitor_control=""
  event_monitor_control_device=""
  event_monitor_control_inode=""
  return "$cleanup_status"
}

start_event_monitor() {
  local events_since remaining monitor_seconds control_details control_extra control_pipe_count
  local control_version control_supervisor control_pgid control_guardian_start
  local control_endpoint control_nonce
  local event_monitor_expected_parent_pid
  event_monitor_output="$stage/docker-events.log"
  event_monitor_error="$stage/docker-events.stderr"
  event_monitor_control="$stage/.docker-events.control"
  event_monitor_token="${timestamp}.$$.${pre_commit:0:12}"
  event_monitor_boundary=0
  event_checkpoint_sequence=0
  active_event_sentinel=""
  : >"$event_monitor_output"
  : >"$event_monitor_error"
  chmod 0600 -- "$event_monitor_output" "$event_monitor_error"
  events_since="$(run_deadline date -u +%Y-%m-%dT%H:%M:%S.%NZ)" || return 1
  remaining="$(remaining_seconds)" || return 1
  ((remaining > DEADLINE_KILL_GRACE_SECONDS + DEADLINE_GROUP_PROOF_SECONDS \
    + DEADLINE_RESUME_RESERVE_SECONDS)) \
    || return 1
  monitor_seconds=$((remaining - DEADLINE_KILL_GRACE_SECONDS \
    - DEADLINE_GROUP_PROOF_SECONDS - DEADLINE_RESUME_RESERVE_SECONDS))
  # This controller deliberately performs three read-only PostgreSQL execs
  # (version, migration SELECT, and pg_dump). Docker exec events do not carry
  # authenticated caller identity, so they cannot distinguish those commands
  # from a Docker-socket administrator without a spoofable heuristic. The
  # reviewed boundary therefore requires root/Docker-socket exclusivity during
  # backup; every non-exec continuity action is monitored and fails closed.
  event_monitor_containment_proven=0
  event_monitor_expected_parent_pid="$BASHPID"
  python3 "$managed_deadline" \
    --expected-parent-pid "$event_monitor_expected_parent_pid" \
    --control-file "$event_monitor_control" \
    "$monitor_seconds" "$DEADLINE_KILL_GRACE_SECONDS" -- \
    docker events --since "$events_since" \
      --filter type=container \
      --filter "label=com.docker.compose.project=$compose_project_name" \
      --filter "label=com.docker.compose.project.working_dir=$repo_real" \
      --filter event=create --filter event=destroy --filter event=start \
      --filter event=die --filter event=kill --filter event=oom \
      --filter event=pause --filter event=rename --filter event=restart \
      --filter event=stop --filter event=unpause --filter event=update \
      --filter event=health_status \
      --format '{{.Action}}|{{.ID}}|{{ index .Actor.Attributes "com.docker.compose.service" }}|{{ index .Actor.Attributes "com.docker.compose.project.working_dir" }}|{{ index .Actor.Attributes "com.codestead.backup.monitor.token" }}|{{ index .Actor.Attributes "com.codestead.backup.monitor.phase" }}|{{ index .Actor.Attributes "signal" }}|{{ index .Actor.Attributes "exitCode" }}' \
      >"$event_monitor_output" 2>"$event_monitor_error" &
  event_monitor_pid=$!
  event_monitor_active=1
  run_deadline bash -c '
    set -Eeuo pipefail
    control="$1"
    supervisor="$2"
    while [[ ! -s "$control" ]]; do
      [[ -r "/proc/$supervisor/stat" ]] || exit 70
      sleep 0.02
    done
  ' event-monitor-control "$event_monitor_control" "$event_monitor_pid" \
    || return 1
  require_secure_regular_file "$event_monitor_control" 600 "$(id -u)" \
    || return 1
  IFS='|' read -r event_monitor_control_device event_monitor_control_inode \
    <<<"$(stat -c '%d|%i' -- "$event_monitor_control")" || return 1
  [[ "$event_monitor_control_device" =~ ^[1-9][0-9]*$ \
    && "$event_monitor_control_inode" =~ ^[1-9][0-9]*$ ]] || return 1
  control_details="$(cat -- "$event_monitor_control")" || return 1
  control_pipe_count="${control_details//[!|]/}"
  ((${#control_pipe_count} == 6)) || return 1
  IFS='|' read -r control_version control_supervisor \
    event_monitor_supervisor_start control_pgid control_guardian_start \
    control_endpoint control_nonce control_extra <<<"$control_details"
  [[ -z "${control_extra:-}" && "$control_version" == v1 \
    && "$control_supervisor" == "$event_monitor_pid" \
    && "$event_monitor_supervisor_start" =~ ^[1-9][0-9]*$ \
    && "$control_pgid" =~ ^[1-9][0-9]*$ \
    && "$control_guardian_start" =~ ^[1-9][0-9]*$ \
    && "$control_endpoint" =~ ^[.]managed-deadline-stop-[0-9a-f]{32}[.]sock$ \
    && "$control_nonce" =~ ^[0-9a-f]{64}$ ]] || return 1
  emit_event_monitor_sentinel start
}

reconcile_stale_event_sentinels() {
  local listing container_id details full_id configured_image runtime_image status
  local container_name project_label working_dir_label service_label token phase watchtower extra
  local stale_stamp stale_phase stale_pid removed_id expected_runtime_image
  expected_runtime_image="$(run_fixed_deadline 30 5 \
    docker image inspect --format '{{.Id}}' "$operations_image")" || return 1
  expected_runtime_image="${expected_runtime_image//$'\r'/}"
  expected_runtime_image="${expected_runtime_image//$'\n'/}"
  [[ "$expected_runtime_image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  listing="$(run_fixed_deadline 30 5 docker ps -a \
    --filter 'name=^codestead-backup-monitor-' \
    --format '{{.ID}}')" || return 1
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    details="$(run_fixed_deadline 30 5 docker inspect \
      --format '{{.Id}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.Name}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "com.codestead.backup.monitor.token" }}|{{ index .Config.Labels "com.codestead.backup.monitor.phase" }}|{{ index .Config.Labels "com.centurylinklabs.watchtower.enable" }}' \
      "$container_id")" || return 1
    IFS='|' read -r full_id configured_image runtime_image status container_name \
      project_label working_dir_label service_label token phase watchtower extra \
      <<<"$details"
    [[ -z "${extra:-}" \
      && "$full_id" =~ ^[0-9a-f]{64}$ \
      && "$full_id" == "$container_id"* \
      && "$configured_image" == "$operations_image" \
      && "$runtime_image" == "$expected_runtime_image" \
      && "$status" == created \
      && "$project_label" == "$compose_project_name" \
      && "$working_dir_label" == "$repo_real" \
      && "$service_label" == backup-monitor \
      && "$watchtower" == false ]] || return 1
    if [[ "$container_name" =~ ^/codestead-backup-monitor-([0-9]{8}T[0-9]{6}Z)-(start|quiesce-open|quiesce-close|end|checkpoint-[1-9][0-9]*)-([0-9]+)$ ]]; then
      stale_stamp="${BASH_REMATCH[1]}"
      stale_phase="${BASH_REMATCH[2]}"
      stale_pid="${BASH_REMATCH[3]}"
    else
      return 1
    fi
    [[ "$phase" == "$stale_phase" \
      && "$token" =~ ^${stale_stamp}[.]${stale_pid}[.][0-9a-f]{12}$ ]] \
      || return 1
    removed_id="$(run_fixed_deadline 30 5 \
      docker rm --force "$full_id")" || return 1
    removed_id="${removed_id//$'\r'/}"
    removed_id="${removed_id//$'\n'/}"
    [[ "$removed_id" == "$full_id" ]] || return 1
  done <<<"$listing"
}

close_event_monitor() {
  local drain_status=0 closed_boundary
  emit_event_monitor_sentinel end || return 1
  closed_boundary="$event_monitor_boundary"
  [[ "$closed_boundary" =~ ^[1-9][0-9]*$ ]] || return 1
  event_monitor_is_alive || return 1
  drain_event_monitor_group || drain_status=$?
  ((event_monitor_containment_proven == 1 && drain_status == 0)) || return 1
  event_monitor_active=0
  event_monitor_pid=""
  event_monitor_supervisor_start=""
  event_monitor_control=""
  event_monitor_control_device=""
  event_monitor_control_inode=""
  event_monitor_closed=1
  [[ ! -s "$event_monitor_error" ]] || return 1
  audit_event_monitor closed "$closed_boundary"
}

if [[ -e "$marker" || -L "$marker" ]]; then
  require_secure_regular_file "$marker" 600 "$(id -u)" \
    || die "existing success marker is unsafe"
  cp -- "$marker" "$marker_before" || die "existing success marker snapshot failed"
  chmod 0600 -- "$marker_before" || die "existing success marker snapshot mode failed"
  marker_before_present=1
fi
reconcile_stale_event_sentinels \
  || die "stale backup-monitor sentinel reconciliation failed closed"

canonical_tar() {
  local output="$1" base="$2" mtime="$3"
  shift 3
  tar --sort=name --format=posix \
    --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner \
    --mode='a-s,a-t,u+rwX,go+rX,go-w' --mtime="$mtime" \
    --use-compress-program='gzip -n' --create --file "$output" \
    --directory "$base" "$@"
}

assert_safe_source_tree() {
  local source source_inode
  for source in "$@"; do
    [[ ! -L "$source" && ( -f "$source" || -d "$source" ) ]] || return 1
    if [[ -f "$source" ]]; then
      source_inode="$(stat -c '%d:%i' -- "$source")" || return 1
      [[ "$source_inode" != "$credential_key_inode" ]] || return 1
    elif find -P "$source" -type f -printf '%D:%i\n' \
      | grep -Fqx -- "$credential_key_inode"; then
      return 1
    fi
    if [[ -d "$source" ]] \
      && find -P "$source" -mindepth 1 ! -type f ! -type d -print -quit | grep -q .; then
      return 1
    fi
  done
}

capture_image_map() {
  local output_file="$1" bounded="$2" listing line service container_id image known
  local -a compose_args=(
    docker compose --env-file "$COMPOSE_ENV_FILE" -f "$REPO_ROOT/compose.yaml"
    ps -a --format '{{.Service}} {{.ID}}'
  )
  if [[ "$bounded" == true ]]; then
    listing="$(run_deadline "${compose_args[@]}")" || return 1
  else
    listing="$("${compose_args[@]}")" || return 1
  fi
  if [[ "$bounded" == true ]]; then
    run_deadline bash -c ': >"$1"' _ "$output_file" || return 1
  else
    : >"$output_file"
  fi
  declare -A seen_services=()
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    read -r service container_id extra <<<"$line"
    [[ -z "${extra:-}" && "$service" =~ ^[a-z0-9-]+$ \
      && "$container_id" =~ ^[A-Za-z0-9_.-]+$ \
      && -z "${seen_services[$service]+x}" ]] || return 1
    known=0
    for allowed in "${REQUIRED_IMAGE_SERVICES[@]}" "${OPTIONAL_CREATED_IMAGE_SERVICES[@]}"; do
      [[ "$service" != "$allowed" ]] || known=1
    done
    ((known == 1)) || return 1
    seen_services[$service]=1
    if [[ "$bounded" == true ]]; then
      image="$(run_deadline docker inspect --format '{{.Image}}' "$container_id")" || return 1
    else
      image="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
    fi
    [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    if [[ "$bounded" == true ]]; then
      run_deadline bash -c 'printf "%s=%s\n" "$2" "$3" >>"$1"' \
        _ "$output_file" "$service" "$image" || return 1
    else
      printf '%s=%s\n' "$service" "$image" >>"$output_file"
    fi
  done <<<"$listing"
  for service in "${REQUIRED_IMAGE_SERVICES[@]}"; do
    [[ -n "${seen_services[$service]+x}" ]] || return 1
  done
  if [[ "$bounded" == true ]]; then
    run_deadline sort -o "$output_file" "$output_file"
  else
    sort -o "$output_file" "$output_file"
  fi
}

capture_mutator_container_map() {
  local output_file="$1" listing line service container_id full_id extra captured
  local details running project working_dir service_label
  declare -A expected_services=()
  declare -A seen_services=()
  declare -A seen_ids=()
  local -a command=(
    docker compose --env-file "$COMPOSE_ENV_FILE" -f "$REPO_ROOT/compose.yaml"
    ps --status running --format '{{.Service}} {{.ID}}'
  )

  : >"$output_file" || return 1
  chmod 0600 -- "$output_file" || return 1
  for captured in "${captured_mutators[@]}"; do
    [[ "$captured" =~ ^[a-z0-9-]+$ \
      && -z "${expected_services[$captured]+x}" ]] || return 1
    expected_services[$captured]=1
  done
  if ((clamav_expected_running == 1)); then
    expected_services[clamav]=1
  fi
  listing="$(run_deadline "${command[@]}")" || return 1
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    read -r service container_id extra <<<"$line"
    [[ -z "${extra:-}" && "$service" =~ ^[a-z0-9-]+$ \
      && "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    [[ -n "${expected_services[$service]+x}" ]] || continue
    [[ -z "${seen_services[$service]+x}" ]] || return 1
    details="$(run_deadline docker inspect --format \
      '{{.Id}}|{{.State.Running}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.service" }}' \
      "$container_id")" || return 1
    IFS='|' read -r full_id running project working_dir service_label extra \
      <<<"$details"
    [[ -z "${extra:-}" && "$full_id" =~ ^[0-9a-f]{64}$ \
      && "$full_id" == "$container_id"* && "$running" == true \
      && "$project" == "$compose_project_name" \
      && "$working_dir" == "$repo_real" && "$service_label" == "$service" \
      && -z "${seen_ids[$full_id]+x}" ]] || return 1
    seen_services[$service]=1
    seen_ids[$full_id]=1
    if [[ "$service" == clamav ]]; then
      expected_clamav_id="$full_id"
    else
      printf '%s|%s\n' "$service" "$full_id" >>"$output_file" \
        || return 1
    fi
  done <<<"$listing"
  for captured in "${captured_mutators[@]}"; do
    [[ -n "${seen_services[$captured]+x}" ]] || return 1
  done
  ((clamav_expected_running == 0)) \
    || [[ -n "${seen_services[clamav]+x}" \
      && "$expected_clamav_id" =~ ^[0-9a-f]{64}$ ]] || return 1
  sort -o "$output_file" "$output_file"
}

assert_captured_mutators_stopped() {
  local service expected_id details full_id running project working_dir
  local service_label extra
  while IFS='|' read -r service expected_id extra || [[ -n "${service:-}" ]]; do
    [[ -n "${service:-}" ]] || continue
    [[ -z "${extra:-}" && "$service" =~ ^[a-z0-9-]+$ \
      && "$expected_id" =~ ^[0-9a-f]{64}$ ]] || return 1
    details="$(run_deadline docker inspect --format \
      '{{.Id}}|{{.State.Running}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.service" }}' \
      "$expected_id")" || return 1
    IFS='|' read -r full_id running project working_dir service_label extra \
      <<<"$details"
    [[ -z "${extra:-}" && "$full_id" == "$expected_id" \
      && "$running" == false && "$project" == "$compose_project_name" \
      && "$working_dir" == "$repo_real" && "$service_label" == "$service" ]] \
      || return 1
  done <"$expected_mutator_map"
}

current_postgres_container_id() {
  local bounded="$1" parser_command
  local -a command=(
    docker compose --env-file "$COMPOSE_ENV_FILE" -f "$REPO_ROOT/compose.yaml"
    ps -a --format '{{.Service}} {{.ID}}'
  )
  parser_command='set -Eeuo pipefail
listing="$("$@")"
count=0
container_id=""
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  read -r service candidate extra <<<"$line"
  [[ -z "${extra:-}" && "$service" =~ ^[a-z0-9-]+$ \
    && "$candidate" =~ ^[A-Za-z0-9_.-]+$ ]] || exit 84
  if [[ "$service" == postgres ]]; then
    [[ "$candidate" =~ ^[0-9a-f]{12,64}$ ]] || exit 84
    ((count += 1))
    container_id="$candidate"
  fi
done <<<"$listing"
((count == 1)) || exit 85
printf "%s\n" "$container_id"'
  if [[ "$bounded" == true ]]; then
    run_deadline bash -c "$parser_command" postgres-container "${command[@]}"
  else
    run_fixed_deadline 30 5 \
      bash -c "$parser_command" postgres-container "${command[@]}"
  fi
}

inspect_postgres_state() {
  local container_id="$1" bounded="$2"
  local -a command=(
    docker inspect --format
    '{{.Id}}|{{.State.Running}}|{{.State.Status}}|{{.State.Health.Status}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.service" }}'
    "$container_id"
  )
  if [[ "$bounded" == true ]]; then
    run_deadline "${command[@]}"
  else
    run_fixed_deadline 30 5 "${command[@]}"
  fi
}

validate_postgres_state_details() {
  local details="$1" expected_id="${2:-}" full_id running status health
  local project working_dir service extra
  IFS='|' read -r full_id running status health project working_dir service extra \
    <<<"$details"
  [[ -z "${extra:-}" && "$full_id" =~ ^[0-9a-f]{64}$ \
    && "$running" == true && "$status" == running && "$health" == healthy \
    && "$project" == "$compose_project_name" && "$working_dir" == "$repo_real" \
    && "$service" == postgres ]] || return 1
  [[ -z "$expected_id" || "$full_id" == "$expected_id" ]]
}

capture_expected_postgres() {
  local bounded="${1:-false}" details
  expected_postgres_compose_id="$(current_postgres_container_id "$bounded")" \
    || return 1
  details="$(inspect_postgres_state "$expected_postgres_compose_id" "$bounded")" \
    || return 1
  validate_postgres_state_details "$details" || return 1
  expected_postgres_id="${details%%|*}"
  [[ "$expected_postgres_id" == "$expected_postgres_compose_id"* ]]
}

assert_postgres_continuity() {
  local current_id details
  current_id="$(current_postgres_container_id true)" || return 1
  [[ "$current_id" == "$expected_postgres_compose_id" ]] || return 1
  details="$(inspect_postgres_state "$current_id" true)" || return 1
  validate_postgres_state_details "$details" "$expected_postgres_id"
}

validate_running_services() {
  local output="$1" service allowed candidate captured
  declare -A seen_running=()
  declare -A captured_set=()
  for captured in "${captured_mutators[@]}"; do
    captured_set[$captured]=1
  done
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    [[ "$service" =~ ^[a-z0-9-]+$ && -z "${seen_running[$service]+x}" ]] || return 1
    seen_running[$service]=1
    case "$service" in
      postgres|clamav) ;;
      migrate|lifecycle|platform-seed|admin-bootstrap) return 1 ;;
      *)
        allowed=0
        for candidate in "${BACKUP_MUTATING_SERVICES[@]}"; do
          [[ "$service" != "$candidate" ]] || allowed=1
        done
        ((allowed == 1)) || return 1
        [[ -n "${captured_set[$service]+x}" ]] || return 1
        ;;
    esac
  done <<<"$output"
  for service in "${captured_mutators[@]}"; do
    [[ -n "${seen_running[$service]+x}" ]] || return 1
  done
  [[ -n "${seen_running[postgres]+x}" ]]
}

capture_mutators_from_running_output() {
  local output="$1" allowed running_service
  captured_mutators=()
  for allowed in "${BACKUP_MUTATING_SERVICES[@]}"; do
    while IFS= read -r running_service; do
      if [[ "$running_service" == "$allowed" ]]; then
        captured_mutators+=("$allowed")
        break
      fi
    done <<<"$output"
  done
}

validate_quiesced_running_services() {
  local output="$1" service
  declare -A seen_running=()
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    [[ "$service" =~ ^[a-z0-9-]+$ && -z "${seen_running[$service]+x}" ]] \
      || return 1
    seen_running[$service]=1
    [[ "$service" == postgres || "$service" == clamav ]] || return 1
  done <<<"$output"
  [[ -n "${seen_running[postgres]+x}" \
    && ( "$clamav_expected_running" == 0 \
      || -n "${seen_running[clamav]+x}" ) ]]
}

tar_mtime="${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC"
repo_snapshot="$stage/repository-source"
mkdir -m 0700 -- "$repo_snapshot"
if ! git -C "$repo_real" archive --format=tar "$pre_commit" -- \
  "${REPOSITORY_ARCHIVE_PATHS[@]}" \
  | tar --extract --file=- --directory "$repo_snapshot" \
    --no-same-owner --no-same-permissions; then
  die "reviewed repository snapshot creation failed"
fi
repo_sources=(
  "$repo_snapshot/content" "$repo_snapshot/drizzle" "$repo_snapshot/infra"
  "$repo_snapshot/docs/deployment.md" "$repo_snapshot/docs/runbooks"
  "$repo_snapshot/compose.yaml" "$repo_snapshot/Dockerfile" "$repo_snapshot/.dockerignore"
)
assert_safe_source_tree "${repo_sources[@]}" \
  || die "repository backup source contains an unsafe entry"
log "backup phase=repository-packaging"
if ! canonical_tar "$stage/repository.tar.gz" "$repo_snapshot" "$tar_mtime" \
  --exclude='.git' --exclude='.env' --exclude='.env.*' \
  --exclude='infra/secrets' --exclude='infra/cloudflare/config.yml' \
  --exclude='*.pem' --exclude='*.key' --exclude='*credentials*.json' \
  --exclude='*.eml' --exclude='*.mbox' --exclude='*.pst' --exclude='*.ost' \
  .dockerignore Dockerfile compose.yaml content docs/deployment.md docs/runbooks drizzle infra \
  >/dev/null 2>&1; then
  die "repository packaging failed"
fi
safe_remove_tree "$repo_snapshot" || die "reviewed repository snapshot cleanup failed"

probe_output_dir="$stage/probe-output"
mkdir -m 0700 -- "$probe_output_dir"
if [[ "$(id -u)" == 0 ]]; then
  chown 1000:"$secrets_gid" -- "$probe_output_dir"
fi
log "backup phase=credential-probe"
docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 0.5 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --user 1000:1000 --group-add "$secrets_gid" \
  --mount "type=bind,src=$CREDENTIAL_MASTER_KEY_FILE,dst=/run/secrets/credential_master_key,readonly" \
  --mount "type=bind,src=$probe_output_dir,dst=/output" \
  --entrypoint node "$operations_image" \
  --import tsx /app/scripts/backup/create-credential-probe.ts \
  /output/credential-probe.json /run/secrets/credential_master_key \
  >/dev/null 2>&1
if [[ "$(id -u)" == 0 ]]; then
  [[ -f "$probe_output_dir/credential-probe.json" \
    && ! -L "$probe_output_dir/credential-probe.json" ]] \
    || die "credential probe output is unsafe"
  chown --no-dereference 0:0 -- "$probe_output_dir/credential-probe.json"
  chown 0:0 -- "$probe_output_dir"
fi
require_secure_regular_file "$probe_output_dir/credential-probe.json" 600 "$(id -u)" \
  || die "credential probe output is unsafe"
mv -T -- "$probe_output_dir/credential-probe.json" "$stage/credential-probe.json"
rmdir -- "$probe_output_dir"

pre_images="$stage/images.pre"
post_images="$stage/images.post"
expected_mutator_map="$stage/mutators.expected"
capture_image_map "$pre_images" false || die "active container image inventory is invalid"

if ! age-keygen -o "$identity" >/dev/null 2>&1; then
  die "ephemeral age identity generation failed"
fi
chmod 0600 -- "$identity"
if ! age-keygen -y "$identity" >"$ephemeral_recipient" 2>/dev/null; then
  die "ephemeral age recipient derivation failed"
fi
chmod 0600 -- "$ephemeral_recipient"
cat -- "$AGE_RECIPIENT_FILE" "$ephemeral_recipient" >"$combined_recipients"
chmod 0600 -- "$combined_recipients"

deadline_seconds=$((SECONDS + QUIESCE_BUDGET_SECONDS))
start_event_monitor || die "release-scoped Docker event monitor could not establish continuity"
running_before="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" ps --status running --services)" \
  || die "running service inventory failed"
capture_mutators_from_running_output "$running_before"
validate_running_services "$running_before" \
  || die "a conflicting or unknown Compose service is running"
if grep -Fxq clamav <<<"$running_before"; then
  clamav_expected_running=1
fi
capture_expected_postgres true \
  || die "PostgreSQL is not running healthy with stable release identity"
capture_mutator_container_map "$expected_mutator_map" \
  || die "running mutator container identity capture failed"
audit_event_monitor active \
  || die "release-scoped Docker event continuity failed during identity capture"
quiesce_started=1
deadline_log() {
  local message="$*"
  run_deadline bash -c \
    'printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2' \
    _ "$message"
}
die() {
  printf 'fatal: quiesced backup transaction failed: %s\n' "$*" >&2
  exit 1
}
phase=quiescing
deadline_log "backup phase=quiescing" || die
emit_event_monitor_sentinel quiesce-open \
  || die "release-scoped Docker event monitor could not open quiesce"
quiesce_event_phase=1
quiesce_command='set -Eeuo pipefail; source "$1"; config="$2"; shift 2; BACKUP_CONFIG_FILE="$config"; load_backup_config; captured_for_child=("$@"); quiesce_mutators captured_for_child'
run_deadline bash -c "$quiesce_command" _ "$SCRIPT_DIR/common.sh" \
  "${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" "${captured_mutators[@]}"
emit_event_monitor_sentinel quiesce-close \
  || die "release-scoped Docker event monitor could not close quiesce"
quiesce_event_phase=2
audit_event_monitor active \
  || die "captured mutator stop lifecycle failed closed"
assert_captured_mutators_stopped \
  || die "captured mutator container remained running after quiesce"
phase=quiesced
deadline_log "backup phase=quiesced" || die

running_after="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" ps --status running --services)" \
  || die "post-quiesce service confirmation failed"
validate_quiesced_running_services "$running_after" \
  || die "PostgreSQL continuity or post-quiesce service state failed"
assert_postgres_continuity \
  || die "PostgreSQL identity or health changed after quiesce"

snapshot_timestamp="$(run_deadline date -u +%Y%m%dT%H%M%SZ)" \
  || die "snapshot timestamp failed"
database_version="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" exec -T postgres postgres --version)" \
  || die "PostgreSQL version query failed"
database_version="${database_version//$'\r'/}"
database_version="${database_version//$'\n'/}"
[[ "$database_version" =~ ^postgres[[:space:]]+\(PostgreSQL\)[[:space:]]+17([.][0-9]+)?([[:space:]][A-Za-z0-9._+\(\)/:=-]+)*$ ]] \
  || die "PostgreSQL version is outside the reviewed major"
assert_postgres_continuity \
  || die "PostgreSQL identity or health changed after version query"

migration_rows="$stage/migrations.rows"
redirect_command='output="$1"; shift; exec "$@" >"$output"'
migration_parser_script='import hashlib
import re
import sys

if len(sys.argv) != 3 or sys.argv[1] != "migration-row-parser":
    raise SystemExit(80)

row_path = sys.argv[2]
count = 0
last_id = "0"
last_created_at = "0"
state_hash = hashlib.sha256()
integer_pattern = re.compile(rb"[0-9]{1,20}")
hash_pattern = re.compile(rb"[0-9a-f]{64}")

with open(row_path, "rb") as rows:
    for raw_row in rows:
        state_hash.update(raw_row)
        row = raw_row[:-1] if raw_row.endswith(b"\n") else raw_row
        if not row:
            continue
        fields = row.split(b"|")
        if len(fields) != 3:
            raise SystemExit(81)
        migration_id, migration_hash, created_at = fields
        if (
            integer_pattern.fullmatch(migration_id) is None
            or hash_pattern.fullmatch(migration_hash) is None
            or integer_pattern.fullmatch(created_at) is None
        ):
            raise SystemExit(81)
        count += 1
        if count > 100_000:
            raise SystemExit(82)
        last_id = migration_id.decode("ascii")
        last_created_at = created_at.decode("ascii")

sys.stdout.write(
    f"{count}|{last_id}|{last_created_at}|{state_hash.hexdigest()}\n"
)'
migration_summary_command='set -Eeuo pipefail
rows="$1"
parser="$2"
shift 2
trap '\''rm -f -- "$rows"'\'' EXIT
"$@" >"$rows"
python3 -c "$parser" migration-row-parser "$rows"'
migration_summary="$(run_deadline bash -c "$migration_summary_command" \
  migration-summary "$migration_rows" "$migration_parser_script" \
  docker compose --env-file "$COMPOSE_ENV_FILE" \
    -f "$REPO_ROOT/compose.yaml" exec -T postgres sh -ceu \
    'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --quiet --tuples-only --no-align --field-separator="|" --set=ON_ERROR_STOP=1 --command="SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id"')" \
  || die "migration state query or validation failed"
IFS='|' read -r migration_count migration_last_id migration_last_created_at \
  migration_state_sha256 migration_extra <<<"$migration_summary"
[[ -z "${migration_extra:-}" \
  && "$migration_count" =~ ^[0-9]{1,6}$ \
  && "$migration_count" -le 100000 \
  && "$migration_last_id" =~ ^[0-9]{1,20}$ \
  && "$migration_last_created_at" =~ ^[0-9]{1,20}$ \
  && "$migration_state_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "migration state summary was invalid"
unset migration_summary
assert_postgres_continuity \
  || die "PostgreSQL identity or health changed after migration query"

deadline_log "backup phase=dumping" || die
run_deadline bash -c "$redirect_command" _ "$stage/database.dump" \
  docker compose --env-file "$COMPOSE_ENV_FILE" \
    -f "$REPO_ROOT/compose.yaml" exec -T postgres sh -ceu \
    'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl'
[[ -s "$stage/database.dump" ]] || die "PostgreSQL dump is empty"
assert_postgres_continuity \
  || die "PostgreSQL identity or health changed after logical dump"
phase=dump_complete
deadline_log "backup phase=dump_complete" || die

app_data_included=false
if [[ -e "$LEARN_DATA_ROOT/app-data" || -L "$LEARN_DATA_ROOT/app-data" ]]; then
  [[ -d "$LEARN_DATA_ROOT/app-data" && ! -L "$LEARN_DATA_ROOT/app-data" ]] \
    || die "application data root is unsafe"
  credential_inode_match="$(run_deadline find -P "$LEARN_DATA_ROOT/app-data" \
    -type f -samefile "$CREDENTIAL_MASTER_KEY_FILE" -print -quit)" \
    || die "application data credential-key identity scan failed"
  if [[ -n "$credential_inode_match" ]]; then
    die "application data contains the credential master key inode"
  fi
  unsafe_app_entry="$(run_deadline find -P "$LEARN_DATA_ROOT/app-data" \
    -mindepth 1 ! -type f ! -type d -print -quit)" \
    || die "application data safety scan failed"
  [[ -z "$unsafe_app_entry" ]] || die "application data contains an unsafe entry"
  run_deadline tar --sort=name --format=posix \
    --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner --mode='a-s,a-t,u+rwX,go+rX,go-w' \
    --mtime="$tar_mtime" --use-compress-program='gzip -n' \
    --exclude='.env' --exclude='.env.*' --exclude='*.pem' --exclude='*.key' \
    --exclude='*credentials*.json' --exclude='*.eml' --exclude='*.mbox' \
    --exclude='*.pst' --exclude='*.ost' --exclude='*/mail/*' --exclude='*/email/*' \
    --exclude='*mail-backup*' --create --file "$stage/app-data.tar.gz" \
    --directory "$LEARN_DATA_ROOT" app-data >/dev/null 2>&1
  app_data_included=true
fi
phase=objects_complete
deadline_log "backup phase=objects_complete" || die

audit_event_monitor active \
  || die "release-scoped Docker event continuity failed during recovery-point capture"

running_after_objects="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" ps --status running --services)" \
  || die "post-capture service confirmation failed"
validate_quiesced_running_services "$running_after_objects" \
  || die "PostgreSQL continuity or post-capture service state failed"
assert_postgres_continuity \
  || die "PostgreSQL identity or health changed during recovery-point capture"

post_commit="$(run_deadline git -C "$repo_real" rev-parse --verify HEAD)" \
  || die "installed release commit recheck failed"
[[ "$post_commit" == "$pre_commit" ]] || die "installed release changed during backup"
require_clean_release true || die "installed release worktree changed during backup"
capture_image_map "$post_images" true || die "container image inventory recheck failed"
run_deadline cmp -s -- "$pre_images" "$post_images" \
  || die "container image inventory changed during backup"

manifest_command='set -Eeuo pipefail
output="$1"
images="$2"
shift 2
printf "%s\n" \
  "format=learncoding-backup-v1" \
  "created_utc=$1" \
  "snapshot_utc=$2" \
  "source_host=$3" \
  "git_commit=$4" \
  "database_version=$5" \
  "migration_count=$6" \
  "migration_last_id=$7" \
  "migration_last_created_at=$8" \
  "migration_state_sha256=$9" \
  "app_data_included=${10}" \
  "contains_secret_files=false" \
  "contains_email_exports=false" >"$output"
while IFS="=" read -r image_service image_id; do
  printf "image_id.%s=%s\n" "$image_service" "$image_id" >>"$output"
done <"$images"'
run_deadline bash -c "$manifest_command" _ \
  "$stage/MANIFEST.txt" "$pre_images" "$timestamp" "$snapshot_timestamp" \
  "$source_host" "$pre_commit" "$database_version" "$migration_count" \
  "$migration_last_id" "$migration_last_created_at" "$migration_state_sha256" \
  "$app_data_included"

checksum_command='set -Eeuo pipefail; cd "$1"; if [[ "$2" == true ]]; then sha256sum --text database.dump repository.tar.gz app-data.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS; else sha256sum --text database.dump repository.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS; fi'
run_deadline bash -c "$checksum_command" _ "$stage" "$app_data_included"

outer_members=(MANIFEST.txt SHA256SUMS)
[[ "$app_data_included" != true ]] || outer_members+=(app-data.tar.gz)
outer_members+=(credential-probe.json database.dump repository.tar.gz)
run_deadline tar --sort=name --format=posix \
  --pax-option=delete=atime,delete=ctime \
  --owner=0 --group=0 --numeric-owner --mode='u=rw,go=' --mtime="$tar_mtime" \
  --use-compress-program='gzip -n' --create --file "$outer_plain" \
  --directory "$stage" "${outer_members[@]}"

tmp_archive="$(run_deadline mktemp -- "$full_dir/.${filename}.tmp.XXXXXX")" \
  || die "ciphertext temporary creation failed"
run_deadline rm -f -- "$tmp_archive" || die "ciphertext temporary preparation failed"
run_deadline age --encrypt --recipients-file "$combined_recipients" \
  --output "$tmp_archive" "$outer_plain" >/dev/null 2>&1
[[ -f "$tmp_archive" && ! -L "$tmp_archive" && -s "$tmp_archive" ]] \
  || die "encrypted candidate is empty"
run_deadline chmod 0600 -- "$tmp_archive" || die "encrypted candidate mode failed"
phase=encrypted
deadline_log "backup phase=encrypted" || die

verify_result="$(run_deadline bash "$SCRIPT_DIR/verify-archive.sh" \
  "$tmp_archive" "$identity" "$verify_dir")" \
  || die "candidate decrypt verification failed"
[[ "$verify_result" == archive_valid=true ]] \
  || die "candidate verifier returned an invalid acknowledgement"
phase=candidate_verified
deadline_log "backup phase=candidate_verified" || die

run_deadline sync -f -- "$tmp_archive"
ciphertext_hash="$(run_deadline sha256sum "$tmp_archive")" \
  || die "ciphertext checksum creation failed"
ciphertext_hash="${ciphertext_hash%% *}"
[[ "$ciphertext_hash" =~ ^[0-9a-f]{64}$ ]] || die "ciphertext checksum is invalid"
tmp_checksum="$(run_deadline mktemp -- "$full_dir/.${filename}.sha256.tmp.XXXXXX")" \
  || die "ciphertext sidecar temporary creation failed"
sidecar_command='printf "%s  %s\n" "$2" "$3" >"$1"; chmod 0600 -- "$1"'
run_deadline bash -c "$sidecar_command" _ \
  "$tmp_checksum" "$ciphertext_hash" "$filename" \
  || die "ciphertext sidecar creation failed"
run_deadline sync -f -- "$tmp_checksum"

run_deadline mv -T -- "$tmp_archive" "$final_archive"
tmp_archive=""
run_deadline mv -T -- "$tmp_checksum" "$final_checksum"
tmp_checksum=""
metadata_command='source "$1"; require_secure_regular_file "$2" 600 "$(id -u)"'
run_deadline bash -c "$metadata_command" _ "$SCRIPT_DIR/common.sh" "$final_archive" \
  || die "published archive metadata is unsafe"
run_deadline bash -c "$metadata_command" _ "$SCRIPT_DIR/common.sh" "$final_checksum" \
  || die "published checksum metadata is unsafe"
published_sidecar="$(run_deadline cat -- "$final_checksum")" \
  || die "published checksum could not be read"
[[ "$published_sidecar" == "$ciphertext_hash  $filename" ]] \
  || die "published checksum content is invalid"
final_hash="$(run_deadline sha256sum "$final_archive")" \
  || die "published archive checksum failed"
final_hash="${final_hash%% *}"
[[ "$final_hash" == "$ciphertext_hash" ]] || die "published archive hash changed"
run_deadline sync -f -- "$full_dir"
phase=files_published
deadline_log "backup phase=files_published" || die
audit_event_monitor active \
  || die "release-scoped Docker event continuity failed before marker publication"
running_before_marker="$(run_deadline docker compose --env-file "$COMPOSE_ENV_FILE" \
  -f "$REPO_ROOT/compose.yaml" ps --status running --services)" \
  || die "pre-marker service confirmation failed"
validate_quiesced_running_services "$running_before_marker" \
  || die "PostgreSQL or ClamAV running-state continuity failed before marker publication"
assert_postgres_continuity \
  || die "PostgreSQL identity or health changed before marker publication"

completed_utc="$(run_deadline date -u +%Y%m%dT%H%M%SZ)" \
  || die "completion timestamp failed"
marker_command='set -Eeuo pipefail; source "$1"; write_success_marker "$2" "$3" "$4" "$5"'
publication_commit_uncertain=1
marker_validation_pending=1
if ! run_deadline bash -c "$marker_command" _ "$SCRIPT_DIR/common.sh" \
  "$marker" "$filename" "$completed_utc" "$ciphertext_hash"; then
  die "success marker durability failed"
fi
marker_published=1
close_event_monitor \
  || die "release-scoped Docker event continuity failed after marker durability"
marker_validation_pending=0
marker_committed=1
publication_commit_uncertain=0
phase=marker_committed
deadline_log "backup phase=marker_committed" || die

deadline_log "backup phase=pruning" || die
run_deadline env BACKUP_LOCK_HELD=1 \
  BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/learncoding/backup.env}" \
  bash "$SCRIPT_DIR/prune.sh"

resume_captured
if ! enqueue_backup_status success "$timestamp"; then
  emit_alert warning backup_report_not_queued \
    "backup success status could not be queued; inspect protected operations logs"
fi
emit_alert info backup_complete \
  "nightly encrypted backup completed and passed decrypt verification"
log "backup phase=complete"
