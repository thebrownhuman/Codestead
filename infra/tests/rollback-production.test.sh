#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rollback="$repo_root/infra/ops/rollback-production.sh"
fixture_generator="$repo_root/infra/tests/fixtures/create-release-tree-fixture.py"
ingress_control_script="$repo_root/infra/ops/ingress-control.py"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

chmod 0700 "$work"
mkdir -p "$work/bin" "$work/repo/infra/ops" "$work/repo/infra/runner-vm" \
  "$work/runtime-state" "$work/records/20260719T000000Z-1" "$work/records/20260719T000000Z-2"
chmod 0750 "$work/runtime-state"
touch "$work/repo/compose.yaml" "$work/compose.env"
printf '%s\n' 'APP_URL=https://pilot.example.test' >"$work/compose.env"
printf '%s\n' 'reviewed host firewall fixture' >"$work/repo/infra/runner-vm/host-runner.nft"
cp "$repo_root/infra/ops/package-release-tree.py" "$work/repo/infra/ops/package-release-tree.py"
cp "$ingress_control_script" "$work/repo/infra/ops/ingress-control.py"
chmod 0755 "$work/repo/infra/ops/package-release-tree.py"
chmod 0755 "$work/repo/infra/ops/ingress-control.py"
cat >"$work/repo/.gitignore" <<'EOF'
/RELEASE.SHA256SUMS
/dist
/services/runner/dist
EOF
git -C "$work/repo" init -q
git -C "$work/repo" config user.name 'Codestead rollback test'
git -C "$work/repo" config user.email 'rollback-test@codestead.invalid'
git -C "$work/repo" config core.autocrlf false
git -C "$work/repo" remote add origin https://github.com/example/codestead
git -C "$work/repo" add .gitignore compose.yaml infra/ops/package-release-tree.py infra/ops/ingress-control.py infra/runner-vm/host-runner.nft
git -C "$work/repo" commit -qm 'fixture rollback checkout'
/usr/bin/python3 "$fixture_generator" \
  --source "$work/repo" \
  --packager "$work/repo/infra/ops/package-release-tree.py" \
  --destination "$work/release-package" \
  >/dev/null || fail "unable to generate canonical rollback fixture"
cp "$work/repo/RELEASE.SHA256SUMS" "$work/valid-release-manifest"

previous_commit="1111111111111111111111111111111111111111"
candidate_commit="2222222222222222222222222222222222222222"
previous_tree="3333333333333333333333333333333333333333"
printf '%s\n' "$previous_commit" >"$work/records/20260719T000000Z-1/git-commit.txt"
printf '%s\n' "$previous_tree" >"$work/records/20260719T000000Z-1/git-tree.txt"
printf '%s\n' 'previous verified application image record bytes' \
  >"$work/records/20260719T000000Z-1/application-image-record.json"
previous_application_sha="$(sha256sum "$work/records/20260719T000000Z-1/application-image-record.json" | cut -d' ' -f1)"
printf '%s\n' "$previous_application_sha" >"$work/records/20260719T000000Z-1/application-image-record-sha256.txt"
printf '%s\n' 'result=completed' >"$work/records/20260719T000000Z-1/status.env"
printf '%s\n' '20260719T000000Z-1' >"$work/records/20260719T000000Z-2/previous-release-id.txt"
printf '%s\n' "$previous_commit" >"$work/records/20260719T000000Z-2/previous-git-commit.txt"
printf '%s\n' "$candidate_commit" >"$work/records/20260719T000000Z-2/git-commit.txt"
printf '%s\n' \
  'release_id=20260719T000000Z-2' \
  'result=failed' \
  'stage=public-readiness' \
  'exit_code=1' \
  'schema_rollback=not_attempted' >"$work/records/20260719T000000Z-2/status.env"
printf '%s\n' 'release_id=20260719T000000Z-1' "git_commit=$previous_commit" >"$work/records/current-release.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" >"$work/records/latest-candidate.env"
chmod 0600 "$work/records/current-release.env" "$work/records/latest-candidate.env"
{
  printf 'services:\n'
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '  %s:\n' "$service"
    printf '    image: "registry.example.test/codestead/previous-%s@sha256:%064d"\n' "$service" 7
  done
} >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
{
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '%s\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' \
      "$service" "$service" 7 8
  done
} >"$work/records/20260719T000000Z-2/previous-running-images.tsv"
{
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '%s\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' \
      "$service" "$service" 7 8
  done
} >"$work/records/20260719T000000Z-1/deployed-service-images.tsv"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"

cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

authority_error() {
  echo "fake docker requires the fixed daemon endpoint and Compose project" >&2
  exit 64
}

