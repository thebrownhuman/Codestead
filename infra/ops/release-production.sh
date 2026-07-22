#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: release-production.sh [--bootstrap-admin] [--acquire-images] [--schema-backward-compatible] [--lock-timeout SECONDS] [--stage-timeout SECONDS] [--startup-wait SECONDS]

Runs the explicit Codestead production release transaction. The optional
administrator bootstrap is never run unless --bootstrap-admin is supplied;
its temporary password remains a Compose file-backed secret.
Image acquisition is opt-in and pulls only the canonical digest references in
the reviewed Compose configuration. A prior runtime may be restored after a
failed candidate only with the explicit --schema-backward-compatible assertion.


--test-harness-root is reserved for the standalone adversarial test. It
confines every configurable path and fake binary to one private directory.
EOF
}

bootstrap_admin=false
acquire_images=false
schema_backward_compatible=false
lock_timeout=30
stage_timeout=900
startup_wait=600
test_harness_root=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --bootstrap-admin)
      bootstrap_admin=true
      shift
      ;;
    --acquire-images)
      acquire_images=true
      shift
      ;;
    --schema-backward-compatible)
      schema_backward_compatible=true
      shift
      ;;
    --lock-timeout)
      [[ "$#" -ge 2 ]] || fatal "--lock-timeout requires a positive integer"
      lock_timeout="$2"
      shift 2
      ;;
    --stage-timeout)
      [[ "$#" -ge 2 ]] || fatal "--stage-timeout requires a positive integer"
      stage_timeout="$2"
      shift 2
      ;;
    --startup-wait)
      [[ "$#" -ge 2 ]] || fatal "--startup-wait requires a positive integer"
      startup_wait="$2"
      shift 2
      ;;
    --test-harness-root)
      [[ "$#" -ge 2 ]] || fatal "--test-harness-root requires an absolute path"
      test_harness_root="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      fatal "unknown argument: $1"
      ;;
  esac
done

positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

positive_integer "$lock_timeout" || fatal "--lock-timeout requires a positive integer"
positive_integer "$stage_timeout" || fatal "--stage-timeout requires a positive integer"
positive_integer "$startup_wait" || fatal "--startup-wait requires a positive integer"
(( lock_timeout <= 300 )) || fatal "--lock-timeout may not exceed 300 seconds"
(( stage_timeout <= 1800 )) || fatal "--stage-timeout may not exceed 1800 seconds"
(( startup_wait <= 1200 )) || fatal "--startup-wait may not exceed 1200 seconds"
(( stage_timeout >= startup_wait )) || fatal "--stage-timeout must be at least --startup-wait"

[[ ! ${RELEASE_GIT_COMMIT+x} ]] || {
  fatal "RELEASE_GIT_COMMIT is forbidden; release evidence is derived from the verified checkout"
}

readonly -a forbidden_client_environment=(
  DOCKER_HOST
  DOCKER_CONTEXT
  DOCKER_CONFIG
  DOCKER_CERT_PATH
  DOCKER_TLS
  DOCKER_TLS_VERIFY
  DOCKER_API_VERSION
  DOCKER_DEFAULT_PLATFORM
  DOCKER_CUSTOM_HEADERS
  COMPOSE_FILE
  COMPOSE_PATH_SEPARATOR
  COMPOSE_PROJECT_NAME
  COMPOSE_PROFILES
  COMPOSE_ENV_FILES
  COMPOSE_DISABLE_ENV_FILE
  COMPOSE_CONVERT_WINDOWS_PATHS
  COMPOSE_IGNORE_ORPHANS
  COMPOSE_REMOVE_ORPHANS
  COMPOSE_PARALLEL_LIMIT
  COMPOSE_EXPERIMENTAL
  COMPOSE_BAKE
  COMPOSE_PROVIDER
)
for authority_variable in "${forbidden_client_environment[@]}"; do
  [[ ! -v "$authority_variable" ]] || {
    fatal "$authority_variable is forbidden; production Docker and Compose authority is fixed by this transaction"
  }
done
unset authority_variable

# Root releases never resolve commands through an inherited PATH. The explicit
# test harness may replace only Docker and sync, and only inside its private root.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly cat_bin=/usr/bin/cat
readonly chmod_bin=/usr/bin/chmod
readonly date_bin=/usr/bin/date
readonly env_bin=/usr/bin/env
readonly system_flock_bin=/usr/bin/flock
readonly git_bin=/usr/bin/git
readonly install_bin=/usr/bin/install
readonly mv_bin=/usr/bin/mv
readonly realpath_bin=/usr/bin/realpath
readonly rm_bin=/usr/bin/rm
readonly sha256sum_bin=/usr/bin/sha256sum
readonly node_bin=/usr/bin/node
readonly python_bin=/usr/bin/python3.12
readonly sort_bin=/usr/bin/sort
readonly stat_bin=/usr/bin/stat
readonly timeout_bin=/usr/bin/timeout

for trusted_command in \
  "$cat_bin" "$chmod_bin" "$date_bin" "$env_bin" "$system_flock_bin" "$git_bin" \
  "$install_bin" "$mv_bin" "$node_bin" "$python_bin" "$realpath_bin" "$rm_bin" "$sha256sum_bin" "$sort_bin" "$stat_bin" "$timeout_bin"; do
  [[ -f "$trusted_command" && -x "$trusted_command" && ! -L "$trusted_command" ]] || {
    fatal "required trusted command is unavailable: $trusted_command"
  }
done

path_identity() {
  "$stat_bin" -Lc '%u:%g:%a' -- "$1"
}

mode_value() {
  local mode="$1"
  printf '%d\n' "$((8#$mode))"
}

lock_object_identity() {
  "$stat_bin" -Lc '%u:%g:%a:%h:%d:%i' -- "$1"
}

assert_lock_object_identity() {
  local identity="$1" label="$2" expected_uid="$3" expected_gid="$4"
  local uid gid mode links device inode extra
  IFS=: read -r uid gid mode links device inode extra <<<"$identity"
  [[ -z "$extra" && "$uid" == "$expected_uid" && "$gid" == "$expected_gid" ]] || {
    fatal "$label has an untrusted owner or malformed identity"
  }
  [[ "$mode" == 600 ]] || fatal "$label must have mode 0600"
  [[ "$links" == 1 ]] || fatal "$label must have exactly one hard link"
  [[ "$device" =~ ^[0-9]+$ && "$inode" =~ ^[0-9]+$ ]] || {
    fatal "$label has a malformed device or inode identity"
  }
}

