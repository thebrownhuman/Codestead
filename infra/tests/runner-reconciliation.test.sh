#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash_bin=/usr/bin/bash
sh_bin=/usr/bin/sh
env_bin=/usr/bin/env
sha256_bin=/usr/bin/sha256sum
launcher="$repo_root/infra/runner/run-runner.sh"
launcher_shebang='#!/bin/sh'
launcher_reviewed_sha256='2e1e16226bf22428389c6fbd71100305023c8a374dbd23e2221182a4e237f838'
runner_unit="$repo_root/infra/runner/learncoding-runner.service.example"
runner_env="$repo_root/infra/env/runner.env.example"
tmp_base="$(cd /tmp && pwd -P)"
work="$(mktemp -d "$tmp_base/runner-reconciliation.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'runner reconciliation fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
lock_holder=""
cleanup() {
  if [[ -n "$lock_holder" ]]; then
    kill "$lock_holder" 2>/dev/null || true
    wait "$lock_holder" 2>/dev/null || true
  fi
  if [[ -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

fail() {
  if [[ "${RUNNER_HARNESS_ACTIVE:-0}" == 1 && -n "${runner_harness_failure_marker:-}" ]]; then
    printf '%s\n' "$*" >"$runner_harness_failure_marker"
  fi
  echo "FAIL: $*" >&2
  exit 1
}

source_manipulates_path() {
  local source="$1"
  local line
  local path_token_regex='(^|[^A-Za-z0-9_])PATH([^A-Za-z0-9_]|$)'

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ $path_token_regex ]] && return 0
  done <"$source"
  return 1
}

make_path_sealed_copy() {
  local source="$1"
  local destination="$2"
  local interpreter="$3"
  local expected_shebang="$4"
  local expected_sha256="$5"

  verify_exact_reviewed_shell_source "$source" "$interpreter" "$expected_shebang" "$expected_sha256" || return 1

  {
    printf '#!%s\n' "$interpreter"
    printf '%s\n' 'PATH='
    printf '%s\n' 'readonly PATH'
    tail -n +2 "$source"
  } >"$destination"
  chmod 0700 "$destination"
}

sha256_file() {
  local source="$1"
  local digest_line
  local digest

  digest_line="$("$sha256_bin" -- "$source")" || return 1
  digest="${digest_line%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

verify_exact_reviewed_shell_source() {
  local source="$1"
  local interpreter="$2"
  local expected_shebang="$3"
  local expected_sha256="$4"
  local first_line
  local shebang_count=0
  local line
  local actual_sha256

  [[ -f "$source" && ! -L "$source" ]] || return 1
  IFS= read -r first_line <"$source" || return 1
  [[ "$first_line" == "$expected_shebang" && "$first_line" != *$'\r'* ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || return 1
    [[ "$line" == '#!'* ]] && shebang_count=$((shebang_count + 1))
  done <"$source"
  (( shebang_count == 1 )) || return 1
  [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual_sha256="$(sha256_file "$source")" || return 1
  [[ "$actual_sha256" == "$expected_sha256" ]] || return 1
  "$interpreter" -n "$source" >/dev/null 2>&1
}

assert_source_identity_mutations() {
  local interpreter="$1"
  local expected_shebang="$2"
  local safe_source="$work/reviewed-source-safe.sh"
  local mutated_source="$work/reviewed-source-mutated.sh"
  local transformed="$work/reviewed-source-transformed.sh"
  local outside_sentinel="$work/reviewed-source-outside.sentinel"
  local safe_sha256
  local label
  local mutation

  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || fail 'could not hash the reviewed source mutation baseline'
  printf '%s' unchanged >"$outside_sentinel"

  while IFS='|' read -r label mutation; do
    {
      printf '%s\n' "$expected_shebang"
      printf '%s\n' 'set -e'
      printf '%s\n' "$mutation"
      printf '%s\n' 'printf reached >"$SOURCE_IDENTITY_SENTINEL"'
    } >"$mutated_source"
    rm -f -- "$transformed"
    if make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
      fail "reviewed source identity accepted $label mutation"
    fi
    [[ ! -e "$transformed" ]] || fail "reviewed source identity transformed $label mutation"
    [[ "$(<"$outside_sentinel")" == unchanged ]] || fail "reviewed source identity reached the sentinel for $label mutation"
  done <<'EOF'
dynamic-command-p|opt=-p; command "$opt" -v cp
dynamic-hash-p|opt=-p; d=/usr/bin; hash "$opt" "$d/cp" cp
assembled-absolute|d=/usr/bin; target="$d/cp"; command -v "$target"
new-shell|d=/usr/bin; shell="$d/sh"; "$shell" -c 'command -v cp'
dynamic-source|verb=source; "$verb" "$DYNAMIC_HELPER"
dynamic-dot-source|verb=.; "$verb" "$DYNAMIC_HELPER"
dynamic-env|verb=env; "$verb" command -v cp
dynamic-builtin|verb=builtin; "$verb" command -p -v cp
dynamic-exec|verb=exec; "$verb" /usr/bin/sh -c 'command -v cp'
EOF

  {
    printf '%s\n' '/usr/bin/cp -- "$SOURCE" "$DESTINATION"'
    printf '%s\n' 'set -e'
  } >"$mutated_source"
  rm -f -- "$transformed"
  if make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    fail 'reviewed source identity accepted a line-1 absolute command'
  fi
  [[ ! -e "$transformed" && "$(<"$outside_sentinel")" == unchanged ]] ||
    fail 'line-1 mutation reached transformation or the outside sentinel'

  printf '%s\n%s\n%s\n' "$expected_shebang" "$expected_shebang" 'set -e' >"$mutated_source"
  if make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    fail 'reviewed source identity accepted a duplicate shebang'
  fi
  printf '%s\r\n%s\r\n' "$expected_shebang" 'set -e' >"$mutated_source"
  if make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    fail 'reviewed source identity accepted CRLF source'
  fi
  rm -f -- "$work/reviewed-source-symlink.sh"
  ln -s "$safe_source" "$work/reviewed-source-symlink.sh"
  if [[ -L "$work/reviewed-source-symlink.sh" ]]; then
    if make_path_sealed_copy "$work/reviewed-source-symlink.sh" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
      fail 'reviewed source identity accepted a symlink source'
    fi
  fi
  rm -f -- "$work/reviewed-source-symlink.sh"
}

assert_path_mutation_defenses() {
  local interpreter="$1"
  local mutation_source="$work/path-mutation-source.sh"
  local sealed_mutation="$work/path-mutation-sealed.sh"
  local mutation_bin="$work/path-mutation-bin"
  local resolution="$work/path-mutation-resolution"
  local sentinel="$work/path-mutation-sentinel"
  local mutation
  local mutation_status
  local mutation_sha256

  mkdir -m 0700 "$mutation_bin"
  for mutation in \
    'PATH=/usr/bin:/bin' \
    'export PATH=/usr/bin:/bin' \
    'unset PATH' \
    'readonly PATH=/usr/bin:/bin'; do
    # command -v is a shell builtin; none of these probes executes cp.
    {
      printf '#!%s\n' "$interpreter"
      printf '%s\n' \
        'set -e' \
        "$mutation" \
        'command -v cp >"$PATH_MUTATION_RESOLUTION"' \
        'printf compromised >"$PATH_MUTATION_SENTINEL"'
    } >"$mutation_source"
    source_manipulates_path "$mutation_source" || fail "PATH static guard missed: $mutation"
    mutation_sha256="$(sha256_file "$mutation_source")" || fail 'could not hash PATH mutation source'
    rm -f -- "$sealed_mutation" "$resolution"
    make_path_sealed_copy "$mutation_source" "$sealed_mutation" "$interpreter" "#!$interpreter" "$mutation_sha256" ||
      fail 'could not create reviewed PATH mutation copy'
    printf '%s' unchanged >"$sentinel"
    set +e
    "$env_bin" -i PATH="$mutation_bin" PATH_MUTATION_RESOLUTION="$resolution" \
      PATH_MUTATION_SENTINEL="$sentinel" "$interpreter" "$sealed_mutation" \
      >"$work/path-mutation.stdout" 2>"$work/path-mutation.stderr"
    mutation_status=$?
    set -e

    (( mutation_status != 0 )) || fail "same-interpreter PATH mutation unexpectedly succeeded: $mutation"
    [[ ! -e "$resolution" ]] || fail "PATH mutation resolved a host executable before rejection: $mutation"
    [[ "$(<"$sentinel")" == unchanged ]] || fail "PATH mutation reached the outside sentinel: $mutation"
  done
}

make_runner_launcher_copy() {
  local source="$1"
  local destination="$2"
  local expected_sha256="$3"
  local flock_wrapper="$4"
  local node_wrapper="$5"
  local canonical_flock='if ! /usr/bin/flock --exclusive --nonblock 9; then'
  local canonical_node='exec /usr/bin/node /opt/learncoding/services/runner/dist/index.js'
  local line
  local line_number=0
  local flock_count=0
  local node_count=0
  local flock_line=0
  local node_line=0

  verify_exact_reviewed_shell_source "$source" "$sh_bin" "$launcher_shebang" "$expected_sha256" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    if [[ "$line" == "$canonical_flock" ]]; then
      flock_count=$((flock_count + 1))
      flock_line="$line_number"
    fi
    if [[ "$line" == "$canonical_node" ]]; then
      node_count=$((node_count + 1))
      node_line="$line_number"
    fi
  done <"$source"
  (( flock_count == 1 && node_count == 1 && flock_line < node_line )) || return 1

  {
    printf '#!%s\n' "$sh_bin"
    printf '%s\n' \
      'cat() { /usr/bin/cat "$@"; }' \
      'mkdir() { /usr/bin/mkdir "$@"; }' \
      'stat() { "${RUNNER_TEST_STAT_BIN:-/usr/bin/stat}" "$@"; }' \
      'id() { /usr/bin/id "$@"; }' \
      'chmod() { /usr/bin/chmod "$@"; }'
    printf '%s\n' 'PATH=' 'readonly PATH'
    tail -n +2 "$source" | while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$canonical_flock" ]]; then
        printf 'if ! %q --exclusive --nonblock 9; then\n' "$flock_wrapper"
      elif [[ "$line" == "$canonical_node" ]]; then
        printf 'exec %q /opt/learncoding/services/runner/dist/index.js\n' "$node_wrapper"
      else
        printf '%s\n' "$line"
      fi
    done
  } >"$destination"
  chmod 0700 "$destination"
  [[ "$(grep -Fxc -- "if ! $flock_wrapper --exclusive --nonblock 9; then" "$destination" || true)" == 1 ]] || return 1
  [[ "$(grep -Fxc -- "exec $node_wrapper /opt/learncoding/services/runner/dist/index.js" "$destination" || true)" == 1 ]] || return 1
  ! grep -Fq -- '/usr/bin/flock' "$destination" || return 1
  ! grep -Fq -- 'exec /usr/bin/node' "$destination" || return 1
}

write_runner_site_mutation() {
  local mutation="$1"
  local destination="$2"
  local canonical_flock='if ! /usr/bin/flock --exclusive --nonblock 9; then'
  local canonical_node='exec /usr/bin/node /opt/learncoding/services/runner/dist/index.js'
  local line

  : >"$destination"
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$mutation:$line" in
      "missing-flock:$canonical_flock") continue ;;
      "duplicate-flock:$canonical_flock") printf '%s\n%s\n' "$line" "$line" >>"$destination"; continue ;;
      "changed-flock:$canonical_flock") printf '%s\n' 'if ! /usr/bin/flock --exclusive --blocking 9; then' >>"$destination"; continue ;;
      "missing-node:$canonical_node") continue ;;
      "duplicate-node:$canonical_node") printf '%s\n%s\n' "$line" "$line" >>"$destination"; continue ;;
      "changed-node:$canonical_node") printf '%s\n' 'exec /usr/bin/node /opt/learncoding/services/runner/dist/other.js' >>"$destination"; continue ;;
      "reordered:$canonical_flock") printf '%s\n%s\n' "$canonical_node" "$line" >>"$destination"; continue ;;
      "reordered:$canonical_node") continue ;;
    esac
    printf '%s\n' "$line" >>"$destination"
  done <"$launcher"
}