[[ "${1:-}" == --host && "${2:-}" == unix:///var/run/docker.sock ]] || authority_error
shift 2
if [[ "${1:-}" == compose ]]; then
  [[ "${2:-}" == --project-name && "${3:-}" == learncoding ]] || authority_error
  shift 3
  set -- compose "$@"
fi

if [[ "${1:-}" != image ]]; then
  marker="$FAKE_CONTROL_ROOT/control/release-quarantine"
  [[ -f "$marker" && ! -L "$marker" && "$(cat "$marker")" == codestead-release-quarantine-v1 ]] || {
    echo "rollback mutation ran without durable quarantine" >&2
    exit 97
  }
fi
(
  printf '%s' "${1:-}"
  shift || true
  printf '\t%s' "$@"
  printf '\n'
) >>"$FAKE_DOCKER_LOG"

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" && "${3:-}" == "--format" && "$#" == 5 ]]; then
  [[ "$5" == *@sha256:* ]] || exit 64
  printf 'sha256:%064d\n' 8
  exit 0
fi

if [[ "${1:-}" == "inspect" && "${2:-}" == "--format" && "$#" == 4 \
  && "$3" == '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Name}}\t{{.Config.Image}}\t{{.Image}}' ]]; then
  service="${4#restored-}"
  service="${service%-container}"
  case "$service" in
    app|cloudflared|exam-finalization-worker|mail-worker|practice-runner-recovery-worker|project-review-correction-worker|regrade-worker|reward-worker|runner-egress-gateway)
      if [[ "${FAKE_SCENARIO:-}" == legacy-gateway-transition && "$service" == runner-egress-gateway ]]; then
        printf '%s\t/learncoding-%s-1\tregistry.example.test/codestead/gateway@sha256:%064d\tsha256:%064d\n' \
          "$service" "$service" 9 8
      else
        printf '%s\t/learncoding-%s-1\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' \
          "$service" "$service" "$service" 7 8
      fi
      ;;
    postgres)
      printf 'postgres\t/learncoding-postgres-1\tregistry.example.test/codestead/postgres@sha256:%064d\tsha256:%064d\n' 6 6
      ;;
    *) exit 64 ;;
  esac
  exit 0
fi

[[ "${1:-}" == "compose" ]] || exit 64
shift
[[ "$1" == "--env-file" && "$2" == "$EXPECTED_COMPOSE_ENV" && "$3" == "-f" && "$4" == "$EXPECTED_COMPOSE_FILE" ]] || exit 64
shift 4
if [[ "${1:-}" == "-f" ]]; then
  [[ "$2" == "$EXPECTED_OVERRIDE" ]] || exit 64
  shift 2
fi
if [[ "$1" == "ps" && "$2" == "-q" && "$#" == 3 ]]; then
  printf 'restored-%s-container\n' "$3"
  exit 0