assert_private_harness() {
  local path="$1" resolved lexical identity uid _gid mode
  [[ "$path" == /* ]] || fatal "--test-harness-root must be absolute"
  [[ -d "$path" && ! -L "$path" ]] || fatal "test harness root must be a real directory"
  resolved="$($realpath_bin -e -- "$path")"
  lexical="$($realpath_bin -sm -- "$path")"
  [[ "$resolved" == "$lexical" ]] || fatal "test harness root must not contain symlink components"
  identity="$(path_identity "$resolved")"
  IFS=: read -r uid _gid mode <<<"$identity"
  [[ "$uid" == "$EUID" && "$mode" == 700 ]] || {
    fatal "test harness root must be caller-owned with mode 0700"
  }
  printf '%s\n' "$resolved"
}

if [[ -n "$test_harness_root" ]]; then
  test_harness_root="$(assert_private_harness "$test_harness_root")"
  readonly docker_bin="$test_harness_root/bin/docker"
  readonly sync_bin="$test_harness_root/bin/sync"
  readonly flock_bin="$test_harness_root/bin/flock"
else
  (( EUID == 0 )) || fatal "production releases must run as root"
  readonly docker_bin=/usr/bin/docker
  readonly sync_bin=/usr/bin/sync
  readonly flock_bin="$system_flock_bin"
fi
readonly test_harness_root

for selected_command in "$docker_bin" "$sync_bin" "$flock_bin"; do
  [[ -f "$selected_command" && -x "$selected_command" && ! -L "$selected_command" ]] || {
    fatal "required release command is unavailable: $selected_command"
  }
  if [[ -n "$test_harness_root" ]]; then
    selected_resolved="$($realpath_bin -m -- "$selected_command")"
    selected_lexical="$($realpath_bin -sm -- "$selected_command")"
    [[ "$selected_resolved" == "$selected_lexical" ]] || {
      fatal "test release command contains a symlink component: $selected_command"
    }
    case "$selected_lexical" in
      "$test_harness_root"/*) ;;
      *) fatal "test release command escapes the explicit harness: $selected_command" ;;
    esac
  fi
done

readonly -a docker_cli=(
  "$docker_bin" --host unix:///var/run/docker.sock
)

timeout_version="$($timeout_bin --version 2>/dev/null || true)"
[[ "$timeout_version" == *"GNU coreutils"* ]] || fatal "GNU timeout is required"

readonly repo_root="${REPO_ROOT:-/opt/learncoding}"
readonly compose_env="${COMPOSE_ENV_FILE:-/etc/learncoding/compose.env}"
readonly compose_file="${COMPOSE_FILE_PATH:-$repo_root/compose.yaml}"
if [[ -n "$test_harness_root" ]]; then
  readonly release_lock_file="${RELEASE_LOCK_FILE:-$test_harness_root/run/codestead-release.lock}"
else
  [[ -z "${RELEASE_LOCK_FILE+x}" ]] || fatal "RELEASE_LOCK_FILE is forbidden in production"
  readonly release_lock_file=/run/lock/codestead-release.lock
fi
readonly release_record_root="${RELEASE_RECORD_ROOT:-/var/lib/learncoding/releases}"
readonly validate_runtime_script="${VALIDATE_RUNTIME_SCRIPT:-$repo_root/infra/ops/validate-runtime.sh}"
readonly smoke_production_script="${SMOKE_PRODUCTION_SCRIPT:-$repo_root/infra/ops/smoke-production.sh}"
readonly prepare_postgres_script="${PREPARE_POSTGRES_SCRIPT:-$repo_root/infra/ops/prepare-postgres-control-socket.sh}"
readonly prepare_object_script="${PREPARE_OBJECT_SCRIPT:-$repo_root/infra/ops/prepare-object-storage.mjs}"
readonly runtime_state_root="${RUNTIME_STATE_ROOT:-/etc/learncoding}"
readonly release_tree_packager="$repo_root/infra/ops/package-release-tree.py"
if [[ -n "$test_harness_root" ]]; then
  readonly ingress_control_script="$test_harness_root/repo/infra/ops/ingress-control.py"
  readonly -a ingress_control=("$python_bin" "$ingress_control_script" --test-harness-root "$test_harness_root")
else
  readonly ingress_control_script=/opt/learncoding/infra/ops/ingress-control.py
  readonly -a ingress_control=(/usr/bin/python3.12 /opt/learncoding/infra/ops/ingress-control.py)
fi
readonly release_manifest="$repo_root/RELEASE.SHA256SUMS"
readonly application_image_record_json="$repo_root/dist/application-images/application-images.json"
readonly application_image_record_env="$repo_root/dist/application-images/application-images.env"
readonly firewall_policy="$repo_root/infra/runner-vm/host-runner.nft"
readonly runner_runtime_record_json="$repo_root/services/runner/dist/runtime-images.json"
readonly runner_runtime_record="$repo_root/services/runner/dist/runtime-images.env"
readonly active_release_state="$runtime_state_root/active-release.env"

assert_safe_path() {
  local path="$1" label="$2" resolved lexical
  [[ "$path" == /* ]] || fatal "$label must be absolute"
  resolved="$($realpath_bin -m -- "$path")"
  lexical="$($realpath_bin -sm -- "$path")"
  [[ "$resolved" == "$lexical" ]] || fatal "$label contains a symlink component: $path"
  if [[ -n "$test_harness_root" ]]; then
    case "$lexical" in
      "$test_harness_root"|"$test_harness_root"/*) ;;
      *) fatal "$label escapes the explicit test harness: $path" ;;
    esac
  fi
}

assert_root_owned_not_writable() {
  local path="$1" label="$2" identity uid gid mode numeric
  identity="$(path_identity "$path")"
  IFS=: read -r uid gid mode <<<"$identity"
  [[ "$uid" == 0 && "$gid" == 0 ]] || fatal "$label must be owned by root:root"
  numeric="$(mode_value "$mode")"
  (( (numeric & 0022) == 0 )) || fatal "$label must not be group- or world-writable"
}

assert_root_owned_no_world_write() {
  local path="$1" label="$2" identity uid gid mode numeric
  identity="$(path_identity "$path")"
  IFS=: read -r uid gid mode <<<"$identity"
  [[ "$uid" == 0 && "$gid" == 0 ]] || fatal "$label must be owned by root:root"
  numeric="$(mode_value "$mode")"
  (( (numeric & 0002) == 0 )) || fatal "$label must not be world-writable"
}

for path_and_label in \
  "$repo_root|repository root" \
  "$compose_env|Compose environment" \
  "$compose_file|Compose file" \
  "$release_lock_file|release lock file" \
  "$release_record_root|release record root" \
  "$validate_runtime_script|runtime validator" \
  "$smoke_production_script|production smoke" \
  "$prepare_postgres_script|PostgreSQL storage preparer" \
  "$prepare_object_script|object storage preparer" \
  "$release_tree_packager|release tree packager" \
  "$ingress_control_script|ingress control helper" \
  "$runtime_state_root|runtime state root" \
  "$application_image_record_json|application image JSON record" \
  "$application_image_record_env|application image environment record" \
  "$release_manifest|release manifest" \
  "$firewall_policy|host firewall policy" \
  "$runner_runtime_record_json|runner runtime JSON record" \
  "$runner_runtime_record|runner runtime record" \
  "$active_release_state|active release state"; do
  assert_safe_path "${path_and_label%%|*}" "${path_and_label#*|}"
done

[[ -d "$repo_root" && ! -L "$repo_root" ]] || fatal "repository root must be a real directory: $repo_root"
[[ -f "$compose_env" && ! -L "$compose_env" ]] || fatal "Compose environment must be a regular non-symlink file: $compose_env"
[[ -f "$compose_file" && ! -L "$compose_file" ]] || fatal "Compose file must be a regular non-symlink file: $compose_file"
[[ -f "$validate_runtime_script" && -x "$validate_runtime_script" && ! -L "$validate_runtime_script" ]] || {
  fatal "runtime validator must be an executable non-symlink file: $validate_runtime_script"
}
[[ -f "$smoke_production_script" && -x "$smoke_production_script" && ! -L "$smoke_production_script" ]] || {
  fatal "production smoke must be an executable non-symlink file: $smoke_production_script"
}
[[ -f "$prepare_postgres_script" && -x "$prepare_postgres_script" && ! -L "$prepare_postgres_script" ]] || {
  fatal "PostgreSQL storage preparer must be an executable non-symlink file: $prepare_postgres_script"
}
[[ -f "$prepare_object_script" && ! -L "$prepare_object_script" ]] || {
  fatal "object storage preparer must be a regular non-symlink file: $prepare_object_script"
}
[[ -f "$release_tree_packager" && -x "$release_tree_packager" && ! -L "$release_tree_packager" ]] || {
  fatal "release tree packager must be an executable non-symlink file: $release_tree_packager"
}
[[ -f "$ingress_control_script" && -x "$ingress_control_script" && ! -L "$ingress_control_script" ]] || {
  fatal "ingress control helper must be an executable non-symlink file: $ingress_control_script"
}
[[ -d "$runtime_state_root" && ! -L "$runtime_state_root" ]] || {
  fatal "runtime state root must be a pre-created real directory: $runtime_state_root"
}
for identity_source in "$application_image_record_json" "$application_image_record_env" \
  "$release_manifest" "$firewall_policy" "$runner_runtime_record_json" "$runner_runtime_record"; do
  [[ -f "$identity_source" && ! -L "$identity_source" ]] || fatal "runtime identity source is missing or unsafe: $identity_source"
done

lock_parent="${release_lock_file%/*}"
[[ -n "$lock_parent" ]] || lock_parent=/
record_parent="${release_record_root%/*}"
[[ -n "$record_parent" ]] || record_parent=/
assert_safe_path "$lock_parent" "release lock directory"
assert_safe_path "$record_parent" "release record parent"
[[ -d "$lock_parent" && ! -L "$lock_parent" ]] || fatal "release lock directory must be a real directory: $lock_parent"
[[ -d "$record_parent" && ! -L "$record_parent" ]] || fatal "release record parent must be a real directory: $record_parent"
[[ -d "$release_record_root" && ! -L "$release_record_root" ]] || {
  fatal "release record root must be pre-created as a real directory: $release_record_root"
}

if [[ -z "$test_harness_root" ]]; then
  assert_root_owned_not_writable "$repo_root" "repository root"
  assert_root_owned_not_writable "$compose_env" "Compose environment"
  assert_root_owned_not_writable "$compose_file" "Compose file"
  assert_root_owned_not_writable "$validate_runtime_script" "runtime validator"
  assert_root_owned_not_writable "$smoke_production_script" "production smoke"
  assert_root_owned_not_writable "$prepare_postgres_script" "PostgreSQL storage preparer"
  assert_root_owned_not_writable "$prepare_object_script" "object storage preparer"
  assert_root_owned_not_writable "$release_tree_packager" "release tree packager"
  assert_root_owned_not_writable "$ingress_control_script" "ingress control helper"
  assert_root_owned_not_writable "$application_image_record_json" "application image JSON record"
  assert_root_owned_not_writable "$application_image_record_env" "application image environment record"
  assert_root_owned_not_writable "$release_manifest" "release manifest"
  assert_root_owned_not_writable "$firewall_policy" "host firewall policy"
  assert_root_owned_not_writable "$runner_runtime_record_json" "runner runtime JSON record"
  assert_root_owned_not_writable "$runner_runtime_record" "runner runtime record"
  assert_root_owned_not_writable "$docker_bin" "Docker client"
  if [[ "$lock_parent" == /run/lock ]]; then
    [[ "$(path_identity "$lock_parent")" == 0:0:1777 ]] || fatal "/run/lock must be exactly root:root mode 1777"
  else
    assert_root_owned_no_world_write "$lock_parent" "release lock directory"
  fi
  assert_root_owned_not_writable "$record_parent" "release record parent"
  assert_root_owned_not_writable "$release_record_root" "release record root"
  assert_root_owned_not_writable "$runtime_state_root" "runtime state root"
  [[ "$(path_identity "$release_record_root")" == 0:0:700 ]] || {
    fatal "release record root must be owned by root:root with mode 0700"
  }
else
  record_identity="$(path_identity "$release_record_root")"
  IFS=: read -r record_uid _record_gid record_mode <<<"$record_identity"
  [[ "$record_uid" == "$EUID" && "$record_mode" == 700 ]] || {
    fatal "test release record root must be caller-owned with mode 0700"
  }
  runtime_state_identity="$(path_identity "$runtime_state_root")"
  IFS=: read -r runtime_state_uid _runtime_state_gid runtime_state_mode <<<"$runtime_state_identity"
  [[ "$runtime_state_uid" == "$EUID" && "$runtime_state_mode" == 750 ]] || {
    fatal "test runtime state root must be caller-owned with mode 0750"
  }
fi

[[ -f "$release_lock_file" && ! -L "$release_lock_file" ]] || {
  fatal "release lock must be a pre-provisioned regular non-symlink file"
}
lock_identity_before_open="$(lock_object_identity "$release_lock_file")"
if [[ -z "$test_harness_root" ]]; then
  expected_lock_uid=0
  expected_lock_gid=0
else
  expected_lock_uid="$EUID"
  expected_lock_gid="$($stat_bin -Lc '%g' -- "$test_harness_root")"
fi
assert_lock_object_identity "$lock_identity_before_open" "release lock" \
  "$expected_lock_uid" "$expected_lock_gid"

exec 9<"$release_lock_file"
lock_fd_path="/proc/$$/fd/9"
[[ -f "$release_lock_file" && ! -L "$release_lock_file" ]] || {
  fatal "release lock path changed during open"
}
lock_path_after_open="$(lock_object_identity "$release_lock_file")"
lock_fd_after_open="$(lock_object_identity "$lock_fd_path")"
assert_lock_object_identity "$lock_path_after_open" "release lock path after open" \
  "$expected_lock_uid" "$expected_lock_gid"
assert_lock_object_identity "$lock_fd_after_open" "release lock descriptor after open" \
  "$expected_lock_uid" "$expected_lock_gid"
[[ "$lock_path_after_open" == "$lock_fd_after_open" ]] || fatal "release lock path and descriptor split during open"
if [[ -n "$lock_identity_before_open" ]]; then
  [[ "$lock_identity_before_open" == "$lock_path_after_open" ]] || fatal "release lock identity changed during open"
fi
"$flock_bin" --exclusive --wait "$lock_timeout" 9 || fatal "another production release holds the host lock"
[[ -f "$release_lock_file" && ! -L "$release_lock_file" ]] || {
  fatal "release lock path changed while acquiring the lock"
}
lock_path_after_flock="$(lock_object_identity "$release_lock_file")"
lock_fd_after_flock="$(lock_object_identity "$lock_fd_path")"
assert_lock_object_identity "$lock_path_after_flock" "release lock path after flock" \
  "$expected_lock_uid" "$expected_lock_gid"
assert_lock_object_identity "$lock_fd_after_flock" "release lock descriptor after flock" \
  "$expected_lock_uid" "$expected_lock_gid"
[[ "$lock_path_after_flock" == "$lock_fd_after_flock" \
  && "$lock_path_after_flock" == "$lock_path_after_open" \
  && "$lock_fd_after_flock" == "$lock_fd_after_open" ]] || {
  fatal "release lock path and descriptor split while acquiring the lock"
}
run_ingress_control() {
  "$timeout_bin" --signal=TERM --kill-after=10s "${stage_timeout}s" "${ingress_control[@]}" "$@"
}
quarantine_tunnel_early() {
  "$timeout_bin" --signal=TERM --kill-after=10s "${stage_timeout}s" \
    "${docker_cli[@]}" compose --project-name learncoding --env-file "$compose_env" -f "$compose_file" \
    stop --timeout 30 cloudflared
}
release_completed=false
release_quarantine_active=false
on_early_exit() {
  local exit_code="$?"
  trap '' HUP INT TERM
  trap - EXIT
  if [[ "$release_completed" != true ]]; then
    run_ingress_control quarantine-create || true
    quarantine_tunnel_early || quarantine_tunnel_early || true
  fi
  exit "$exit_code"
}
trap on_early_exit EXIT
trap 'trap "" HUP INT TERM; exit 129' HUP
trap 'trap "" HUP INT TERM; exit 130' INT
trap 'trap "" HUP INT TERM; exit 143' TERM

run_ingress_control quarantine-create || fatal "unable to create durable release quarantine"
release_quarantine_active=true
quarantine_tunnel_early || quarantine_tunnel_early || {
  fatal "unable to stop public ingress after durable release quarantine"
}

release_id="$($date_bin -u +'%Y%m%dT%H%M%SZ')-$$"
readonly release_id
record_dir="$release_record_root/$release_id"
assert_safe_path "$record_dir" "release record directory"
[[ ! -e "$record_dir" ]] || fatal "release record already exists: $record_dir"
"$install_bin" -d -m 0700 "$record_dir"
record_dir_identity="$(path_identity "$record_dir")"
IFS=: read -r record_dir_uid record_dir_gid record_dir_mode <<<"$record_dir_identity"
if [[ -z "$test_harness_root" ]]; then
  [[ "$record_dir_uid" == 0 && "$record_dir_gid" == 0 && "$record_dir_mode" == 700 ]] || {
    fatal "release record directory must be owned by root:root with mode 0700"
  }
else
  [[ "$record_dir_uid" == "$EUID" && "$record_dir_mode" == 700 ]] || {
    fatal "test release record directory must be caller-owned with mode 0700"
  }
fi
readonly record_dir

current_stage="initializing"
schema_rollback="not_attempted"
candidate_started=true
previous_runtime_available=false
runtime_state_commit_visible=false
previous_release_id="none"
previous_git_commit="none"
current_pointer="$release_record_root/current-release.env"
latest_candidate_pointer="$release_record_root/latest-candidate.env"
release_pointer_temporary=""
runtime_inventory_temporary=""
runtime_active_temporary=""
release_tree=""
runtime_application_temporary=""
application_image_record_sha256=""
application_image_record_sha256_before_validation=""
candidate_gateway_image=""
candidate_gateway_identity=""

sync_path() {
  "$timeout_bin" --signal=TERM --kill-after=10s "${stage_timeout}s" \
    "$sync_bin" -f -- "$1"
}

sync_evidence_file() {
  sync_path "$1"
  sync_path "$record_dir"
}

write_status() {
  local result="$1" exit_code="$2"
  local temporary="$record_dir/.status.env.tmp"
  {
    printf 'release_id=%s\n' "$release_id"
    printf 'result=%s\n' "$result"
    printf 'stage=%s\n' "$current_stage"
    printf 'exit_code=%s\n' "$exit_code"
    printf 'schema_rollback=%s\n' "$schema_rollback"
  } >"$temporary"
  sync_path "$temporary"
  "$mv_bin" -f -- "$temporary" "$record_dir/status.env"
  sync_evidence_file "$record_dir/status.env"
}

record_event() {
  local event="$1"
  printf '%s\t%s\t%s\n' "$($date_bin -u +'%Y-%m-%dT%H:%M:%SZ')" "$current_stage" "$event" \
    >>"$record_dir/stages.tsv"
  sync_evidence_file "$record_dir/stages.tsv"
}

load_previous_release_pointer() {
  assert_safe_path "$current_pointer" "current release pointer"
  [[ ! -L "$current_pointer" ]] || fatal "current release pointer must not be a symlink"
  [[ -e "$current_pointer" ]] || return 0
  [[ -f "$current_pointer" ]] || fatal "current release pointer must be a regular file"

  local identity uid gid mode
  identity="$(path_identity "$current_pointer")"
  IFS=: read -r uid gid mode <<<"$identity"
  if [[ -z "$test_harness_root" ]]; then
    [[ "$uid" == 0 && "$gid" == 0 && "$mode" == 600 ]] || {
      fatal "current release pointer must be owned by root:root with mode 0600"
    }
  else
    [[ "$uid" == "$EUID" && "$mode" == 600 ]] || {
      fatal "test current release pointer must be caller-owned with mode 0600"
    }
  fi

  local key value pointer_release="" pointer_commit="" seen_release=false seen_commit=false
  while IFS='=' read -r key value; do
    case "$key" in
      release_id)
        [[ "$seen_release" == false ]] || fatal "current release pointer repeats release_id"
        seen_release=true
        pointer_release="$value"
        ;;
      git_commit)
        [[ "$seen_commit" == false ]] || fatal "current release pointer repeats git_commit"
        seen_commit=true
        pointer_commit="$value"
        ;;
      *) fatal "current release pointer contains an unknown field" ;;
    esac
  done <"$current_pointer"

  [[ "$seen_release" == true && "$seen_commit" == true ]] || {
    fatal "current release pointer is incomplete"
  }
  [[ "$pointer_release" =~ ^[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*$ ]] || {
    fatal "current release pointer contains an invalid release id"
  }
  [[ "$pointer_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
    fatal "current release pointer contains an invalid Git commit"
  }

  local previous_record="$release_record_root/$pointer_release"
  assert_safe_path "$previous_record" "previous release record"
  [[ -d "$previous_record" && ! -L "$previous_record" ]] || {
    fatal "current release pointer does not name a retained release record"
  }
  [[ -f "$previous_record/status.env" && ! -L "$previous_record/status.env" ]] || {
    fatal "previous release status is missing"
  }
  [[ -f "$previous_record/git-commit.txt" && ! -L "$previous_record/git-commit.txt" ]] || {
    fatal "previous release Git evidence is missing"
  }
  local previous_completed=false status_line
  while IFS= read -r status_line; do
    [[ "$status_line" == "result=completed" ]] && previous_completed=true
  done <"$previous_record/status.env"
  [[ "$previous_completed" == true ]] || {
    fatal "current release pointer does not name a completed release"
  }
  [[ "$("$cat_bin" "$previous_record/git-commit.txt")" == "$pointer_commit" ]] || {
    fatal "current release pointer Git evidence does not match"
  }
  previous_release_id="$pointer_release"
  previous_git_commit="$pointer_commit"
}

on_exit() {
  local exit_code="$?"
  local -a runtime_temporaries=()
  trap '' HUP INT TERM
  trap - EXIT
  if [[ "$release_completed" != true && "$release_quarantine_active" == true ]]; then
    run_ingress_control quarantine-create || true
  fi
  if [[ "$release_completed" != true ]]; then
    if [[ -n "$release_pointer_temporary" ]]; then
      "$rm_bin" -f -- "$release_pointer_temporary" || true
      sync_path "$release_record_root" || true
      release_pointer_temporary=""
    fi
    [[ -n "$runtime_inventory_temporary" ]] && runtime_temporaries+=("$runtime_inventory_temporary")
    [[ -n "$runtime_application_temporary" ]] && runtime_temporaries+=("$runtime_application_temporary")
    [[ -n "$runtime_active_temporary" ]] && runtime_temporaries+=("$runtime_active_temporary")
    if (( ${#runtime_temporaries[@]} > 0 )); then
      "$rm_bin" -f -- "${runtime_temporaries[@]}" || true
      sync_path "$runtime_state_root" || true
      runtime_inventory_temporary=""
      runtime_application_temporary=""
      runtime_active_temporary=""
    fi
    if [[ "$candidate_started" == true ]]; then
      failed_stage="$current_stage"
      current_stage="fail-closed-quarantine"
      if quarantine_tunnel || quarantine_tunnel; then
        record_event "tunnel_stopped_after_candidate_failure" || true
        if [[ "$schema_backward_compatible" == true && "$previous_runtime_available" == true ]]; then
          if [[ "$runtime_state_commit_visible" == true ]]; then
            record_event "automatic_restore_skipped_after_runtime_state_commit" || true
          else
            restore_previous_runtime || true
          fi
        fi
        quarantine_tunnel || quarantine_tunnel || true
      else
        record_event "tunnel_stop_failed" || true
        if [[ "$schema_backward_compatible" == true ]]; then
          schema_rollback="restore_failed"
        fi
      fi
      current_stage="$failed_stage"
    fi
    write_status failed "$exit_code" || true
    record_event failed || true
    echo "fatal: production release failed at stage $current_stage; evidence retained at $record_dir" >&2
  fi
  exit "$exit_code"
}
trap on_exit EXIT
trap 'trap "" HUP INT TERM; exit 129' HUP
trap 'trap "" HUP INT TERM; exit 130' INT
trap 'trap "" HUP INT TERM; exit 143' TERM

load_previous_release_pointer

printf '%s\n' "$previous_git_commit" >"$record_dir/previous-git-commit.txt"
sync_evidence_file "$record_dir/previous-git-commit.txt"
printf '%s\n' "$previous_release_id" >"$record_dir/previous-release-id.txt"
sync_evidence_file "$record_dir/previous-release-id.txt"

sync_path "$release_record_root"
sync_path "$record_dir"
write_status running 0
record_event started

"$cat_bin" >"$record_dir/rollback.txt" <<EOF
No automatic schema rollback was attempted or is claimed by this transaction.
The previous-running-images.tsv file records the pre-release service/image identities.
Application rollback may reuse a previous reviewed image only when it is compatible with the migrated schema.
Restore a verified recovery point for an incompatible schema; never improvise reverse SQL on production data.
When previous-runtime.override.yaml and a previous release id are present, this paste-ready command restores only pinned local images:
sudo '$repo_root/infra/ops/rollback-production.sh' --release-record '$record_dir' --schema-backward-compatible
EOF
sync_evidence_file "$record_dir/rollback.txt"

run_bounded() {
  "$timeout_bin" --signal=TERM --kill-after=10s "${stage_timeout}s" "$@"
}

readonly -a compose=(
  "${docker_cli[@]}" compose --project-name learncoding
  --env-file "$compose_env"
  -f "$compose_file"
)
readonly -a core_services=(
  postgres
  app
  runner-egress-gateway
  mail-worker
  reward-worker
  regrade-worker
  exam-finalization-worker
  file-erasure-worker
  practice-runner-recovery-worker
  project-review-correction-worker
)
readonly -a database_mutator_services=(
  app
  mail-worker
  reward-worker
  regrade-worker
  exam-finalization-worker
  practice-runner-recovery-worker
  project-review-correction-worker
  file-erasure-worker
)
readonly -a restorable_runtime_services=(
  app
  runner-egress-gateway
  mail-worker
  reward-worker
  regrade-worker
  exam-finalization-worker
  file-erasure-worker
  practice-runner-recovery-worker
  project-review-correction-worker
  cloudflared
)
readonly -a managed_runtime_services=(
  app
  cloudflared
  exam-finalization-worker
  file-erasure-worker
  mail-worker
  postgres
  practice-runner-recovery-worker
  project-review-correction-worker
  regrade-worker
  reward-worker
  runner-egress-gateway
)
readonly tunnel_service="cloudflared"


run_one_shot() {
  local service="$1"
  run_bounded "${compose[@]}" --profile operations up --no-deps \
    --no-build --pull never --force-recreate --exit-code-from "$service" "$service"
  # A successful one-shot is no longer part of the boot/recovery inventory.
  # Failed one-shots are intentionally retained for operator diagnostics.
  run_bounded "${compose[@]}" --profile operations rm -f "$service"
}

stop_database_mutators() {
  run_bounded "${compose[@]}" stop --timeout 60 "${database_mutator_services[@]}"
  if [[ "$uploads_enabled" == true ]]; then
    run_bounded "${compose[@]}" --profile uploads stop --timeout 60 scan-worker
  fi
}

reject_residual_database_sessions() {
  local session_count
  session_count="$(
    run_bounded "${compose[@]}" exec -T postgres psql --host=/run/learncoding-postgres \
      --username "$postgres_user" --dbname "$postgres_database" --no-psqlrc --quiet \
      --no-align --tuples-only \
      --set ON_ERROR_STOP=1 --command \
      "select count(*) from pg_stat_activity where (usename in ('learncoding_app','learncoding_migrator','learncoding_worker','learncoding_ops','learncoding_owner') or usename = current_user) and pid <> pg_backend_pid();"
  )" || fatal "unable to inspect residual restricted database sessions"
  session_count="${session_count//$'\r'/}"
  [[ "$session_count" =~ ^[0-9]+$ && "$session_count" == 0 ]] || {
    fatal "restricted database sessions remain after mutator shutdown"
  }
}

resolve_candidate_gateway_projection() {
  local line key value image identity extra found=false identity_found=false line_number=0
  candidate_gateway_image=""
  candidate_gateway_identity=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number="$((line_number + 1))"
    [[ "$line" != *$'\r'* && -n "$line" ]] || {
      fatal "application image environment record is malformed"
    }
    if (( line_number == 1 )); then
      [[ "$line" == '# Generated by scripts/app-images/manage-application-images.mjs; do not hand-edit.' ]] || {
        fatal "application image environment record has an invalid generated header"
      }
      continue
    fi
    if (( line_number == 2 )); then
      [[ "$line" =~ ^#[[:space:]]application-image-record-id=[0-9a-f]{64}$ ]] || {
        fatal "application image environment record has an invalid record header"
      }
      continue
    fi
    [[ "$line" == *=* ]] || fatal "application image environment record is malformed"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && -n "$value" ]] || {
      fatal "application image environment record is malformed"
    }
    if [[ "$key" == APP_RUNTIME_IMAGE ]]; then
      [[ "$found" == false ]] || fatal "application image environment record repeats APP_RUNTIME_IMAGE"
      found=true
      [[ "$value" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
        fatal "APP_RUNTIME_IMAGE is not a canonical digest"
      }
      candidate_gateway_image="$value"
    fi
  done <"$application_image_record_env"
  (( line_number >= 3 )) || fatal "application image environment record is incomplete"
  [[ "$found" == true ]] || fatal "application image environment record omits APP_RUNTIME_IMAGE"

  while IFS=$'\t' read -r image identity extra; do
    [[ -n "$image" && -z "$extra" ]] || fatal "candidate image identity evidence is malformed"
    [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
      fatal "candidate image identity reference is malformed"
    }
    [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || fatal "candidate image identity is malformed"
    if [[ "$image" == "$candidate_gateway_image" ]]; then
      [[ "$identity_found" == false ]] || fatal "candidate image identity evidence duplicates APP_RUNTIME_IMAGE"
      identity_found=true
      candidate_gateway_identity="$identity"
    fi
  done <"$record_dir/candidate-image-identities.tsv"
  [[ "$identity_found" == true ]] || fatal "candidate image identity evidence omits APP_RUNTIME_IMAGE"
}
prepare_previous_runtime_override() {
  local service image identity extra local_identity required prior_record prior_mapping transition_file
  local expected_count=0 previous_count=0 eligible=true legacy_transition=false
  declare -A previous_images=()
  declare -A previous_identities=()
  declare -A expected_images=()
  declare -A expected_identities=()

  [[ "$previous_release_id" != none ]] || eligible=false

  while IFS=$'\t' read -r service image identity extra; do
    [[ -n "$service" ]] || continue
    [[ -z "$extra" ]] || eligible=false
    case "$service" in
      app|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|file-erasure-worker|practice-runner-recovery-worker|project-review-correction-worker|cloudflared|runner-egress-gateway) ;;
      *) continue ;;
    esac
    [[ ! ${previous_images[$service]+present} ]] || eligible=false
    [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || eligible=false
    [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || eligible=false
    previous_images[$service]="$image"
    ((previous_count += 1))
    previous_identities[$service]="$identity"
  done <"$record_dir/previous-running-images.tsv"

  if [[ "$previous_release_id" != none ]]; then
    prior_record="$release_record_root/$previous_release_id"
    prior_mapping="$prior_record/deployed-service-images.tsv"
    assert_safe_path "$prior_mapping" "previous release deployed image evidence"
    [[ -f "$prior_mapping" && ! -L "$prior_mapping" ]] || {
      fatal "previous completed release lacks per-service deployed image evidence"
    }
    while IFS=$'\t' read -r service image identity extra; do
      [[ -n "$service" && -z "$extra" ]] || fatal "previous deployed image evidence is malformed"
      case "$service" in
        app|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|file-erasure-worker|practice-runner-recovery-worker|project-review-correction-worker|cloudflared|runner-egress-gateway) ;;
        *) fatal "previous deployed image evidence names an unexpected service" ;;
      esac
      [[ ! ${expected_images[$service]+present} ]] || fatal "previous deployed image evidence contains a duplicate service"
      [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || fatal "previous deployed image reference is not canonical"
      [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || fatal "previous deployed image identity is malformed"
      expected_images[$service]="$image"
      expected_identities[$service]="$identity"
      ((expected_count += 1))
    done <"$prior_mapping"
    if [[ "$expected_count" == "${#restorable_runtime_services[@]}" ]]; then
      :
    elif [[ "$expected_count" == "$(( ${#restorable_runtime_services[@]} - 1 ))" ]] \
      && [[ -z "${expected_images[runner-egress-gateway]+present}" ]]; then
      legacy_transition=true
    else
      fatal "previous deployed image evidence is incomplete"
    fi
  fi

  for required in "${restorable_runtime_services[@]}"; do
    if [[ "$legacy_transition" == true && "$required" == runner-egress-gateway ]]; then
      continue
    fi
    [[ ${previous_images[$required]+present} ]] || eligible=false
    [[ ${expected_images[$required]+present} ]] || eligible=false
    [[ "${previous_images[$required]:-}" == "${expected_images[$required]:-}" ]] || eligible=false
    [[ "${previous_identities[$required]:-}" == "${expected_identities[$required]:-}" ]] || eligible=false
  done

  if [[ "$legacy_transition" == true ]]; then
    if [[ "$previous_count" != "$(( ${#restorable_runtime_services[@]} - 1 ))" \
      || -n "${previous_images[runner-egress-gateway]+present}" ]]; then
      eligible=false
    fi
    resolve_candidate_gateway_projection
    previous_images[runner-egress-gateway]="$candidate_gateway_image"
    previous_identities[runner-egress-gateway]="$candidate_gateway_identity"
  elif [[ "$previous_release_id" != none \
    && "$previous_count" != "${#restorable_runtime_services[@]}" ]]; then
    eligible=false
  fi
  if [[ "$eligible" == true ]]; then
    for required in "${restorable_runtime_services[@]}"; do
      if ! local_identity="$(run_bounded "${docker_cli[@]}" image inspect --format '{{.Id}}' "${previous_images[$required]}" 2>/dev/null)"; then
        eligible=false
        break
      fi
      local_identity="${local_identity//$'\r'/}"
      local_identity="${local_identity//$'\n'/}"
      if [[ "$local_identity" != "${previous_identities[$required]}" ]]; then
        eligible=false
        break
      fi
    done
  fi

  if [[ "$eligible" != true && "$previous_release_id" == none ]]; then
    record_event "previous_runtime_restore_unavailable"
    return 0
  fi
  [[ "$eligible" == true ]] || {
    fatal "pre-release runtime does not match the linked reviewed release"
  }

  if [[ "$legacy_transition" == true ]]; then
    transition_file="$record_dir/previous-runtime-transition.env"
    {
      printf 'SCHEMA_VERSION=1\n'
      printf 'MODE=legacy_pre_gateway\n'
      printf 'PREVIOUS_RELEASE_ID=%s\n' "$previous_release_id"
      printf 'SOURCE_RELEASE_ID=%s\n' "$release_id"
      printf 'SOURCE_GIT_COMMIT=%s\n' "$release_commit"
      printf 'RETAINED_SERVICE=runner-egress-gateway\n'
      printf 'RETAINED_IMAGE=%s\n' "$candidate_gateway_image"
      printf 'RETAINED_IDENTITY=%s\n' "$candidate_gateway_identity"
    } >"$transition_file"
    "$chmod_bin" 0600 "$transition_file"
    sync_evidence_file "$transition_file"
    record_event "legacy_gateway_transition"
  fi

  {
    printf 'services:\n'
    for required in "${restorable_runtime_services[@]}"; do
      printf '  %s:\n' "$required"
      printf '    image: "%s"\n' "${previous_images[$required]}"
    done
  } >"$record_dir/previous-runtime.override.yaml"
  "$chmod_bin" 0600 "$record_dir/previous-runtime.override.yaml"
  sync_evidence_file "$record_dir/previous-runtime.override.yaml"
  previous_runtime_available=true
  record_event "previous_runtime_restore_available"
}
quarantine_tunnel() {
  run_bounded "${compose[@]}" stop --timeout 30 "$tunnel_service"
}

record_deployed_service_images() {
  local output="$record_dir/deployed-service-images.tsv"
  local service container_output container_id candidate_container deployed_line extra_service image identity extra
  local candidate_image candidate_identity candidate_extra found
  : >"$output"
  sync_evidence_file "$output"

  for service in "${restorable_runtime_services[@]}"; do
    container_output="$(run_bounded "${compose[@]}" ps -q "$service")" || {
      fatal "unable to inspect deployed container for $service"
    }
    container_id=""
    while IFS= read -r candidate_container; do
      [[ -n "$candidate_container" ]] || continue
      [[ -z "$container_id" ]] || fatal "deployed service has multiple containers: $service"
      container_id="$candidate_container"
    done <<<"$container_output"
    [[ -n "$container_id" ]] || fatal "deployed service has no container: $service"

    deployed_line="$(run_bounded "${docker_cli[@]}" inspect \
      --format '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Config.Image}}\t{{.Image}}' \
      "$container_id")" || fatal "unable to inspect deployed image for $service"
    IFS=$'\t' read -r extra_service image identity extra <<<"$deployed_line"
    [[ "$extra_service" == "$service" && -z "$extra" ]] || {
      fatal "deployed container identity does not match service: $service"
    }
    [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
      fatal "deployed service image is not a canonical digest: $service"
    }
    [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || {
      fatal "deployed service image identity is malformed: $service"
    }

    found=false
    while IFS=$'\t' read -r candidate_image candidate_identity candidate_extra; do
      [[ -z "$candidate_extra" ]] || fatal "candidate image identity evidence is malformed"
      if [[ "$candidate_image" == "$image" && "$candidate_identity" == "$identity" ]]; then
        found=true
      fi
    done <"$record_dir/candidate-image-identities.tsv"
    [[ "$found" == true ]] || fatal "deployed service image is outside the reviewed candidate inventory: $service"

    printf '%s\t%s\t%s\n' "$service" "$image" "$identity" >>"$output"
  done
  sync_evidence_file "$output"
}

file_sha256() {
  local path="$1" output digest
  output="$("$sha256sum_bin" -- "$path")" || fatal "unable to hash runtime identity source"
  digest="${output%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fatal "runtime identity digest is malformed"
  printf '%s\n' "$digest"
}

compose_env_value() {
  local requested_key="$1" default_supplied=false default_value="" line key value found=false result=""
  if [[ "$#" == 2 ]]; then
    default_supplied=true
    default_value="$2"
  elif [[ "$#" != 1 ]]; then
    fatal "internal Compose environment lookup error"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || fatal "Compose environment contains a carriage return"
    [[ -n "$line" && "$line" != '#'* ]] || continue
    [[ "$line" == *=* ]] || fatal "Compose environment contains a malformed line"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fatal "Compose environment contains an invalid key"
    if [[ "$key" == "$requested_key" ]]; then
      [[ "$found" == false ]] || fatal "Compose environment repeats $requested_key"
      found=true
      result="$value"
    fi
  done <"$compose_env"
  if [[ "$found" == false ]]; then
    [[ "$default_supplied" == true ]] || fatal "Compose environment does not define $requested_key"
    result="$default_value"
  fi
  printf '%s\n' "$result"
}

compose_public_origin() {
  local origin
  origin="$(compose_env_value APP_URL)"
  [[ "$origin" =~ ^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || {
    fatal "APP_URL must be a canonical lowercase public HTTPS origin"
  }
  [[ ! "$origin" =~ ^https://([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
    fatal "APP_URL must be a canonical lowercase public HTTPS origin"
  }
  printf '%s\n' "$origin"
}

public_origin="$(compose_public_origin)"
readonly public_origin
postgres_image="$(compose_env_value POSTGRES_IMAGE)"
readonly postgres_image
postgres_uid="$(compose_env_value POSTGRES_UID)"
readonly postgres_uid
postgres_gid="$(compose_env_value POSTGRES_GID)"
readonly postgres_gid
learn_data_root="$(compose_env_value LEARN_DATA_ROOT /srv/learncoding)"
readonly learn_data_root
uploads_enabled="$(compose_env_value UPLOADS_ENABLED false)"
readonly uploads_enabled
postgres_database="$(compose_env_value POSTGRES_DB learncoding)"
readonly postgres_database
postgres_user="$(compose_env_value POSTGRES_USER learncoding)"
readonly postgres_user

[[ "$postgres_image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || fatal "POSTGRES_IMAGE must be a canonical digest"
[[ "$postgres_uid" =~ ^[1-9][0-9]*$ ]] || fatal "POSTGRES_UID must be a canonical positive integer"
[[ "$postgres_gid" =~ ^[1-9][0-9]*$ ]] || fatal "POSTGRES_GID must be a canonical positive integer"
[[ "$learn_data_root" == /* && "$learn_data_root" != / && "$learn_data_root" != */ && "$learn_data_root" != *[[:space:]]* ]] || {
  fatal "LEARN_DATA_ROOT must be a canonical absolute directory"
}
assert_safe_path "$learn_data_root" "learning data root"
[[ "$uploads_enabled" == true || "$uploads_enabled" == false ]] || fatal "UPLOADS_ENABLED must be true or false"
[[ "$postgres_database" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fatal "POSTGRES_DB must be a canonical identifier"
[[ "$postgres_user" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fatal "POSTGRES_USER must be a canonical identifier"

record_managed_runtime_state() {
  local inventory="$record_dir/managed-containers.tsv"
  local active="$record_dir/active-release.env"
  local service container_output container_id="" candidate_container inspected
  local inspected_service inspected_name image identity extra candidate_image candidate_identity candidate_extra found
  local managed_sha manifest_sha firewall_sha runtime_sha current_application_sha retained_application_sha
  : >"$inventory"
  for service in "${managed_runtime_services[@]}"; do
    container_output="$(run_bounded "${compose[@]}" ps -q "$service")" || {
      fatal "unable to inspect managed container for $service"
    }
    container_id=""
    while IFS= read -r candidate_container; do
      [[ -n "$candidate_container" ]] || continue
      [[ -z "$container_id" ]] || fatal "managed service has multiple containers: $service"
      container_id="$candidate_container"
    done <<<"$container_output"
    [[ -n "$container_id" ]] || fatal "managed service has no container: $service"
    inspected="$(run_bounded "${docker_cli[@]}" inspect \
      --format '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Name}}\t{{.Config.Image}}\t{{.Image}}' \
      "$container_id")" || fatal "unable to inspect managed container identity: $service"
    IFS=$'\t' read -r inspected_service inspected_name image identity extra <<<"$inspected"
    [[ "$inspected_service" == "$service" && "$inspected_name" == "/learncoding-$service-1" && -z "$extra" ]] || {
      fatal "managed container identity does not match the fixed Compose project: $service"
    }
    [[ "$image" =~ ^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[0-9a-f]{64}$ ]] || {
      fatal "managed container image is not a canonical digest: $service"
    }
    [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || fatal "managed image identity is malformed: $service"
    found=false
    while IFS=$'\t' read -r candidate_image candidate_identity candidate_extra; do
      [[ -z "$candidate_extra" ]] || fatal "candidate image identity evidence is malformed"
      if [[ "$candidate_image" == "$image" && "$candidate_identity" == "$identity" ]]; then
        found=true
      fi
    done <"$record_dir/candidate-image-identities.tsv"
    [[ "$found" == true ]] || fatal "managed container image is outside the reviewed candidate inventory: $service"
    printf '%s\t%s\t%s\t%s\n' "$service" "learncoding-$service-1" "$image" "$identity" >>"$inventory"
  done
  "$chmod_bin" 0600 "$inventory"
  sync_evidence_file "$inventory"

  managed_sha="$(file_sha256 "$inventory")"
  manifest_sha="$(file_sha256 "$release_manifest")"
  firewall_sha="$(file_sha256 "$firewall_policy")"
  runtime_sha="$(file_sha256 "$runner_runtime_record")"
  current_application_sha="$(file_sha256 "$application_image_record_json")"
  retained_application_sha="$(file_sha256 "$record_dir/application-image-record.json")"
  [[ "$current_application_sha" == "$application_image_record_sha256" \
    && "$retained_application_sha" == "$application_image_record_sha256" ]] || {
    fatal "verified application image record changed before runtime state publication"
  }
  {
    printf 'SCHEMA_VERSION=1\n'
    printf 'GIT_COMMIT=%s\n' "$release_commit"
    printf 'GIT_TREE=%s\n' "$release_tree"
    printf 'RELEASE_MANIFEST_SHA256=%s\n' "$manifest_sha"
    printf 'APPLICATION_IMAGE_RECORD_SHA256=%s\n' "$application_image_record_sha256"
    printf 'COMPOSE_PROJECT=learncoding\n'
    printf 'COMPOSE_WORKDIR=/opt/learncoding\n'
    printf 'PUBLIC_ORIGIN=%s\n' "$public_origin"
    printf 'MANAGED_INVENTORY_SHA256=%s\n' "$managed_sha"
    printf 'FIREWALL_POLICY_SHA256=%s\n' "$firewall_sha"
    printf 'RUNNER_GUEST_RELEASE_SHA256=%s\n' "$manifest_sha"
    printf 'RUNNER_RUNTIME_IMAGES_SHA256=%s\n' "$runtime_sha"
  } >"$active"
  "$chmod_bin" 0600 "$active"
  sync_evidence_file "$active"
}

validate_runtime_state_target() {
  local path="$1" label="$2" identity uid gid mode links
  [[ ! -L "$path" ]] || fatal "$label must not be a symlink"
  [[ ! -e "$path" || -f "$path" ]] || fatal "$label must be a regular file"
  [[ -e "$path" ]] || return 0
  identity="$(path_identity "$path")"
  IFS=: read -r uid gid mode <<<"$identity"
  if [[ -z "$test_harness_root" ]]; then
    [[ "$uid" == 0 && "$gid" == 0 ]] || fatal "$label must be owned by root:root"
  else
    [[ "$uid" == "$EUID" ]] || fatal "$label must be owned by the test caller"
  fi
  [[ "$mode" == 644 ]] || fatal "$label must have mode 0644"
  links="$($stat_bin -Lc '%h' -- "$path")"
  [[ "$links" == 1 ]] || fatal "$label must have exactly one hard link"
}

publish_immutable_runtime_blob() {
  local source="$1" expected_sha="$2" target="$3" temporary="$4" label="$5" actual_sha
  [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fatal "$label digest is malformed"
  assert_safe_path "$target" "$label target"
  assert_safe_path "$temporary" "$label temporary"
  validate_runtime_state_target "$target" "existing $label"
  if [[ -e "$target" ]]; then
    actual_sha="$(file_sha256 "$target")"
    [[ "$actual_sha" == "$expected_sha" ]] || fatal "existing $label does not match its content address"
    sync_path "$target"
    sync_path "$runtime_state_root"
    return 0
  fi
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fatal "$label temporary already exists"
  "$cat_bin" "$source" >"$temporary"
  "$chmod_bin" 0644 "$temporary"
  sync_path "$temporary"
  actual_sha="$(file_sha256 "$temporary")"
  [[ "$actual_sha" == "$expected_sha" ]] || fatal "$label changed while being published"
  "$mv_bin" -- "$temporary" "$target"
  sync_path "$target"
  sync_path "$runtime_state_root"
  validate_runtime_state_target "$target" "published $label"
  [[ "$(file_sha256 "$target")" == "$expected_sha" ]] || fatal "published $label failed digest verification"
}

publish_runtime_state() {
  local inventory_source="$record_dir/managed-containers.tsv"
  local application_source="$record_dir/application-image-record.json"
  local active_source="$record_dir/active-release.env"
  local inventory_sha application_sha inventory_target application_target
  inventory_sha="$(file_sha256 "$inventory_source")"
  application_sha="$(file_sha256 "$application_source")"
  [[ "$application_sha" == "$application_image_record_sha256" ]] || {
    fatal "retained application image record changed before runtime state publication"
  }
  inventory_target="$runtime_state_root/managed-containers.${inventory_sha}.tsv"
  application_target="$runtime_state_root/application-images.${application_sha}.json"
  runtime_inventory_temporary="$runtime_state_root/.managed-containers.${inventory_sha}.${release_id}.tmp"
  runtime_application_temporary="$runtime_state_root/.application-images.${application_sha}.${release_id}.tmp"
  runtime_active_temporary="$runtime_state_root/.active-release.${release_id}.tmp"

  publish_immutable_runtime_blob \
    "$inventory_source" "$inventory_sha" "$inventory_target" \
    "$runtime_inventory_temporary" "managed container inventory"
  runtime_inventory_temporary=""
  publish_immutable_runtime_blob \
    "$application_source" "$application_sha" "$application_target" \
    "$runtime_application_temporary" "application image record"
  runtime_application_temporary=""

  assert_safe_path "$active_release_state" "active release state"
  assert_safe_path "$runtime_active_temporary" "active release temporary"
  validate_runtime_state_target "$active_release_state" "existing active release state"
  [[ ! -e "$runtime_active_temporary" && ! -L "$runtime_active_temporary" ]] || {
    fatal "active release temporary already exists"
  }
  "$cat_bin" "$active_source" >"$runtime_active_temporary"
  "$chmod_bin" 0644 "$runtime_active_temporary"
  sync_path "$runtime_active_temporary"
  "$mv_bin" -f -- "$runtime_active_temporary" "$active_release_state"
  runtime_state_commit_visible=true
  sync_path "$active_release_state"
  sync_path "$runtime_state_root"
  runtime_active_temporary=""
}

run_smoke_phase() {
  local requested_phase="$1"
  run_bounded "$env_bin" \
    "DOCKER_HOST=unix:///var/run/docker.sock" \
    "COMPOSE_PROJECT_NAME=learncoding" \
    "COMPOSE_ENV_FILE=$compose_env" \
    "COMPOSE_FILE_PATH=$compose_file" \
    "$smoke_production_script" --phase "$requested_phase" --startup-wait "$startup_wait"
}

restore_previous_runtime() {
  [[ "$schema_backward_compatible" == true && "$previous_runtime_available" == true ]] || return 2
  local failed_stage="$current_stage"
  local override="$record_dir/previous-runtime.override.yaml"
  local -a previous_compose=(
    "${docker_cli[@]}" compose --project-name learncoding
    --env-file "$compose_env"
    -f "$compose_file"
    -f "$override"
  )
  local -a previous_core=(
    app
    mail-worker
    reward-worker
    regrade-worker
    exam-finalization-worker
    practice-runner-recovery-worker
    project-review-correction-worker
    runner-egress-gateway
  )

  current_stage="restore-previous-runtime"
  record_event started || true
  if run_bounded "${previous_compose[@]}" up -d --no-build --pull never --remove-orphans \
      "${previous_core[@]}" \
    && run_smoke_phase internal \
    && run_bounded "${previous_compose[@]}" up -d --no-deps --no-build --pull never "$tunnel_service" \
    && run_smoke_phase public; then
    schema_rollback="previous_runtime_restored"
    record_event completed || true
    current_stage="$failed_stage"
    return 0
  fi

  schema_rollback="restore_failed"
  quarantine_tunnel || true
  record_event failed || true
  current_stage="$failed_stage"
  return 1
}

update_release_pointer() {
  local target="$1" label="$2" pointer_release_id="$3" pointer_git_commit="$4"
  local temporary="$release_record_root/.${label}.${release_id}.tmp"
  release_pointer_temporary="$temporary"
  assert_safe_path "$target" "$label"
  assert_safe_path "$temporary" "$label temporary"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || {
    fatal "$label temporary already exists"
  }
  {
    printf 'release_id=%s\n' "$pointer_release_id"
    printf 'git_commit=%s\n' "$pointer_git_commit"
  } >"$temporary"
  "$chmod_bin" 0600 "$temporary"
  sync_path "$temporary"
  "$mv_bin" -f -- "$temporary" "$target"
  sync_path "$target"
  sync_path "$release_record_root"
  release_pointer_temporary=""
}



release_commit="$(run_bounded "$git_bin" -C "$repo_root" rev-parse --verify HEAD 2>/dev/null || true)"
[[ "$release_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
  fatal "unable to determine an exact lowercase release Git commit"
}
release_tree="$(run_bounded "$git_bin" -C "$repo_root" rev-parse --verify "${release_commit}^{tree}" 2>/dev/null || true)"
[[ "$release_tree" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
  fatal "unable to determine an exact lowercase release Git tree"
}
git_top="$(run_bounded "$git_bin" -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$git_top" && "$($realpath_bin -e -- "$git_top")" == "$($realpath_bin -e -- "$repo_root")" ]] || {
  fatal "repository root is not the verified Git worktree root"
}
if ! git_dirty="$(run_bounded "$git_bin" -C "$repo_root" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
  fatal "unable to verify that the release checkout is clean"
fi
[[ -z "$git_dirty" ]] || fatal "release checkout is dirty; reviewed bytes must match Git HEAD"
run_bounded "$python_bin" "$release_tree_packager" \
  --verify-source-manifest \
  --source "$repo_root" \
  --expected-commit "$release_commit" \
  --expected-tree "$release_tree" \
  --application-image-json "$application_image_record_json" \
  --application-image-env "$application_image_record_env" \
  --runner-runtime-json "$runner_runtime_record_json" \
  --runner-runtime-env "$runner_runtime_record" >/dev/null || {
  fatal "release manifest does not describe the exact clean checkout and canonical runtime overlays"
}
printf '%s\n' "$release_commit" >"$record_dir/git-commit.txt"
sync_evidence_file "$record_dir/git-commit.txt"
printf '%s\n' "$release_tree" >"$record_dir/git-tree.txt"
sync_evidence_file "$record_dir/git-tree.txt"

current_stage="inventory"
write_status running 0
record_event started

candidate_output="$(run_bounded "${compose[@]}" --profile operations config --images)" || {
  fatal "unable to render the release image inventory"
}
: >"$record_dir/candidate-images.txt"
while IFS= read -r image; do
  [[ -n "$image" ]] || continue
  printf '%s\n' "$image" >>"$record_dir/candidate-images.txt"
done <<<"$candidate_output"
"$sort_bin" -u -o "$record_dir/candidate-images.txt" "$record_dir/candidate-images.txt"
sync_evidence_file "$record_dir/candidate-images.txt"
[[ -s "$record_dir/candidate-images.txt" ]] || fatal "release image inventory is empty"

: >"$record_dir/image-acquisitions.tsv"
sync_evidence_file "$record_dir/image-acquisitions.tsv"
while IFS= read -r image; do
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
    fatal "release image inventory contains an unpinned or non-canonical reference"
  }
  if [[ "$acquire_images" == true ]]; then
    run_bounded "${docker_cli[@]}" pull "$image" || fatal "exact release image acquisition failed"
    printf '%s\t%s\n' "$($date_bin -u +'%Y-%m-%dT%H:%M:%SZ')" "$image" \
      >>"$record_dir/image-acquisitions.tsv"
    sync_evidence_file "$record_dir/image-acquisitions.tsv"
    record_event "acquired_image_digest"
  fi
done <"$record_dir/candidate-images.txt"

: >"$record_dir/candidate-image-identities.tsv"
sync_evidence_file "$record_dir/candidate-image-identities.tsv"
while IFS= read -r image; do
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
    fatal "release image inventory contains an unpinned or non-canonical reference"
  }
  image_id="$(run_bounded "${docker_cli[@]}" image inspect --format '{{.Id}}' "$image")" || {
    fatal "reviewed release image is not present locally: $image"
  }
  image_id="${image_id//$'\r'/}"
  image_id="${image_id//$'\n'/}"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fatal "local image identity is malformed: $image"
  printf '%s\t%s\n' "$image" "$image_id" >>"$record_dir/candidate-image-identities.tsv"
  sync_evidence_file "$record_dir/candidate-image-identities.tsv"
done <"$record_dir/candidate-images.txt"

: >"$record_dir/previous-running-images.tsv"
sync_evidence_file "$record_dir/previous-running-images.tsv"
running_ids="$(run_bounded "${compose[@]}" ps -q)" || fatal "unable to inspect the pre-release stack"
while IFS= read -r container_id; do
  [[ -n "$container_id" ]] || continue
  run_bounded "${docker_cli[@]}" inspect \
    --format '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Config.Image}}\t{{.Image}}' \
    "$container_id" >>"$record_dir/previous-running-images.tsv" || {
      fatal "unable to record a pre-release container identity"
    }
  sync_evidence_file "$record_dir/previous-running-images.tsv"
done <<<"$running_ids"
prepare_previous_runtime_override
record_event completed

require_bootstrap_admin_secret="$bootstrap_admin"
readonly require_bootstrap_admin_secret

current_stage="pre-privileged-validation"
write_status running 0
record_event started
run_bounded "$env_bin" \
  "DOCKER_HOST=unix:///var/run/docker.sock" \
  "COMPOSE_PROJECT_NAME=learncoding" \
  "VALIDATION_MODE=operations" \
  "REQUIRE_BOOTSTRAP_ADMIN_SECRET=$require_bootstrap_admin_secret" \
  "REPO_ROOT=$repo_root" \
  "COMPOSE_ENV_FILE=$compose_env" \
  "POSTGRES_IMAGE=$postgres_image" \
  "POSTGRES_UID=$postgres_uid" \
  "POSTGRES_GID=$postgres_gid" \
  "LEARN_DATA_ROOT=$learn_data_root" \
  "UPLOADS_ENABLED=$uploads_enabled" \
  "$validate_runtime_script" --pre-privileged
record_event completed

current_stage="prepare-postgres-storage"
write_status running 0
record_event started
run_bounded "$env_bin" \
  "POSTGRES_UID=$postgres_uid" \
  "POSTGRES_GID=$postgres_gid" \
  "LEARN_DATA_ROOT=$learn_data_root" \
  "$prepare_postgres_script"
record_event completed

current_stage="prepare-object-storage"
write_status running 0
record_event started
run_bounded "$env_bin" \
  "LEARN_DATA_ROOT=$learn_data_root" \
  "UPLOADS_ENABLED=$uploads_enabled" \
  "$node_bin" "$prepare_object_script"
record_event completed

current_stage="preflight"
write_status running 0
record_event started
application_image_record_sha256_before_validation="$(file_sha256 "$application_image_record_json")"
run_bounded "$env_bin" \
  "DOCKER_HOST=unix:///var/run/docker.sock" \
  "COMPOSE_PROJECT_NAME=learncoding" \
  "VALIDATION_MODE=operations" \
  "REQUIRE_BOOTSTRAP_ADMIN_SECRET=$require_bootstrap_admin_secret" \
  "REPO_ROOT=$repo_root" \
  "COMPOSE_ENV_FILE=$compose_env" \
  "APPLICATION_EXPECTED_SOURCE_REVISION=$release_commit" \
  "APPLICATION_EXPECTED_SOURCE_TREE=$release_tree" \
  "APPLICATION_IMAGE_RECORD_JSON=$application_image_record_json" \
  "APPLICATION_IMAGE_RECORD_ENV=$application_image_record_env" \
  "$validate_runtime_script"
application_image_record_sha256="$(file_sha256 "$application_image_record_json")"
[[ "$application_image_record_sha256" == "$application_image_record_sha256_before_validation" ]] || {
  fatal "application image record changed during release preflight"
}
"$cat_bin" "$application_image_record_json" >"$record_dir/application-image-record.json"
"$chmod_bin" 0600 "$record_dir/application-image-record.json"
sync_evidence_file "$record_dir/application-image-record.json"
[[ "$(file_sha256 "$record_dir/application-image-record.json")" == "$application_image_record_sha256" ]] || {
  fatal "retained application image record does not match verified bytes"
}
printf '%s\n' "$application_image_record_sha256" >"$record_dir/application-image-record-sha256.txt"
"$chmod_bin" 0600 "$record_dir/application-image-record-sha256.txt"
sync_evidence_file "$record_dir/application-image-record-sha256.txt"
record_event completed

current_stage="tunnel-quarantine"
write_status running 0
record_event started
candidate_started=true
quarantine_tunnel
update_release_pointer "$latest_candidate_pointer" latest-candidate "$release_id" "$release_commit"
record_event completed

current_stage="stop-database-mutators"
write_status running 0
record_event started
stop_database_mutators
record_event completed

current_stage="postgres"
write_status running 0
record_event started
run_bounded "${compose[@]}" up -d --wait --wait-timeout "$stage_timeout" \
  --no-build --pull never postgres
record_event completed

current_stage="reject-residual-database-sessions"
write_status running 0
record_event started
reject_residual_database_sessions
record_event completed

current_stage="database-role-bootstrap"
write_status running 0
record_event started
run_one_shot database-role-bootstrap
record_event completed

current_stage="database-negative-probes"
write_status running 0
record_event started
run_one_shot database-negative-probes
record_event completed

current_stage="migrate"
write_status running 0
record_event started
run_one_shot migrate
record_event completed

current_stage="platform-seed"
write_status running 0
record_event started
run_one_shot platform-seed
record_event completed

if [[ "$bootstrap_admin" == true ]]; then
  current_stage="admin-bootstrap"
  write_status running 0
  record_event started
  run_one_shot admin-bootstrap
  record_event completed
fi

current_stage="database-boundary-verifier"
write_status running 0
record_event started
run_one_shot database-boundary-verifier
record_event completed

current_stage="core-start"
write_status running 0
record_event started
run_bounded "${compose[@]}" up -d --no-build --pull never --remove-orphans \
  "${core_services[@]}"
record_event completed

current_stage="internal-readiness"
write_status running 0
record_event started
run_smoke_phase internal
record_event completed

current_stage="tunnel-start"
write_status running 0
record_event started
run_bounded "${compose[@]}" up -d --no-deps --no-build --pull never "$tunnel_service"
record_event completed

current_stage="public-readiness"
write_status running 0
record_event started
run_smoke_phase public
record_event completed

current_stage="record-deployed-images"
write_status running 0
record_event started
record_deployed_service_images
record_event completed

current_stage="record-runtime-state"
write_status running 0
record_event started
record_managed_runtime_state
record_event completed

current_stage="complete"
write_status completed 0
record_event completed
sync_path "$record_dir"
publish_runtime_state
update_release_pointer "$current_pointer" current-release "$release_id" "$release_commit"
run_ingress_control quarantine-clear || fatal "unable to clear durable release quarantine"
release_completed=true
printf 'production release completed; evidence retained at %s\n' "$record_dir"
