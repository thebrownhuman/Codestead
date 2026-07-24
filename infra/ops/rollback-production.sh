#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: rollback-production.sh --release-record PATH --schema-backward-compatible [--lock-timeout SECONDS] [--stage-timeout SECONDS] [--startup-wait SECONDS]

Restores the exact pre-release application images recorded by a release.
It never reverses schema changes, builds images, or pulls images. The explicit
schema compatibility assertion is mandatory.
EOF
}

release_record=""
schema_backward_compatible=false
lock_timeout=30
stage_timeout=900
startup_wait=600
test_harness_root=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --release-record)
      [[ "$#" -ge 2 ]] || fatal "--release-record requires an absolute path"
      release_record="$2"
      shift 2
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

[[ "$schema_backward_compatible" == true ]] || {
  fatal "--schema-backward-compatible is required; this command never reverses migrations"
}
[[ -n "$release_record" && "$release_record" == /* ]] || fatal "--release-record requires an absolute path"
for value in "$lock_timeout" "$stage_timeout" "$startup_wait"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fatal "timeouts must be positive integers"
done
(( lock_timeout <= 300 && stage_timeout <= 1800 && startup_wait <= 1200 )) || fatal "timeout exceeds its safety bound"
(( stage_timeout >= startup_wait )) || fatal "--stage-timeout must be at least --startup-wait"

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

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly cat_bin=/usr/bin/cat
readonly chmod_bin=/usr/bin/chmod
readonly date_bin=/usr/bin/date
readonly env_bin=/usr/bin/env
readonly system_flock_bin=/usr/bin/flock
readonly git_bin=/usr/bin/git
readonly mv_bin=/usr/bin/mv
readonly python_bin=/usr/bin/python3.12
readonly realpath_bin=/usr/bin/realpath
readonly rm_bin=/usr/bin/rm
readonly sha256sum_bin=/usr/bin/sha256sum
readonly stat_bin=/usr/bin/stat
readonly timeout_bin=/usr/bin/timeout

if [[ -n "$test_harness_root" ]]; then
  [[ "$test_harness_root" == /* && -d "$test_harness_root" && ! -L "$test_harness_root" ]] || {
    fatal "test harness root must be an absolute real directory"
  }
  test_harness_root="$("$realpath_bin" -e -- "$test_harness_root")"
  [[ "$("$stat_bin" -Lc '%u:%a' -- "$test_harness_root")" == "$EUID:700" ]] || {
    fatal "test harness root must be caller-owned with mode 0700"
  }
  readonly docker_bin="$test_harness_root/bin/docker"
  readonly sync_bin="$test_harness_root/bin/sync"
  readonly flock_bin="$test_harness_root/bin/flock"
else
  (( EUID == 0 )) || fatal "production rollback must run as root"
  readonly docker_bin=/usr/bin/docker
  readonly sync_bin=/usr/bin/sync
  readonly flock_bin="$system_flock_bin"
fi

for command in "$cat_bin" "$chmod_bin" "$date_bin" "$env_bin" "$flock_bin" "$git_bin" "$mv_bin" \
  "$python_bin" "$realpath_bin" "$rm_bin" "$sha256sum_bin" "$stat_bin" "$timeout_bin" "$docker_bin" "$sync_bin"; do
  [[ -f "$command" && -x "$command" && ! -L "$command" ]] || fatal "required trusted command is unavailable"
done

readonly -a docker_cli=(
  "$docker_bin" --host unix:///var/run/docker.sock
)

file_sha256() {
  local path="$1" output digest
  output="$("$sha256sum_bin" -- "$path")" || fatal "unable to hash runtime identity source"
  digest="${output%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fatal "runtime identity digest is malformed"
  printf '%s\n' "$digest"
}

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
readonly smoke_production_script="${SMOKE_PRODUCTION_SCRIPT:-$repo_root/infra/ops/smoke-production.sh}"
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

safe_path() {
  local path="$1" label="$2" lexical resolved
  [[ "$path" == /* ]] || fatal "$label must be absolute"
  lexical="$("$realpath_bin" -sm -- "$path")"
  resolved="$("$realpath_bin" -m -- "$path")"
  [[ "$lexical" == "$resolved" ]] || fatal "$label contains a symlink component"
  if [[ -n "$test_harness_root" ]]; then
    case "$lexical" in
      "$test_harness_root"|"$test_harness_root"/*) ;;
      *) fatal "$label escapes the test harness" ;;
    esac
  fi
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

assert_trusted_not_writable() {
  local path="$1" label="$2" identity uid gid mode numeric
  identity="$("$stat_bin" -Lc '%u:%g:%a' -- "$path")"
  IFS=: read -r uid gid mode <<<"$identity"
  if [[ -z "$test_harness_root" ]]; then
    [[ "$uid" == 0 && "$gid" == 0 ]] || fatal "$label must be owned by root:root"
  else
    [[ "$uid" == "$EUID" ]] || fatal "$label must be owned by the test caller"
  fi
  numeric="$(mode_value "$mode")"
  (( (numeric & 0022) == 0 )) || fatal "$label must not be group- or world-writable"
}

for item in "$repo_root|repository root" "$compose_env|Compose environment" \
  "$compose_file|Compose file" "$release_lock_file|release lock" \
  "$release_record_root|release record root" "$release_record|release record" \
  "$smoke_production_script|production smoke" \
  "$ingress_control_script|ingress control helper" \
  "$runtime_state_root|runtime state root" \
  "$release_tree_packager|release tree packager" \
  "$release_manifest|release manifest" \
  "$application_image_record_json|application image JSON record" \
  "$application_image_record_env|application image environment record" \
  "$firewall_policy|host firewall policy" \
  "$runner_runtime_record_json|runner runtime JSON record" \
  "$runner_runtime_record|runner runtime record" \
  "$active_release_state|active release state"; do
  safe_path "${item%%|*}" "${item#*|}"
done

lock_parent="${release_lock_file%/*}"
[[ -n "$lock_parent" ]] || lock_parent=/
safe_path "$lock_parent" "release lock directory"
[[ -d "$repo_root" && ! -L "$repo_root" ]] || fatal "repository root must be a real directory"
[[ -f "$compose_env" && ! -L "$compose_env" ]] || fatal "Compose environment must be a regular non-symlink file"
[[ -f "$compose_file" && ! -L "$compose_file" ]] || fatal "Compose file must be a regular non-symlink file"
[[ -f "$smoke_production_script" && -x "$smoke_production_script" && ! -L "$smoke_production_script" ]] || {
  fatal "production smoke must be an executable non-symlink file"
}
[[ -f "$release_tree_packager" && -x "$release_tree_packager" && ! -L "$release_tree_packager" ]] || {
  fatal "release tree packager must be an executable non-symlink file"
}
[[ -f "$ingress_control_script" && -x "$ingress_control_script" && ! -L "$ingress_control_script" ]] || {
  fatal "ingress control helper must be an executable non-symlink file"
}
for trusted_input in \
  "$repo_root|repository root" \
  "$compose_env|Compose environment" \
  "$compose_file|Compose file" \
  "$smoke_production_script|production smoke" \
  "$release_tree_packager|release tree packager" \
  "$ingress_control_script|ingress control helper" \
  "$docker_bin|Docker client" \
  "$sync_bin|sync"; do
  assert_trusted_not_writable "${trusted_input%%|*}" "${trusted_input#*|}"
done

compose_public_origin() {
  local line key value found=false origin=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || fatal "Compose environment contains a carriage return"
    [[ -n "$line" && "$line" != '#'* ]] || continue
    [[ "$line" == *=* ]] || fatal "Compose environment contains a malformed line"
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$key" == APP_URL ]]; then
      [[ "$found" == false ]] || fatal "Compose environment repeats APP_URL"
      found=true
      origin="$value"
    fi
  done <"$compose_env"
  [[ "$found" == true ]] || fatal "Compose environment does not define APP_URL"
  [[ "$origin" =~ ^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || {
    fatal "APP_URL must be a canonical lowercase public HTTPS origin"
  }
  [[ ! "$origin" =~ ^https://([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
    fatal "APP_URL must be a canonical lowercase public HTTPS origin"
  }
  printf '%s\n' "$origin"
}

# Validate immutable, authenticated operator configuration before taking the
# host transaction lock. Once the lock is held, durable ingress quarantine is
# the first side effect; mutable release evidence is inspected only afterward.
public_origin="$(compose_public_origin)"
readonly public_origin

[[ -d "$lock_parent" && ! -L "$lock_parent" ]] || fatal "release lock directory must be a real directory"
if [[ -z "$test_harness_root" ]]; then
  if [[ "$lock_parent" == /run/lock ]]; then
    [[ "$("$stat_bin" -Lc '%u:%g:%a' -- "$lock_parent")" == 0:0:1777 ]] || fatal "/run/lock must be exactly root:root mode 1777"
  else
    assert_trusted_not_writable "$lock_parent" "release lock directory"
  fi
else
  assert_trusted_not_writable "$lock_parent" "test release lock directory"
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
"$flock_bin" --exclusive --wait "$lock_timeout" 9 || fatal "another release or rollback holds the host lock"
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

run_ingress_control_early() {
  "$timeout_bin" --signal=TERM --kill-after=10s "${stage_timeout}s" "${ingress_control[@]}" "$@"
}
quarantine_tunnel_early() {
  "$timeout_bin" --signal=TERM --kill-after=10s "${stage_timeout}s" \
    "${docker_cli[@]}" compose --project-name learncoding --env-file "$compose_env" -f "$compose_file" \
    stop --timeout 30 cloudflared
}
rollback_completed=false
mutation_started=true
on_early_exit() {
  local exit_code="$?"
  trap '' HUP INT TERM
  trap - EXIT
  if [[ "$rollback_completed" != true ]]; then
    run_ingress_control_early quarantine-create || true
    quarantine_tunnel_early || quarantine_tunnel_early || true
  fi
  exit "$exit_code"
}
trap on_early_exit EXIT
trap 'trap "" HUP INT TERM; exit 129' HUP
trap 'trap "" HUP INT TERM; exit 130' INT
trap 'trap "" HUP INT TERM; exit 143' TERM

run_ingress_control_early quarantine-create || fatal "unable to create durable release quarantine"
quarantine_tunnel_early || quarantine_tunnel_early || {
  fatal "unable to stop public ingress after durable release quarantine"
}

[[ -d "$runtime_state_root" && ! -L "$runtime_state_root" ]] || fatal "runtime state root must be a real directory"
for identity_source in "$release_manifest" "$application_image_record_json" \
  "$application_image_record_env" "$firewall_policy" "$runner_runtime_record_json" "$runner_runtime_record"; do
  [[ -f "$identity_source" && ! -L "$identity_source" ]] || fatal "runtime identity source is missing or unsafe"
done
if [[ -z "$test_harness_root" ]]; then
  for trusted_input in "$runtime_state_root|runtime state root" "$release_manifest|release manifest" \
    "$application_image_record_json|application image JSON record" \
    "$application_image_record_env|application image environment record" \
    "$firewall_policy|host firewall policy" "$runner_runtime_record_json|runner runtime JSON record" \
    "$runner_runtime_record|runner runtime record"; do
    assert_trusted_not_writable "${trusted_input%%|*}" "${trusted_input#*|}"
  done
else
  [[ "$($stat_bin -Lc '%u:%a' -- "$runtime_state_root")" == "$EUID:750" ]] || fatal "test runtime state root must be caller-owned with mode 0750"
fi

record_root_real="$("$realpath_bin" -e -- "$release_record_root")"
record_real="$("$realpath_bin" -e -- "$release_record")"
case "$record_real" in
  "$record_root_real"/*) ;;
  *) fatal "release record is outside the configured release record root" ;;
esac
[[ -d "$record_real" && ! -L "$record_real" ]] || fatal "release record must be a real directory"
assert_trusted_not_writable "$record_root_real" "release record root"
assert_trusted_not_writable "$record_real" "release record"

record_release_id="${record_real##*/}"
[[ "$record_release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*$ ]] || fatal "release record directory has an invalid release id"
override="$record_real/previous-runtime.override.yaml"
record_status_file="$record_real/status.env"
record_git_file="$record_real/git-commit.txt"
previous_release_file="$record_real/previous-release-id.txt"
previous_git_file="$record_real/previous-git-commit.txt"
previous_images_file="$record_real/previous-running-images.tsv"
transition_file="$record_real/previous-runtime-transition.env"
mail_outbox_contract_file="$record_real/mail-outbox-contract.env"
for evidence in "$override" "$record_status_file" "$record_git_file" \
  "$previous_release_file" "$previous_git_file" "$previous_images_file"; do
  [[ -f "$evidence" && ! -L "$evidence" ]] || fatal "rollback evidence is incomplete"
done
[[ "$("$stat_bin" -Lc '%a' -- "$override")" == 600 ]] || fatal "rollback override must have mode 0600"
for evidence in "$override" "$record_status_file" "$record_git_file" "$previous_release_file" "$previous_git_file" "$previous_images_file"; do assert_trusted_not_writable "$evidence" "rollback evidence"; done

if [[ -e "$mail_outbox_contract_file" || -L "$mail_outbox_contract_file" ]]; then
  safe_path "$mail_outbox_contract_file" "mail outbox contract evidence"
  [[ -f "$mail_outbox_contract_file" && ! -L "$mail_outbox_contract_file" ]] || {
    fatal "mail outbox contract evidence must be a regular non-symlink file"
  }
  [[ "$("$stat_bin" -Lc '%a' -- "$mail_outbox_contract_file")" == 600 ]] || {
    fatal "mail outbox contract evidence must have mode 0600"
  }
  assert_trusted_not_writable "$mail_outbox_contract_file" "mail outbox contract evidence"
  mapfile -t mail_outbox_contract_lines <"$mail_outbox_contract_file"
  [[ "${#mail_outbox_contract_lines[@]}" == 6 \
    && "${mail_outbox_contract_lines[0]:-}" == SCHEMA_VERSION=1 \
    && "${mail_outbox_contract_lines[1]:-}" == MAIL_OUTBOX_PHASE=* \
    && "${mail_outbox_contract_lines[2]:-}" == OUTBOX_WORKER_MODE=* \
    && "${mail_outbox_contract_lines[3]:-}" == STORE_CUTOVER=* \
    && "${mail_outbox_contract_lines[4]:-}" == PREVIOUS_MAIL_OUTBOX_PHASE=* \
    && "${mail_outbox_contract_lines[5]:-}" == PREVIOUS_OUTBOX_WORKER_MODE=* ]] || {
    fatal "mail outbox contract evidence is malformed"
  }
  rollback_mail_phase="${mail_outbox_contract_lines[1]#MAIL_OUTBOX_PHASE=}"
  rollback_worker_mode="${mail_outbox_contract_lines[2]#OUTBOX_WORKER_MODE=}"
  rollback_store_cutover="${mail_outbox_contract_lines[3]#STORE_CUTOVER=}"
  rollback_previous_mail_phase="${mail_outbox_contract_lines[4]#PREVIOUS_MAIL_OUTBOX_PHASE=}"
  rollback_previous_worker_mode="${mail_outbox_contract_lines[5]#PREVIOUS_OUTBOX_WORKER_MODE=}"
  case "$rollback_mail_phase|$rollback_worker_mode|$rollback_store_cutover|$rollback_previous_mail_phase|$rollback_previous_worker_mode" in
    "dual-write-v1|fenced-postgres-v1|false|legacy-v0|legacy-direct-v1" \
      |"dual-write-v1|fenced-postgres-v1|false|dual-write-v1|fenced-postgres-v1" \
      |"store-v1|fenced-postgres-v1|true|dual-write-v1|fenced-postgres-v1" \
      |"store-v1|fenced-postgres-v1|false|store-v1|fenced-postgres-v1") ;;
    *) fatal "mail outbox contract evidence contains an invalid transition" ;;
  esac
  if [[ "$rollback_store_cutover" == true ]]; then
    fatal "mail store cutover is forward-only; the pre-cutover artifact cannot be restored"
  fi
  if [[ "$rollback_mail_phase" == store-v1 \
    && "$rollback_previous_mail_phase" != store-v1 ]]; then
    fatal "fenced mail rollback evidence does not name a fenced previous release"
  fi
fi

previous_release_id="$(<"$previous_release_file")"
previous_git_commit="$(<"$previous_git_file")"
[[ "$previous_release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*$ ]] || fatal "rollback has no retained prior release id"
[[ "$previous_git_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || fatal "rollback has no valid prior Git commit"
legacy_transition=false
retained_gateway_image=""
retained_gateway_identity=""
if [[ -e "$transition_file" || -L "$transition_file" ]]; then
  safe_path "$transition_file" "previous runtime transition evidence"
  [[ -f "$transition_file" && ! -L "$transition_file" ]] || {
    fatal "previous runtime transition evidence must be a regular non-symlink file"
  }
  [[ "$($stat_bin -Lc '%a' -- "$transition_file")" == 600 ]] || {
    fatal "previous runtime transition evidence must have mode 0600"
  }
  assert_trusted_not_writable "$transition_file" "previous runtime transition evidence"
  mapfile -t transition_lines <"$transition_file"
  [[ "${#transition_lines[@]}" == 8 \
    && "${transition_lines[0]:-}" == SCHEMA_VERSION=1 \
    && "${transition_lines[1]:-}" == MODE=legacy_pre_gateway \
    && "${transition_lines[2]:-}" == "PREVIOUS_RELEASE_ID=$previous_release_id" \
    && "${transition_lines[3]:-}" == "SOURCE_RELEASE_ID=$record_release_id" \
    && "${transition_lines[5]:-}" == RETAINED_SERVICE=runner-egress-gateway ]] || {
    fatal "previous runtime transition evidence is malformed or not bound to this rollback"
  }
  transition_source_commit="${transition_lines[4]#SOURCE_GIT_COMMIT=}"
  retained_gateway_image="${transition_lines[6]#RETAINED_IMAGE=}"
  retained_gateway_identity="${transition_lines[7]#RETAINED_IDENTITY=}"
  [[ "${transition_lines[4]}" == "SOURCE_GIT_COMMIT=$transition_source_commit" \
    && "$transition_source_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ \
    && "$transition_source_commit" == "$(<"$record_git_file")" \
    && "${transition_lines[6]}" == "RETAINED_IMAGE=$retained_gateway_image" \
    && "$retained_gateway_image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ \
    && "${transition_lines[7]}" == "RETAINED_IDENTITY=$retained_gateway_identity" \
    && "$retained_gateway_identity" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    fatal "previous runtime transition gateway identity is invalid"
  }
  legacy_transition=true
fi
previous_record="$release_record_root/$previous_release_id"
safe_path "$previous_record" "previous release record"
[[ -d "$previous_record" && ! -L "$previous_record" ]] || fatal "previous release record is not retained"
assert_trusted_not_writable "$previous_record" "previous release record"
previous_status_file="$previous_record/status.env"
previous_record_git_file="$previous_record/git-commit.txt"
previous_record_tree_file="$previous_record/git-tree.txt"
previous_application_record_file="$previous_record/application-image-record.json"
previous_application_sha_file="$previous_record/application-image-record-sha256.txt"
previous_deployed_images_file="$previous_record/deployed-service-images.tsv"
for evidence in "$previous_status_file" "$previous_record_git_file" "$previous_record_tree_file" \
  "$previous_application_record_file" "$previous_application_sha_file" "$previous_deployed_images_file"; do
  [[ -f "$evidence" && ! -L "$evidence" ]] || fatal "previous release evidence is incomplete"
done
for evidence in "$previous_status_file" "$previous_record_git_file" "$previous_record_tree_file" \
  "$previous_application_record_file" "$previous_application_sha_file" "$previous_deployed_images_file"; do
  assert_trusted_not_writable "$evidence" "previous release evidence"
done
previous_completed=false
while IFS= read -r status_line; do
  [[ "$status_line" == "result=completed" ]] && previous_completed=true
done <"$previous_status_file"
[[ "$previous_completed" == true ]] || fatal "previous release was not completed"
[[ "$(<"$previous_record_git_file")" == "$previous_git_commit" ]] || fatal "previous release Git evidence does not match"
previous_git_tree="$(<"$previous_record_tree_file")"
[[ "$previous_git_tree" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || fatal "previous release Git tree evidence is invalid"
previous_application_record_sha256="$(<"$previous_application_sha_file")"
[[ "$previous_application_record_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  fatal "previous application image record digest is invalid"
}
[[ "$(file_sha256 "$previous_application_record_file")" == "$previous_application_record_sha256" ]] || {
  fatal "previous application image record does not match its retained digest"
}

readonly -a restorable_services=(
  app
  runner-egress-gateway
  mail-worker
  reward-worker
  regrade-worker
  exam-finalization-worker
  practice-runner-recovery-worker
  project-review-correction-worker
  cloudflared
)
readonly -a managed_runtime_services=(
  app
  cloudflared
  exam-finalization-worker
  mail-worker
  postgres
  practice-runner-recovery-worker
  project-review-correction-worker
  regrade-worker
  reward-worker
  runner-egress-gateway
)
readonly -a previous_core=(
  app
  mail-worker
  reward-worker
  regrade-worker
  exam-finalization-worker
  practice-runner-recovery-worker
  project-review-correction-worker
  runner-egress-gateway
)

declare -A recorded_images=()
declare -A recorded_identities=()
recorded_line_count=0
while IFS=$'\t' read -r service image identity extra; do
  ((recorded_line_count += 1))
  [[ -n "$service" && -z "$extra" ]] || fatal "recorded runtime image evidence is malformed"
  case "$service" in
    app|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|practice-runner-recovery-worker|project-review-correction-worker|cloudflared|runner-egress-gateway) ;;
    *) fatal "recorded runtime image evidence names an unexpected service" ;;
  esac
  [[ ! ${recorded_images[$service]+present} ]] || fatal "recorded runtime image evidence contains a duplicate service"
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || fatal "recorded runtime image reference is not a canonical digest"
  [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || fatal "recorded runtime image identity is malformed"
  recorded_images[$service]="$image"
  recorded_identities[$service]="$identity"
done <"$previous_images_file"
if [[ "$legacy_transition" == true ]]; then
  [[ "$recorded_line_count" == "$(( ${#restorable_services[@]} - 1 ))" \
    && -z "${recorded_images[runner-egress-gateway]+present}" ]] || {
    fatal "recorded pre-gateway runtime image evidence is incomplete"
  }
  recorded_images[runner-egress-gateway]="$retained_gateway_image"
  recorded_identities[runner-egress-gateway]="$retained_gateway_identity"
else
  [[ "$recorded_line_count" == "${#restorable_services[@]}" ]] || {
    fatal "recorded runtime image evidence is incomplete"
  }
fi
for service in "${restorable_services[@]}"; do
  [[ ${recorded_images[$service]+present} ]] || fatal "recorded runtime image evidence is incomplete"
done

declare -A reviewed_images=()
declare -A reviewed_identities=()
reviewed_line_count=0
while IFS=$'\t' read -r service image identity extra; do
  ((reviewed_line_count += 1))
  [[ -n "$service" && -z "$extra" ]] || fatal "previous deployed image evidence is malformed"
  case "$service" in
    app|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|practice-runner-recovery-worker|project-review-correction-worker|cloudflared|runner-egress-gateway) ;;
    *) fatal "previous deployed image evidence names an unexpected service" ;;
  esac
  [[ ! ${reviewed_images[$service]+present} ]] || {
    fatal "previous deployed image evidence contains a duplicate service"
  }
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
    fatal "previous deployed image reference is not a canonical digest"
  }
  [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    fatal "previous deployed image identity is malformed"
  }
  reviewed_images[$service]="$image"
  reviewed_identities[$service]="$identity"
done <"$previous_deployed_images_file"
if [[ "$legacy_transition" == true ]]; then
  [[ "$reviewed_line_count" == "$(( ${#restorable_services[@]} - 1 ))" \
    && -z "${reviewed_images[runner-egress-gateway]+present}" ]] || {
    fatal "previous pre-gateway deployed image evidence is incomplete"
  }
  reviewed_images[runner-egress-gateway]="$retained_gateway_image"
  reviewed_identities[runner-egress-gateway]="$retained_gateway_identity"
else
  [[ "$reviewed_line_count" == "${#restorable_services[@]}" ]] || {
    fatal "previous deployed image evidence is incomplete"
  }
fi
for service in "${restorable_services[@]}"; do
  [[ "${recorded_images[$service]:-}" == "${reviewed_images[$service]:-}" \
    && "${recorded_identities[$service]:-}" == "${reviewed_identities[$service]:-}" ]] || {
    fatal "rollback runtime evidence is not bound to the previous completed release"
  }
done

load_release_pointer() {
  local path="$1" label="$2" key value
  local seen_release=false seen_commit=false
  LOADED_RELEASE_ID=""
  LOADED_GIT_COMMIT=""
  safe_path "$path" "$label"
  [[ -f "$path" && ! -L "$path" ]] || fatal "$label must be a regular non-symlink file"
  assert_trusted_not_writable "$path" "$label"
  while IFS='=' read -r key value; do
    case "$key" in
      release_id)
        [[ "$seen_release" == false ]] || fatal "$label repeats release_id"
        seen_release=true
        LOADED_RELEASE_ID="$value"
        ;;
      git_commit)
        [[ "$seen_commit" == false ]] || fatal "$label repeats git_commit"
        seen_commit=true
        LOADED_GIT_COMMIT="$value"
        ;;
      *) fatal "$label contains an unknown field" ;;
    esac
  done <"$path"
  [[ "$seen_release" == true && "$seen_commit" == true ]] || fatal "$label is incomplete"
  [[ "$LOADED_RELEASE_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*$ ]] || fatal "$label has an invalid release id"
  [[ "$LOADED_GIT_COMMIT" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || fatal "$label has an invalid Git commit"
}

record_git_commit="$(<"$record_git_file")"
[[ "$record_git_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || fatal "release record Git evidence is invalid"

record_status_id=""
record_result=""
record_stage=""
seen_status_id=false
seen_status_result=false
seen_status_stage=false
while IFS='=' read -r key value; do
  case "$key" in
    release_id)
      [[ "$seen_status_id" == false ]] || fatal "release status repeats release_id"
      seen_status_id=true
      record_status_id="$value"
      ;;
    result)
      [[ "$seen_status_result" == false ]] || fatal "release status repeats result"
      seen_status_result=true
      record_result="$value"
      ;;
    stage)
      [[ "$seen_status_stage" == false ]] || fatal "release status repeats stage"
      seen_status_stage=true
      record_stage="$value"
      ;;
    exit_code|schema_rollback) ;;
    *) fatal "release status contains an unknown field" ;;
  esac
done <"$record_status_file"
[[ "$seen_status_id" == true && "$seen_status_result" == true && "$seen_status_stage" == true ]] || fatal "release status is incomplete"
[[ "$record_status_id" == "$record_release_id" ]] || fatal "release status id does not match its record directory"
[[ "$record_result" == completed || "$record_result" == failed ]] || fatal "release status result is not rollback-eligible"

latest_candidate_pointer="$release_record_root/latest-candidate.env"
current_pointer="$release_record_root/current-release.env"
load_release_pointer "$latest_candidate_pointer" "latest candidate pointer"
latest_release_id="$LOADED_RELEASE_ID"
latest_git_commit="$LOADED_GIT_COMMIT"
[[ "$latest_release_id" == "$record_release_id" && "$latest_git_commit" == "$record_git_commit" ]] || {
  fatal "release record is not the latest candidate"
}

load_release_pointer "$current_pointer" "current release pointer"
current_release_id="$LOADED_RELEASE_ID"
current_git_commit="$LOADED_GIT_COMMIT"
if [[ "$record_result" == completed ]]; then
  [[ "$current_release_id" == "$record_release_id" && "$current_git_commit" == "$record_git_commit" ]] || {
    fatal "completed rollback record is not the currently deployed release"
  }
else
  case "$record_stage" in
    postgres|migrate|database-role-reconciliation|platform-seed|admin-bootstrap|core-start|internal-readiness|tunnel-start|public-readiness|complete) ;;
    *) fatal "failed release did not reach a rollback-eligible candidate stage" ;;
  esac
  [[ "$current_release_id" == "$previous_release_id" && "$current_git_commit" == "$previous_git_commit" ]] || {
    fatal "failed rollback record does not descend from the current release"
  }
fi

run_bounded() {
  "$timeout_bin" --signal=TERM --kill-after=10s "${stage_timeout}s" "$@"
}

record_rollback_runtime_state() {
  local inventory="$record_real/rollback-managed-containers.tsv"
  local active="$record_real/rollback-active-release.env"
  local service container_output container_id candidate_container inspected inspected_service inspected_name image identity extra
  local managed_sha manifest_sha firewall_sha runtime_sha
  : >"$inventory"
  for service in "${managed_runtime_services[@]}"; do
    container_output="$(run_bounded "${previous_compose[@]}" ps -q "$service")" || {
      fatal "unable to inspect restored managed container for $service"
    }
    container_id=""
    while IFS= read -r candidate_container; do
      [[ -n "$candidate_container" ]] || continue
      [[ -z "$container_id" ]] || fatal "restored managed service has multiple containers: $service"
      container_id="$candidate_container"
    done <<<"$container_output"
    [[ -n "$container_id" ]] || fatal "restored managed service has no container: $service"
    inspected="$(run_bounded "${docker_cli[@]}" inspect \
      --format '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Name}}\t{{.Config.Image}}\t{{.Image}}' \
      "$container_id")" || fatal "unable to inspect restored managed container: $service"
    IFS=$'\t' read -r inspected_service inspected_name image identity extra <<<"$inspected"
    [[ "$inspected_service" == "$service" && "$inspected_name" == "/learncoding-$service-1" && -z "$extra" ]] || {
      fatal "restored managed container identity is invalid: $service"
    }
    [[ "$image" =~ ^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[0-9a-f]{64}$ ]] || {
      fatal "restored managed image is not a canonical digest: $service"
    }
    [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || fatal "restored managed image identity is malformed: $service"
    if [[ "$service" != postgres ]]; then
      [[ "$image" == "${reviewed_images[$service]}" && "$identity" == "${reviewed_identities[$service]}" ]] || {
        fatal "restored managed image does not match the previous completed release: $service"
      }
    fi
    printf '%s\t%s\t%s\t%s\n' "$service" "learncoding-$service-1" "$image" "$identity" >>"$inventory"
  done
  "$chmod_bin" 0600 "$inventory"
  run_bounded "$sync_bin" -f -- "$inventory"
  run_bounded "$sync_bin" -f -- "$record_real"
  managed_sha="$(file_sha256 "$inventory")"
  manifest_sha="$(file_sha256 "$release_manifest")"
  firewall_sha="$(file_sha256 "$firewall_policy")"
  runtime_sha="$(file_sha256 "$runner_runtime_record")"
  {
    printf 'SCHEMA_VERSION=1\n'
    printf 'GIT_COMMIT=%s\n' "$previous_git_commit"
    printf 'GIT_TREE=%s\n' "$previous_git_tree"
    printf 'RELEASE_MANIFEST_SHA256=%s\n' "$manifest_sha"
    printf 'APPLICATION_IMAGE_RECORD_SHA256=%s\n' "$previous_application_record_sha256"
    printf 'COMPOSE_PROJECT=learncoding\n'
    printf 'COMPOSE_WORKDIR=/opt/learncoding\n'
    printf 'PUBLIC_ORIGIN=%s\n' "$public_origin"
    printf 'MANAGED_INVENTORY_SHA256=%s\n' "$managed_sha"
    printf 'FIREWALL_POLICY_SHA256=%s\n' "$firewall_sha"
    printf 'RUNNER_GUEST_RELEASE_SHA256=%s\n' "$manifest_sha"
    printf 'RUNNER_RUNTIME_IMAGES_SHA256=%s\n' "$runtime_sha"
  } >"$active"
  "$chmod_bin" 0600 "$active"
  run_bounded "$sync_bin" -f -- "$active"
  run_bounded "$sync_bin" -f -- "$record_real"
}

validate_runtime_state_target() {
  local path="$1" label="$2" identity uid gid mode links
  [[ ! -L "$path" ]] || fatal "$label must not be a symlink"
  [[ ! -e "$path" || -f "$path" ]] || fatal "$label must be a regular file"
  [[ -e "$path" ]] || return 0
  identity="$($stat_bin -Lc '%u:%g:%a' -- "$path")"
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
  safe_path "$target" "$label target"
  safe_path "$temporary" "$label temporary"
  validate_runtime_state_target "$target" "existing $label"
  if [[ -e "$target" ]]; then
    actual_sha="$(file_sha256 "$target")"
    [[ "$actual_sha" == "$expected_sha" ]] || fatal "existing $label does not match its content address"
    run_bounded "$sync_bin" -f -- "$target"
    run_bounded "$sync_bin" -f -- "$runtime_state_root"
    return 0
  fi
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fatal "$label temporary already exists"
  "$cat_bin" "$source" >"$temporary"
  "$chmod_bin" 0644 "$temporary"
  run_bounded "$sync_bin" -f -- "$temporary"
  actual_sha="$(file_sha256 "$temporary")"
  [[ "$actual_sha" == "$expected_sha" ]] || fatal "$label changed while being published"
  "$mv_bin" -- "$temporary" "$target"
  run_bounded "$sync_bin" -f -- "$target"
  run_bounded "$sync_bin" -f -- "$runtime_state_root"
  validate_runtime_state_target "$target" "published $label"
  [[ "$(file_sha256 "$target")" == "$expected_sha" ]] || fatal "published $label failed digest verification"
}

publish_rollback_runtime_state() {
  local inventory_source="$record_real/rollback-managed-containers.tsv"
  local application_source="$previous_application_record_file"
  local active_source="$record_real/rollback-active-release.env"
  local inventory_sha application_sha inventory_target application_target
  inventory_sha="$(file_sha256 "$inventory_source")"
  application_sha="$(file_sha256 "$application_source")"
  [[ "$application_sha" == "$previous_application_record_sha256" ]] || {
    fatal "previous application image record changed before runtime state publication"
  }
  inventory_target="$runtime_state_root/managed-containers.${inventory_sha}.tsv"
  application_target="$runtime_state_root/application-images.${application_sha}.json"
  rollback_inventory_temporary="$runtime_state_root/.managed-containers.${inventory_sha}.${record_release_id}.$$.tmp"
  rollback_application_temporary="$runtime_state_root/.application-images.${application_sha}.${record_release_id}.$$.tmp"
  rollback_active_temporary="$runtime_state_root/.active-release.${record_release_id}.$$.tmp"

  publish_immutable_runtime_blob \
    "$inventory_source" "$inventory_sha" "$inventory_target" \
    "$rollback_inventory_temporary" "managed container inventory"
  rollback_inventory_temporary=""
  publish_immutable_runtime_blob \
    "$application_source" "$application_sha" "$application_target" \
    "$rollback_application_temporary" "application image record"
  rollback_application_temporary=""

  safe_path "$active_release_state" "active release state"
  safe_path "$rollback_active_temporary" "active release temporary"
  validate_runtime_state_target "$active_release_state" "existing active release state"
  [[ ! -e "$rollback_active_temporary" && ! -L "$rollback_active_temporary" ]] || {
    fatal "active release temporary already exists"
  }
  "$cat_bin" "$active_source" >"$rollback_active_temporary"
  "$chmod_bin" 0644 "$rollback_active_temporary"
  run_bounded "$sync_bin" -f -- "$rollback_active_temporary"
  "$mv_bin" -f -- "$rollback_active_temporary" "$active_release_state"
  run_bounded "$sync_bin" -f -- "$active_release_state"
  run_bounded "$sync_bin" -f -- "$runtime_state_root"
  rollback_active_temporary=""
}

write_release_pointer() {
  local target="$1" release_id="$2" git_commit="$3" label="$4"
  local temporary="$release_record_root/.${label}.$$.tmp"
  safe_path "$target" "$label"
  safe_path "$temporary" "$label temporary"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fatal "$label temporary already exists"
  {
    printf 'release_id=%s\n' "$release_id"
    printf 'git_commit=%s\n' "$git_commit"
  } >"$temporary"
  "$chmod_bin" 0600 "$temporary"
  run_bounded "$sync_bin" -f -- "$temporary"
  "$mv_bin" -f -- "$temporary" "$target"
  run_bounded "$sync_bin" -f -- "$target"
  run_bounded "$sync_bin" -f -- "$release_record_root"
}

rollback_host_commit="$(run_bounded "$git_bin" -C "$repo_root" rev-parse --verify HEAD 2>/dev/null || true)"
[[ "$rollback_host_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
  fatal "unable to determine an exact lowercase rollback host Git commit"
}
rollback_host_tree="$(run_bounded "$git_bin" -C "$repo_root" rev-parse --verify "${rollback_host_commit}^{tree}" 2>/dev/null || true)"
[[ "$rollback_host_tree" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
  fatal "unable to determine an exact lowercase rollback host Git tree"
}
rollback_git_top="$(run_bounded "$git_bin" -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$rollback_git_top" \
  && "$("$realpath_bin" -e -- "$rollback_git_top")" == "$("$realpath_bin" -e -- "$repo_root")" ]] || {
  fatal "repository root is not the verified Git worktree root"
}
if ! rollback_git_dirty="$(run_bounded "$git_bin" -C "$repo_root" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
  fatal "unable to verify that the rollback checkout is clean"
fi
[[ -z "$rollback_git_dirty" ]] || {
  fatal "rollback checkout is dirty; reviewed bytes must match Git HEAD"
}
run_bounded "$python_bin" "$release_tree_packager" \
  --verify-source-manifest \
  --source "$repo_root" \
  --expected-commit "$rollback_host_commit" \
  --expected-tree "$rollback_host_tree" \
  --application-image-json "$application_image_record_json" \
  --application-image-env "$application_image_record_env" \
  --runner-runtime-json "$runner_runtime_record_json" \
  --runner-runtime-env "$runner_runtime_record" >/dev/null || {
  fatal "release manifest does not describe the exact clean rollback checkout and canonical runtime overlays"
}

readonly -a compose=(
  "${docker_cli[@]}" compose --project-name learncoding
  --env-file "$compose_env"
  -f "$compose_file"
)
readonly -a previous_compose=(
  "${compose[@]}"
  -f "$override"
)

mapfile -t override_lines <"$override"
[[ "${override_lines[0]:-}" == "services:" ]] || fatal "rollback override is malformed"
expected_line_count="$((1 + ${#restorable_services[@]} * 2))"
[[ "${#override_lines[@]}" == "$expected_line_count" ]] || fatal "rollback override has unexpected content"
for index in "${!restorable_services[@]}"; do
  service="${restorable_services[$index]}"
  service_line="${override_lines[$((1 + index * 2))]}"
  image_line="${override_lines[$((2 + index * 2))]}"
  [[ "$service_line" == "  $service:" ]] || fatal "rollback override service order is invalid"
  [[ "$image_line" =~ ^\ \ \ \ image:\ \"([^\"[:space:]]+@sha256:[0-9a-f]{64})\"$ ]] || {
    fatal "rollback override image is not a canonical digest"
  }
  image="${BASH_REMATCH[1]}"
  [[ "$image" == "${recorded_images[$service]}" ]] || {
    fatal "rollback override does not match the recorded runtime image"
  }
  image_id="$(run_bounded "${docker_cli[@]}" image inspect --format '{{.Id}}' "$image")" || {
    fatal "rollback image is not present locally"
  }
  image_id="${image_id//$'\r'/}"
  image_id="${image_id//$'\n'/}"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fatal "rollback image identity is malformed"
  [[ "$image_id" == "${recorded_identities[$service]}" ]] || {
    fatal "local rollback image no longer matches the recorded identity"
  }
done

rollback_inventory_temporary=""
rollback_application_temporary=""
rollback_active_temporary=""
quarantine_tunnel() {
  run_bounded "${compose[@]}" stop --timeout 30 cloudflared
}
run_ingress_control() {
  run_bounded "${ingress_control[@]}" "$@"
}
on_exit() {
  local exit_code="$?"
  local -a runtime_temporaries=()
  trap '' HUP INT TERM
  trap - EXIT
  if [[ "$rollback_completed" != true ]]; then
    [[ -n "$rollback_inventory_temporary" ]] && runtime_temporaries+=("$rollback_inventory_temporary")
    [[ -n "$rollback_application_temporary" ]] && runtime_temporaries+=("$rollback_application_temporary")
    [[ -n "$rollback_active_temporary" ]] && runtime_temporaries+=("$rollback_active_temporary")
    if (( ${#runtime_temporaries[@]} > 0 )); then
      "$rm_bin" -f -- "${runtime_temporaries[@]}" || true
      run_bounded "$sync_bin" -f -- "$runtime_state_root" || true
      rollback_inventory_temporary=""
      rollback_application_temporary=""
      rollback_active_temporary=""
    fi
  fi
  if [[ "$mutation_started" == true && "$rollback_completed" != true ]]; then
    run_ingress_control quarantine-create || true
    quarantine_tunnel || quarantine_tunnel || true
  fi
  exit "$exit_code"
}
trap on_exit EXIT
trap 'trap "" HUP INT TERM; exit 129' HUP
trap 'trap "" HUP INT TERM; exit 130' INT
trap 'trap "" HUP INT TERM; exit 143' TERM

run_smoke_phase() {
  run_bounded "$env_bin" \
    "DOCKER_HOST=unix:///var/run/docker.sock" \
    "COMPOSE_PROJECT_NAME=learncoding" \
    "COMPOSE_ENV_FILE=$compose_env" \
    "COMPOSE_FILE_PATH=$compose_file" \
    "$smoke_production_script" --phase "$1" --startup-wait "$startup_wait"
}

run_bounded "${previous_compose[@]}" up -d --no-build --pull never --remove-orphans \
  "${previous_core[@]}"
run_smoke_phase internal
run_bounded "${previous_compose[@]}" up -d --no-deps --no-build --pull never cloudflared
run_smoke_phase public

record_rollback_runtime_state
publish_rollback_runtime_state
write_release_pointer "$current_pointer" "$previous_release_id" "$previous_git_commit" current-release
write_release_pointer "$latest_candidate_pointer" "$previous_release_id" "$previous_git_commit" latest-candidate
rollback_result="previous_runtime_restored"
if [[ "$legacy_transition" == true ]]; then
  rollback_result="previous_runtime_restored_legacy_gateway_retained"
fi
printf '%s\t%s\t%s\n' "$("$date_bin" -u +'%Y-%m-%dT%H:%M:%SZ')" \
  "$previous_release_id" "$rollback_result" >>"$record_real/rollback-executions.tsv"
run_bounded "$sync_bin" -f -- "$record_real/rollback-executions.tsv"
run_bounded "$sync_bin" -f -- "$record_real"

run_ingress_control quarantine-clear || fatal "unable to clear durable release quarantine"
rollback_completed=true
printf 'production runtime restored to release %s; schema was not reversed\n' "$previous_release_id"