fi
if [[ "$1" == "stop" && "$2" == "--timeout" && "$3" == "30" && "$4" == "cloudflared" ]]; then
  stop_count="$(cat "$FAKE_QUARANTINE_STOP_COUNT")"
  stop_count="$((stop_count + 1))"
  printf '%s\n' "$stop_count" >"$FAKE_QUARANTINE_STOP_COUNT"
  if [[ "${FAKE_SCENARIO:-}" == quarantine-stop-failure && "$stop_count" -le 2 ]]; then
    exit 58
  fi
  if [[ "${FAKE_SCENARIO:-}" == signal-first-quarantine-stop && "$stop_count" == 1 ]]; then
    timeout_parent="$PPID"
    rollback_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    rollback_pid="${rollback_pid//[[:space:]]/}"
    [[ "$rollback_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    /bin/kill -TERM "$rollback_pid"
  fi
  if [[ "${FAKE_SCENARIO:-}" == repeated-signal-early-cleanup ]]; then
    timeout_parent="$PPID"
    rollback_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    rollback_pid="${rollback_pid//[[:space:]]/}"
    [[ "$rollback_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    case "$stop_count" in
      1)
        /bin/kill -TERM "$rollback_pid"
        exit 58
        ;;
      2)
        /bin/kill -HUP "$rollback_pid"
        /bin/kill -INT "$rollback_pid"
        exit 58
        ;;
    esac
  fi
  if [[ "${FAKE_SCENARIO:-}" == repeated-signal-late-cleanup && "$stop_count" == 2 ]]; then
    timeout_parent="$PPID"
    rollback_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    rollback_pid="${rollback_pid//[[:space:]]/}"
    [[ "$rollback_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    /bin/kill -TERM "$rollback_pid"
    /bin/kill -HUP "$rollback_pid"
    /bin/kill -INT "$rollback_pid"
    exit 58
  fi
  exit 0
fi
if [[ "$1" == "up" ]]; then
  [[ " $* " == *" --no-build "* && " $* " == *" --pull never "* ]] || exit 64
  exit 0
fi
exit 64
EOF
chmod 0755 "$work/bin/docker"

cat >"$work/bin/sync" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_SYNC_LOG"
if [[ "${FAKE_SCENARIO:-}" == "runtime-state-active-fsync-failure" ]]; then
  case "$*" in
    *"/.active-release."*".tmp") exit 62 ;;
  esac
fi
EOF
chmod 0755 "$work/bin/sync"

cat >"$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
swap_lock_path() {
  [[ -n "${FAKE_LOCK_SWAP_PATH:-}" ]] || exit 96
  mv -- "$FAKE_LOCK_SWAP_PATH" "$FAKE_LOCK_SWAP_PATH.detached"
  : >"$FAKE_LOCK_SWAP_PATH"
  chmod 0600 "$FAKE_LOCK_SWAP_PATH"
}
if [[ "${FAKE_SCENARIO:-}" == lock-path-swap-before-flock ]]; then
  swap_lock_path
fi
/usr/bin/flock "$@"
flock_status="$?"
if [[ "${FAKE_SCENARIO:-}" == lock-path-swap-after-flock ]]; then
  swap_lock_path
fi
exit "$flock_status"
EOF
chmod 0755 "$work/bin/flock"

cat >"$work/smoke-production.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock ]]
[[ "${COMPOSE_PROJECT_NAME:-}" == learncoding ]]
printf '%s\n' "$*" >>"$FAKE_SMOKE_LOG"
if [[ ("${FAKE_SCENARIO:-}" == "public-failure" \
  || "${FAKE_SCENARIO:-}" == "repeated-signal-late-cleanup") \
  && " $* " == *" --phase public "* ]]; then
  rm -f -- "$FAKE_CONTROL_ROOT/control/release-quarantine"
  exit 51
fi
EOF
chmod 0755 "$work/smoke-production.sh"

run_rollback() {
  local scenario="$1"
  shift
  local case_dir="$work/case-$scenario"
  local lock_file="${RUN_LOCK_FILE:-$case_dir/release.lock}"
  mkdir -p "$case_dir"
  : >"$case_dir/docker.log"
  : >"$case_dir/smoke.log"
  : >"$case_dir/sync.log"
  : >"$case_dir/stdout"
  : >"$case_dir/stderr"
  printf '0\n' >"$case_dir/quarantine-stop.count"
  if [[ "${RUN_LOCK_PRECREATE:-true}" == true && ! -e "$lock_file" && ! -L "$lock_file" ]]; then
    : >"$lock_file"
    chmod 0600 "$lock_file"
  fi
  set +e
  REPO_ROOT="$work/repo" \
    COMPOSE_ENV_FILE="$work/compose.env" \
    COMPOSE_FILE_PATH="$work/repo/compose.yaml" \
    RELEASE_LOCK_FILE="$lock_file" \
    RELEASE_RECORD_ROOT="$work/records" \
    RUNTIME_STATE_ROOT="$work/runtime-state" \
    SMOKE_PRODUCTION_SCRIPT="$work/smoke-production.sh" \
    FAKE_DOCKER_LOG="$case_dir/docker.log" \
    FAKE_SMOKE_LOG="$case_dir/smoke.log" \
    FAKE_SYNC_LOG="$case_dir/sync.log" \
    FAKE_SCENARIO="$scenario" \
    FAKE_LOCK_SWAP_PATH="${RUN_LOCK_SWAP_PATH:-}" \
    FAKE_QUARANTINE_STOP_COUNT="$case_dir/quarantine-stop.count" \
    FAKE_CONTROL_ROOT="$work" \
    EXPECTED_COMPOSE_ENV="$work/compose.env" \
    EXPECTED_COMPOSE_FILE="$work/repo/compose.yaml" \
    EXPECTED_OVERRIDE="$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
    bash "$rollback" --test-harness-root "$work" \
      --release-record "$work/records/20260719T000000Z-2" \
      --lock-timeout 1 --stage-timeout 5 --startup-wait 3 "$@" \
      >"$case_dir/stdout" 2>"$case_dir/stderr"
  ROLLBACK_STATUS=$?
  set -e
  ROLLBACK_CASE="$case_dir"
}

assert_only_quarantine_stops() {
  local log="$1" label="$2" line
  local command env_flag env_path file_flag file_path action timeout_flag seconds service extra
  local stop_count=0 marker="$work/control/release-quarantine"
  [[ -f "$marker" && ! -L "$marker" && "$(cat "$marker")" == codestead-release-quarantine-v1 ]] || {
    fail "$label did not retain an authentic durable quarantine"
  }
  while IFS= read -r line; do
    IFS=$'\t' read -r command env_flag env_path file_flag file_path action \
      timeout_flag seconds service extra <<<"$line"
    [[ "$command" == compose && "$env_flag" == --env-file \
      && "$env_path" == "$work/compose.env" && "$file_flag" == -f \
      && "$file_path" == "$work/repo/compose.yaml" && "$action" == stop \
      && "$timeout_flag" == --timeout && "$seconds" == 30 \
      && "$service" == cloudflared && -z "$extra" ]] || {
      fail "$label performed Docker work beyond tunnel quarantine"
    }
    stop_count="$((stop_count + 1))"
  done <"$log"
  (( stop_count >= 1 )) || fail "$label omitted tunnel quarantine"
}

printf '%s\n' 'APP_URL=https://127.0.0.1' >"$work/compose.env"
run_rollback ipv4-public-origin --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an IPv4 APP_URL as a public origin"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "invalid IPv4 APP_URL reached Docker"
grep -Fq 'canonical lowercase public HTTPS origin' "$ROLLBACK_CASE/stderr" || {
  fail "invalid IPv4 APP_URL rejection was not explicit"
}
printf '%s\n' 'APP_URL=https://pilot.example.test' >"$work/compose.env"
echo "ok - rollback rejects an IPv4 APP_URL before Docker"

authority_environment=(
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
for authority_variable in "${authority_environment[@]}"; do
  export "$authority_variable=attacker-controlled"
  run_rollback "ambient-${authority_variable,,}" --schema-backward-compatible
  unset "$authority_variable"
  [[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted ambient authority from $authority_variable"
  [[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "$authority_variable reached Docker"
  grep -Fq "$authority_variable is forbidden" "$ROLLBACK_CASE/stderr" || fail "$authority_variable rejection was not explicit"
done
echo "ok - rollback rejects ambient Docker and Compose authority before mutation"

grep -Fq -- '== /run/lock ]]; then' "$rollback" || {
  fail "rollback does not isolate the production /run/lock exception"
}
grep -Fq -- '== 0:0:1777 ]] || fatal "/run/lock must be exactly root:root mode 1777"' "$rollback" || {
  fail "rollback does not require exact root:root 1777 metadata for /run/lock"
}
echo "ok - rollback permits only the exact production /run/lock metadata contract"

grep -Fq '[[ -z "${RELEASE_LOCK_FILE+x}" ]] || fatal "RELEASE_LOCK_FILE is forbidden in production"' "$rollback" || {
  fail "rollback does not reject ambient production lock authority"
}

lock_attack_root="$work/lock-object-attacks"
mkdir -p "$lock_attack_root"
chmod 0700 "$lock_attack_root"

missing_lock="$lock_attack_root/missing.lock"
RUN_LOCK_FILE="$missing_lock" RUN_LOCK_PRECREATE=false \
  run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE RUN_LOCK_PRECREATE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback created and accepted a missing lock object"
[[ ! -e "$missing_lock" && ! -L "$missing_lock" ]] || fail "rollback created the missing lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "missing rollback lock reached Docker"

fifo_lock="$lock_attack_root/fifo.lock"
mkfifo "$fifo_lock"
exec 8<>"$fifo_lock"
RUN_LOCK_FILE="$fifo_lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
exec 8>&-
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a FIFO lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "FIFO lock object reached Docker"

symlink_target="$lock_attack_root/symlink-target.lock"
printf '%s\n' lock >"$symlink_target"
chmod 0600 "$symlink_target"
ln -s "$symlink_target" "$lock_attack_root/symlink.lock"
RUN_LOCK_FILE="$lock_attack_root/symlink.lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a symlink lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "symlink lock object reached Docker"

hardlink_target="$lock_attack_root/hardlink-target.lock"
printf '%s\n' lock >"$hardlink_target"
chmod 0600 "$hardlink_target"
ln "$hardlink_target" "$lock_attack_root/hardlink.lock"
RUN_LOCK_FILE="$lock_attack_root/hardlink.lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a multiply-linked lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "multiply-linked lock object reached Docker"

wrong_mode_lock="$lock_attack_root/wrong-mode.lock"
printf '%s\n' lock >"$wrong_mode_lock"
chmod 0644 "$wrong_mode_lock"
RUN_LOCK_FILE="$wrong_mode_lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback repaired and accepted a wrong-mode lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "wrong-mode lock object reached Docker"

wrong_owner_lock="$lock_attack_root/wrong-owner.lock"
printf '%s\n' lock >"$wrong_owner_lock"
chmod 0600 "$wrong_owner_lock"
chown 65534:65534 "$wrong_owner_lock"
RUN_LOCK_FILE="$wrong_owner_lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a wrong-owner lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "wrong-owner lock object reached Docker"
chown "$EUID:$(stat -c '%g' "$work")" "$wrong_owner_lock"

swap_lock="$lock_attack_root/path-swap.lock"
printf '%s\n' lock >"$swap_lock"
chmod 0600 "$swap_lock"
RUN_LOCK_FILE="$swap_lock" RUN_LOCK_SWAP_PATH="$swap_lock" \
  run_rollback lock-path-swap-after-flock --schema-backward-compatible
unset RUN_LOCK_FILE RUN_LOCK_SWAP_PATH
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a lock path replaced after flock"
[[ -f "$swap_lock.detached" ]] || fail "rollback lock path-swap hook did not execute"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "split rollback lock reached Docker"

run_rollback quarantine-stop-failure --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted two failed initial tunnel stops"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 3 ]] || {
  fail "rollback EXIT trap did not retry tunnel quarantine after initial stop failure"
}
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "initial rollback tunnel-stop failure"

run_rollback signal-first-quarantine-stop --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "signalled rollback unexpectedly completed"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 2 ]] || {
  fail "rollback signal trap did not retry tunnel quarantine"
}
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "signalled initial rollback tunnel stop"

run_rollback repeated-signal-early-cleanup --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 143 ]] || fail "repeated early rollback signals did not preserve the first TERM status"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 3 ]] || {
  fail "repeated early rollback signals aborted the bounded quarantine retry"
}
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "repeated early rollback cleanup signals"

run_rollback repeated-signal-late-cleanup --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 51 ]] || fail "repeated late rollback signals did not preserve the smoke failure status"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 3 ]] || {
  fail "repeated late rollback signals aborted the bounded quarantine retry"
}