assert_runner_site_mutations() {
  local flock_wrapper="$1"
  local node_wrapper="$2"
  local events="$3"
  local mutation
  local mutated_source="$work/runner-site-mutated.sh"
  local transformed="$work/runner-site-transformed.sh"
  local mutation_sha256

  for mutation in missing-flock duplicate-flock changed-flock missing-node duplicate-node changed-node reordered; do
    write_runner_site_mutation "$mutation" "$mutated_source"
    mutation_sha256="$(sha256_file "$mutated_source")" || fail "could not hash runner $mutation site mutation"
    rm -f -- "$transformed"
    if make_runner_launcher_copy "$mutated_source" "$transformed" "$mutation_sha256" "$flock_wrapper" "$node_wrapper"; then
      fail "runner launcher accepted $mutation absolute command-site mutation"
    fi
    [[ ! -e "$transformed" ]] || fail "runner launcher transformed $mutation absolute command-site mutation"
    [[ ! -s "$events" ]] || fail "runner $mutation site mutation reached a terminal wrapper"
  done
}

verify_fixed_outer_binary() {
  local binary="$1"
  local require_regular="${2:-false}"
  local metadata
  local owner
  local group
  local mode
  local mode_value

  [[ "$binary" == /usr/bin/* && -f "$binary" && -x "$binary" ]] || return 1
  [[ "$require_regular" != true || ! -L "$binary" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$binary")" || return 1
  IFS=: read -r owner group mode <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode))
  (( (mode_value & 8#022) == 0 ))
}

assert_containment_gate_mutations() {
  local sentinel="$work/containment-gate.sentinel"
  local rejected_bwrap="$work/rejected-bwrap"
  local candidate="$work/containment-gate-candidate"
  local status

  printf '%s' unchanged >"$sentinel"
  printf '#!%s\n%s\n' "$bash_bin" 'exit 77' >"$rejected_bwrap"
  {
    printf '#!%s\n' "$bash_bin"
    printf 'printf reached >%q\n' "$sentinel"
  } >"$candidate"
  chmod 0700 "$rejected_bwrap" "$candidate"
  verify_fixed_outer_binary "$work/missing-bwrap" true && fail 'missing containment binary was accepted'
  set +e
  "$env_bin" -i PATH= "$rejected_bwrap" --unshare-user --unshare-pid --unshare-net -- "$candidate" \
    >"$work/rejected-bwrap.stdout" 2>"$work/rejected-bwrap.stderr"
  status=$?
  set -e
  [[ "$status" == 77 ]] || fail 'rejected user namespace did not fail closed'
  [[ "$(<"$sentinel")" == unchanged ]] || fail 'rejected user namespace reached the SUT sentinel'
}

prepare_linux_containment() {
  local entry="$work/namespace-entry.sh"
  local empty="$work/namespace-empty"
  local repo_mask="$work/namespace-repo-mask"
  local outside="/tmp/learncoding-runner-containment-outside-$$"
  local binary
  local probe_status

  [[ "$(/usr/bin/uname -s 2>/dev/null || true)" == Linux && "$EUID" == 0 ]] || {
    echo 'FAIL: authoritative runner contract requires Ubuntu/Linux root with Bubblewrap user/mount/PID/network containment' >&2
    return 1
  }
  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/sh /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/flock /usr/bin/sleep; do
    verify_fixed_outer_binary "$binary" false || {
      echo "FAIL: containment outer binary is not fixed root-owned and non-writable: $binary" >&2
      return 1
    }
  done
  verify_fixed_outer_binary /usr/bin/bwrap true || {
    echo 'FAIL: /usr/bin/bwrap must be a regular root-owned non-writable authoritative test dependency' >&2
    return 1
  }

  mkdir -m 0700 -p "$empty/$(basename -- "$work")" "$repo_mask"
  {
    printf '#!%s\n' /usr/bin/bash
    printf 'readonly containment_work=%q\n' "$work"
    printf 'readonly containment_outside=%q\n' "$outside"
    printf 'readonly containment_repo=%q\n' "$repo_root"
    cat <<'EOF'
set -Eeuo pipefail
[[ "$EUID" == 0 && "$$" == 1 ]] || exit 90
capability_set_count=0
no_new_privs=
while IFS=$'\t ' read -r key value _; do
  case "$key" in
    CapEff:|CapPrm:|CapInh:|CapBnd:|CapAmb:)
      [[ "$value" =~ ^0+$ ]] || exit 91
      capability_set_count=$((capability_set_count + 1))
      ;;
    Groups:) [[ -z "${value:-}" ]] || exit 91 ;;
    NoNewPrivs:) no_new_privs="$value" ;;
  esac
done </proc/self/status
[[ "$capability_set_count" == 5 && "$no_new_privs" == 1 ]] || exit 91
interface_count=0
while IFS= read -r line; do
  case "$line" in
    *:*)
      interface="${line%%:*}"
      interface="${interface//[[:space:]]/}"
      [[ "$interface" == lo ]] || exit 92
      interface_count=$((interface_count + 1))
      ;;
  esac
done </proc/net/dev
[[ "$interface_count" == 1 ]] || exit 92
[[ ! -e /run/docker.sock && ! -e /run/libvirt/libvirt-sock && ! -e /dev/kvm ]] || exit 93
[[ ! -e /etc/passwd && ! -e /etc/learncoding && ! -e /root/.ssh && ! -e /var/lib/learncoding ]] || exit 94
[[ ! -e "$containment_repo/.env" && ! -e "$containment_repo/.git" ]] || exit 94
if { : >"$containment_outside"; } 2>/dev/null; then exit 95; fi
: >"$containment_work/.namespace-write-probe"
exec "$@"
EOF
  } >"$entry"
  chmod 0700 "$entry"
  containment_entry="$entry"
  containment_entry_sha256="$(sha256_file "$entry")" || return 1
  verify_exact_reviewed_shell_source "$entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || return 1

  containment_command=(
    /usr/bin/timeout --signal=KILL --kill-after=5s 45s
    /usr/bin/prlimit --nproc=64:64 --nofile=128:128 --core=0:0 --cpu=30:30 --
    /usr/bin/setpriv --clear-groups
    /usr/bin/bwrap
    --die-with-parent --new-session --unshare-user --uid 0 --gid 0
    --unshare-pid --unshare-net --unshare-ipc --unshare-uts --disable-userns
    --cap-drop ALL --as-pid-1
    --ro-bind / /
    --ro-bind "$empty" /etc
    --ro-bind "$empty" /home
    --ro-bind "$empty" /root
    --ro-bind "$empty" /run
    --ro-bind "$empty" /srv
    --ro-bind "$empty" /mnt
    --ro-bind "$empty" /media
    --ro-bind "$empty" /opt
    --ro-bind "$empty" /var/lib
    --ro-bind "$empty" /var/backups
    --ro-bind "$empty" /var/log
    --ro-bind "$empty" /tmp
    --ro-bind "$repo_mask" "$repo_root"
    --bind "$work" "$work"
    --ro-bind "$empty" "$empty" --ro-bind "$repo_mask" "$repo_mask"
    --ro-bind "$entry" "$entry"
    --ro-bind "$launcher_under_test" "$launcher_under_test"
    --ro-bind "$runner_flock_wrapper" "$runner_flock_wrapper"
    --ro-bind "$runner_node_wrapper" "$runner_node_wrapper"
    --proc /proc --dev /dev --chdir "$work"
    --
    /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all
    /usr/bin/bash "$entry"
  )

  set +e
  /usr/bin/env -i PATH= HOME="$work" "${containment_command[@]}" /usr/bin/bash -c ':' \
    >"$work/containment-preflight.stdout" 2>"$work/containment-preflight.stderr"
  probe_status=$?
  set -e
  (( probe_status == 0 )) || {
    echo 'FAIL: Bubblewrap containment preflight or mandatory user namespace was rejected' >&2
    return 1
  }
  [[ -f "$work/.namespace-write-probe" && ! -e "$outside" ]] || {
    echo 'FAIL: Bubblewrap containment did not prove fixture-only writes' >&2
    return 1
  }
}

declare -A verified_test_script_sha256=()
declare -A verified_test_script_shebang=()

register_verified_test_script() {
  local script="$1"
  local expected_shebang="$2"
  local interpreter="$3"
  local digest

  digest="$(sha256_file "$script")" || fail "could not hash strict test executable: $script"
  verify_exact_reviewed_shell_source "$script" "$interpreter" "$expected_shebang" "$digest" ||
    fail "strict test executable identity is not verified: $script"
  verified_test_script_sha256["$script"]="$digest"
  verified_test_script_shebang["$script"]="$expected_shebang"
}

assert_registered_test_script() {
  local script="$1"
  local expected_sha256="${verified_test_script_sha256[$script]:-}"
  local expected_shebang="${verified_test_script_shebang[$script]:-}"

  [[ -n "$expected_sha256" && -n "$expected_shebang" ]] ||
    fail "unregistered test executable cannot cross the containment boundary: $script"
  verify_exact_reviewed_shell_source "$script" "$bash_bin" "$expected_shebang" "$expected_sha256" ||
    fail "test executable changed after review: $script"
}

assert_containment_dependencies() {
  local binary

  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/sh /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/flock /usr/bin/sleep; do
    verify_fixed_outer_binary "$binary" false || fail "containment dependency changed: $binary"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true || fail 'Bubblewrap containment dependency changed'
}

assert_fixture_path() {
  local label="$1"
  local path="$2"

  case "$path" in
    "$work"|"$work"/*) ;;
    *) fail "$label escaped the verified temporary fixture" ;;
  esac
}

run_runner_sut() {
  local -a clean_environment=(PATH= HOME="$work")
  local -a read_only_test_scripts=()
  local -a execution_containment=()
  local variable
  local value
  local token
  local RUNNER_HARNESS_ACTIVE=1

  verify_exact_reviewed_shell_source "$launcher" "$sh_bin" "$launcher_shebang" "$launcher_reviewed_sha256" ||
    fail 'runner source changed after the reviewed transformation'
  verify_exact_reviewed_shell_source "$launcher_under_test" "$sh_bin" "#!$sh_bin" "$launcher_under_test_sha256" ||
    fail 'transformed runner launcher changed before execution'
  verify_exact_reviewed_shell_source "$runner_flock_wrapper" "$bash_bin" "#!$bash_bin" "$runner_flock_wrapper_sha256" ||
    fail 'strict flock wrapper changed before execution'
  verify_exact_reviewed_shell_source "$runner_node_wrapper" "$bash_bin" "#!$bash_bin" "$runner_node_wrapper_sha256" ||
    fail 'strict node wrapper changed before execution'
  verify_exact_reviewed_shell_source "$containment_entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" ||
    fail 'namespace entry changed before execution'
  assert_containment_dependencies

  for variable in RUNNER_SHARED_SECRET_FILE RUNNER_STATE_ROOT RUNNER_TEMP_ROOT TEST_DOCKER_LOG; do
    if [[ -v $variable ]]; then
      value="${!variable}"
      assert_fixture_path "$variable" "$value"
      clean_environment+=("$variable=$value")
    fi
  done
  for variable in RUNNER_MAX_CONCURRENCY RUNNER_MAX_QUEUE_DEPTH; do
    if [[ -v $variable ]]; then
      clean_environment+=("$variable=${!variable}")
    fi
  done
  if [[ -v RUNNER_DOCKER_BINARY ]]; then
    assert_fixture_path RUNNER_DOCKER_BINARY "$RUNNER_DOCKER_BINARY"
    assert_registered_test_script "$RUNNER_DOCKER_BINARY"
    clean_environment+=("RUNNER_DOCKER_BINARY=$RUNNER_DOCKER_BINARY")
    read_only_test_scripts+=("$RUNNER_DOCKER_BINARY")
  fi
  if [[ -v RUNNER_TEST_STAT_BIN ]]; then
    assert_fixture_path RUNNER_TEST_STAT_BIN "$RUNNER_TEST_STAT_BIN"
    assert_registered_test_script "$RUNNER_TEST_STAT_BIN"
    clean_environment+=("RUNNER_TEST_STAT_BIN=$RUNNER_TEST_STAT_BIN")
    read_only_test_scripts+=("$RUNNER_TEST_STAT_BIN")
  fi

  for token in "${containment_command[@]}"; do
    if [[ "$token" == --proc ]]; then
      for value in "${read_only_test_scripts[@]}"; do
        execution_containment+=(--ro-bind "$value" "$value")
      done
    fi
    execution_containment+=("$token")
  done
  /usr/bin/env -i "${clean_environment[@]}" "${execution_containment[@]}" /usr/bin/sh "$launcher_under_test"
}

runner_terminal_events="$work/runner-terminal-events.log"
runner_harness_failure_marker="$work/runner-harness-failure.log"
runner_flock_wrapper="$work/runner-flock-wrapper"
runner_node_wrapper="$work/runner-node-wrapper"
: >"$runner_terminal_events"
: >"$runner_harness_failure_marker"
{
  printf '#!%s\n' "$bash_bin"
  printf 'readonly runner_test_work=%q\n' "$work"
  printf 'readonly runner_test_events=%q\n' "$runner_terminal_events"
  cat <<'EOF'
set -Eeuo pipefail
[[ "$#" == 3 && "$1" == --exclusive && "$2" == --nonblock && "$3" == 9 ]] || exit 64
state_root="${RUNNER_STATE_ROOT:-}"
case "$state_root" in "$runner_test_work"/*) ;; *) exit 65 ;; esac
expected_lock="$state_root/.runner-process.lock"
[[ -f "$expected_lock" && ! -L "$expected_lock" && /proc/self/fd/9 -ef "$expected_lock" ]] || exit 66
printf '%s\n' 'flock --exclusive --nonblock 9' >>"$runner_test_events"
exec /usr/bin/flock --exclusive --nonblock 9
EOF
} >"$runner_flock_wrapper"
{
  printf '#!%s\n' "$bash_bin"
  printf 'readonly runner_test_events=%q\n' "$runner_terminal_events"
  cat <<'EOF'
set -Eeuo pipefail
[[ "$#" == 1 && "$1" == /opt/learncoding/services/runner/dist/index.js ]] || exit 64
printf '%s\n' 'node-terminal /opt/learncoding/services/runner/dist/index.js' >>"$runner_test_events"
exit 86
EOF
} >"$runner_node_wrapper"
chmod 0700 "$runner_flock_wrapper" "$runner_node_wrapper"
runner_flock_wrapper_sha256="$(sha256_file "$runner_flock_wrapper")" || fail 'could not hash strict runner flock wrapper'
runner_node_wrapper_sha256="$(sha256_file "$runner_node_wrapper")" || fail 'could not hash strict runner node wrapper'
verify_exact_reviewed_shell_source "$runner_flock_wrapper" "$bash_bin" "#!$bash_bin" "$runner_flock_wrapper_sha256" ||
  fail 'strict runner flock wrapper identity is not verified'
verify_exact_reviewed_shell_source "$runner_node_wrapper" "$bash_bin" "#!$bash_bin" "$runner_node_wrapper_sha256" ||
  fail 'strict runner node wrapper identity is not verified'

verify_exact_reviewed_shell_source "$launcher" "$sh_bin" "$launcher_shebang" "$launcher_reviewed_sha256" ||
  fail 'runner launcher source identity, shebang, regular-file, LF, or syntax contract is not reviewed'
assert_source_identity_mutations "$sh_bin" "$launcher_shebang"
if source_manipulates_path "$launcher"; then
  fail 'runner launcher may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$sh_bin"
assert_runner_site_mutations "$runner_flock_wrapper" "$runner_node_wrapper" "$runner_terminal_events"
launcher_under_test="$work/run-runner.sealed.sh"
make_runner_launcher_copy "$launcher" "$launcher_under_test" "$launcher_reviewed_sha256" "$runner_flock_wrapper" "$runner_node_wrapper" ||
  fail 'could not create the reviewed runner launcher test copy'
[[ "$(sed -n '7p' "$launcher_under_test")" == 'PATH=' && "$(sed -n '8p' "$launcher_under_test")" == 'readonly PATH' ]] ||
  fail 'runner launcher test copy did not seal PATH before the SUT body'
launcher_under_test_sha256="$(sha256_file "$launcher_under_test")" || fail 'could not hash transformed runner launcher'
verify_exact_reviewed_shell_source "$launcher_under_test" "$sh_bin" "#!$sh_bin" "$launcher_under_test_sha256" ||
  fail 'transformed runner launcher identity is not verified'

assert_containment_gate_mutations
prepare_linux_containment || exit 1
unset RUNNER_SHARED_SECRET_FILE RUNNER_STATE_ROOT RUNNER_TEMP_ROOT RUNNER_MAX_CONCURRENCY \
  RUNNER_MAX_QUEUE_DEPTH RUNNER_DOCKER_BINARY RUNNER_TEST_STAT_BIN TEST_DOCKER_LOG

printf '%s' 'runner-test-secret-is-at-least-thirty-two-bytes' >"$work/secret"
chmod 0440 "$work/secret"
printf '#!%s\n' "$bash_bin" >"$work/docker"
cat >>"$work/docker" <<'EOF'
set -eu
{
  printf '%q' "${1:-}"
  for argument in "${@:2}"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$TEST_DOCKER_LOG"
case "${1:-}" in
  ps)
    printf '%s\n' abc123 def456
    ;;
  rm)
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0755 "$work/docker"
register_verified_test_script "$work/docker" "#!$bash_bin" "$bash_bin"

set +e
RUNNER_SHARED_SECRET_FILE="$work/secret" \
  RUNNER_DOCKER_BINARY="$work/docker" \
  RUNNER_MAX_QUEUE_DEPTH=100 \
  RUNNER_STATE_ROOT="$work/state" \
  RUNNER_TEMP_ROOT="$work/tmp" \
  TEST_DOCKER_LOG="$work/docker.log" \
  run_runner_sut >/dev/null 2>&1
initial_status=$?
set -e
[[ "$initial_status" == 86 ]] || fail "strict node terminal wrapper returned unexpected status $initial_status"

[[ -d "$work/tmp" ]]
[[ "$(wc -l <"$work/docker.log" | tr -d ' ')" == "3" ]]
grep -Fxq 'ps --all --quiet --filter label=io.learncoding.runner.job=true' "$work/docker.log"
grep -Fxq 'rm --force abc123' "$work/docker.log"
grep -Fxq 'rm --force def456' "$work/docker.log"
[[ "$(wc -l <"$runner_terminal_events" | tr -d ' ')" == 2 ]] ||
  fail 'initial runner execution did not reach each strict terminal wrapper exactly once'
[[ "$(sed -n '1p' "$runner_terminal_events")" == 'flock --exclusive --nonblock 9' ]] ||
  fail 'initial runner execution did not preserve the exact flock terminal event'
[[ "$(sed -n '2p' "$runner_terminal_events")" == 'node-terminal /opt/learncoding/services/runner/dist/index.js' ]] ||
  fail 'initial runner execution did not terminate at the exact reviewed Node site'

assert_rejected_before_docker() {
  local label="$1"
  local assignment
  local rejection_status
  shift
  : >"$work/rejected-docker.log"
  set +e
  (
    export TEST_DOCKER_LOG="$work/rejected-docker.log"
    export RUNNER_DOCKER_BINARY="$work/docker"
    for assignment in "$@"; do
      case "$assignment" in
        RUNNER_SHARED_SECRET_FILE=*|RUNNER_STATE_ROOT=*|RUNNER_TEMP_ROOT=*|RUNNER_MAX_CONCURRENCY=*|RUNNER_MAX_QUEUE_DEPTH=*|RUNNER_TEST_STAT_BIN=*)
          export "$assignment"
          ;;
        *) fail "unreviewed runner test assignment: $assignment" ;;
      esac
    done
    run_runner_sut
  )
  rejection_status=$?
  set -e
  [[ ! -s "$runner_harness_failure_marker" ]] ||
    fail "$label encountered a harness integrity failure: $(<"$runner_harness_failure_marker")"
  if (( rejection_status == 0 )); then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  [[ ! -s "$work/rejected-docker.log" ]] || {
    echo "$label reached Docker before rejecting unsafe configuration" >&2
    exit 1
  }
}

assert_rejected_before_reconciliation() {
  local label="$1"
  local state_path="$2"
  local temp_path="$3"
  shift 3
  assert_rejected_before_docker "$label" "$@"
  [[ ! -e "$state_path" && ! -e "$temp_path" ]] || {
    echo "$label created state/temp before rejecting unsafe configuration" >&2
    exit 1
  }
}

assert_directory_empty() {
  local directory="$1"
  local -a entries=()
  shopt -s nullglob dotglob
  entries=("$directory"/*)
  shopt -u nullglob dotglob
  (( ${#entries[@]} == 0 )) || {
    echo "unsafe configuration wrote beneath $directory before rejection" >&2
    exit 1
  }
}

make_stat_ownership_override() {
  local bin_dir="$1"
  local target_path="$2"
  local override_kind="$3"
  local actual_uid
  local actual_gid
  actual_uid="$(id -u)"
  actual_gid="$(id -g)"
  mkdir -m 0700 "$bin_dir"
  printf '#!%s\n' "$bash_bin" >"$bin_dir/stat"
  cat >>"$bin_dir/stat" <<EOF
set -Eeuo pipefail
target="\${!#}"
[[ "\$#" == 4 && "\${1:-}" == -c && "\${3:-}" == -- && "\$target" == "$work"/* ]] || exit 97
if [[ "\$target" != "$target_path" ]]; then exec /usr/bin/stat "\$@"; fi
case "$override_kind:\${2:-}" in
  owner:%u) printf '%s\\n' 999999 ;;
  owner:%g) printf '%s\\n' "$actual_gid" ;;
  owner:%u:%g:%a) printf '%s\\n' "999999:$actual_gid:\$(/usr/bin/stat -c '%a' -- \"\$target\")" ;;
  group:%u) printf '%s\\n' "$actual_uid" ;;
  group:%g) printf '%s\\n' 999999 ;;
  group:%u:%g:%a) printf '%s\\n' "$actual_uid:999999:\$(/usr/bin/stat -c '%a' -- \"\$target\")" ;;
  *) exec /usr/bin/stat "\$@" ;;
  esac
EOF
  chmod 0755 "$bin_dir/stat"
  register_verified_test_script "$bin_dir/stat" "#!$bash_bin" "$bash_bin"
}

assert_rejected_before_reconciliation \
  'missing runner secret' \
  "$work/missing-secret-state" "$work/missing-secret-tmp" \
  RUNNER_SHARED_SECRET_FILE="$work/missing-secret" RUNNER_STATE_ROOT="$work/missing-secret-state" \
    RUNNER_TEMP_ROOT="$work/missing-secret-tmp" RUNNER_MAX_QUEUE_DEPTH=100 >/dev/null 2>&1

printf '%s' short >"$work/short-secret"
chmod 0440 "$work/short-secret"
assert_rejected_before_reconciliation \
  'short runner secret' \
  "$work/short-secret-state" "$work/short-secret-tmp" \
  RUNNER_SHARED_SECRET_FILE="$work/short-secret" RUNNER_STATE_ROOT="$work/short-secret-state" \
    RUNNER_TEMP_ROOT="$work/short-secret-tmp" RUNNER_MAX_QUEUE_DEPTH=100 >/dev/null 2>&1

cp "$work/secret" "$work/secret-bad-mode"
chmod 0640 "$work/secret-bad-mode"
assert_rejected_before_reconciliation \
  'secret mode must be exact 0440' \
  "$work/secret-mode-state" "$work/secret-mode-tmp" \
  RUNNER_SHARED_SECRET_FILE="$work/secret-bad-mode" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-mode-state" RUNNER_TEMP_ROOT="$work/secret-mode-tmp" \
    >/dev/null 2>&1

cp "$work/secret" "$work/secret-bad-owner"
chmod 0440 "$work/secret-bad-owner"
make_stat_ownership_override "$work/secret-owner-bin" "$work/secret-bad-owner" owner
assert_rejected_before_reconciliation \
  'secret owner must match the runner ownership contract' \
  "$work/secret-owner-state" "$work/secret-owner-tmp" \
  RUNNER_TEST_STAT_BIN="$work/secret-owner-bin/stat" RUNNER_SHARED_SECRET_FILE="$work/secret-bad-owner" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-owner-state" RUNNER_TEMP_ROOT="$work/secret-owner-tmp" \
    >/dev/null 2>&1

cp "$work/secret" "$work/secret-bad-group"
chmod 0440 "$work/secret-bad-group"
make_stat_ownership_override "$work/secret-group-bin" "$work/secret-bad-group" group
assert_rejected_before_reconciliation \
  'secret ownership group must match the runner' \
  "$work/secret-group-state" "$work/secret-group-tmp" \
  RUNNER_TEST_STAT_BIN="$work/secret-group-bin/stat" RUNNER_SHARED_SECRET_FILE="$work/secret-bad-group" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-group-state" RUNNER_TEMP_ROOT="$work/secret-group-tmp" \
    >/dev/null 2>&1

cp "$work/secret" "$work/secret-target"
chmod 0440 "$work/secret-target"
[[ "$(stat -c '%u:%g:%a' -- "$work/secret-target")" == "$(stat -c '%u:%g:%a' -- "$work/secret")" ]]
ln -s "$work/secret-target" "$work/secret-symlink"
assert_rejected_before_reconciliation \
  'secret symlink must be rejected' \
  "$work/secret-symlink-state" "$work/secret-symlink-tmp" \
  RUNNER_SHARED_SECRET_FILE="$work/secret-symlink" RUNNER_MAX_QUEUE_DEPTH=100 \
    RUNNER_STATE_ROOT="$work/secret-symlink-state" RUNNER_TEMP_ROOT="$work/secret-symlink-tmp" \
    >/dev/null 2>&1

assert_rejected_before_reconciliation \
  'wrong runner concurrency' \
  "$work/concurrency-state" "$work/concurrency-tmp" \
  RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_MAX_CONCURRENCY=3 RUNNER_STATE_ROOT="$work/concurrency-state" \
    RUNNER_TEMP_ROOT="$work/concurrency-tmp" RUNNER_MAX_QUEUE_DEPTH=100 >/dev/null 2>&1

while IFS='|' read -r queue_label queue_value; do
  queue_state="$work/queue-$queue_label-state"
  queue_temp="$work/queue-$queue_label-tmp"
  if [[ "$queue_label" == missing ]]; then
    assert_rejected_before_reconciliation \
      'queue depth missing' "$queue_state" "$queue_temp" \
      RUNNER_SHARED_SECRET_FILE="$work/secret" \
        RUNNER_STATE_ROOT="$queue_state" RUNNER_TEMP_ROOT="$queue_temp" >/dev/null 2>&1
  else
    assert_rejected_before_reconciliation \
      "queue depth $queue_label" "$queue_state" "$queue_temp" \
      RUNNER_MAX_QUEUE_DEPTH="$queue_value" RUNNER_SHARED_SECRET_FILE="$work/secret" \
        RUNNER_STATE_ROOT="$queue_state" RUNNER_TEMP_ROOT="$queue_temp" >/dev/null 2>&1
  fi
done <<'EOF'
missing|
zero|0
negative|-1
unbounded|unbounded
wrong|99
upper-bound|101
oversized|2147483647
EOF

mkdir -m 0755 "$work/bad-mode-state"
assert_rejected_before_docker \
  'unsafe runner state mode' \
  RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-mode-state" \
    RUNNER_TEMP_ROOT="$work/bad-mode-tmp" RUNNER_MAX_QUEUE_DEPTH=100 >/dev/null 2>&1
[[ ! -e "$work/bad-mode-state/.runner-process.lock" && ! -e "$work/bad-mode-tmp" ]]

mkdir -m 0700 "$work/bad-temp-state"
mkdir -m 0755 "$work/bad-mode-tmp"
assert_rejected_before_docker \
  'unsafe runner temp mode' \
  RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-temp-state" \
    RUNNER_TEMP_ROOT="$work/bad-mode-tmp" RUNNER_MAX_QUEUE_DEPTH=100 >/dev/null 2>&1
assert_directory_empty "$work/bad-mode-tmp"

mkdir -m 0700 "$work/bad-owner-temp-state" "$work/bad-owner-tmp"
make_stat_ownership_override "$work/temp-owner-bin" "$work/bad-owner-tmp" owner
assert_rejected_before_docker \
  'unsafe runner temp owner' \
  RUNNER_TEST_STAT_BIN="$work/temp-owner-bin/stat" RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/bad-owner-temp-state" \
    RUNNER_TEMP_ROOT="$work/bad-owner-tmp" RUNNER_MAX_QUEUE_DEPTH=100 >/dev/null 2>&1
assert_directory_empty "$work/bad-owner-tmp"

mkdir -m 0700 "$work/owner-state"
make_stat_ownership_override "$work/owner-bin" "$work/owner-state" owner
: >"$work/rejected-docker.log"
if RUNNER_TEST_STAT_BIN="$work/owner-bin/stat" TEST_DOCKER_LOG="$work/rejected-docker.log" RUNNER_DOCKER_BINARY="$work/docker" \
  RUNNER_SHARED_SECRET_FILE="$work/secret" RUNNER_STATE_ROOT="$work/owner-state" \
  RUNNER_TEMP_ROOT="$work/owner-tmp" RUNNER_MAX_QUEUE_DEPTH=100 run_runner_sut >/dev/null 2>&1; then
  echo 'unsafe runner state owner unexpectedly succeeded' >&2
  exit 1
fi
[[ ! -s "$work/rejected-docker.log" ]]
[[ ! -e "$work/owner-state/.runner-process.lock" && ! -e "$work/owner-tmp" ]]

printf '#!%s\n' "$bash_bin" >"$work/docker-invalid"
cat >>"$work/docker-invalid" <<'EOF'
set -eu
if [[ "${1:-}" == "ps" ]]; then printf '%s\n' 'not-a-container-id'; exit 0; fi
exit 91
EOF
chmod 0755 "$work/docker-invalid"
register_verified_test_script "$work/docker-invalid" "#!$bash_bin" "$bash_bin"
if RUNNER_SHARED_SECRET_FILE="$work/secret" \
  RUNNER_DOCKER_BINARY="$work/docker-invalid" \
  RUNNER_MAX_QUEUE_DEPTH=100 \
  RUNNER_STATE_ROOT="$work/invalid-state" \
  RUNNER_TEMP_ROOT="$work/invalid-tmp" \
  run_runner_sut >/dev/null 2>&1; then
  echo "runner launcher accepted an invalid Docker container id" >&2
  exit 1
fi
[[ -d "$work/invalid-tmp" ]]

mkdir -m 0700 "$work/locked-state"
: >"$work/locked-docker.log"
printf '%s' 'state-must-remain-unchanged' >"$work/locked-state/state-sentinel"
host_lock_path="$work/locked-state/.runner-process.lock"
[[ "$host_lock_path" == "$work/locked-state/.runner-process.lock" && ! -L "$host_lock_path" ]] ||
  fail 'host lock fixture path is not the exact reviewed temporary lock path'
/usr/bin/flock --exclusive --no-fork "$host_lock_path" \
  /usr/bin/bash -c ': >"$1"; exec /usr/bin/sleep 30' _ "$work/lock-ready" &
lock_holder=$!
for ((attempt = 0; attempt < 100; attempt++)); do
  [[ -f "$work/lock-ready" ]] && break
  /usr/bin/sleep 0.01
done
[[ -f "$work/lock-ready" ]]
[[ -f "$host_lock_path" && ! -L "$host_lock_path" ]] || fail 'host lock fixture is not a regular verified lock file'

contenders=()
flock_count_before="$(grep -Fxc -- 'flock --exclusive --nonblock 9' "$runner_terminal_events" || true)"
locked_terminal_count_before="$(grep -Fxc -- 'node-terminal /opt/learncoding/services/runner/dist/index.js' "$runner_terminal_events" || true)"
for ((attempt = 0; attempt < 12; attempt++)); do
  (
    if RUNNER_SHARED_SECRET_FILE="$work/secret" \
      RUNNER_DOCKER_BINARY="$work/docker" \
      RUNNER_MAX_QUEUE_DEPTH=100 \
      RUNNER_STATE_ROOT="$work/locked-state" \
      RUNNER_TEMP_ROOT="$work/locked-tmp" \
      TEST_DOCKER_LOG="$work/locked-docker.log" \
      run_runner_sut >/dev/null 2>&1; then
      echo "duplicate runner launcher unexpectedly acquired the process lock" >&2
      exit 1
    fi
  ) &
  contenders+=("$!")
done
for contender in "${contenders[@]}"; do
  if ! wait "$contender"; then
    [[ ! -s "$runner_harness_failure_marker" ]] ||
      fail "lock contender encountered a harness integrity failure: $(<"$runner_harness_failure_marker")"
    fail 'lock contender process failed outside the expected SUT rejection'
  fi
done
[[ ! -s "$runner_harness_failure_marker" ]] || fail "lock contender encountered a harness integrity failure: $(<"$runner_harness_failure_marker")"
flock_count_after="$(grep -Fxc -- 'flock --exclusive --nonblock 9' "$runner_terminal_events" || true)"
locked_terminal_count_after="$(grep -Fxc -- 'node-terminal /opt/learncoding/services/runner/dist/index.js' "$runner_terminal_events" || true)"
(( flock_count_after == flock_count_before + 12 )) || fail 'not every lock contender reached the exact strict flock wrapper once'
(( locked_terminal_count_after == locked_terminal_count_before )) || fail 'a lock contender reached the Node terminal wrapper'
[[ ! -s "$work/locked-docker.log" ]]
[[ ! -d "$work/locked-tmp" ]]
[[ "$(cat "$work/locked-state/state-sentinel")" == "state-must-remain-unchanged" ]]
kill "$lock_holder"
wait "$lock_holder" 2>/dev/null || true
lock_holder=""

terminal_count_before="$(grep -Fxc -- 'node-terminal /opt/learncoding/services/runner/dist/index.js' "$runner_terminal_events" || true)"
set +e
RUNNER_SHARED_SECRET_FILE="$work/secret" \
  RUNNER_DOCKER_BINARY="$work/docker" \
  RUNNER_MAX_QUEUE_DEPTH=100 \
  RUNNER_STATE_ROOT="$work/locked-state" \
  RUNNER_TEMP_ROOT="$work/locked-tmp" \
  TEST_DOCKER_LOG="$work/locked-docker.log" \
  run_runner_sut >/dev/null 2>&1
unlocked_status=$?
set -e
[[ "$unlocked_status" == 86 ]] || fail "unlocked runner did not terminate at the strict Node wrapper: $unlocked_status"
terminal_count_after="$(grep -Fxc -- 'node-terminal /opt/learncoding/services/runner/dist/index.js' "$runner_terminal_events" || true)"
(( terminal_count_after == terminal_count_before + 1 )) ||
  fail 'unlocked runner did not emit exactly one strict Node terminal event'
[[ "$(wc -l <"$work/locked-docker.log" | tr -d ' ')" == "3" ]]
grep -Fxq 'ps --all --quiet --filter label=io.learncoding.runner.job=true' "$work/locked-docker.log"
[[ "$(cat "$work/locked-state/state-sentinel")" == "state-must-remain-unchanged" ]]

contract_failures=()
expect_exact_assignment() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local count
  count="$(grep -Ec "^${key}=" "$file" || true)"
  if [[ "$count" != 1 ]] || ! grep -Fxq -- "$expected" "$file"; then contract_failures+=("$label"); fi
}

expect_exact_assignment "$runner_unit" Restart 'Restart=on-failure' 'runner unit must restart only on failure'
expect_exact_assignment "$runner_unit" RestartSec 'RestartSec=5s' 'runner unit must use a five-second restart delay'
expect_exact_assignment "$runner_unit" StateDirectoryMode 'StateDirectoryMode=0700' 'runner unit must retain a mode-0700 state directory'
expect_exact_assignment "$runner_unit" LimitCORE 'LimitCORE=0' 'runner unit must disable learner-memory core dumps'
expect_exact_assignment "$runner_env" RUNNER_HOST 'RUNNER_HOST=10.20.0.12' 'runner must bind only to the fixed private guest address'
expect_exact_assignment "$runner_env" RUNNER_PORT 'RUNNER_PORT=4100' 'runner must expose only the private API port'
expect_exact_assignment "$runner_env" RUNNER_MAX_CONCURRENCY 'RUNNER_MAX_CONCURRENCY=2' 'runner must expose exactly two concurrent slots'
expect_exact_assignment "$runner_env" RUNNER_MAX_QUEUE_DEPTH 'RUNNER_MAX_QUEUE_DEPTH=100' 'runner queue must use the reviewed finite depth'

start_limit_lines="$(grep -Ec '^StartLimitBurst=([1-9]|10)$' "$runner_unit" || true)"
all_start_limit_lines="$(grep -Ec '^StartLimitBurst=' "$runner_unit" || true)"
if [[ "$start_limit_lines" != 1 || "$all_start_limit_lines" != 1 ]]; then
  contract_failures+=('runner unit must set one nonzero bounded StartLimitBurst no greater than 10')
fi
if grep -Eiq '(^|[=:[:space:]])(0\.0\.0\.0|\[?::\]?)(:|$)|RUNNER_HOST=(localhost|127\.0\.0\.1)' "$runner_env"; then
  contract_failures+=('runner environment must not contain a wildcard, localhost, or public bind')
fi

if (( ${#contract_failures[@]} > 0 )); then
  echo 'runner unit/environment contract failed:' >&2
  for failure in "${contract_failures[@]}"; do printf -- '- %s\n' "$failure" >&2; done
  exit 1
fi

echo "runner-reconciliation-tests-ok"