echo "ok - rollback rejects unsafe lock object types, links, ownership, and mode"
echo "ok - rollback arms fail-closed signal and EXIT traps before initial quarantine"

rm -f "$work/repo/RELEASE.SHA256SUMS"
run_rollback missing-release-manifest --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a missing source manifest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "missing rollback manifest"
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

printf '%s\n' 'not a release manifest' >"$work/repo/RELEASE.SHA256SUMS"
run_rollback malformed-release-manifest --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a malformed source manifest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "malformed rollback manifest"
grep -Fq 'release manifest' "$ROLLBACK_CASE/stderr" || {
  fail "malformed rollback manifest rejection was not explicit"
}
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

head -n 1 "$work/valid-release-manifest" >>"$work/repo/RELEASE.SHA256SUMS"
run_rollback extra-release-manifest-record --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an extra manifest record"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "extra rollback manifest record"
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

{
  IFS= read -r first_manifest_record
  printf '0%s\n' "${first_manifest_record:1}"
  tail -n +2
} <"$work/valid-release-manifest" >"$work/repo/RELEASE.SHA256SUMS"
run_rollback tampered-release-manifest --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a tampered manifest digest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "tampered rollback manifest"
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"
echo "ok - rollback requires the exact canonical host release manifest under quarantine"

run_rollback missing-assertion
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted no schema compatibility assertion"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "unsafe rollback touched Docker"

chmod 0666 "$work/repo/compose.yaml"
run_rollback writable-compose --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a group/world-writable Compose file"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "writable Compose input reached Docker"
chmod 0644 "$work/repo/compose.yaml"

chmod 0775 "$work/smoke-production.sh"
run_rollback writable-smoke --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a group-writable root-executed smoke script"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "writable smoke input reached Docker"
chmod 0755 "$work/smoke-production.sh"

mv "$work/repo" "$work/real-repo"
ln -s "$work/real-repo" "$work/repo"
run_rollback symlinked-repo-parent --schema-backward-compatible
symlink_status="$ROLLBACK_STATUS"
symlink_case="$ROLLBACK_CASE"
rm "$work/repo"
mv "$work/real-repo" "$work/repo"
[[ "$symlink_status" != 0 ]] || fail "rollback accepted a repository path with a symlink component"
[[ ! -s "$symlink_case/docker.log" ]] || fail "symlinked rollback input reached Docker"

echo "ok - rollback rejects writable and symlinked root-executed inputs"

chown 65534:65534 "$work/repo/compose.yaml"
run_rollback wrong-owner-compose --schema-backward-compatible
wrong_owner_status="$ROLLBACK_STATUS"
wrong_owner_case="$ROLLBACK_CASE"
chown "$EUID:$(stat -c '%g' "$work")" "$work/repo/compose.yaml"
[[ "$wrong_owner_status" != 0 ]] || fail "rollback accepted a Compose file owned by another identity"
[[ ! -s "$wrong_owner_case/docker.log" ]] || fail "wrong-owner Compose input reached Docker"
grep -Eqi 'owned|dirty' "$wrong_owner_case/stderr" || {
  cat "$wrong_owner_case/stderr" >&2
  fail "wrong-owner rejection was not explicit"
}

echo "ok - rollback rejects root-executed input owned by another identity"

chmod 0666 "$work/records/20260719T000000Z-2/previous-running-images.tsv"
run_rollback writable-release-evidence --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted group/world-writable release evidence"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "writable release evidence"
chmod 0644 "$work/records/20260719T000000Z-2/previous-running-images.tsv"
grep -Fqi 'writable' "$ROLLBACK_CASE/stderr" || fail "writable evidence rejection was not explicit"
echo "ok - rollback rejects writable release evidence before rollback mutation"

printf '%s\n' 'result=failed' >"$work/records/20260719T000000Z-1/status.env"
run_rollback incomplete-previous --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an incomplete previous release"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "incomplete previous release"
printf '%s\n' 'result=completed' >"$work/records/20260719T000000Z-1/status.env"
echo "ok - rollback requires a retained completed previous release"

cp "$work/records/20260719T000000Z-2/previous-running-images.tsv" "$work/previous-running-images.bound.tsv"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" "$work/previous-runtime.bound.yaml"
sed -i 's#/previous-#/swapped-#g' "$work/records/20260719T000000Z-2/previous-running-images.tsv"
sed -i 's#/previous-#/swapped-#g' "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback swapped-reviewed-runtime --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted self-consistent runtime evidence not bound to the previous completed release"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "unbound rollback evidence"
mv "$work/previous-running-images.bound.tsv" \
  "$work/records/20260719T000000Z-2/previous-running-images.tsv"
mv "$work/previous-runtime.bound.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
echo "ok - rollback evidence is bound to the previous completed release inventory"

printf '%s\n' 'release_id=20260719T000000Z-9' 'git_commit=9999999999999999999999999999999999999999' \
  >"$work/records/latest-candidate.env"
run_rollback stale-release-record --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a release record that is not the latest candidate"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "stale release record"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/latest-candidate.env"

echo "ok - rollback rejects a stale release record before mutation"

cp "$work/records/current-release.env" "$work/rollback-pointer-before.env"
cp "$work/records/latest-candidate.env" "$work/rollback-candidate-before.env"
run_rollback runtime-state-active-fsync-failure --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback ignored active runtime state fsync failure"
[[ -f "$work/control/release-quarantine" ]] || fail "failed rollback did not leave durable quarantine"
cmp -s "$work/records/current-release.env" "$work/rollback-pointer-before.env" || {
  fail "rollback runtime state failure advanced the deployed pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/rollback-candidate-before.env" || {
  fail "rollback runtime state failure consumed the candidate pointer"
}
[[ ! -e "$work/runtime-state/active-release.env" ]] || {
  fail "rollback runtime state failure published an uncommitted active manifest"
}
[[ "$(grep -Fc $'stop\t--timeout\t30\tcloudflared' "$ROLLBACK_CASE/docker.log")" -ge 2 ]] || {
  fail "rollback runtime state failure did not re-quarantine the tunnel"
}
if find "$work/runtime-state" -mindepth 1 -maxdepth 1 -name '.*.tmp' -print -quit | grep -q .; then
  fail "rollback runtime state failure left a temporary publication artifact"
fi
echo "ok - rollback runtime state publication failure preserves the prior commit point"
rollback_application_blob="$work/runtime-state/application-images.${previous_application_sha}.json"
[[ -f "$rollback_application_blob" ]] || fail "failed rollback did not durably publish its pre-commit application record"
printf '%s\n' 'corrupted content-addressed rollback record' >"$rollback_application_blob"
run_rollback preexisting-runtime-state-corruption --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback overwrote a corrupted existing content-addressed record"
grep -Fq 'does not match its content address' "$ROLLBACK_CASE/stderr" || {
  fail "rollback content-address collision rejection was not explicit"
}
cmp -s "$work/records/current-release.env" "$work/rollback-pointer-before.env" || {
  fail "corrupted rollback content record advanced the deployed pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/rollback-candidate-before.env" || {
  fail "corrupted rollback content record consumed the candidate pointer"
}
[[ ! -e "$work/runtime-state/active-release.env" ]] || fail "corrupted rollback content record published an active manifest"
cat "$work/records/20260719T000000Z-1/application-image-record.json" >"$rollback_application_blob"
chmod 0644 "$rollback_application_blob"
echo "ok - rollback rejects a corrupted pre-existing content-addressed record"


run_rollback success --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 0 ]] || {
  cat "$ROLLBACK_CASE/stderr" >&2
  cat "$ROLLBACK_CASE/docker.log" >&2
  fail "valid rollback failed"
}
[[ ! -e "$work/control/release-quarantine" ]] || fail "successful rollback did not clear quarantine exactly once"
[[ "$(cat "$ROLLBACK_CASE/smoke.log")" == $'--phase internal --startup-wait 3\n--phase public --startup-wait 3' ]] || {
  fail "rollback did not smoke internal before public"
}
grep -Fq $'stop\t--timeout\t30\tcloudflared' "$ROLLBACK_CASE/docker.log" || fail "rollback did not quarantine tunnel first"
grep -Fq $'\t-f\t'"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"$'\tup\t-d\t--no-build\t--pull\tnever' \
  "$ROLLBACK_CASE/docker.log" || fail "rollback did not use recorded override with immutable flags"
if grep -Eq $'(^|\\t)(pull|build)(\\t|$)' "$ROLLBACK_CASE/docker.log"; then
  fail "rollback pulled or built an image"
fi
grep -Fxq 'release_id=20260719T000000Z-1' "$work/records/current-release.env" || fail "rollback pointer release id is wrong"
grep -Fxq "git_commit=$previous_commit" "$work/records/current-release.env" || fail "rollback pointer Git commit is wrong"
grep -Fq 'previous_runtime_restored' "$work/records/20260719T000000Z-2/rollback-executions.tsv" || fail "rollback audit evidence missing"
grep -Fxq 'release_id=20260719T000000Z-1' "$work/records/latest-candidate.env" || fail "latest candidate pointer did not advance after rollback"
grep -Fxq "git_commit=$previous_commit" "$work/records/latest-candidate.env" || fail "latest candidate Git pointer is wrong after rollback"
active_state="$work/runtime-state/active-release.env"
[[ -f "$active_state" && ! -L "$active_state" ]] || fail "rollback did not publish active release state"
active_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$active_state")"
active_application_sha="$(sed -n 's/^APPLICATION_IMAGE_RECORD_SHA256=//p' "$active_state")"
managed_state="$work/runtime-state/managed-containers.${active_managed_sha}.tsv"
application_state="$work/runtime-state/application-images.${active_application_sha}.json"
[[ -f "$managed_state" && ! -L "$managed_state" ]] || fail "rollback did not publish content-addressed managed container state"
[[ -f "$application_state" && ! -L "$application_state" ]] || fail "rollback did not publish content-addressed application image state"
[[ "$(stat -c '%a' "$active_state")" == 644 \
  && "$(stat -c '%a' "$managed_state")" == 644 \
  && "$(stat -c '%a' "$application_state")" == 644 ]] || {
  fail "rollback runtime state does not have protected mode 0644"
}
cmp -s "$managed_state" "$work/records/20260719T000000Z-2/rollback-managed-containers.tsv" || {
  fail "rollback inventory is not retained in its execution record"
}
cmp -s "$application_state" "$work/records/20260719T000000Z-1/application-image-record.json" || {
  fail "rollback published the current checkout record instead of the previous retained application image record"
}
if cmp -s "$application_state" "$work/repo/dist/application-images/application-images.json"; then
  fail "rollback recovery state was rebound to the different current checkout record"
fi
cmp -s "$active_state" "$work/records/20260719T000000Z-2/rollback-active-release.env" || {
  fail "rollback active state is not retained in its execution record"
}
[[ ! -e "$work/runtime-state/managed-containers.tsv" && ! -e "$work/runtime-state/application-images.json" ]] || {
  fail "rollback left a mutable fixed evidence path"
}
mapfile -t rollback_services < <(cut -f1 "$managed_state")
expected_rollback_services=(
  app cloudflared exam-finalization-worker mail-worker postgres
  practice-runner-recovery-worker project-review-correction-worker regrade-worker reward-worker runner-egress-gateway
)
[[ "${rollback_services[*]}" == "${expected_rollback_services[*]}" ]] || fail "rollback inventory coverage is invalid"
while IFS=$'\t' read -r service container _image _identity extra; do
  [[ -n "$service" && -z "$extra" && "$container" == "learncoding-$service-1" ]] || {
    fail "rollback inventory row is malformed"
  }
done <"$managed_state"
managed_sha="$(sha256sum "$managed_state" | cut -d' ' -f1)"
manifest_sha="$(sha256sum "$work/repo/RELEASE.SHA256SUMS" | cut -d' ' -f1)"
firewall_sha="$(sha256sum "$work/repo/infra/runner-vm/host-runner.nft" | cut -d' ' -f1)"
runtime_sha="$(sha256sum "$work/repo/services/runner/dist/runtime-images.env" | cut -d' ' -f1)"
expected_active="$(printf '%s\n' \
  'SCHEMA_VERSION=1' "GIT_COMMIT=$previous_commit" "GIT_TREE=$previous_tree" \
  "RELEASE_MANIFEST_SHA256=$manifest_sha" \
  "APPLICATION_IMAGE_RECORD_SHA256=$previous_application_sha" \
  'COMPOSE_PROJECT=learncoding' 'COMPOSE_WORKDIR=/opt/learncoding' \
  'PUBLIC_ORIGIN=https://pilot.example.test' "MANAGED_INVENTORY_SHA256=$managed_sha" \
  "FIREWALL_POLICY_SHA256=$firewall_sha" "RUNNER_GUEST_RELEASE_SHA256=$manifest_sha" \
  "RUNNER_RUNTIME_IMAGES_SHA256=$runtime_sha")"
[[ "$(cat "$active_state")" == "$expected_active" ]] || fail "rollback active manifest is not consumer-compatible"
grep -Fq -- "$managed_state" "$ROLLBACK_CASE/sync.log" || fail "rollback inventory was not fsynced"
grep -Fq -- "$application_state" "$ROLLBACK_CASE/sync.log" || fail "rollback application image record was not fsynced"
grep -Fq -- "$active_state" "$ROLLBACK_CASE/sync.log" || fail "rollback active state was not fsynced"
echo "ok - paste-ready rollback restores only exact local images and advances the pointer"

run_rollback repeated-stale-record --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an already-restored stale release record"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "already-restored stale release record"
echo "ok - successful rollback consumes the candidate state exactly once"

printf '%s\n' \
  'release_id=20260719T000000Z-2' \
  'result=completed' \
  'stage=complete' \
  'exit_code=0' \
  'schema_rollback=not_attempted' >"$work/records/20260719T000000Z-2/status.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/current-release.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/latest-candidate.env"
run_rollback public-failure --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted failed public smoke"
[[ -f "$work/control/release-quarantine" ]] || fail "failed public smoke did not recreate durable quarantine"
[[ "$(grep -Fc $'stop\t--timeout\t30\tcloudflared' "$ROLLBACK_CASE/docker.log")" -ge 2 ]] || {
  fail "failed rollback did not re-quarantine the tunnel"
}
grep -Fxq 'release_id=20260719T000000Z-2' "$work/records/current-release.env" || {
  fail "failed rollback changed the deployed release pointer"
}
echo "ok - failed rollback remains fail closed and preserves the current pointer"

run_rollback success --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 0 ]] || fail "rollback rerun did not recover from durable quarantine"
[[ ! -e "$work/control/release-quarantine" ]] || fail "successful rollback rerun did not clear durable quarantine"
echo "ok - failed rollback remains quarantined until a successful rerun"

cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" "$work/bad.override"
sed -i '3c\    image: "registry.example.test/codestead/previous-app:mutable"' "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback malformed --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a mutable image override"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "mutable rollback image override"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "malformed rollback reached smoke"
mv "$work/bad.override" "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
echo "ok - rollback rejects modified or mutable image evidence before mutation"

cp "$work/records/20260719T000000Z-2/previous-running-images.tsv" "$work/previous-running-images.good.tsv"
sed -i '1s/sha256:0000000000000000000000000000000000000000000000000000000000000008$/sha256:0000000000000000000000000000000000000000000000000000000000000009/' \
  "$work/records/20260719T000000Z-2/previous-running-images.tsv"
run_rollback tampered-identity --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted image identity evidence that no longer matches local storage"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "tampered rollback image identity"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "tampered identity evidence reached smoke"
mv "$work/previous-running-images.good.tsv" "$work/records/20260719T000000Z-2/previous-running-images.tsv"
echo "ok - rollback binds override references to recorded and local image identities"

printf '%s\n' \
  'release_id=20260719T000000Z-2' \
  'result=failed' \
  'stage=public-readiness' \
  'exit_code=1' \
  'schema_rollback=not_attempted' >"$work/records/20260719T000000Z-2/status.env"
printf '%s\n' 'release_id=20260719T000000Z-1' "git_commit=$previous_commit" \
  >"$work/records/current-release.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/latest-candidate.env"
grep -v '^runner-egress-gateway' "$work/records/20260719T000000Z-2/previous-running-images.tsv" \
  >"$work/legacy-previous-running-images.tsv"
mv "$work/legacy-previous-running-images.tsv" \
  "$work/records/20260719T000000Z-2/previous-running-images.tsv"
grep -v '^runner-egress-gateway' "$work/records/20260719T000000Z-1/deployed-service-images.tsv" \
  >"$work/legacy-deployed-service-images.tsv"
mv "$work/legacy-deployed-service-images.tsv" \
  "$work/records/20260719T000000Z-1/deployed-service-images.tsv"
{
  printf 'services:\n'
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '  %s:\n' "$service"
    if [[ "$service" == runner-egress-gateway ]]; then
      printf '    image: "registry.example.test/codestead/gateway@sha256:%064d"\n' 9
    else
      printf '    image: "registry.example.test/codestead/previous-%s@sha256:%064d"\n' "$service" 7
    fi
  done
} >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
{
  printf '%s\n' \
    'SCHEMA_VERSION=1' \
    'MODE=legacy_pre_gateway' \
    'PREVIOUS_RELEASE_ID=20260719T000000Z-1' \
    'SOURCE_RELEASE_ID=20260719T000000Z-2' \
    "SOURCE_GIT_COMMIT=$candidate_commit" \
    'RETAINED_SERVICE=runner-egress-gateway' \
    "RETAINED_IMAGE=registry.example.test/codestead/gateway@sha256:$(printf '%064d' 9)" \
    "RETAINED_IDENTITY=sha256:$(printf '%064d' 8)"
} >"$work/records/20260719T000000Z-2/previous-runtime-transition.env"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime-transition.env"
transition_path="$work/records/20260719T000000Z-2/previous-runtime-transition.env"
cp "$transition_path" "$work/valid-previous-runtime-transition.env"
sed -i "s/SOURCE_GIT_COMMIT=$candidate_commit/SOURCE_GIT_COMMIT=4444444444444444444444444444444444444444/" "$transition_path"
run_rollback tampered-legacy-transition --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted transition evidence bound to another candidate"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "unbound transition evidence"
grep -Fqi 'transition' "$ROLLBACK_CASE/stderr" || {
  fail "unbound transition evidence rejection was not explicit"
}
mv "$work/valid-previous-runtime-transition.env" "$transition_path"
chmod 0600 "$transition_path"
echo "ok - rollback rejects unbound pre-gateway transition evidence before rollback mutation"


run_rollback legacy-gateway-transition --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 0 ]] || {
  cat "$ROLLBACK_CASE/stderr" >&2
  fail "rollback rejected the exact versioned pre-gateway transition"
}
legacy_active="$work/runtime-state/active-release.env"
legacy_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$legacy_active")"
legacy_managed="$work/runtime-state/managed-containers.${legacy_managed_sha}.tsv"
grep -Fq $'runner-egress-gateway\tlearncoding-runner-egress-gateway-1\tregistry.example.test/codestead/gateway@sha256:' \
  "$legacy_managed" || fail "legacy rollback inventory does not expose the retained gateway version"
grep -Fq 'previous_runtime_restored_legacy_gateway_retained' \
  "$work/records/20260719T000000Z-2/rollback-executions.tsv" || {
  fail "legacy rollback audit does not name the mixed transition"
}
echo "ok - rollback restores pre-gateway services while retaining the reviewed gateway with explicit evidence"

echo "rollback-production-tests-ok"
