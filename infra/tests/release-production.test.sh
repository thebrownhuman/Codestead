#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deployment_guide="$repo_root/docs/deployment.md"
update_runbook="$repo_root/docs/runbooks/updates-and-rollback.md"
release_script="$repo_root/infra/ops/release-production.sh"
smoke_script="$repo_root/infra/ops/smoke-production.sh"
rollback_script="$repo_root/infra/ops/rollback-production.sh"
ingress_control_script="$repo_root/infra/ops/ingress-control.py"
guarded_start_script="$repo_root/infra/ops/start-production-stack.sh"
fixture_generator="$repo_root/infra/tests/fixtures/create-release-tree-fixture.py"
dispatch_binding_boundary_commit=b73788a4b4d213e6423d737050b9e14c6a5d91b5
dispatch_binding_capability_path=infra/ops/mail-outbox-dispatch-binding-capability.env
dispatch_binding_capability_blob=ea707715f84608b1e1a33ac1832d533b878b6c07
dispatch_binding_runtime_capability=exact-adapter-payload-sha256-before-provider-call-v1
dispatch_binding_privilege_contract=owner-execute-worker-columns-update-only-no-grant-option-trigger-v1
dispatch_binding_registry_row="0064_mail_outbox_dispatch_binding|$dispatch_binding_boundary_commit|$dispatch_binding_capability_path|100644|$dispatch_binding_capability_blob|SCHEMA_VERSION=1|OUTBOX_WORKER_MODE=fenced-postgres-v1|DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability|DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract"
guarded_delivery_boundary_commit=7eeafd73c5d41ea49526d908165e0a7cefa92097
guarded_delivery_redaction_migration_path=drizzle/0068_mail_outbox_quarantine_redaction_authority_v2.sql
guarded_delivery_redaction_migration_blob=1188c910c5f89c902110349a1fc7564c6c9b1bfd
guarded_delivery_migration_path=drizzle/0069_mail_outbox_guarded_delivery_authority.sql
guarded_delivery_migration_blob=a957b7b13445fee8174677c69e7cedb542d74eee
guarded_delivery_migration_diagnostic='guarded delivery migration is absent or does not match the reviewed Git blob'
guarded_delivery_capability_path=infra/ops/mail-outbox-guarded-delivery-capability.env
guarded_delivery_capability_blob=2b0cd7af4b6d7a39756e94485aa370abfb6e2acf
guarded_delivery_runtime_capability=guarded-prepared-dispatch-tx1-tx2-exact-byte-v1
delivery_release_authority_contract=append-only-task7-release-receipt-v1
guarded_delivery_privilege_contract=owner-app-worker-release-receipt-least-privilege-v1
guarded_delivery_registry_row="0069_mail_outbox_guarded_delivery_authority|$guarded_delivery_boundary_commit|$guarded_delivery_capability_path|100644|$guarded_delivery_capability_blob|SCHEMA_VERSION=1|OUTBOX_WORKER_MODE=fenced-postgres-v1|GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability|DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract|GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract"
compose_unit="$repo_root/infra/systemd/learncoding-compose.service"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[[ "$EUID" == 0 ]] || fail "release and rollback behavioral tests require root"
chmod 0700 "$work"
[[ ! -L "$work" && -d "$work" ]] || fail "test temporary root is not a real directory"
[[ "$(stat -c '%u:%a' -- "$work")" == "0:700" ]] || {
  fail "test temporary root is not private and root-owned"
}
[[ -z "${GIT_CONFIG_COUNT+x}" && -z "${GIT_CONFIG_PARAMETERS+x}" ]] || {
  fail "ambient Git configuration injection is forbidden"
}
source_git_config="$work/source-git.config"
(
  umask 077
  : >"$source_git_config"
)
[[ ! -L "$source_git_config" && -f "$source_git_config" ]] || {
  fail "source Git configuration is not a regular file"
}
[[ "$(stat -c '%u:%a' -- "$source_git_config")" == "0:600" ]] || {
  fail "source Git configuration is not private and root-owned"
}
export GIT_CONFIG_GLOBAL="$source_git_config"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$source_git_config" --add safe.directory "$repo_root" || {
  fail "unable to trust the exact source repository"
}
mapfile -t source_safe_directories < <(
  git config --file "$source_git_config" --get-all safe.directory
)
[[ "${#source_safe_directories[@]}" == 1 \
  && "${source_safe_directories[0]}" == "$repo_root" ]] || {
  fail "source Git configuration does not contain only the exact repository"
}

[[ -x "$release_script" ]] || fail "release-production.sh is missing or not executable"
[[ -x "$rollback_script" ]] || fail "rollback-production.sh is missing or not executable"
for capability_consumer in "$release_script" "$rollback_script"; do
  grep -Fq "$dispatch_binding_registry_row" "$capability_consumer" || {
    fail "release and rollback must share the exact pinned capability registry row"
  }
  grep -Fq "readonly mail_outbox_dispatch_binding_capability_blob=$dispatch_binding_capability_blob" \
    "$capability_consumer" || fail "capability consumer does not pin the reviewed Git blob"
  grep -Fq "$guarded_delivery_registry_row" "$capability_consumer" || {
    fail "release and rollback must share the exact pinned 0069 capability registry row"
  }
  grep -Fq "readonly mail_outbox_guarded_delivery_capability_blob=$guarded_delivery_capability_blob" \
    "$capability_consumer" || fail "capability consumer does not pin the reviewed 0069 Git blob"
done
grep -Fq "load_dispatch_binding_capability \"\$release_commit\" \"\$release_tree\" \"source image\"" \
  "$release_script" || fail "release capability is not bound to the verified source tree"
grep -Fq "load_dispatch_binding_capability \"\$previous_git_commit\" \"\$previous_git_tree\" \"previous image\"" \
  "$release_script" || fail "release capability is not bound to previous Git tree evidence"


grep -Fq 'same NUC' "$deployment_guide" || fail "deployment guide does not place the isolated runner guest on the same NUC"
grep -Fq 'browser-durable outbox' "$deployment_guide" || {
  fail "deployment guide does not require browser-durable lesson and exam outboxes before invitations"
}
grep -Fq 'survive browser close/reopen and synchronize exactly once' "$deployment_guide" || {
  fail "deployment guide omits browser close/reopen recovery evidence"
}
grep -Fq 'final keystroke' "$deployment_guide" || fail "deployment guide overstates the no-UPS durability boundary"
if grep -Fq 'Browser-local crash durability remains a separate implementation' "$deployment_guide"; then
  fail "deployment guide still defers mandatory browser durability"
fi
grep -Fq "\`0062_mail_outbox_retention_redaction\` is a forward-only authority boundary" "$update_runbook" || {
  fail "update runbook omits the 0062 retention-authority boundary"
}
grep -Fq "\`0064_mail_outbox_dispatch_binding\` is a second forward-only authority boundary" \
  "$update_runbook" || fail "update runbook omits the 0064 dispatch-binding boundary"
grep -Fq "\`0069_mail_outbox_guarded_delivery_authority\` is a third forward-only authority boundary" \
  "$update_runbook" || fail "update runbook omits the 0069 guarded-delivery boundary"
grep -Fq 'No authority boundary after 0069 has an approved introduction SHA' "$update_runbook" || {
  fail "update runbook invents or omits the future additive authority rule"
}
grep -Fq 'requires the exact checked-in dispatch-binding capability contract' \
  "$deployment_guide" || {
  fail "deployment guide omits the checked-in 0064 runtime capability gate"
}
grep -Fq '0069_mail_outbox_guarded_delivery_authority' "$deployment_guide" \
  && grep -Fq 'V4 evidence binds the guarded TX1/TX2 exact-byte runtime' "$deployment_guide" || {
  fail "deployment guide omits the candidate-bound 0069 runtime capability gate"
}
grep -Fq 'PREVIOUS_RUNTIME_COMPATIBLE=true' "$update_runbook" || {
  fail "update runbook omits the versioned compatibility evidence gate"
}
grep -Fq 'fenced-postgres-v1 cannot roll back to legacy-direct-v1' "$update_runbook" || {
  fail "update runbook omits the claimant rollback boundary"
}
grep -Fq "never authorizes rollback across \`0062_mail_outbox_retention_redaction\`" "$deployment_guide" || {
  fail "deployment guide overstates the schema compatibility flag across 0062"
}

mkdir -p "$work/bin" "$work/data" "$work/repo/infra/ops" "$work/repo/infra/runner-vm" \
  "$work/run" "$work/secrets"
touch "$work/run/learncoding-backup.lock"
chmod 0600 "$work/run/learncoding-backup.lock"
touch "$work/repo/compose.yaml" "$work/compose.env"
cat >"$work/compose.env" <<EOF
APP_URL=https://pilot.example.test
POSTGRES_IMAGE=registry.example.test/postgres@sha256:1111111111111111111111111111111111111111111111111111111111111111
POSTGRES_UID=999
POSTGRES_GID=999
LEARN_DATA_ROOT=$work/data
UPLOADS_ENABLED=false
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
EOF
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
printf '%s' 'do-not-log-this-temporary-password' >"$work/secrets/bootstrap_admin_password"
git -C "$work/repo" init -q
git -C "$work/repo" config user.name 'Codestead release test'
git -C "$work/repo" config user.email 'release-test@codestead.invalid'
git -C "$work/repo" config core.autocrlf false
git -C "$work/repo" remote add origin https://github.com/example/codestead
git -C "$work/repo" add .gitignore compose.yaml infra/ops/package-release-tree.py infra/ops/ingress-control.py infra/runner-vm/host-runner.nft
git -C "$work/repo" commit -qm 'fixture release commit'

declare -a source_git
if source_git_dir="$(
  git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
)"; then
  source_git=(git -C "$repo_root")
else
  if ! command -v git.exe >/dev/null || ! command -v wslpath >/dev/null; then
    fail "source Git repository is unavailable"
  fi
  source_repo_windows="$(wslpath -w "$repo_root")"
  source_git=(git.exe -C "$source_repo_windows")
  source_git_dir_windows="$(
    "${source_git[@]}" rev-parse --path-format=absolute --git-common-dir | tr -d '\r'
  )"
  source_git_dir="$(wslpath -u "$source_git_dir_windows")"
fi
source_git_dir="$(realpath -e -- "$source_git_dir")" || {
  fail "source Git directory is unavailable"
}
[[ -d "$source_git_dir" ]] || fail "source Git directory is unavailable"
git config --file "$source_git_config" --add safe.directory "$source_git_dir" || {
  fail "unable to trust the exact source Git directory"
}
mapfile -t source_safe_directories < <(
  git config --file "$source_git_config" --get-all safe.directory
)
[[ "${#source_safe_directories[@]}" == 2 \
  && "${source_safe_directories[0]}" == "$repo_root" \
  && "${source_safe_directories[1]}" == "$source_git_dir" ]] || {
  fail "source Git configuration is not the exact closed trust set"
}
dispatch_binding_source_commit="$(
  "${source_git[@]}" rev-parse --verify \
    '76d2854b537aa9165083074e1c841f4f18ed84ce^{commit}' | tr -d '\r'
)"
dispatch_binding_source_tree="$(
  "${source_git[@]}" rev-parse --verify "${dispatch_binding_source_commit}^{tree}" \
    | tr -d '\r'
)"
dispatch_binding_source_capability_entry="$(
  "${source_git[@]}" ls-tree "$dispatch_binding_source_tree" -- \
    "$dispatch_binding_capability_path" | tr -d '\r'
)"
[[ "$dispatch_binding_source_capability_entry" == "100644 blob $dispatch_binding_capability_blob"$'\t'"$dispatch_binding_capability_path" ]] || {
  fail "the real source tree does not contain the exact reviewed 0064 capability blob"
}
dispatch_binding_source_ref="$(
  "${source_git[@]}" for-each-ref --contains "$dispatch_binding_source_commit" \
    --format='%(refname)' refs/heads refs/remotes | tr -d '\r' | sed -n '1p'
)"
[[ "$dispatch_binding_source_ref" == refs/* ]] || {
  fail "0064 boundary is not reachable from a trusted source ref"
}
dispatch_binding_source_distance="$(
  "${source_git[@]}" rev-list --count \
    "$dispatch_binding_boundary_commit..$dispatch_binding_source_ref" | tr -d '\r'
)"
[[ "$dispatch_binding_source_distance" =~ ^[0-9]+$ ]] || {
  fail "dispatch binding boundary source distance is invalid"
}
dispatch_binding_source_depth="$((dispatch_binding_source_distance + 2))"
git -C "$work/repo" remote add dispatch-binding-boundary \
  "ext::git -c safe.directory=$source_git_dir -c uploadpack.allowFilter=true upload-pack $source_git_dir"
git -C "$work/repo" config extensions.partialClone dispatch-binding-boundary
git -C "$work/repo" config remote.dispatch-binding-boundary.promisor true
git -C "$work/repo" config remote.dispatch-binding-boundary.partialclonefilter blob:none
git -c protocol.ext.allow=always -C "$work/repo" fetch --quiet --filter=blob:none \
  --depth="$dispatch_binding_source_depth" dispatch-binding-boundary \
  "$dispatch_binding_source_ref" 2>/dev/null || {
  fail "unable to import the complete 0064 boundary fixture"
}
git -C "$work/repo" cat-file -e \
  "${dispatch_binding_source_commit}^{commit}" 2>/dev/null || {
  fail "the real post-0064 source commit was not imported"
}
dispatch_binding_real_repo="$work/dispatch-binding-real-repo"
mkdir -p "$dispatch_binding_real_repo"
git -C "$dispatch_binding_real_repo" init -q
git -C "$dispatch_binding_real_repo" remote add origin \
  https://github.com/example/codestead
git -C "$dispatch_binding_real_repo" remote add source \
  "ext::git -c safe.directory=$source_git_dir upload-pack $source_git_dir"
git -c protocol.ext.allow=always -C "$dispatch_binding_real_repo" fetch --quiet \
  --depth="$dispatch_binding_source_depth" source \
  "$dispatch_binding_source_ref" 2>/dev/null || {
  fail "unable to import the real post-0064 source tree without a blob filter"
}
git -C "$dispatch_binding_real_repo" checkout --quiet --detach \
  "$dispatch_binding_source_commit" || {
  fail "unable to check out the real post-0064 source tree"
}
git -C "$dispatch_binding_real_repo" config core.filemode true
git -C "$dispatch_binding_real_repo" remote remove source


release_fixture_generation=0
regenerate_release_fixture() {
  release_fixture_generation="$((release_fixture_generation + 1))"
  /usr/bin/python3 "$fixture_generator" \
    --source "$work/repo" \
    --packager "$work/repo/infra/ops/package-release-tree.py" \
    --destination "$work/release-package-$release_fixture_generation" \
    >/dev/null || fail "unable to generate canonical release fixture"
  cp "$work/repo/RELEASE.SHA256SUMS" "$work/current-valid-release-manifest"
}

regenerate_release_fixture

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

marker="$FAKE_CONTROL_ROOT/control/release-quarantine"
[[ -f "$marker" && ! -L "$marker" && "$(cat "$marker")" == codestead-release-quarantine-v1 ]] || {
  echo "release mutation ran without durable quarantine" >&2
  exit 97
}

(
  printf '%s' "${1:-}"
  shift || true
  printf '\t%s' "$@"
  printf '\n'
) >>"$FAKE_DOCKER_LOG"

(
  printf 'docker\t%s' "${1:-}"
  shift || true
  printf '\t%s' "$@"
  printf '\n'
) >>"$FAKE_TRACE_LOG"

die_unknown() {
  echo "fake docker rejected unknown arguments" >&2
  exit 64
}

if [[ "${1:-}" == "pull" && "$#" == 2 ]]; then
  [[ "$2" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || die_unknown
  [[ "${FAKE_SCENARIO:-}" != "pull-failure" ]] || exit 17
  exit 0
fi

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" && "${3:-}" == "--format" && "$#" == 5 ]]; then

  [[ "$4" == '{{.Id}}' ]] || die_unknown
  [[ "$5" == *@sha256:* ]] || die_unknown
  if [[ "${FAKE_SCENARIO:-}" == "missing-image" && "$5" == *"/image1@"* ]]; then
    exit 1
  fi
  if [[ "$5" == *"/previous-"* ]]; then
    printf 'sha256:%064d\n' 8
  elif [[ "${FAKE_SCENARIO:-}" == "publication-base" || "${FAKE_SCENARIO:-}" == "runtime-state-active-fsync-failure" ]]; then
    printf 'sha256:%064d\n' 6
  else
    printf 'sha256:%064d\n' 9
  fi
  exit 0
fi

if [[ "${1:-}" == "inspect" && "${2:-}" == "--format" && "$#" == 4 \
  && "$3" == '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Name}}\t{{.Config.Image}}\t{{.Image}}' ]]; then
  service="${4#new-}"
  service="${service%-container}"
  case "$service" in
    app) digit=1 ;;
    runner-egress-gateway) digit=1 ;;
    cloudflared) digit=8 ;;
    file-erasure-worker) digit=3 ;;
    exam-finalization-worker) digit=5 ;;
    mail-worker) digit=2 ;;
    postgres) digit=1 ;;
    practice-runner-recovery-worker) digit=6 ;;
    project-review-correction-worker) digit=7 ;;
    regrade-worker) digit=4 ;;
    reward-worker) digit=3 ;;
    *) die_unknown ;;
  esac
  image_digit="$digit"
  identity_digit=9
  if [[ "${FAKE_SCENARIO:-}" == "publication-base" ]]; then
    image_digit="$((digit + 10))"
  fi
  [[ "${FAKE_SCENARIO:-}" != "publication-base" && "${FAKE_SCENARIO:-}" != "runtime-state-active-fsync-failure" ]] || identity_digit=6
  printf '%s\t/learncoding-%s-1\tregistry.example.test/codestead/image%s@sha256:%064d\tsha256:%064d\n' \
    "$service" "$service" "$image_digit" "$image_digit" "$identity_digit"
  exit 0
fi

if [[ "${1:-}" == "inspect" && "${2:-}" == "--format" && "$#" == 4 ]]; then
  [[ "$3" == '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Config.Image}}\t{{.Image}}' ]] || die_unknown
  if [[ "$4" == old-deployed-*-container ]]; then
    service="${4#old-deployed-}"
    service="${service%-container}"
    case "$service" in
      app) digit=1 ;;
      runner-egress-gateway) digit=1 ;;
      mail-worker) digit=2 ;;
      file-erasure-worker) digit=3 ;;
      reward-worker) digit=3 ;;
      regrade-worker) digit=4 ;;
      exam-finalization-worker) digit=5 ;;
      practice-runner-recovery-worker) digit=6 ;;
      project-review-correction-worker) digit=7 ;;
      cloudflared) digit=8 ;;
      *) die_unknown ;;
    esac
    image_digit="$digit"
    identity_digit=9
    if [[ "${FAKE_SCENARIO:-}" == "runtime-state-active-fsync-failure" ]]; then
      image_digit="$((digit + 10))"
      identity_digit=6
    fi
    printf '%s\tregistry.example.test/codestead/image%s@sha256:%064d\tsha256:%064d\n' \
      "$service" "$image_digit" "$image_digit" "$identity_digit"
    exit 0
  fi
  if [[ "$4" == new-*-container ]]; then
    service="${4#new-}"
    service="${service%-container}"
    case "$service" in
      app) digit=1 ;;
      runner-egress-gateway) digit=1 ;;
      mail-worker) digit=2 ;;
      file-erasure-worker) digit=3 ;;
      reward-worker) digit=3 ;;
      regrade-worker) digit=4 ;;
      exam-finalization-worker) digit=5 ;;
      practice-runner-recovery-worker) digit=6 ;;
      project-review-correction-worker) digit=7 ;;
      cloudflared) digit=8 ;;
      *) die_unknown ;;
    esac
    image_digit="$digit"
    identity_digit=9
    if [[ "${FAKE_SCENARIO:-}" == "publication-base" ]]; then
      image_digit="$((digit + 10))"
    fi
    [[ "${FAKE_SCENARIO:-}" != "publication-base" && "${FAKE_SCENARIO:-}" != "runtime-state-active-fsync-failure" ]] || identity_digit=6
    printf '%s\tregistry.example.test/codestead/image%s@sha256:%064d\tsha256:%064d\n' \
      "$service" "$image_digit" "$image_digit" "$identity_digit"
    exit 0
  fi
  if [[ "$4" == "old-app-container" && "${FAKE_SCENARIO:-}" != restorable-* \
    && "${FAKE_SCENARIO:-}" != "legacy-gateway-transition" ]]; then
    printf 'app\tregistry.example.test/codestead/runtime@sha256:%064d\tsha256:%064d\n' 1 2
    exit 0
  fi
  service="${4#old-}"
  service="${service%-container}"
  case "$service" in
    app|mail-worker|reward-worker|regrade-worker|exam-finalization-worker|file-erasure-worker|practice-runner-recovery-worker|project-review-correction-worker|cloudflared|runner-egress-gateway) ;;
    *) die_unknown ;;
  esac
  printf '%s\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' "$service" "$service" 7 8
  exit 0
fi

[[ "${1:-}" == "compose" ]] || die_unknown
shift
[[ "${1:-}" == "--env-file" && "${2:-}" == "$EXPECTED_COMPOSE_ENV" ]] || die_unknown

[[ "${3:-}" == "-f" && "${4:-}" == "$EXPECTED_COMPOSE_FILE" ]] || die_unknown
shift 4
override_file=""
if [[ "${1:-}" == "-f" && "$#" -ge 2 ]]; then
  override_file="$2"
  shift 2
fi

if [[ "$#" == 4 && "$1" == "--profile" && "$2" == "operations" && "$3" == "config" && "$4" == "--images" ]]; then
  if [[ "${FAKE_SCENARIO:-}" == "unpinned-image" ]]; then
    printf '%s\n' 'registry.example.test/codestead/runtime:mutable'
  elif [[ "${FAKE_SCENARIO:-}" == "uppercase-image" ]]; then
    printf '%s\n' 'registry.example.test/codestead/runtime@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  elif [[ "${FAKE_SCENARIO:-}" == "publication-base" ]]; then
    for digit in 1 2 3 4 5 6 7 8; do
      image_digit="$((digit + 10))"
      printf 'registry.example.test/codestead/image%s@sha256:%064d\n' "$image_digit" "$image_digit"
    done
  else
    for digit in 1 2 3 4 5 6 7 8; do
      printf 'registry.example.test/codestead/image%s@sha256:%064d\n' "$digit" "$digit"
    done
  fi
  exit 0
fi

if [[ "$#" == 2 && "$1" == "ps" && "$2" == "-q" ]]; then
  if [[ "${FAKE_SCENARIO:-}" == "legacy-gateway-transition" ]]; then
    for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
      file-erasure-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
      printf 'old-%s-container\n' "$service"
    done
  elif [[ "${FAKE_SCENARIO:-}" == "restorable-bound-public-smoke-failure" ]]; then
    for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
      file-erasure-worker practice-runner-recovery-worker project-review-correction-worker cloudflared runner-egress-gateway; do
      printf 'old-deployed-%s-container\n' "$service"
    done
  elif [[ "${FAKE_SCENARIO:-}" == restorable-* ]]; then
    for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
      file-erasure-worker practice-runner-recovery-worker project-review-correction-worker cloudflared runner-egress-gateway; do
      printf 'old-%s-container\n' "$service"
    done
  elif [[ "${FAKE_SCENARIO:-}" == "pointer-second" \
    || "${FAKE_SCENARIO:-}" == "guarded-delivery-exact-compatible-second" \
    || "${FAKE_SCENARIO:-}" == "mail-cutover-success" \
    || "${FAKE_SCENARIO:-}" == "mail-drain-failure" \
    || "${FAKE_SCENARIO:-}" == "mail-contract-failure" \
    || "${FAKE_SCENARIO:-}" == "mail-backup-lock-busy" \
    || "${FAKE_SCENARIO:-}" == "runtime-state-active-fsync-failure" \
    || "${FAKE_SCENARIO:-}" == "post-active-target-fsync-failure" \
    || "${FAKE_SCENARIO:-}" == "post-active-pointer-fsync-failure" ]]; then
    for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
      file-erasure-worker practice-runner-recovery-worker project-review-correction-worker cloudflared runner-egress-gateway; do
      printf 'old-deployed-%s-container\n' "$service"
    done
  else
    printf '%s\n' old-app-container
  fi
  exit 0
fi
if [[ "$#" == 3 && "$1" == "ps" && "$2" == "-q" ]]; then
  printf 'new-%s-container\n' "$3"
  exit 0
fi
if [[ "$#" == 4 && "$1" == "stop" && "$2" == "--timeout" && "$3" == "30" && "$4" == "cloudflared" ]]; then
  stop_count="$(cat "$FAKE_QUARANTINE_STOP_COUNT")"
  stop_count="$((stop_count + 1))"
  printf '%s\n' "$stop_count" >"$FAKE_QUARANTINE_STOP_COUNT"
  if [[ "${FAKE_SCENARIO:-}" == quarantine-stop-failure && "$stop_count" -le 2 ]]; then
    exit 58
  fi
  if [[ "${FAKE_SCENARIO:-}" == signal-first-quarantine-stop && "$stop_count" == 1 ]]; then
    timeout_parent="$PPID"
    release_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    release_pid="${release_pid//[[:space:]]/}"
    [[ "$release_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    /bin/kill -TERM "$release_pid"
  fi
  if [[ "${FAKE_SCENARIO:-}" == repeated-signal-early-cleanup ]]; then
    timeout_parent="$PPID"
    release_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    release_pid="${release_pid//[[:space:]]/}"
    [[ "$release_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    case "$stop_count" in
      1)
        /bin/kill -TERM "$release_pid"
        exit 58
        ;;
      2)
        /bin/kill -HUP "$release_pid"
        /bin/kill -INT "$release_pid"
        exit 58
        ;;
    esac
  fi
  if [[ "${FAKE_SCENARIO:-}" == repeated-signal-late-cleanup && "$stop_count" == 3 ]]; then
    timeout_parent="$PPID"
    release_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    release_pid="${release_pid//[[:space:]]/}"
    [[ "$release_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    /bin/kill -TERM "$release_pid"
    /bin/kill -HUP "$release_pid"
    /bin/kill -INT "$release_pid"
    exit 58
  fi
  exit 0
fi

if [[ "$#" == 11 && "$1" == "stop" && "$2" == "--timeout" && "$3" == "60" ]]; then
  [[ "$4" == app ]]
  [[ "$5" == mail-worker ]]
  [[ "$6" == reward-worker ]]
  [[ "$7" == regrade-worker ]]
  [[ "$8" == exam-finalization-worker ]]
  [[ "$9" == practice-runner-recovery-worker ]]
  [[ "${10}" == project-review-correction-worker ]]
  [[ "${11}" == file-erasure-worker ]]
  [[ "${FAKE_SCENARIO:-}" != "mutator-stop-failure" \
    && "${FAKE_SCENARIO:-}" != "repeated-signal-late-cleanup" ]] || exit 48
  exit 0
fi

if [[ "$#" == 6 && "$1" == "--profile" && "$2" == "uploads" && "$3" == "stop" && "$4" == "--timeout" && "$5" == "60" && "$6" == "scan-worker" ]]; then
  exit 0
fi

if [[ "$1" == "exec" && " $* " == *" psql "* \
  && " $* " == *" --host=/run/learncoding-postgres "* \
  && " $* " == *" codestead-production-pg-major-v1 "* ]]; then
  [[ " $* " == *" --no-psqlrc "* && " $* " == *" --quiet "* \
    && " $* " == *" --no-align "* && " $* " == *" --tuples-only "* \
    && " $* " == *" --set ON_ERROR_STOP=1 "* ]] || die_unknown
  case "${FAKE_SCENARIO:-}" in
    postgres-major-16) printf '160011\n' ;;
    postgres-major-18) printf '180000\n' ;;
    postgres-major-malformed) printf '17.5\n' ;;
    postgres-major-query-failure) exit 74 ;;
    *) printf '170000\n' ;;
  esac
  exit 0
fi

if [[ "$1" == "exec" && " $* " == *" psql "* \
  && " $* " == *" --host=/run/learncoding-postgres "* \
  && " $* " == *" mail-store-drain-gate-v1 "* ]]; then
  [[ " $* " == *" --no-psqlrc "* && " $* " == *" --quiet "* \
    && " $* " == *" --no-align "* && " $* " == *" --tuples-only "* ]] || die_unknown
  if [[ "${FAKE_SCENARIO:-}" == "mail-drain-failure" ]]; then
    printf '1|0|0\n'
  else
    printf '0|0|0\n'
  fi
  exit 0
fi

if [[ "$1" == "exec" && " $* " == *" psql "* \
  && " $* " == *" --host=/run/learncoding-postgres "* \
  && " $* " == *" mail-store-contract-gate-v1 "* ]]; then
  [[ " $* " == *" --no-psqlrc "* && " $* " == *" --quiet "* \
    && " $* " == *" --no-align "* && " $* " == *" --tuples-only "* ]] || die_unknown
  if [[ "${FAKE_SCENARIO:-}" == "mail-contract-failure" ]]; then
    printf 't|t|t|0|1\n'
  else
    printf 't|t|t|0|0\n'
  fi
  exit 0
fi

if [[ "$1" == "exec" && " $* " == *" psql "* && " $* " == *" --host=/run/learncoding-postgres "* && " $* " == *" pg_stat_activity "* ]]; then
  [[ " $* " == *" --no-psqlrc "* ]] || die_unknown
  [[ " $* " == *" --quiet "* ]] || die_unknown
  [[ " $* " == *" or usename = current_user) "* ]] || die_unknown
  case "${FAKE_SCENARIO:-}" in
    residual-session-failure|residual-current-user-session-failure) printf '1\n' ;;
    residual-session-noncanonical-failure) printf ' 0\n' ;;
    *) printf '0\n' ;;
  esac
  exit 0
fi


if [[ "$1" == "up" ]]; then
  if [[ " $* " == *" postgres "* && " $* " != *" app "* ]]; then
    [[ "${FAKE_SCENARIO:-}" != "postgres-failure" ]] || exit 31
    exit 0
  fi
  if [[ " $* " == *" app "* && " $* " != *" cloudflared "* ]]; then
    [[ "${FAKE_SCENARIO:-}" != "pilot-failure" ]] || exit 32
    exit 0
  fi
  if [[ " $* " == *" cloudflared "* && " $* " != *" app "* ]]; then
    [[ "${FAKE_SCENARIO:-}" != "tunnel-failure" ]] || exit 33
    exit 0
  fi
  [[ -n "$override_file" ]] || die_unknown
  exit 0
fi

if [[ "$1" == "--profile" && "$2" == "operations" && "$3" == "up" ]]; then
  service="${!#}"
  case "$service" in
    database-role-bootstrap)
      [[ "${FAKE_SCENARIO:-}" != "role-bootstrap-failure" ]] || exit 40
      if [[ "${FAKE_SCENARIO:-}" == "role-reconciliation-failure" ]]; then
        bootstrap_count="$(
          grep -Fc \
            $'\t--exit-code-from\tdatabase-role-bootstrap\tdatabase-role-bootstrap' \
            "$FAKE_DOCKER_LOG" || true
        )"
        (( bootstrap_count < 2 )) || exit 47
      fi
      ;;
    database-negative-probes) [[ "${FAKE_SCENARIO:-}" != "negative-probes-failure" ]] || exit 44 ;;
    migrate) [[ "${FAKE_SCENARIO:-}" != "migration-failure" ]] || exit 41 ;;
    platform-seed) [[ "${FAKE_SCENARIO:-}" != "seed-failure" ]] || exit 42 ;;
    admin-bootstrap) [[ "${FAKE_SCENARIO:-}" != "bootstrap-failure" ]] || exit 43 ;;
    database-boundary-verifier) [[ "${FAKE_SCENARIO:-}" != "boundary-verifier-failure" ]] || exit 46 ;;
    *) die_unknown ;;
  esac
  exit 0
fi

if [[ "$1" == "--profile" && "$2" == "operations" && "$3" == "rm" && "$4" == "-f" && "$#" == 5 ]]; then
  case "$5" in
    database-role-bootstrap|database-negative-probes|migrate|platform-seed|admin-bootstrap|database-boundary-verifier) exit 0 ;;
    *) die_unknown ;;
  esac
fi

die_unknown
EOF
chmod 0755 "$work/bin/docker"

cat >"$work/bin/sync" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_SYNC_LOG"
[[ "${FAKE_SCENARIO:-}" != "fsync-failure" ]] || exit 61
if [[ "${FAKE_SCENARIO:-}" == "runtime-state-active-fsync-failure" ]]; then
  case "$*" in
    *"/.active-release."*".tmp") exit 62 ;;
  esac
fi
if [[ "${FAKE_SCENARIO:-}" == "post-active-target-fsync-failure" \
  && "$*" == "-f -- $RUNTIME_STATE_ROOT/active-release.env" ]]; then
  exit 63
fi
if [[ "${FAKE_SCENARIO:-}" == "post-active-pointer-fsync-failure" \
  && "$*" == "-f -- $RELEASE_RECORD_ROOT/".current-release.*.tmp ]]; then
  exit 64
fi
exit 0
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
if [[ "${FAKE_SCENARIO:-}" == mail-backup-lock-busy && "${*: -1}" == 8 ]]; then
  exit 75
fi
/usr/bin/flock "$@"
flock_status="$?"
if [[ "${FAKE_SCENARIO:-}" == lock-path-swap-after-flock ]]; then
  swap_lock_path
fi
exit "$flock_status"
EOF
chmod 0755 "$work/bin/flock"

cat >"$work/prepare-postgres.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${POSTGRES_UID:-}" == 999 ]]
[[ "${POSTGRES_GID:-}" == 999 ]]
[[ "${LEARN_DATA_ROOT:-}" == "$EXPECTED_DATA_ROOT" ]]
printf '%s\n' prepare-postgres >>"$FAKE_TRACE_LOG"
if [[ "${FAKE_SCENARIO:-}" == "slow-transaction" ]]; then
  : >"$FAKE_SLOW_READY"
  while [[ ! -e "$FAKE_SLOW_RELEASE" ]]; do sleep 0.05; done
fi
[[ "${FAKE_SCENARIO:-}" != "prepare-postgres-failure" ]] || exit 71
EOF
chmod 0755 "$work/prepare-postgres.sh"

cat >"$work/prepare-object.mjs" <<'EOF'
import { appendFileSync } from "node:fs";

if (
  process.env.LEARN_DATA_ROOT !== process.env.EXPECTED_DATA_ROOT ||
  process.env.UPLOADS_ENABLED !== "false"
) {
  process.exit(72);
}
appendFileSync(process.env.FAKE_TRACE_LOG, "prepare-object\n", { encoding: "utf8" });
if (process.env.FAKE_SCENARIO === "prepare-object-failure") process.exit(73);
EOF
chmod 0644 "$work/prepare-object.mjs"

cat >"$work/bin/date" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'inherited date executed\n' >>"$FAKE_DATE_MARKER"
exec /usr/bin/date "$@"
EOF
chmod 0755 "$work/bin/date"

cat >"$work/bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'inherited git executed\n' >>"$FAKE_GIT_MARKER"
exec /usr/bin/git "$@"
EOF
chmod 0755 "$work/bin/git"

cat >"$work/validate-runtime.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock ]]
[[ "${COMPOSE_PROJECT_NAME:-}" == learncoding ]]
phase="${1:---full}"
printf '%s\t%s\n' "${VALIDATION_MODE:-unset}" "$phase" >>"$FAKE_VALIDATE_LOG"
printf 'validate\t%s\n' "$phase" >>"$FAKE_TRACE_LOG"
[[ "${VALIDATION_MODE:-}" == operations ]]
[[ "${REQUIRE_BOOTSTRAP_ADMIN_SECRET:-}" == true || "${REQUIRE_BOOTSTRAP_ADMIN_SECRET:-}" == false ]]
if [[ "$phase" == "--pre-privileged" ]]; then
  [[ "$#" == 1 ]]
  [[ "${POSTGRES_IMAGE:-}" == registry.example.test/postgres@sha256:1111111111111111111111111111111111111111111111111111111111111111 ]]
  [[ "${POSTGRES_UID:-}" == 999 ]]
  [[ "${POSTGRES_GID:-}" == 999 ]]
  [[ "${LEARN_DATA_ROOT:-}" == "$EXPECTED_DATA_ROOT" ]]
  [[ "${UPLOADS_ENABLED:-}" == false ]]
  [[ "${FAKE_SCENARIO:-}" != "pre-privileged-failure" ]] || exit 20
  exit 0
fi
[[ "$#" == 0 ]]
printf '%s\t%s\n' "${APPLICATION_EXPECTED_SOURCE_REVISION:-unset}" "${APPLICATION_EXPECTED_SOURCE_TREE:-unset}" >>"$FAKE_VALIDATE_SOURCE_LOG"
printf '%s\t%s\n' "${APPLICATION_IMAGE_RECORD_JSON:-unset}" "${APPLICATION_IMAGE_RECORD_ENV:-unset}" >>"$FAKE_VALIDATE_IMAGE_LOG"
[[ "${FAKE_SCENARIO:-}" != "full-validation-failure" ]] || exit 21
EOF
chmod 0755 "$work/validate-runtime.sh"

cat >"$work/smoke-production.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock ]]
[[ "${COMPOSE_PROJECT_NAME:-}" == learncoding ]]
printf '%s\n' "$*" >>"$FAKE_SMOKE_LOG"
printf 'smoke\t%s\n' "$*" >>"$FAKE_TRACE_LOG"
count="$(cat "$FAKE_SMOKE_COUNT")"
count="$((count + 1))"
printf '%s\n' "$count" >"$FAKE_SMOKE_COUNT"
[[ "${FAKE_SCENARIO:-}" != "smoke-failure" ]] || exit 51
[[ ! ("${FAKE_SCENARIO:-}" == "internal-smoke-failure" && " $* " == *" --phase internal "*) ]] || exit 52
[[ ! ("${FAKE_SCENARIO:-}" == "public-smoke-failure" && " $* " == *" --phase public "*) ]] || exit 53
if [[ "${FAKE_SCENARIO:-}" == "public-smoke-removes-quarantine" && " $* " == *" --phase public "* ]]; then
  rm -f -- "$FAKE_CONTROL_ROOT/control/release-quarantine"
  exit 55
fi
if [[ "${FAKE_SCENARIO:-}" == "restorable-bound-public-smoke-failure" && " $* " == *" --phase public "* && "$count" == 2 ]]; then
  exit 54
fi
EOF
chmod 0755 "$work/smoke-production.sh"

run_release() {
  local scenario="$1"
  shift
  local run_repo_root="${RUN_REPO_ROOT:-$work/repo}"
  local case_dir="$work/case-$scenario-${RUN_COUNTER:-0}"
  local record_root="${RUN_RECORD_ROOT:-$case_dir/records}"
  local run_stage_timeout="${RUN_STAGE_TIMEOUT:-5}"
  RUN_COUNTER="$(( ${RUN_COUNTER:-0} + 1 ))"
  export RUN_COUNTER
  mkdir -p "$case_dir" "$record_root"
  local runtime_state_root="${RUN_RUNTIME_STATE_ROOT:-$case_dir/runtime-state}"
  local lock_file="${RUN_LOCK_FILE:-$case_dir/release.lock}"
  mkdir -p "$runtime_state_root"
  chmod 0700 "$record_root"
  chmod 0750 "$runtime_state_root"
  : >"$case_dir/docker.log"
  : >"$case_dir/validate.log"
  : >"$case_dir/validate-source.log"
  : >"$case_dir/smoke.log"
  : >"$case_dir/sync.log"
  : >"$case_dir/stdout"
  : >"$case_dir/validate-image.log"
  : >"$case_dir/stderr"
  : >"$case_dir/date.log"
  : >"$case_dir/git.log"
  : >"$case_dir/trace.log"
  printf '0\n' >"$case_dir/quarantine-stop.count"
  printf '0\n' >"$case_dir/smoke.count"
  if [[ "${RUN_LOCK_PRECREATE:-true}" == true && ! -e "$lock_file" && ! -L "$lock_file" ]]; then
    : >"$lock_file"
    chmod 0600 "$lock_file"
  fi
  RELEASE_RECORD_ROOT_USED="$record_root"

  set +e
  PATH="$work/bin:/usr/bin:/bin" \
    REPO_ROOT="$run_repo_root" \
    COMPOSE_ENV_FILE="$work/compose.env" \
    COMPOSE_FILE_PATH="$run_repo_root/compose.yaml" \
    RELEASE_LOCK_FILE="$lock_file" \
    RELEASE_RECORD_ROOT="$record_root" \
    RUNTIME_STATE_ROOT="$runtime_state_root" \
    PREPARE_POSTGRES_SCRIPT="$work/prepare-postgres.sh" \
    PREPARE_OBJECT_SCRIPT="$work/prepare-object.mjs" \
    VALIDATE_RUNTIME_SCRIPT="$work/validate-runtime.sh" \
    SMOKE_PRODUCTION_SCRIPT="$work/smoke-production.sh" \
    FAKE_SCENARIO="$scenario" \
    FAKE_CONTROL_ROOT="$work" \
    FAKE_SLOW_READY="$work/slow.ready" \
    FAKE_SLOW_RELEASE="$work/slow.release" \
    FAKE_DOCKER_LOG="$case_dir/docker.log" \
    FAKE_VALIDATE_LOG="$case_dir/validate.log" \
    FAKE_VALIDATE_SOURCE_LOG="$case_dir/validate-source.log" \
    FAKE_VALIDATE_IMAGE_LOG="$case_dir/validate-image.log" \
    FAKE_SMOKE_LOG="$case_dir/smoke.log" \
    FAKE_SYNC_LOG="$case_dir/sync.log" \
    FAKE_DATE_MARKER="$case_dir/date.log" \
    FAKE_GIT_MARKER="$case_dir/git.log" \
    FAKE_TRACE_LOG="$case_dir/trace.log" \
    FAKE_QUARANTINE_STOP_COUNT="$case_dir/quarantine-stop.count" \
    FAKE_LOCK_SWAP_PATH="${RUN_LOCK_SWAP_PATH:-}" \
    FAKE_SMOKE_COUNT="$case_dir/smoke.count" \
    EXPECTED_COMPOSE_ENV="$work/compose.env" \
    EXPECTED_DATA_ROOT="$work/data" \
    EXPECTED_COMPOSE_FILE="$run_repo_root/compose.yaml" \
    bash "$release_script" --test-harness-root "$work" --lock-timeout 1 --stage-timeout "$run_stage_timeout" --startup-wait 3 "$@" \
      >"$case_dir/stdout" 2>"$case_dir/stderr"
  RELEASE_STATUS=$?
  set -e
  RELEASE_CASE_DIR="$case_dir"
  RELEASE_RUNTIME_STATE_ROOT_USED="$runtime_state_root"
  export RELEASE_STATUS RELEASE_CASE_DIR RELEASE_RECORD_ROOT_USED RELEASE_RUNTIME_STATE_ROOT_USED
}

only_record_dir() {
  local record_root="$1"
  local -a records=()
  mapfile -t records < <(find "$record_root" -mindepth 1 -maxdepth 1 -type d -print)
  [[ "${#records[@]}" == 1 ]] || fail "expected exactly one release record, found ${#records[@]}"
  printf '%s\n' "${records[0]}"
}

line_number() {
  local pattern="$1" file="$2"
  grep -n -m1 -F -- "$pattern" "$file" | cut -d: -f1
}

assert_no_secret() {
  local case_dir="$1"
  if grep -R -Fq -- 'do-not-log-this-temporary-password' "$case_dir"; then
    fail "bootstrap password leaked into release output or evidence"
  fi
}

assert_only_early_quarantine() {
  local log="$1" label="$2" expected_compose_file="${3:-$work/repo/compose.yaml}"
  local marker="$work/control/release-quarantine"
  local line command env_flag env_path file_flag file_path action timeout_flag seconds service extra
  local stop_count=0

  [[ -f "$marker" && ! -L "$marker" ]] || {
    fail "$label did not retain the durable release quarantine"
  }
  [[ "$(cat "$marker")" == codestead-release-quarantine-v1 ]] || {
    fail "$label retained a malformed release quarantine"
  }
  while IFS= read -r line; do
    IFS=$'\t' read -r command env_flag env_path file_flag file_path action \
      timeout_flag seconds service extra <<<"$line"
    [[ "$command" == compose && "$env_flag" == --env-file \
      && "$env_path" == "$work/compose.env" && "$file_flag" == -f \
      && "$file_path" == "$expected_compose_file" && "$action" == stop \
      && "$timeout_flag" == --timeout && "$seconds" == 30 \
      && "$service" == cloudflared && -z "$extra" ]] || {
      fail "$label performed Docker work beyond tunnel quarantine"
    }
    stop_count="$((stop_count + 1))"
  done <"$log"
  (( stop_count >= 1 )) || fail "$label omitted the immediate tunnel quarantine"
}

assert_immutable_flags() {
  local log="$1"
  local line
  while IFS= read -r line; do
    [[ "$line" == *$'\t--no-build'* || "$line" == *$'\t--no-build\t'* ]] || {
      fail "release mutation omitted --no-build: $line"
    }
    [[ "$line" == *$'\t--pull\tnever'* ]] || fail "release mutation omitted --pull never: $line"
  done < <(grep -E $'compose\t.*\t(up|run)\t' "$log")
}

dispatch_binding_preflight_head="$(git -C "$work/repo" rev-parse --verify HEAD)"
dispatch_binding_real_package="$work/dispatch-binding-real-package"
/usr/bin/python3 "$fixture_generator" \
  --source "$dispatch_binding_real_repo" \
  --packager "$dispatch_binding_real_repo/infra/ops/package-release-tree.py" \
  --destination "$dispatch_binding_real_package" \
  >/dev/null || fail "unable to package the real post-0064 source tree"
dispatch_binding_packaged_capability="$dispatch_binding_real_package/$dispatch_binding_capability_path"
[[ -f "$dispatch_binding_packaged_capability" && ! -L "$dispatch_binding_packaged_capability" \
  && "$(stat -c '%a' "$dispatch_binding_packaged_capability")" == 644 ]] || {
  fail "the real release package did not preserve the capability as mode 100644"
}
[[ "$(git -C "$dispatch_binding_real_repo" hash-object -- \
  "$dispatch_binding_packaged_capability")" == "$dispatch_binding_capability_blob" ]] || {
  fail "the real release package did not preserve the reviewed capability blob"
}
/usr/bin/python3 "$dispatch_binding_real_repo/infra/ops/package-release-tree.py" \
  --verify-source-manifest \
  --source "$dispatch_binding_real_repo" \
  --expected-commit "$dispatch_binding_source_commit" \
  --expected-tree "$dispatch_binding_source_tree" \
  --application-image-json "$dispatch_binding_real_repo/dist/application-images/application-images.json" \
  --application-image-env "$dispatch_binding_real_repo/dist/application-images/application-images.env" \
  --runner-runtime-json "$dispatch_binding_real_repo/services/runner/dist/runtime-images.json" \
  --runner-runtime-env "$dispatch_binding_real_repo/services/runner/dist/runtime-images.env" \
  >/dev/null || {
  fail "the real post-0064 source manifest does not verify before release"
}

dispatch_binding_real_records="$work/dispatch-binding-real-records"
RUN_REPO_ROOT="$dispatch_binding_real_repo" RUN_RECORD_ROOT="$dispatch_binding_real_records" RUN_STAGE_TIMEOUT=30 \
  run_release dispatch-binding-real-post-0064
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "release rejected the real post-0064 source tree"
}
dispatch_binding_real_record="$(only_record_dir "$dispatch_binding_real_records")"
[[ "$(cat "$dispatch_binding_real_record/git-commit.txt")" == "$dispatch_binding_source_commit" \
  && "$(cat "$dispatch_binding_real_record/git-tree.txt")" == "$dispatch_binding_source_tree" ]] || {
  fail "the successful post-0064 release was not bound to its exact commit and tree"
}
grep -Fxq "DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability" \
  "$dispatch_binding_real_record/mail-outbox-contract.env" || {
  fail "the successful post-0064 release omitted its exact runtime capability"
}
grep -Fxq "DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract" \
  "$dispatch_binding_real_record/mail-outbox-contract.env" || {
  fail "the successful post-0064 release omitted its exact privilege capability"
}
echo "ok - release packages and accepts a real exact post-0064 capability tree"

dispatch_binding_preflight_tree="$(git -C "$work/repo" rev-parse --verify 'HEAD^{tree}')"
dispatch_binding_missing_capability_commit="$(
  printf '%s\n' 'fixture 0064 source without a checked-in runtime capability' \
    | git -C "$work/repo" commit-tree "$dispatch_binding_preflight_tree" \
      -p "$dispatch_binding_preflight_head" -p "$dispatch_binding_boundary_commit"
)"
git -C "$work/repo" reset --quiet --hard "$dispatch_binding_missing_capability_commit"
regenerate_release_fixture
dispatch_binding_preflight_records="$work/dispatch-binding-preflight-records"
RUN_RECORD_ROOT="$dispatch_binding_preflight_records" \
  run_release dispatch-binding-capability-missing
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || {
  fail "release started a 0064 image without a checked-in exact dispatch binding capability"
}
assert_only_early_quarantine \
  "$RELEASE_CASE_DIR/docker.log" "0064 missing runtime capability refusal"
[[ ! -s "$RELEASE_CASE_DIR/smoke.log" ]] || {
  fail "0064 missing runtime capability refusal reached smoke"
}
grep -Fq '0064_mail_outbox_dispatch_binding' "$RELEASE_CASE_DIR/stderr" || {
  fail "0064 missing runtime capability refusal did not name the authority boundary"
}
grep -Fq 'checked-in dispatch binding capability' "$RELEASE_CASE_DIR/stderr" || {
  fail "0064 missing runtime capability refusal did not identify the absent contract"
}
if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' \
  "$RELEASE_CASE_DIR/stdout" "$RELEASE_CASE_DIR/stderr"; then
  fail "0064 missing runtime capability refusal disclosed Git or capability hashes"
fi
git -C "$work/repo" reset --quiet --hard "$dispatch_binding_preflight_head"
regenerate_release_fixture
echo "ok - release fails closed after 0064 while the runtime capability identifier is absent"

guarded_delivery_missing_repo="$work/guarded-delivery-missing-repo"
git -c advice.detachedHead=false clone --quiet --no-local \
  "$repo_root" "$guarded_delivery_missing_repo"
git -C "$guarded_delivery_missing_repo" remote set-url origin \
  https://github.com/example/codestead
git -C "$guarded_delivery_missing_repo" config user.name \
  'Codestead guarded delivery release test'
git -C "$guarded_delivery_missing_repo" config user.email \
  'guarded-delivery-release@codestead.invalid'
git -C "$guarded_delivery_missing_repo" checkout --quiet \
  "$guarded_delivery_boundary_commit"
[[ -z "$(git -C "$guarded_delivery_missing_repo" status --porcelain=v1 --untracked-files=all)" ]] || {
  fail "0069 missing-capability fixture is not an exact clean Git tree"
}
[[ "$(git -C "$guarded_delivery_missing_repo" ls-tree -r --name-only HEAD -- \
  drizzle/0069_mail_outbox_guarded_delivery_authority.sql)" == \
  drizzle/0069_mail_outbox_guarded_delivery_authority.sql ]] || {
  fail "0069 missing-capability fixture does not contain the reviewed migration"
}
[[ -z "$(git -C "$guarded_delivery_missing_repo" ls-tree -r --name-only HEAD -- \
  "$guarded_delivery_capability_path")" ]] || {
  fail "0069 missing-capability fixture unexpectedly contains the capability"
}
[[ "$(git -C "$guarded_delivery_missing_repo" ls-tree HEAD -- \
  "$guarded_delivery_redaction_migration_path")" == \
  "100644 blob $guarded_delivery_redaction_migration_blob"$'\t'"$guarded_delivery_redaction_migration_path" ]] || {
  fail "historical 0069 fixture does not retain the reviewed 0068 migration"
}
[[ "$(git -C "$guarded_delivery_missing_repo" ls-tree HEAD -- \
  "$guarded_delivery_migration_path")" != \
  "100644 blob $guarded_delivery_migration_blob"$'\t'"$guarded_delivery_migration_path" ]] || {
  fail "historical 0069 fixture unexpectedly contains the corrected migration"
}
/usr/bin/python3 "$fixture_generator" \
  --source "$guarded_delivery_missing_repo" \
  --packager "$guarded_delivery_missing_repo/infra/ops/package-release-tree.py" \
  --destination "$work/guarded-delivery-stale-package" \
  >/dev/null || fail "unable to package the stale 0069 migration fixture"

guarded_delivery_stale_records="$work/guarded-delivery-stale-records"
RUN_REPO_ROOT="$guarded_delivery_missing_repo" \
  RUN_RECORD_ROOT="$guarded_delivery_stale_records" RUN_STAGE_TIMEOUT=30 \
  run_release guarded-delivery-migration-stale
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" != 0 ]] || {
  fail "release accepted the historical stale 0069 migration"
}
assert_only_early_quarantine \
  "$RELEASE_CASE_DIR/docker.log" "stale 0069 migration refusal" \
  "$guarded_delivery_missing_repo/compose.yaml"
[[ ! -s "$RELEASE_CASE_DIR/smoke.log" ]] || {
  fail "stale 0069 migration refusal reached smoke"
}
if find "$guarded_delivery_stale_records" -mindepth 2 -maxdepth 2 \
    -name mail-outbox-contract.env -print -quit | grep -q .; then
  fail "stale 0069 migration refusal wrote mail outbox contract evidence"
fi
[[ ! -e "$guarded_delivery_stale_records/current-release.env" \
  && ! -e "$guarded_delivery_stale_records/latest-candidate.env" ]] || {
  fail "stale 0069 migration refusal advanced a release pointer"
}
grep -Fq "$guarded_delivery_migration_diagnostic" \
  "$RELEASE_CASE_DIR/stderr" || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "stale 0069 migration refusal was not explicit"
}
if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' \
    "$RELEASE_CASE_DIR/stdout" "$RELEASE_CASE_DIR/stderr"; then
  fail "stale 0069 migration refusal disclosed Git or capability hashes"
fi
echo "ok - release rejects the historical 0069 SQL before capability or image work"

cp "$repo_root/$guarded_delivery_migration_path" \
  "$guarded_delivery_missing_repo/$guarded_delivery_migration_path"
chmod 0644 "$guarded_delivery_missing_repo/$guarded_delivery_migration_path"
git -C "$guarded_delivery_missing_repo" add "$guarded_delivery_migration_path"
git -C "$guarded_delivery_missing_repo" commit -qm \
  'fixture corrected guarded delivery migration'
[[ "$(git -C "$guarded_delivery_missing_repo" ls-tree HEAD -- \
  "$guarded_delivery_migration_path")" == \
  "100644 blob $guarded_delivery_migration_blob"$'\t'"$guarded_delivery_migration_path" ]] || {
  fail "corrected 0069 fixture does not contain the reviewed migration blob"
}
/usr/bin/python3 "$fixture_generator" \
  --source "$guarded_delivery_missing_repo" \
  --packager "$guarded_delivery_missing_repo/infra/ops/package-release-tree.py" \
  --destination "$work/guarded-delivery-missing-package" \
  >/dev/null || fail "unable to package the 0069 missing-capability fixture"

guarded_delivery_missing_records="$work/guarded-delivery-missing-records"
RUN_REPO_ROOT="$guarded_delivery_missing_repo" \
  RUN_RECORD_ROOT="$guarded_delivery_missing_records" RUN_STAGE_TIMEOUT=30 \
  run_release guarded-delivery-capability-missing
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" != 0 ]] || {
  fail "release started a 0069 image without its exact guarded delivery capability"
}
assert_only_early_quarantine \
  "$RELEASE_CASE_DIR/docker.log" "0069 missing guarded delivery capability refusal" \
  "$guarded_delivery_missing_repo/compose.yaml"
[[ ! -s "$RELEASE_CASE_DIR/smoke.log" ]] || {
  fail "0069 missing guarded delivery capability refusal reached smoke"
}
if find "$guarded_delivery_missing_records" -mindepth 2 -maxdepth 2 \
    -name mail-outbox-contract.env -print -quit | grep -q .; then
  fail "0069 missing capability refusal wrote mail outbox contract evidence"
fi
[[ ! -e "$guarded_delivery_missing_records/current-release.env" \
  && ! -e "$guarded_delivery_missing_records/latest-candidate.env" ]] || {
  fail "0069 missing capability refusal advanced a release pointer"
}
grep -Fq '0069_mail_outbox_guarded_delivery_authority requires a checked-in guarded delivery capability before release' \
  "$RELEASE_CASE_DIR/stderr" || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "0069 missing capability refusal was not explicit"
}
if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' \
    "$RELEASE_CASE_DIR/stdout" "$RELEASE_CASE_DIR/stderr"; then
  fail "0069 missing capability refusal disclosed Git or capability hashes"
fi
echo "ok - release fails closed for a 0069 tree without the exact capability"

guarded_delivery_exact_repo="$work/guarded-delivery-exact-repo"
git -c advice.detachedHead=false clone --quiet --no-local \
  "$guarded_delivery_missing_repo" "$guarded_delivery_exact_repo"
git -C "$guarded_delivery_exact_repo" remote set-url origin \
  https://github.com/example/codestead
mkdir -p "$guarded_delivery_exact_repo/infra/ops"
cp "$repo_root/$guarded_delivery_capability_path" \
  "$guarded_delivery_exact_repo/$guarded_delivery_capability_path"
chmod 0644 "$guarded_delivery_exact_repo/$guarded_delivery_capability_path"
git -C "$guarded_delivery_exact_repo" add "$guarded_delivery_capability_path"
git -C "$guarded_delivery_exact_repo" commit -qm \
  'fixture exact guarded delivery capability'
guarded_delivery_exact_commit="$(
  git -C "$guarded_delivery_exact_repo" rev-parse --verify HEAD
)"
guarded_delivery_exact_tree="$(
  git -C "$guarded_delivery_exact_repo" rev-parse --verify 'HEAD^{tree}'
)"
[[ "$(git -C "$guarded_delivery_exact_repo" ls-tree "$guarded_delivery_exact_tree" -- \
  "$guarded_delivery_capability_path")" == \
  "100644 blob $guarded_delivery_capability_blob"$'\t'"$guarded_delivery_capability_path" ]] || {
  fail "0069 exact candidate tree does not contain the pinned capability blob"
}
/usr/bin/python3 "$fixture_generator" \
  --source "$guarded_delivery_exact_repo" \
  --packager "$guarded_delivery_exact_repo/infra/ops/package-release-tree.py" \
  --destination "$work/guarded-delivery-exact-package" \
  >/dev/null || fail "unable to package the exact 0069 release fixture"
[[ -z "$(git -C "$guarded_delivery_exact_repo" status --porcelain=v1 --untracked-files=all)" ]] || {
  fail "0069 exact release fixture is not a clean Git tree"
}
guarded_delivery_exact_records="$work/guarded-delivery-exact-records"
RUN_REPO_ROOT="$guarded_delivery_exact_repo" \
  RUN_RECORD_ROOT="$guarded_delivery_exact_records" RUN_STAGE_TIMEOUT=30 \
  run_release guarded-delivery-exact
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "release rejected the exact 0069 guarded delivery capability tree"
}
guarded_delivery_exact_record="$(only_record_dir "$guarded_delivery_exact_records")"
[[ "$(<"$guarded_delivery_exact_record/git-commit.txt")" == "$guarded_delivery_exact_commit" \
  && "$(<"$guarded_delivery_exact_record/git-tree.txt")" == "$guarded_delivery_exact_tree" ]] || {
  fail "successful 0069 release evidence is not bound to its exact commit and tree"
}
cat >"$work/expected-guarded-delivery-contract.env" <<EOF
SCHEMA_VERSION=4
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability
DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract
GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=legacy-v0
PREVIOUS_OUTBOX_WORKER_MODE=legacy-direct-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=legacy-direct-v1
PREVIOUS_DISPATCH_BINDING_RUNTIME=none
PREVIOUS_DISPATCH_BINDING_PRIVILEGE=none
PREVIOUS_GUARDED_DELIVERY_RUNTIME=none
PREVIOUS_DELIVERY_RELEASE_AUTHORITY=none
PREVIOUS_GUARDED_DELIVERY_PRIVILEGE=none
PREVIOUS_RUNTIME_COMPATIBLE=false
FORWARD_ONLY_MIGRATION=0069_mail_outbox_guarded_delivery_authority
EOF
cmp -s "$guarded_delivery_exact_record/mail-outbox-contract.env" \
  "$work/expected-guarded-delivery-contract.env" || {
  diff -u "$work/expected-guarded-delivery-contract.env" \
    "$guarded_delivery_exact_record/mail-outbox-contract.env" >&2 || true
  fail "successful 0069 release omitted exact V4 compatibility evidence"
}
echo "ok - release accepts only the exact candidate-bound 0069 capability and writes V4 evidence"

printf '%s\n' 'second exact guarded delivery release fixture' \
  >"$guarded_delivery_exact_repo/guarded-delivery-second-release.fixture"
git -C "$guarded_delivery_exact_repo" add guarded-delivery-second-release.fixture
git -C "$guarded_delivery_exact_repo" commit -qm \
  'fixture second exact guarded delivery release'
guarded_delivery_second_commit="$(
  git -C "$guarded_delivery_exact_repo" rev-parse --verify HEAD
)"
guarded_delivery_second_tree="$(
  git -C "$guarded_delivery_exact_repo" rev-parse --verify 'HEAD^{tree}'
)"
[[ "$(git -C "$guarded_delivery_exact_repo" ls-tree "$guarded_delivery_second_tree" -- \
  "$guarded_delivery_capability_path")" == \
  "100644 blob $guarded_delivery_capability_blob"$'\t'"$guarded_delivery_capability_path" ]] || {
  fail "second 0069 candidate tree does not retain the pinned capability blob"
}
/usr/bin/python3 "$fixture_generator" \
  --source "$guarded_delivery_exact_repo" \
  --packager "$guarded_delivery_exact_repo/infra/ops/package-release-tree.py" \
  --destination "$work/guarded-delivery-second-package" \
  >/dev/null || fail "unable to package the second exact 0069 release fixture"
[[ -z "$(git -C "$guarded_delivery_exact_repo" status --porcelain=v1 --untracked-files=all)" ]] || {
  fail "second 0069 release fixture is not a clean Git tree"
}
RUN_REPO_ROOT="$guarded_delivery_exact_repo" \
  RUN_RECORD_ROOT="$guarded_delivery_exact_records" RUN_STAGE_TIMEOUT=30 \
  run_release guarded-delivery-exact-compatible-second
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "release rejected the second exact 0069 guarded delivery tree"
}
guarded_delivery_second_release_id="$(
  sed -n 's/^release_id=//p' "$guarded_delivery_exact_records/current-release.env"
)"
guarded_delivery_second_record="$guarded_delivery_exact_records/$guarded_delivery_second_release_id"
[[ -d "$guarded_delivery_second_record" \
  && "$(<"$guarded_delivery_second_record/git-commit.txt")" == "$guarded_delivery_second_commit" \
  && "$(<"$guarded_delivery_second_record/git-tree.txt")" == "$guarded_delivery_second_tree" \
  && "$(<"$guarded_delivery_second_record/previous-git-commit.txt")" == "$guarded_delivery_exact_commit" ]] || {
  fail "second 0069 release evidence is not bound to exact current and previous commits"
}
cat >"$work/expected-guarded-delivery-compatible-contract.env" <<EOF
SCHEMA_VERSION=4
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability
DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract
GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
PREVIOUS_DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
PREVIOUS_DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
PREVIOUS_GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability
PREVIOUS_DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract
PREVIOUS_GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract
PREVIOUS_RUNTIME_COMPATIBLE=true
FORWARD_ONLY_MIGRATION=none
EOF
cmp -s "$guarded_delivery_second_record/mail-outbox-contract.env" \
  "$work/expected-guarded-delivery-compatible-contract.env" || {
  diff -u "$work/expected-guarded-delivery-compatible-contract.env" \
    "$guarded_delivery_second_record/mail-outbox-contract.env" >&2 || true
  fail "second 0069 release omitted compatible V4 previous-capability evidence"
}
grep -Fxq "git_commit=$guarded_delivery_second_commit" \
  "$guarded_delivery_exact_records/current-release.env" || {
  fail "second compatible 0069 release did not advance the current pointer"
}
echo "ok - a second exact 0069 release retains the previous tuple and records compatibility"

guarded_delivery_tampered_repo="$work/guarded-delivery-tampered-repo"
git -c advice.detachedHead=false clone --quiet --no-local \
  "$guarded_delivery_exact_repo" "$guarded_delivery_tampered_repo"
git -C "$guarded_delivery_tampered_repo" remote set-url origin \
  https://github.com/example/codestead
sed -i 's/least-privilege-v1/least-privilege-v1-tampered/' \
  "$guarded_delivery_tampered_repo/$guarded_delivery_capability_path"
git -C "$guarded_delivery_tampered_repo" add "$guarded_delivery_capability_path"
git -C "$guarded_delivery_tampered_repo" commit -qm \
  'fixture tampered guarded delivery capability'
/usr/bin/python3 "$fixture_generator" \
  --source "$guarded_delivery_tampered_repo" \
  --packager "$guarded_delivery_tampered_repo/infra/ops/package-release-tree.py" \
  --destination "$work/guarded-delivery-tampered-package" \
  >/dev/null || fail "unable to package the tampered 0069 release fixture"
guarded_delivery_tampered_records="$work/guarded-delivery-tampered-records"
RUN_REPO_ROOT="$guarded_delivery_tampered_repo" \
  RUN_RECORD_ROOT="$guarded_delivery_tampered_records" RUN_STAGE_TIMEOUT=30 \
  run_release guarded-delivery-capability-tampered
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a tampered 0069 capability"
assert_only_early_quarantine \
  "$RELEASE_CASE_DIR/docker.log" "0069 tampered guarded delivery capability refusal" \
  "$guarded_delivery_tampered_repo/compose.yaml"
if find "$guarded_delivery_tampered_records" -mindepth 2 -maxdepth 2 \
    -name mail-outbox-contract.env -print -quit | grep -q .; then
  fail "0069 tampered capability refusal wrote mail outbox contract evidence"
fi
[[ ! -e "$guarded_delivery_tampered_records/current-release.env" \
  && ! -e "$guarded_delivery_tampered_records/latest-candidate.env" ]] || {
  fail "0069 tampered capability refusal advanced a release pointer"
}
grep -Fq 'guarded delivery capability has an absent, unknown, or mismatched version' \
  "$RELEASE_CASE_DIR/stderr" || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "tampered 0069 capability refusal was not explicit"
}
if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' \
    "$RELEASE_CASE_DIR/stdout" "$RELEASE_CASE_DIR/stderr"; then
  fail "tampered 0069 capability refusal disclosed Git or capability hashes"
fi
echo "ok - release rejects a candidate-bound but noncanonical 0069 capability"

cat >"$work/compose.env" <<EOF
APP_URL=https://127.0.0.1
POSTGRES_IMAGE=registry.example.test/postgres@sha256:1111111111111111111111111111111111111111111111111111111111111111
POSTGRES_UID=999
POSTGRES_GID=999
LEARN_DATA_ROOT=$work/data
UPLOADS_ENABLED=false
EOF
run_release ipv4-public-origin
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted an IPv4 APP_URL as a public origin"
[[ "$(cat "$RELEASE_CASE_DIR/docker.log")" == *$'\tstop\t--timeout\t30\tcloudflared' ]] || {
  fail "invalid release input was not durably quarantined before validation"
}
[[ -f "$work/control/release-quarantine" ]] || fail "invalid release input did not retain durable quarantine"
grep -Fq 'canonical lowercase public HTTPS origin' "$RELEASE_CASE_DIR/stderr" || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "invalid IPv4 APP_URL rejection was not explicit"
}
cat >"$work/compose.env" <<EOF
APP_URL=https://pilot.example.test
POSTGRES_IMAGE=registry.example.test/postgres@sha256:1111111111111111111111111111111111111111111111111111111111111111
POSTGRES_UID=999
POSTGRES_GID=999
LEARN_DATA_ROOT=$work/data
UPLOADS_ENABLED=false
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
EOF
echo "ok - release rejects an IPv4 APP_URL before Docker"

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
  run_release "ambient-${authority_variable,,}"
  unset "$authority_variable"
  [[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted ambient authority from $authority_variable"
  [[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "$authority_variable reached Docker"
  grep -Fq "$authority_variable is forbidden" "$RELEASE_CASE_DIR/stderr" || fail "$authority_variable rejection was not explicit"
done
echo "ok - release rejects ambient Docker and Compose authority before mutation"

grep -Fq -- '== /run/lock ]]; then' "$release_script" || {
  fail "release does not isolate the production /run/lock exception"
}
grep -Fq -- '== 0:0:1777 ]] || fatal "/run/lock must be exactly root:root mode 1777"' "$release_script" || {
  fail "release does not require exact root:root 1777 metadata for /run/lock"
}
echo "ok - release permits only the exact production /run/lock metadata contract"
forward_only_records="$work/forward-only-release-records"
RUN_RECORD_ROOT="$forward_only_records" run_release retention-authority-flag-conflict \
  --schema-backward-compatible
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || {
  fail "pre-0062 retention authority accepted generic automatic rollback"
}
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "retention authority rollback refusal"
[[ ! -e "$forward_only_records/current-release.env" ]] || {
  fail "retention authority rollback refusal advanced the current release pointer"
}
grep -Fq '0062_mail_outbox_retention_redaction' "$RELEASE_CASE_DIR/stderr" || {
  fail "retention authority rollback refusal did not name migration 0062"
}
echo "ok - pre-0062 retention authority cannot enable generic automatic rollback"


run_release success
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "normal release failed"
}
[[ ! -e "$work/control/release-quarantine" ]] || fail "successful release did not clear quarantine exactly once"
record="$(only_record_dir "$RELEASE_CASE_DIR/records")"
grep -Fxq 'result=completed' "$record/status.env" || fail "success record is not completed"
grep -Fxq 'schema_rollback=not_attempted' "$record/status.env" || fail "success record omitted schema rollback boundary"
cat >"$work/expected-forward-only-mail-contract.env" <<'EOF'
SCHEMA_VERSION=2
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=legacy-v0
PREVIOUS_OUTBOX_WORKER_MODE=legacy-direct-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=legacy-direct-v1
PREVIOUS_RUNTIME_COMPATIBLE=false
FORWARD_ONLY_MIGRATION=0062_mail_outbox_retention_redaction
EOF
cmp -s "$record/mail-outbox-contract.env" "$work/expected-forward-only-mail-contract.env" || {
  fail "first ops-owner retention release omitted its exact forward-only contract"
}
grep -Fq '0062_mail_outbox_retention_redaction' "$record/rollback.txt" || {
  fail "forward-only rollback evidence did not name migration 0062"
}
if grep -Eq '^sudo .*rollback-production\.sh.*--schema-backward-compatible$' "$record/rollback.txt"; then
  fail "forward-only rollback evidence exposed a runnable compatibility command"
fi
grep -Fq -- "$record/mail-outbox-contract.env" "$RELEASE_CASE_DIR/sync.log" || {
  fail "forward-only retention authority contract was not fsynced"
}

[[ "$(cat "$RELEASE_CASE_DIR/validate.log")" == $'operations\t--pre-privileged\noperations\t--full' ]] || {
  fail "normal release did not run both operations validation phases"
}
[[ "$(cat "$RELEASE_CASE_DIR/smoke.log")" == $'--phase internal --startup-wait 3\n--phase public --startup-wait 3' ]] || {
  fail "release did not smoke the internal stack before the public origin"
}
grep -Fq $'app\tregistry.example.test/codestead/runtime@sha256:' "$record/previous-running-images.tsv" || {
  fail "previous running image identity was not preserved"
}
[[ "$(wc -l <"$record/candidate-images.txt")" == 8 ]] || fail "candidate image inventory is incomplete"
expected_commit="$(/usr/bin/git -C "$work/repo" rev-parse --verify HEAD)"
expected_tree="$(/usr/bin/git -C "$work/repo" rev-parse --verify 'HEAD^{tree}')"
expected_application_record="$work/repo/dist/application-images/application-images.json"
expected_application_env="$work/repo/dist/application-images/application-images.env"
expected_application_sha="$(sha256sum "$expected_application_record" | cut -d' ' -f1)"
[[ "$(cat "$record/git-commit.txt")" == "$expected_commit" ]] || {
  fail "release evidence was not bound to the checked-out Git HEAD"
}
[[ "$(cat "$record/git-tree.txt")" == "$expected_tree" ]] || {
  fail "release evidence was not bound to the checked-out Git tree"
}
cmp -s "$record/application-image-record.json" "$expected_application_record" || {
  fail "release evidence did not retain the exact verified application image record"
}
[[ "$(cat "$record/application-image-record-sha256.txt")" == "$expected_application_sha" ]] || {
  fail "release evidence did not retain the exact application image record digest"
}
[[ "$(cat "$RELEASE_CASE_DIR/validate-source.log")" == "$expected_commit"$'\t'"$expected_tree" ]] || {
  fail "release preflight did not bind application images to the exact release Git commit and tree"
}
[[ "$(cat "$RELEASE_CASE_DIR/validate-image.log")" == "$expected_application_record"$'\t'"$expected_application_env" ]] || {
  fail "release preflight did not verify the fixed application image record pair"
}
grep -Fxq "release_id=$(basename "$record")" "$RELEASE_CASE_DIR/records/latest-candidate.env" || {
  fail "release did not publish the latest candidate id"
}
grep -Fxq "git_commit=$expected_commit" "$RELEASE_CASE_DIR/records/latest-candidate.env" || {
  fail "release did not publish the latest candidate Git commit"
}
for durable in status.env stages.tsv rollback.txt git-commit.txt previous-git-commit.txt previous-release-id.txt \
  git-tree.txt application-image-record.json application-image-record-sha256.txt candidate-images.txt \
  candidate-image-identities.tsv deployed-service-images.tsv previous-running-images.tsv image-acquisitions.tsv; do
  grep -Fq -- "$record/$durable" "$RELEASE_CASE_DIR/sync.log" || {
    fail "release evidence was not fsynced: $durable"
  }
done
grep -Fq -- "$RELEASE_CASE_DIR/records/latest-candidate.env" "$RELEASE_CASE_DIR/sync.log" || {
  fail "latest candidate pointer was not fsynced"
}
grep -Fq -- "$record" "$RELEASE_CASE_DIR/sync.log" || fail "release record directory was not fsynced"
[[ "$(wc -l <"$record/deployed-service-images.tsv")" == 10 ]] || fail "deployed per-service image evidence is incomplete"
for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
  file-erasure-worker practice-runner-recovery-worker project-review-correction-worker cloudflared runner-egress-gateway; do
  [[ "$(grep -c "^${service}"$'\t' "$record/deployed-service-images.tsv")" == 1 ]] || fail "deployed evidence omitted or duplicated $service"
done

active_state="$RELEASE_RUNTIME_STATE_ROOT_USED/active-release.env"
active_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$active_state")"
active_application_sha="$(sed -n 's/^APPLICATION_IMAGE_RECORD_SHA256=//p' "$active_state")"
managed_state="$RELEASE_RUNTIME_STATE_ROOT_USED/managed-containers.$active_managed_sha.tsv"
application_state="$RELEASE_RUNTIME_STATE_ROOT_USED/application-images.$active_application_sha.json"
[[ -f "$active_state" && ! -L "$active_state" ]] || fail "active release state was not atomically published"
[[ -f "$managed_state" && ! -L "$managed_state" ]] || fail "hash-addressed managed inventory was not published"
[[ -f "$application_state" && ! -L "$application_state" ]] || fail "hash-addressed application record was not published"
[[ "$(stat -c '%a' "$active_state")" == 644 && "$(stat -c '%a' "$managed_state")" == 644 \
  && "$(stat -c '%a' "$application_state")" == 644 ]] || {
  fail "published runtime state does not have protected mode 0644"
}
cmp -s "$active_state" "$record/active-release.env" || fail "published active state is not retained in its release record"
cmp -s "$managed_state" "$record/managed-containers.tsv" || fail "published inventory is not retained in its release record"
cmp -s "$application_state" "$record/application-image-record.json" || fail "published application record is not the retained verified record"
[[ ! -e "$RELEASE_RUNTIME_STATE_ROOT_USED/managed-containers.tsv" ]] || fail "release published a mutable fixed-name inventory"
mapfile -t managed_services < <(cut -f1 "$managed_state")
expected_managed_services=(
  app cloudflared exam-finalization-worker file-erasure-worker mail-worker postgres
  practice-runner-recovery-worker project-review-correction-worker regrade-worker reward-worker runner-egress-gateway
)
[[ "${managed_services[*]}" == "${expected_managed_services[*]}" ]] || fail "managed inventory order or coverage is invalid"
while IFS=$'\t' read -r service container image identity extra; do
  [[ -n "$service" && -z "$extra" ]] || fail "managed inventory row is malformed"
  [[ "$container" == "learncoding-$service-1" ]] || fail "managed inventory container identity is invalid"
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || fail "managed inventory image is not canonical"
  [[ "$identity" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "managed inventory image identity is malformed"
done <"$managed_state"
managed_sha="$(sha256sum "$managed_state" | cut -d' ' -f1)"
manifest_sha="$(sha256sum "$work/repo/RELEASE.SHA256SUMS" | cut -d' ' -f1)"
firewall_sha="$(sha256sum "$work/repo/infra/runner-vm/host-runner.nft" | cut -d' ' -f1)"
runtime_sha="$(sha256sum "$work/repo/services/runner/dist/runtime-images.env" | cut -d' ' -f1)"
expected_active="$(printf '%s\n' \
  'SCHEMA_VERSION=1' \
  "GIT_COMMIT=$expected_commit" \
  "GIT_TREE=$expected_tree" \
  "RELEASE_MANIFEST_SHA256=$manifest_sha" \
  "APPLICATION_IMAGE_RECORD_SHA256=$expected_application_sha" \
  'COMPOSE_PROJECT=learncoding' \
  'COMPOSE_WORKDIR=/opt/learncoding' \
  'PUBLIC_ORIGIN=https://pilot.example.test' \
  "MANAGED_INVENTORY_SHA256=$managed_sha" \
  "FIREWALL_POLICY_SHA256=$firewall_sha" \
  "RUNNER_GUEST_RELEASE_SHA256=$manifest_sha" \
  "RUNNER_RUNTIME_IMAGES_SHA256=$runtime_sha")"
[[ "$(cat "$active_state")" == "$expected_active" ]] || fail "active release manifest does not match the recovery consumer schema"
grep -Fq -- "$managed_state" "$RELEASE_CASE_DIR/sync.log" || fail "managed inventory publication was not fsynced"
grep -Fq -- "$application_state" "$RELEASE_CASE_DIR/sync.log" || fail "application record publication was not fsynced"
grep -Fq -- "$active_state" "$RELEASE_CASE_DIR/sync.log" || fail "active manifest publication was not fsynced"
echo "ok - completed release atomically publishes recovery runtime state"
[[ ! -s "$RELEASE_CASE_DIR/date.log" ]] || fail "release executed date from inherited PATH"
[[ ! -s "$RELEASE_CASE_DIR/git.log" ]] || fail "release executed git from inherited PATH"

log="$RELEASE_CASE_DIR/docker.log"
trace="$RELEASE_CASE_DIR/trace.log"
pre_validator_line="$(line_number $'validate\t--pre-privileged' "$trace")"
postgres_prep_line="$(line_number 'prepare-postgres' "$trace")"
object_prep_line="$(line_number 'prepare-object' "$trace")"
full_validator_line="$(line_number $'validate\t--full' "$trace")"
tunnel_stop_line="$(line_number $'\tstop\t--timeout\t30\tcloudflared' "$trace")"
mutator_stop_line="$(line_number $'\tstop\t--timeout\t60\tapp\tmail-worker' "$trace")"
postgres_line="$(line_number $'\tup\t-d\t--wait\t--wait-timeout\t5\t--no-build\t--pull\tnever\tpostgres' "$trace")"
postgres_major_line="$(line_number 'codestead-production-pg-major-v1' "$trace")"
session_fence_line="$(line_number 'pg_stat_activity' "$trace")"
role_lines=()
mapfile -t role_lines < <(
  grep -n -F -- $'\t--exit-code-from\tdatabase-role-bootstrap\tdatabase-role-bootstrap' "$trace" |
    cut -d: -f1
)
role_line="${role_lines[0]:-}"
role_reconciliation_line="${role_lines[1]:-}"
negative_line="$(line_number $'\t--exit-code-from\tdatabase-negative-probes\tdatabase-negative-probes' "$trace")"
migrate_line="$(line_number $'\t--exit-code-from\tmigrate\tmigrate' "$trace")"
seed_line="$(line_number $'\t--exit-code-from\tplatform-seed\tplatform-seed' "$trace")"
boundary_line="$(line_number $'\t--exit-code-from\tdatabase-boundary-verifier\tdatabase-boundary-verifier' "$trace")"
pilot_line="$(line_number $'\tup\t-d\t--no-build\t--pull\tnever\t--remove-orphans\tpostgres\tapp\trunner-egress-gateway\tmail-worker' "$trace")"
internal_smoke_line="$(line_number $'smoke\t--phase internal' "$trace")"
tunnel_start_line="$(line_number $'\tup\t-d\t--no-deps\t--no-build\t--pull\tnever\tcloudflared' "$trace")"
[[ -n "$pre_validator_line" && -n "$postgres_prep_line" && -n "$object_prep_line" \
  && -n "$full_validator_line" && -n "$tunnel_stop_line" && -n "$mutator_stop_line" \
  && -n "$postgres_line" && -n "$postgres_major_line" \
  && -n "$session_fence_line" && -n "$role_line" \
  && "${#role_lines[@]}" -eq 2 && -n "$role_reconciliation_line" \
  && -n "$negative_line" && -n "$migrate_line" && -n "$seed_line" \
  && -n "$boundary_line" && -n "$pilot_line" && -n "$internal_smoke_line" \
  && -n "$tunnel_start_line" ]] || {
  fail "release cutover trace omitted a required stage"
}
[[ "$tunnel_stop_line" == 1 ]] || {
  fail "durable release quarantine was not followed by the immediate tunnel stop"
}
(( tunnel_stop_line < pre_validator_line \
  && pre_validator_line < postgres_prep_line \
  && postgres_prep_line < object_prep_line \
  && object_prep_line < full_validator_line \
  && full_validator_line < mutator_stop_line \
  && mutator_stop_line < postgres_line \
  && postgres_line < postgres_major_line \
  && postgres_major_line < session_fence_line \
  && session_fence_line < role_line \
  && role_line < negative_line \
  && negative_line < migrate_line \
  && migrate_line < role_reconciliation_line \
  && role_reconciliation_line < seed_line \
  && seed_line < boundary_line \
  && boundary_line < pilot_line \
  && pilot_line < internal_smoke_line \
  && internal_smoke_line < tunnel_start_line )) || {
  fail "release cutover stages ran out of fail-closed order"
}
if grep -Fq $'\tadmin-bootstrap' "$log"; then fail "bootstrap ran without the explicit flag"; fi
if grep -Fq $'\tlifecycle' "$log"; then fail "scheduled lifecycle ran during release"; fi
pilot_command="$(grep -m1 -F -- $'\tup\t-d\t--no-build\t--pull\tnever\t--remove-orphans\tpostgres\tapp\trunner-egress-gateway\tmail-worker' "$log")"
[[ "$pilot_command" != *$'\tcloudflared'* ]] || fail "candidate tunnel started before internal smoke"
if grep -Fq $'pull\tregistry.example.test' "$log"; then
  fail "default release silently pulled images"
fi
if grep -Fq $'\t--profile\toperations\trun\t' "$log"; then fail "release used Compose run with unsupported --no-build"; fi
for service in database-role-bootstrap database-negative-probes migrate platform-seed database-boundary-verifier; do
  grep -Fq $'\t--profile\toperations\trm\t-f\t'"$service" "$log" || {
    fail "successful one-shot was not removed: $service"
  }
done
[[ "$(grep -Fc \
  $'\t--profile\toperations\trm\t-f\tdatabase-role-bootstrap' \
  "$log")" == 2 ]] || {
  fail "successful release did not remove both role bootstrap one-shots"
}
assert_immutable_flags "$log"
assert_no_secret "$RELEASE_CASE_DIR"
echo "ok - explicit release orders pinned existing images and records rollback evidence"

rm -f "$work/slow.ready" "$work/slow.release"
(
  RUN_COUNTER=9000
  run_release slow-transaction
) &
slow_pid=$!
for _attempt in {1..100}; do
  [[ -e "$work/slow.ready" ]] && break
  sleep 0.05
done
[[ -e "$work/slow.ready" ]] || fail "slow release did not reach its held transaction stage"
[[ "$(/usr/bin/python3.12 "$work/repo/infra/ops/ingress-control.py" --test-harness-root "$work" status --now 100)" == release-quarantined ]] || {
  fail "slow release did not block timer/start ingress authorization"
}
touch "$work/slow.release"
wait "$slow_pid"
[[ ! -e "$work/control/release-quarantine" ]] || fail "successful slow release did not clear quarantine"
echo "ok - durable quarantine blocks ingress authorization throughout a slow locked transaction"

run_release bootstrap-success --bootstrap-admin
[[ "$RELEASE_STATUS" == 0 ]] || fail "explicit bootstrap release failed"
[[ "$(cat "$RELEASE_CASE_DIR/validate.log")" == $'operations\t--pre-privileged\noperations\t--full' ]] || {
  fail "bootstrap release did not run both operations validation phases"
}
bootstrap_log="$RELEASE_CASE_DIR/docker.log"
seed_line="$(line_number $'\tplatform-seed' "$bootstrap_log")"
bootstrap_line="$(line_number $'\tadmin-bootstrap' "$bootstrap_log")"
boundary_line="$(line_number $'\tdatabase-boundary-verifier' "$bootstrap_log")"
pilot_line="$(line_number $'\tup\t-d\t--no-build\t--pull\tnever\t--remove-orphans\tpostgres\tapp' "$bootstrap_log")"
(( seed_line < bootstrap_line && bootstrap_line < boundary_line && boundary_line < pilot_line )) || fail "bootstrap did not run before verification and pilot"
if grep -Fq $'\tlifecycle' "$bootstrap_log"; then fail "bootstrap release ran scheduled lifecycle"; fi
assert_no_secret "$RELEASE_CASE_DIR"
echo "ok - bootstrap is explicit and uses the file-secret preflight"

run_release acquisition --acquire-images
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "explicit image acquisition release failed"
}
[[ "$(grep -Fc $'pull\tregistry.example.test/codestead/image' "$RELEASE_CASE_DIR/docker.log")" == 8 ]] || {
  fail "explicit acquisition did not pull every exact digest"
}
first_pull="$(line_number $'pull\tregistry.example.test/codestead/image' "$RELEASE_CASE_DIR/docker.log")"
postgres_after_pull="$(line_number $'\tup\t-d\t--wait' "$RELEASE_CASE_DIR/docker.log")"
(( first_pull < postgres_after_pull )) || fail "image acquisition happened after release mutation"
acquisition_record="$(only_record_dir "$RELEASE_CASE_DIR/records")"
[[ "$(wc -l <"$acquisition_record/image-acquisitions.tsv")" == 8 ]] || {
  fail "durable image acquisition evidence is incomplete"
}
cut -f2 "$acquisition_record/image-acquisitions.tsv" >"$RELEASE_CASE_DIR/acquired-images.txt"
cmp -s "$acquisition_record/candidate-images.txt" "$RELEASE_CASE_DIR/acquired-images.txt" || {
  fail "durable image acquisition evidence does not name every exact candidate digest"
}
grep -Fq -- "$acquisition_record/image-acquisitions.tsv" "$RELEASE_CASE_DIR/sync.log" || {
  fail "image acquisition evidence was not fsynced"
}
echo "ok - exact digest acquisition is explicit and audited"

shared_records="$work/shared-release-records"
RUN_RECORD_ROOT="$shared_records" run_release pointer-first
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" == 0 ]] || fail "first shared-root release failed"
first_shared_record="$(find "$shared_records" -mindepth 1 -maxdepth 1 -type d -print)"
first_shared_commit="$(cat "$first_shared_record/git-commit.txt")"
mismatch_records="$work/mismatch-release-records"
cp -a "$shared_records" "$mismatch_records"
RUN_RECORD_ROOT="$mismatch_records" run_release pointer-mismatch
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a pre-release runtime not bound to the linked reviewed release"
grep -Fxq "release_id=$(basename "$first_shared_record")" "$mismatch_records/current-release.env" || {
  fail "unbound pre-release runtime advanced the deployed release pointer"
}
if grep -Fq $'\tup\t-d\t--wait' "$RELEASE_CASE_DIR/docker.log"; then
  fail "unbound pre-release runtime reached candidate mutation"
fi
echo "ok - pre-release runtime must match prior per-service reviewed evidence"

printf '%s\n' '# next reviewed release' >>"$work/repo/compose.yaml"
git -C "$work/repo" add compose.yaml
git -C "$work/repo" commit -qm 'fixture second release commit'
regenerate_release_fixture
second_shared_commit="$(git -C "$work/repo" rev-parse --verify HEAD)"
RUN_RECORD_ROOT="$shared_records" run_release pointer-second
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "second shared-root release failed"
}
second_shared_record="$(find "$shared_records" -mindepth 1 -maxdepth 1 -type d ! -path "$first_shared_record" -print)"
[[ "$(cat "$second_shared_record/previous-git-commit.txt")" == "$first_shared_commit" ]] || {
  fail "second release did not record the previously deployed Git revision"
}
[[ "$(cat "$second_shared_record/previous-release-id.txt")" == "$(basename "$first_shared_record")" ]] || {
  fail "second release did not link its previous completed release record"
}
grep -Fxq "release_id=$(basename "$second_shared_record")" "$shared_records/current-release.env" || {
  fail "current release pointer did not advance atomically"
}
grep -Fxq "git_commit=$second_shared_commit" "$shared_records/current-release.env" || {
  fail "current release pointer Git commit is wrong"
}
echo "ok - consecutive releases retain the exact previous Git/release pointer"

dual_contract="$second_shared_record/mail-outbox-contract.env"
grep -Fxq 'SCHEMA_VERSION=2' "$dual_contract" || fail "dual-write release omitted its contract schema"
grep -Fxq 'MAIL_OUTBOX_PHASE=dual-write-v1' "$dual_contract" || fail "dual-write release omitted its phase"
grep -Fxq 'OUTBOX_WORKER_MODE=fenced-postgres-v1' "$dual_contract" || fail "dual-write release omitted its fenced claimant"
grep -Fxq 'OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1' "$dual_contract" || {
  fail "dual-write release omitted its ops-owner retention authority"
}
grep -Fxq 'STORE_CUTOVER=false' "$dual_contract" || fail "dual-write release was mislabeled as a cutover"
grep -Fxq 'PREVIOUS_OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1' "$dual_contract" || {
  fail "later ops-aware release did not retain its compatible predecessor authority"
}
grep -Fxq 'PREVIOUS_RUNTIME_COMPATIBLE=true' "$dual_contract" || {
  fail "later ops-aware release was not marked rollback eligible"
}
grep -Fxq 'FORWARD_ONLY_MIGRATION=none' "$dual_contract" || {
  fail "later ops-aware release retained a stale forward-only migration boundary"
}
grep -Eq '^sudo .*rollback-production\.sh.*--schema-backward-compatible$' \
  "$second_shared_record/rollback.txt" || {
  fail "later ops-aware release omitted its explicit compatibility command"
}
echo "ok - dual-write release records its fenced claimant contract"

printf '%s\n' '# reviewed mail store cutover release' \
  >>"$guarded_delivery_exact_repo/compose.yaml"
git -C "$guarded_delivery_exact_repo" add compose.yaml
git -C "$guarded_delivery_exact_repo" commit -qm 'fixture mail store cutover release'
/usr/bin/python3 "$fixture_generator" \
  --source "$guarded_delivery_exact_repo" \
  --packager "$guarded_delivery_exact_repo/infra/ops/package-release-tree.py" \
  --destination "$work/guarded-delivery-cutover-package" \
  >/dev/null || fail "unable to package the exact guarded delivery cutover fixture"
[[ -z "$(git -C "$guarded_delivery_exact_repo" status --porcelain=v1 --untracked-files=all)" ]] || {
  fail "guarded delivery cutover fixture is not a clean Git tree"
}

set_mail_release_contract() {
  local phase="$1" mode="$2"
  sed -i "s/^MAIL_OUTBOX_PHASE=.*/MAIL_OUTBOX_PHASE=$phase/" "$work/compose.env"
  sed -i "s/^OUTBOX_WORKER_MODE=.*/OUTBOX_WORKER_MODE=$mode/" "$work/compose.env"
}
set_mail_release_contract store-v1 fenced-postgres-v1

mail_cutover_base="$work/mail-cutover-base"
cp -a "$guarded_delivery_exact_records" "$mail_cutover_base"

mail_flag_records="$work/mail-cutover-flag-conflict"
cp -a "$mail_cutover_base" "$mail_flag_records"
RUN_REPO_ROOT="$guarded_delivery_exact_repo" \
  RUN_RECORD_ROOT="$mail_flag_records" RUN_STAGE_TIMEOUT=30 \
  run_release mail-cutover-success \
  --mail-store-cutover --schema-backward-compatible
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" != 0 ]] || fail "mail cutover accepted generic automatic rollback"
grep -Fq 'mutually exclusive' "$RELEASE_CASE_DIR/stderr" || {
  fail "mail cutover/schema rollback flag conflict was not explicit"
}
echo "ok - mail cutover cannot enable legacy automatic rollback"

mail_backup_records="$work/mail-cutover-backup-lock"
cp -a "$mail_cutover_base" "$mail_backup_records"
cp "$mail_backup_records/current-release.env" "$work/mail-backup-pointer-before.env"
RUN_REPO_ROOT="$guarded_delivery_exact_repo" \
  RUN_RECORD_ROOT="$mail_backup_records" RUN_STAGE_TIMEOUT=30 \
  run_release mail-backup-lock-busy --mail-store-cutover
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" != 0 ]] || fail "mail cutover ignored the active host backup writer lock"
grep -Fq 'host backup writer lock' "$RELEASE_CASE_DIR/stderr" || {
  fail "host backup writer lock refusal was not explicit"
}
cmp -s "$mail_backup_records/current-release.env" "$work/mail-backup-pointer-before.env" || {
  fail "backup-lock refusal advanced the release pointer"
}
if grep -Fq $'\tstop\t--timeout\t60\tapp' "$RELEASE_CASE_DIR/docker.log"; then
  fail "mail cutover stopped mutators before fencing the host backup writer"
fi
echo "ok - mail cutover fences the independent host backup writer first"

mail_drain_records="$work/mail-cutover-drain-failure"
cp -a "$mail_cutover_base" "$mail_drain_records"
cp "$mail_drain_records/current-release.env" "$work/mail-drain-pointer-before.env"
RUN_REPO_ROOT="$guarded_delivery_exact_repo" \
  RUN_RECORD_ROOT="$mail_drain_records" RUN_STAGE_TIMEOUT=30 \
  run_release mail-drain-failure --mail-store-cutover
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" != 0 ]] || fail "mail cutover accepted an in-flight pre-cutover claim"
grep -Fq 'pre-cutover mail claims did not drain' "$RELEASE_CASE_DIR/stderr" || {
  fail "pre-cutover mail drain refusal was not explicit"
}
if grep -Fq $'\t--exit-code-from\tmigrate\tmigrate' "$RELEASE_CASE_DIR/docker.log"; then
  fail "mail cutover migrated before the pre-cutover claimant drained"
fi
cmp -s "$mail_drain_records/current-release.env" "$work/mail-drain-pointer-before.env" || {
  fail "mail drain refusal advanced the release pointer"
}
echo "ok - mail cutover drains the pre-cutover claimant before 0059"

mail_contract_records="$work/mail-cutover-contract-failure"
cp -a "$mail_cutover_base" "$mail_contract_records"
cp "$mail_contract_records/current-release.env" "$work/mail-contract-pointer-before.env"
RUN_REPO_ROOT="$guarded_delivery_exact_repo" \
  RUN_RECORD_ROOT="$mail_contract_records" RUN_STAGE_TIMEOUT=30 \
  run_release mail-contract-failure --mail-store-cutover
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" != 0 ]] || fail "mail cutover accepted an incomplete 0059 contract"
grep -Fq '0059 delivery-scope contract is incomplete' "$RELEASE_CASE_DIR/stderr" || {
  fail "0059 contract refusal was not explicit"
}
if grep -Fq $'\tup\t-d\t--no-build\t--pull\tnever\t--remove-orphans\tpostgres\tapp' "$RELEASE_CASE_DIR/docker.log"; then
  fail "mail worker started before the 0059 contract passed"
fi
cmp -s "$mail_contract_records/current-release.env" "$work/mail-contract-pointer-before.env" || {
  fail "0059 contract refusal advanced the release pointer"
}
echo "ok - mail cutover requires the completed 0059 catch-up contract"

mail_success_records="$work/mail-cutover-success"
cp -a "$mail_cutover_base" "$mail_success_records"
RUN_REPO_ROOT="$guarded_delivery_exact_repo" \
  RUN_RECORD_ROOT="$mail_success_records" RUN_STAGE_TIMEOUT=30 \
  run_release mail-cutover-success --mail-store-cutover
unset RUN_REPO_ROOT RUN_RECORD_ROOT RUN_STAGE_TIMEOUT
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "gated mail store cutover failed"
}
mail_success_id="$(sed -n 's/^release_id=//p' "$mail_success_records/current-release.env")"
mail_success_record="$mail_success_records/$mail_success_id"
cat >"$work/expected-mail-cutover-contract.env" <<EOF
SCHEMA_VERSION=4
MAIL_OUTBOX_PHASE=store-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability
DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract
GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract
STORE_CUTOVER=true
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
PREVIOUS_DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
PREVIOUS_DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
PREVIOUS_GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability
PREVIOUS_DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract
PREVIOUS_GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract
PREVIOUS_RUNTIME_COMPATIBLE=false
FORWARD_ONLY_MIGRATION=none
EOF
cmp -s "$mail_success_record/mail-outbox-contract.env" "$work/expected-mail-cutover-contract.env" || {
  diff -u "$work/expected-mail-cutover-contract.env" "$mail_success_record/mail-outbox-contract.env" >&2 || true
  fail "successful mail cutover evidence is incomplete"
}
backup_lock_line="$(line_number $'\tmail-outbox-host-backup-fence\tcompleted' "$mail_success_record/stages.tsv")"
mutator_stop_line="$(line_number $'\tstop-database-mutators\tstarted' "$mail_success_record/stages.tsv")"
drain_line="$(line_number $'\tmail-outbox-drain\tstarted' "$mail_success_record/stages.tsv")"
migrate_line="$(line_number $'\tmigrate\tstarted' "$mail_success_record/stages.tsv")"
contract_line="$(line_number $'\tmail-outbox-0059-catch-up\tstarted' "$mail_success_record/stages.tsv")"
core_line="$(line_number $'\tcore-start\tstarted' "$mail_success_record/stages.tsv")"
(( backup_lock_line < mutator_stop_line && mutator_stop_line < drain_line \
  && drain_line < migrate_line && migrate_line < contract_line && contract_line < core_line )) || {
  fail "mail cutover did not preserve backup-fence -> drain -> 0059 -> claimant order"
}
echo "ok - mail store cutover is ordered and durably evidenced"

set_mail_release_contract dual-write-v1 fenced-postgres-v1

publication_records="$work/publication-release-records"
publication_runtime_state="$work/publication-runtime-state"
RUN_RECORD_ROOT="$publication_records" RUN_RUNTIME_STATE_ROOT="$publication_runtime_state" \
  run_release publication-base
unset RUN_RECORD_ROOT RUN_RUNTIME_STATE_ROOT
[[ "$RELEASE_STATUS" == 0 ]] || fail "runtime publication fixture base release failed"
cp "$publication_records/current-release.env" "$work/publication-pointer-before.env"
cp "$publication_runtime_state/active-release.env" "$work/publication-active-before.env"
base_publication_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$work/publication-active-before.env")"
base_publication_application_sha="$(sed -n 's/^APPLICATION_IMAGE_RECORD_SHA256=//p' "$work/publication-active-before.env")"
base_publication_inventory="$publication_runtime_state/managed-containers.${base_publication_managed_sha}.tsv"
base_publication_application="$publication_runtime_state/application-images.${base_publication_application_sha}.json"
[[ -f "$base_publication_inventory" && -f "$base_publication_application" ]] || {
  fail "base runtime publication omitted content-addressed evidence"
}
cp "$base_publication_inventory" "$work/publication-inventory-before.tsv"
cp "$base_publication_application" "$work/publication-application-before.json"
base_publication_release_id="$(sed -n 's/^release_id=//p' "$work/publication-pointer-before.env")"

printf '%s\n' '# runtime publication failure candidate' >>"$work/repo/compose.yaml"
git -C "$work/repo" add compose.yaml
git -C "$work/repo" commit -qm 'fixture runtime publication failure candidate'
regenerate_release_fixture
RUN_RECORD_ROOT="$publication_records" RUN_RUNTIME_STATE_ROOT="$publication_runtime_state" \
  run_release runtime-state-active-fsync-failure
unset RUN_RECORD_ROOT RUN_RUNTIME_STATE_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || fail "release ignored active runtime state fsync failure"
cmp -s "$publication_records/current-release.env" "$work/publication-pointer-before.env" || {
  fail "runtime state publication failure advanced the deployed release pointer"
}
cmp -s "$publication_runtime_state/active-release.env" "$work/publication-active-before.env" || {
  fail "runtime state publication failure replaced the prior active release manifest"
}
cmp -s "$base_publication_inventory" "$work/publication-inventory-before.tsv" || {
  fail "runtime state publication failure changed the prior managed inventory fixture"
}
cmp -s "$base_publication_application" "$work/publication-application-before.json" || {
  fail "runtime state publication failure changed the prior application image record fixture"
}
failed_publication_release_id="$(sed -n 's/^release_id=//p' "$publication_records/latest-candidate.env")"
[[ -n "$failed_publication_release_id" && "$failed_publication_release_id" != "$base_publication_release_id" ]] || {
  fail "runtime state publication failure did not retain the failed candidate identity"
}
grep -Fxq 'result=failed' "$publication_records/$failed_publication_release_id/status.env" || {
  fail "runtime state publication failure did not retain failed evidence"
}
failed_publication_active="$publication_records/$failed_publication_release_id/active-release.env"
failed_publication_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$failed_publication_active")"
failed_publication_application_sha="$(sed -n 's/^APPLICATION_IMAGE_RECORD_SHA256=//p' "$failed_publication_active")"
[[ "$failed_publication_managed_sha" != "$base_publication_managed_sha" ]] || {
  fail "crash fixture did not exercise a different managed inventory"
}
[[ "$failed_publication_application_sha" != "$base_publication_application_sha" ]] || {
  fail "crash fixture did not exercise a different application image record"
}
[[ -f "$publication_runtime_state/managed-containers.${failed_publication_managed_sha}.tsv" \
  && -f "$publication_runtime_state/application-images.${failed_publication_application_sha}.json" ]] || {
  fail "pre-commit immutable runtime evidence was not durably published"
}
[[ ! -e "$publication_runtime_state/managed-containers.tsv" && ! -e "$publication_runtime_state/application-images.json" ]] || {
  fail "runtime publication left a mutable fixed evidence path"
}
[[ "$(grep -Fc $'\tstop\t--timeout\t30\tcloudflared' "$RELEASE_CASE_DIR/docker.log")" -ge 2 ]] || {
  fail "runtime state publication failure did not re-quarantine the tunnel"
}
if find "$publication_runtime_state" -mindepth 1 -maxdepth 1 -name '.*.tmp' -print -quit | grep -q .; then
  fail "runtime state publication failure left a temporary publication artifact"
fi
echo "ok - runtime state publication failure preserves the prior recovery commit point"
failed_publication_application="$publication_runtime_state/application-images.${failed_publication_application_sha}.json"
printf '%s\n' 'corrupted content-addressed application record' >"$failed_publication_application"
RUN_RECORD_ROOT="$publication_records" RUN_RUNTIME_STATE_ROOT="$publication_runtime_state" \
  run_release runtime-state-active-fsync-failure
unset RUN_RECORD_ROOT RUN_RUNTIME_STATE_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || fail "release overwrote a corrupted existing content-addressed record"
grep -Fq 'does not match its content address' "$RELEASE_CASE_DIR/stderr" || {
  fail "corrupted existing content-addressed record rejection was not explicit"
}
cmp -s "$publication_records/current-release.env" "$work/publication-pointer-before.env" || {
  fail "corrupted content-addressed record advanced the deployed release pointer"
}
cmp -s "$publication_runtime_state/active-release.env" "$work/publication-active-before.env" || {
  fail "corrupted content-addressed record replaced the prior active manifest"
}
echo "ok - release rejects a corrupted pre-existing content-addressed record"


restore_records="$work/restore-release-records"
assert_postcommit_boundary() {
  local scenario="$1" suffix="$2"
  local postcommit_records="$work/postcommit-${suffix}-records"
  local runtime_state="$work/postcommit-${suffix}-runtime-state"
  local pointer_before="$work/postcommit-${suffix}-pointer-before.env"
  local active_before="$work/postcommit-${suffix}-active-before.env"
  RUN_RECORD_ROOT="$postcommit_records" RUN_RUNTIME_STATE_ROOT="$runtime_state" run_release postcommit-base
  unset RUN_RECORD_ROOT RUN_RUNTIME_STATE_ROOT
  [[ "$RELEASE_STATUS" == 0 ]] || fail "$suffix post-commit base release failed"
  cp "$postcommit_records/current-release.env" "$pointer_before"
  cp "$runtime_state/active-release.env" "$active_before"

  printf '%s\n' "# $suffix post-commit candidate" >>"$work/repo/compose.yaml"
  git -C "$work/repo" add compose.yaml
  git -C "$work/repo" commit -qm "fixture $suffix post-commit candidate"
  regenerate_release_fixture
  local candidate_commit
  candidate_commit="$(git -C "$work/repo" rev-parse --verify HEAD)"
  RUN_RECORD_ROOT="$postcommit_records" RUN_RUNTIME_STATE_ROOT="$runtime_state" \
    run_release "$scenario" --schema-backward-compatible
  unset RUN_RECORD_ROOT RUN_RUNTIME_STATE_ROOT
  [[ "$RELEASE_STATUS" != 0 ]] || fail "$suffix post-commit failure was reported as success"
  cmp -s "$postcommit_records/current-release.env" "$pointer_before" || {
    fail "$suffix post-commit failure changed the old audit pointer"
  }
  if cmp -s "$runtime_state/active-release.env" "$active_before"; then
    fail "$suffix post-commit failure did not retain the visible candidate commit marker"
  fi
  grep -Fxq "GIT_COMMIT=$candidate_commit" "$runtime_state/active-release.env" || {
    fail "$suffix post-commit active manifest does not bind the candidate"
  }
  local candidate_release_id candidate_record active_managed_sha active_application_sha
  candidate_release_id="$(sed -n 's/^release_id=//p' "$postcommit_records/latest-candidate.env")"
  candidate_record="$postcommit_records/$candidate_release_id"
  grep -Fxq 'result=failed' "$candidate_record/status.env" || fail "$suffix post-commit record is not rollback-eligible"
  grep -Fxq 'stage=complete' "$candidate_record/status.env" || fail "$suffix post-commit failure stage is wrong"
  grep -Fxq 'schema_rollback=not_attempted' "$candidate_record/status.env" || {
    fail "$suffix post-commit failure falsely claimed an automatic restore"
  }
  grep -Fq 'automatic_restore_skipped_after_runtime_state_commit' "$candidate_record/stages.tsv" || {
    fail "$suffix post-commit failure did not record the restore guard"
  }
  if grep -Fq 'previous-runtime.override.yaml' "$RELEASE_CASE_DIR/docker.log"; then
    fail "$suffix post-commit failure restored containers behind the committed active manifest"
  fi
  active_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$runtime_state/active-release.env")"
  active_application_sha="$(sed -n 's/^APPLICATION_IMAGE_RECORD_SHA256=//p' "$runtime_state/active-release.env")"
  [[ -f "$runtime_state/managed-containers.${active_managed_sha}.tsv" \
    && -f "$runtime_state/application-images.${active_application_sha}.json" ]] || {
    fail "$suffix post-commit active manifest references missing immutable evidence"
  }
  if find "$postcommit_records" -mindepth 1 -maxdepth 1 -name '.*.tmp' -print -quit | grep -q .; then
    fail "$suffix post-commit failure left an audit-pointer temporary"
  fi
  echo "ok - $suffix post-commit failure never restores behind the active commit marker"
}

assert_postcommit_boundary post-active-target-fsync-failure active-target-fsync
assert_postcommit_boundary post-active-pointer-fsync-failure current-pointer-fsync

RUN_RECORD_ROOT="$restore_records" run_release restore-base
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" == 0 ]] || fail "restore fixture base release failed"
RUN_RECORD_ROOT="$restore_records" run_release restorable-bound-public-smoke-failure --schema-backward-compatible
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || fail "failed candidate was reported as a successful release"
failed_release_id="$(sed -n 's/^release_id=//p' "$restore_records/latest-candidate.env")"
[[ -n "$failed_release_id" ]] || fail "failed candidate pointer did not retain the failed release identity"
record="$restore_records/$failed_release_id"
grep -Fxq 'schema_rollback=previous_runtime_restored' "$record/status.env" || {
  cat "$record/status.env" >&2
  cat "$RELEASE_CASE_DIR/stderr" >&2
  cat "$RELEASE_CASE_DIR/docker.log" >&2
  fail "explicit compatible restore did not record prior runtime restoration"
}
[[ "$(cat "$RELEASE_CASE_DIR/smoke.log")" == $'--phase internal --startup-wait 3\n--phase public --startup-wait 3\n--phase internal --startup-wait 3\n--phase public --startup-wait 3' ]] || {
  fail "previous runtime restore did not repeat both safe smoke phases"
}
[[ "$(grep -Fc $'\tstop\t--timeout\t30\tcloudflared' "$RELEASE_CASE_DIR/docker.log")" -ge 3 ]] || {
  fail "post-start failure did not immediately quarantine the tunnel"
}
[[ "$(tail -n 1 "$RELEASE_CASE_DIR/docker.log")" == *$'\tstop\t--timeout\t30\tcloudflared' ]] || {
  fail "automatic previous-runtime restoration left failed release ingress exposed"
}
echo "ok - prior runtime restore requires explicit schema compatibility and remains fail closed"

legacy_records="$work/legacy-gateway-records"
legacy_previous_id="20260718T000000Z-1"
legacy_previous_commit="1111111111111111111111111111111111111111"
legacy_previous_record="$legacy_records/$legacy_previous_id"
mkdir -p "$legacy_previous_record"
printf '%s\n' 'result=completed' >"$legacy_previous_record/status.env"
printf '%s\n' "$legacy_previous_commit" >"$legacy_previous_record/git-commit.txt"
{
  for service in app mail-worker reward-worker regrade-worker exam-finalization-worker \
    file-erasure-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '%s\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' \
      "$service" "$service" 7 8
  done
} >"$legacy_previous_record/deployed-service-images.tsv"
printf '%s\n' "release_id=$legacy_previous_id" "git_commit=$legacy_previous_commit" \
  >"$legacy_records/current-release.env"
chmod 0600 "$legacy_records/current-release.env"

RUN_RECORD_ROOT="$legacy_records" run_release legacy-gateway-transition
unset RUN_RECORD_ROOT
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "first gateway release rejected an exact pre-gateway release inventory"
}
legacy_candidate_id="$(sed -n 's/^release_id=//p' "$legacy_records/current-release.env")"
legacy_candidate_record="$legacy_records/$legacy_candidate_id"
legacy_candidate_commit="$(git -C "$work/repo" rev-parse --verify HEAD)"
[[ "$(wc -l <"$legacy_candidate_record/previous-running-images.tsv")" == 9 ]] || {
  fail "legacy transition rewrote the captured pre-gateway inventory"
}
! grep -q '^runner-egress-gateway' "$legacy_candidate_record/previous-running-images.tsv" || {
  fail "legacy transition invented a previously running gateway container"
}
expected_transition="$(printf '%s\n' \
  'SCHEMA_VERSION=1' 'MODE=legacy_pre_gateway' \
  "PREVIOUS_RELEASE_ID=$legacy_previous_id" "SOURCE_RELEASE_ID=$legacy_candidate_id" \
  "SOURCE_GIT_COMMIT=$legacy_candidate_commit" 'RETAINED_SERVICE=runner-egress-gateway' \
  "RETAINED_IMAGE=registry.example.test/codestead/image1@sha256:$(printf '%064d' 1)" \
  "RETAINED_IDENTITY=sha256:$(printf '%064d' 9)")"
[[ "$(cat "$legacy_candidate_record/previous-runtime-transition.env")" == "$expected_transition" ]] || {
  fail "legacy transition evidence is missing, malformed, or not bound to the candidate gateway"
}
grep -Fq '  runner-egress-gateway:' "$legacy_candidate_record/previous-runtime.override.yaml" || {
  fail "legacy transition override omitted the retained gateway"
}
grep -Fq 'legacy_gateway_transition' "$legacy_candidate_record/stages.tsv" || {
  fail "legacy gateway transition was not explicit in release stage evidence"
}
echo "ok - first gateway release retains a reviewed candidate gateway for exact pre-gateway restore"
for failure_case in \
  pre-privileged-failure \
  prepare-postgres-failure \
  prepare-object-failure \
  full-validation-failure \
  mutator-stop-failure \
  postgres-failure \
  postgres-major-16 \
  postgres-major-18 \
  postgres-major-malformed \
  postgres-major-query-failure \
  residual-session-failure \
  residual-current-user-session-failure \
  residual-session-noncanonical-failure \
  role-bootstrap-failure \
  role-reconciliation-failure \
  negative-probes-failure \
  migration-failure \
  seed-failure \
  bootstrap-failure \
  boundary-verifier-failure \
  pilot-failure \
  internal-smoke-failure \
  public-smoke-failure \
  public-smoke-removes-quarantine \
  tunnel-failure \
  smoke-failure \
  unpinned-image \
  uppercase-image \
  missing-image; do
  extra=()
  [[ "$failure_case" == "bootstrap-failure" ]] && extra=(--bootstrap-admin)
  run_release "$failure_case" "${extra[@]}"
  [[ "$RELEASE_STATUS" != 0 ]] || fail "$failure_case was accepted"
  [[ -f "$work/control/release-quarantine" ]] || fail "$failure_case did not leave durable quarantine"
  record="$(only_record_dir "$RELEASE_CASE_DIR/records")"
  grep -Fxq 'result=failed' "$record/status.env" || fail "$failure_case did not preserve a failed release record"
  grep -Fxq 'schema_rollback=not_attempted' "$record/status.env" || fail "$failure_case falsely implied schema rollback"
  grep -Fq 'Restore a verified recovery point for an incompatible schema' "$record/rollback.txt" || {
    fail "$failure_case did not preserve the schema rollback boundary"
  }
  assert_no_secret "$RELEASE_CASE_DIR"
  case "$failure_case" in
    mutator-stop-failure|postgres-failure|postgres-major-16|postgres-major-18|\
      postgres-major-malformed|postgres-major-query-failure|residual-session-failure|\
      residual-current-user-session-failure|residual-session-noncanonical-failure|\
      role-bootstrap-failure|role-reconciliation-failure|\
      negative-probes-failure|migration-failure|seed-failure|bootstrap-failure|\
      boundary-verifier-failure|pilot-failure|internal-smoke-failure|\
      public-smoke-failure|tunnel-failure|smoke-failure)
    grep -Fq $'\tstop\t--timeout\t30\tcloudflared' "$RELEASE_CASE_DIR/docker.log" || {
      fail "$failure_case did not quarantine cloudflared after candidate mutation"
    }
      ;;
  esac
  if [[ "$failure_case" == postgres-major-* ]]; then
    grep -Fq 'codestead-production-pg-major-v1' "$RELEASE_CASE_DIR/docker.log" || {
      fail "$failure_case did not query the live PostgreSQL server version"
    }
    if grep -Fq \
      $'\t--exit-code-from\tdatabase-role-bootstrap\tdatabase-role-bootstrap' \
      "$RELEASE_CASE_DIR/docker.log"; then
      fail "$failure_case reached database role bootstrap after the version gate"
    fi
    if grep -Fq $'\t--exit-code-from\tmigrate\tmigrate' \
      "$RELEASE_CASE_DIR/docker.log"; then
      fail "$failure_case reached migration after the version gate"
    fi
  fi
  if [[ "$failure_case" == residual-* ]]; then
    if grep -Fq $'\t--exit-code-from\tdatabase-role-bootstrap\tdatabase-role-bootstrap' "$RELEASE_CASE_DIR/docker.log"; then
      fail "$failure_case reached database role bootstrap after a failed session fence"
    fi
    if grep -Fq $'\tup\t-d\t--no-build\t--pull\tnever\t--remove-orphans\tpostgres\tapp' "$RELEASE_CASE_DIR/docker.log"; then
      fail "$failure_case started application services after a failed session fence"
    fi
  fi
  if [[ "$failure_case" == role-reconciliation-failure ]]; then
    grep -Fxq 'stage=database-role-reconciliation' "$record/status.env" || {
      fail "post-migration reconciliation failure recorded the wrong stage"
    }
    [[ "$(grep -Fc \
      $'\t--exit-code-from\tdatabase-role-bootstrap\tdatabase-role-bootstrap' \
      "$RELEASE_CASE_DIR/docker.log")" == 2 ]] || {
      fail "post-migration reconciliation failure did not reach exactly two bootstraps"
    }
    for forbidden_service in platform-seed admin-bootstrap database-boundary-verifier; do
      if grep -Fq $'\t--exit-code-from\t'"$forbidden_service"$'\t'"$forbidden_service" \
        "$RELEASE_CASE_DIR/docker.log"; then
        fail "post-migration reconciliation failure reached $forbidden_service"
      fi
    done
    if grep -Fq \
      $'\tup\t-d\t--no-build\t--pull\tnever\t--remove-orphans\tpostgres\tapp' \
      "$RELEASE_CASE_DIR/docker.log"; then
      fail "post-migration reconciliation failure started the candidate core"
    fi
  fi
  if grep -Fq $'\tlifecycle' "$RELEASE_CASE_DIR/docker.log"; then
    fail "$failure_case invoked scheduled lifecycle during release"
  fi
done

run_release success
[[ "$RELEASE_STATUS" == 0 ]] || fail "release rerun did not recover from durable quarantine"
[[ ! -e "$work/control/release-quarantine" ]] || fail "successful release rerun did not clear durable quarantine"
echo "ok - a failed release remains quarantined until a successful rerun"

echo "ok - every failed stage stops forward progression and preserves evidence"
RELEASE_GIT_COMMIT=1111111111111111111111111111111111111111 run_release success
[[ "$RELEASE_STATUS" != 0 ]] || fail "ambient Git commit override was accepted"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "release touched Docker after ambient commit injection"
echo "ok - release evidence cannot be forged through an ambient commit override"

touch "$work/repo/untracked-release-byte"
run_release success
rm -f "$work/repo/untracked-release-byte"
[[ "$RELEASE_STATUS" != 0 ]] || fail "dirty release checkout was accepted"
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "dirty checkout rejection"
echo "ok - release bytes must exactly match a clean reviewed Git checkout"

rm -f "$work/repo/RELEASE.SHA256SUMS"
run_release missing-release-manifest
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a missing source manifest"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "missing release manifest reached Docker"
cp "$work/current-valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

printf '%s\n' 'not a release manifest' >"$work/repo/RELEASE.SHA256SUMS"
run_release malformed-release-manifest
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a malformed source manifest"
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "malformed release manifest rejection"
grep -Fq 'release manifest' "$RELEASE_CASE_DIR/stderr" || {
  fail "malformed release manifest rejection was not explicit"
}
cp "$work/current-valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

head -n 1 "$work/current-valid-release-manifest" >>"$work/repo/RELEASE.SHA256SUMS"
run_release extra-release-manifest-record
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted an extra manifest record"
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "extra release manifest rejection"
cp "$work/current-valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

{
  IFS= read -r first_manifest_record
  printf '0%s\n' "${first_manifest_record:1}"
  tail -n +2
} <"$work/current-valid-release-manifest" >"$work/repo/RELEASE.SHA256SUMS"
run_release tampered-release-manifest
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a tampered manifest digest"
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "tampered release manifest rejection"
cp "$work/current-valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

run_release restored-release-manifest
[[ "$RELEASE_STATUS" == 0 ]] || {
  cat "$RELEASE_CASE_DIR/stderr" >&2
  fail "release rejected the restored exact canonical manifest"
}
echo "ok - source manifest must be complete, canonical, and exact before Docker"

echo "ok - every failed stage stops forward progression and preserves evidence"
run_release fsync-failure
[[ "$RELEASE_STATUS" != 0 ]] || fail "release ignored an evidence fsync failure"
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "evidence fsync failure"
echo "ok - evidence durability failures stop the release"

ln -s "$work" "$work/symlink-parent"
RUN_REPO_ROOT="$work/symlink-parent/repo" run_release success
unset RUN_REPO_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || fail "repository path with a symlink component was accepted"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "symlinked repository path reached Docker"
echo "ok - trusted release paths reject symlink components"

RUN_REPO_ROOT=/tmp run_release success
unset RUN_REPO_ROOT
[[ "$RELEASE_STATUS" != 0 ]] || fail "test path outside the harness was accepted"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "escaped test path reached Docker"
echo "ok - test release paths cannot escape the private harness"

mv "$work/bin" "$work/real-bin"
ln -s "$work/real-bin" "$work/bin"
run_release success
symlinked_bin_status="$RELEASE_STATUS"
symlinked_bin_case="$RELEASE_CASE_DIR"
rm "$work/bin"
mv "$work/real-bin" "$work/bin"
[[ "$symlinked_bin_status" != 0 ]] || fail "test binary with a symlinked parent was accepted"
[[ ! -s "$symlinked_bin_case/docker.log" ]] || fail "symlinked test binary parent reached Docker"
echo "ok - test command binaries are real descendants of the private harness"

chmod 0777 "$work"
run_release success
unsafe_harness_status="$RELEASE_STATUS"
unsafe_harness_case="$RELEASE_CASE_DIR"
chmod 0700 "$work"
[[ "$unsafe_harness_status" != 0 ]] || fail "unsafe test harness permissions were accepted"
[[ ! -s "$unsafe_harness_case/docker.log" ]] || fail "unsafe test harness reached Docker"
echo "ok - the explicit test harness must be private and caller-owned"

# shellcheck disable=SC2016
grep -Fq '[[ -z "${RELEASE_LOCK_FILE+x}" ]] || fatal "RELEASE_LOCK_FILE is forbidden in production"' "$release_script" || {
  fail "release does not reject ambient production lock authority"
}

lock_attack_root="$work/lock-object-attacks"
mkdir -p "$lock_attack_root"
chmod 0700 "$lock_attack_root"

missing_lock="$lock_attack_root/missing.lock"
RUN_LOCK_FILE="$missing_lock" RUN_LOCK_PRECREATE=false run_release success
unset RUN_LOCK_FILE RUN_LOCK_PRECREATE
[[ "$RELEASE_STATUS" != 0 ]] || fail "release created and accepted a missing lock object"
[[ ! -e "$missing_lock" && ! -L "$missing_lock" ]] || fail "release created the missing lock object"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "missing release lock reached Docker"

fifo_lock="$lock_attack_root/fifo.lock"
mkfifo "$fifo_lock"
exec 8<>"$fifo_lock"
RUN_LOCK_FILE="$fifo_lock" run_release success
unset RUN_LOCK_FILE
exec 8>&-
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a FIFO lock object"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "FIFO lock object reached Docker"

symlink_target="$lock_attack_root/symlink-target.lock"
printf '%s\n' lock >"$symlink_target"
chmod 0600 "$symlink_target"
ln -s "$symlink_target" "$lock_attack_root/symlink.lock"
RUN_LOCK_FILE="$lock_attack_root/symlink.lock" run_release success
unset RUN_LOCK_FILE
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a symlink lock object"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "symlink lock object reached Docker"

hardlink_target="$lock_attack_root/hardlink-target.lock"
printf '%s\n' lock >"$hardlink_target"
chmod 0600 "$hardlink_target"
ln "$hardlink_target" "$lock_attack_root/hardlink.lock"
RUN_LOCK_FILE="$lock_attack_root/hardlink.lock" run_release success
unset RUN_LOCK_FILE
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a multiply-linked lock object"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "multiply-linked lock object reached Docker"

wrong_mode_lock="$lock_attack_root/wrong-mode.lock"
printf '%s\n' lock >"$wrong_mode_lock"
chmod 0644 "$wrong_mode_lock"
RUN_LOCK_FILE="$wrong_mode_lock" run_release success
unset RUN_LOCK_FILE
[[ "$RELEASE_STATUS" != 0 ]] || fail "release repaired and accepted a wrong-mode lock object"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "wrong-mode lock object reached Docker"

wrong_owner_lock="$lock_attack_root/wrong-owner.lock"
printf '%s\n' lock >"$wrong_owner_lock"
chmod 0600 "$wrong_owner_lock"
chown 65534:65534 "$wrong_owner_lock"
RUN_LOCK_FILE="$wrong_owner_lock" run_release success
unset RUN_LOCK_FILE
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a wrong-owner lock object"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "wrong-owner lock object reached Docker"
chown "$EUID:$(stat -c '%g' "$work")" "$wrong_owner_lock"

swap_lock="$lock_attack_root/path-swap.lock"
printf '%s\n' lock >"$swap_lock"
chmod 0600 "$swap_lock"
RUN_LOCK_FILE="$swap_lock" RUN_LOCK_SWAP_PATH="$swap_lock" \
  run_release lock-path-swap-after-flock
unset RUN_LOCK_FILE RUN_LOCK_SWAP_PATH
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted a lock path replaced after flock"
[[ -f "$swap_lock.detached" ]] || fail "release lock path-swap hook did not execute"
[[ ! -s "$RELEASE_CASE_DIR/docker.log" ]] || fail "split release lock reached Docker"

run_release quarantine-stop-failure
[[ "$RELEASE_STATUS" != 0 ]] || fail "release accepted two failed initial tunnel stops"
[[ "$(cat "$RELEASE_CASE_DIR/quarantine-stop.count")" -ge 3 ]] || {
  fail "release EXIT trap did not retry tunnel quarantine after initial stop failure"
}
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "initial tunnel-stop failure"

run_release signal-first-quarantine-stop
[[ "$RELEASE_STATUS" != 0 ]] || fail "signalled release unexpectedly completed"
[[ "$(cat "$RELEASE_CASE_DIR/quarantine-stop.count")" -ge 2 ]] || {
  fail "release signal trap did not retry tunnel quarantine"
}
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "signalled initial tunnel stop"

run_release repeated-signal-early-cleanup
[[ "$RELEASE_STATUS" == 143 ]] || fail "repeated early signals did not preserve the first TERM status"
[[ "$(cat "$RELEASE_CASE_DIR/quarantine-stop.count")" -ge 3 ]] || {
  fail "repeated early signals aborted the bounded quarantine retry"
}
assert_only_early_quarantine "$RELEASE_CASE_DIR/docker.log" "repeated early cleanup signals"

run_release repeated-signal-late-cleanup
[[ "$RELEASE_STATUS" == 48 ]] || fail "repeated late signals did not preserve the mutator failure status"
[[ "$(cat "$RELEASE_CASE_DIR/quarantine-stop.count")" -ge 4 ]] || {
  fail "repeated late signals aborted the bounded quarantine retry"
}

echo "ok - release rejects unsafe lock object types, links, ownership, and mode"
echo "ok - release arms fail-closed signal and EXIT traps before initial quarantine"

set +e
/usr/bin/setpriv --reuid=65534 --regid=65534 --clear-groups \
  bash "$release_script" --lock-timeout 1 --stage-timeout 5 --startup-wait 3 \
  >"$work/non-root.stdout" 2>"$work/non-root.stderr"
non_root_status=$?
set -e
[[ "$non_root_status" != 0 ]] || fail "production mode ran without root"
grep -Fqi 'root' "$work/non-root.stderr" || fail "non-root rejection was not explicit"
echo "ok - production mode requires root; test bypass is explicit and contained"

lock_case="$work/lock-contention"
mkdir -p "$lock_case/records"
chmod 0700 "$lock_case/records"
: >"$lock_case/docker.log"
: >"$lock_case/validate.log"
: >"$lock_case/smoke.log"
: >"$lock_case/sync.log"
(
  exec 8>"$lock_case/release.lock"
  flock --exclusive 8
  sleep 4
) &
lock_holder=$!
sleep 0.2
chmod 0600 "$lock_case/release.lock"
started="$SECONDS"
set +e
PATH="$work/bin:/usr/bin:/bin" \
  REPO_ROOT="$work/repo" \
  COMPOSE_ENV_FILE="$work/compose.env" \
  COMPOSE_FILE_PATH="$work/repo/compose.yaml" \
  RELEASE_LOCK_FILE="$lock_case/release.lock" \
  RELEASE_RECORD_ROOT="$lock_case/records" \
  VALIDATE_RUNTIME_SCRIPT="$work/validate-runtime.sh" \
  SMOKE_PRODUCTION_SCRIPT="$work/smoke-production.sh" \
  FAKE_SCENARIO=success \
  FAKE_DOCKER_LOG="$lock_case/docker.log" \
  FAKE_VALIDATE_LOG="$lock_case/validate.log" \
  FAKE_SMOKE_LOG="$lock_case/smoke.log" \
  FAKE_SYNC_LOG="$lock_case/sync.log" \
  EXPECTED_COMPOSE_ENV="$work/compose.env" \
  EXPECTED_COMPOSE_FILE="$work/repo/compose.yaml" \
  bash "$release_script" --test-harness-root "$work" --lock-timeout 1 --stage-timeout 5 --startup-wait 3 \
    >"$lock_case/stdout" 2>"$lock_case/stderr"
lock_status=$?
set -e
elapsed="$((SECONDS - started))"
kill "$lock_holder" 2>/dev/null || true
wait "$lock_holder" 2>/dev/null || true
[[ "$lock_status" != 0 ]] || fail "concurrent release acquired the held lock"
(( elapsed <= 3 )) || fail "exclusive lock wait was not bounded: ${elapsed}s"
[[ ! -s "$lock_case/docker.log" ]] || fail "release touched Docker without the host lock"
echo "ok - concurrent releases fail within the bounded lock timeout"

for invalid in 0 nope -1; do
  if bash "$release_script" --lock-timeout "$invalid" >/dev/null 2>&1; then
    fail "invalid lock timeout was accepted: $invalid"
  fi
  if bash "$release_script" --stage-timeout "$invalid" >/dev/null 2>&1; then
    fail "invalid stage timeout was accepted: $invalid"
  fi
done
if bash "$release_script" --unknown >/dev/null 2>&1; then fail "unknown option was accepted"; fi

for forbidden in release-production operations migrate platform-seed admin-bootstrap; do
  if grep -Fq -- "$forbidden" "$compose_unit"; then
    fail "ordinary boot unit invokes release-only behavior: $forbidden"
  fi
done
for forbidden in migrate platform-seed admin-bootstrap operations; do
  if grep -Fq -- "$forbidden" "$smoke_script"; then
    fail "pilot smoke falsely requires a release-only service: $forbidden"
  fi
done
guarded_start_command='/usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/bash /opt/learncoding/infra/ops/start-production-stack.sh --startup-wait 600'
grep -Fxq -- "ExecStart=$guarded_start_command" "$compose_unit" || {
  fail "ordinary boot does not delegate startup to the guarded pinned-image launcher"
}
grep -Fxq -- "ExecReload=$guarded_start_command" "$compose_unit" || {
  fail "ordinary reload does not delegate startup to the guarded pinned-image launcher"
}
# shellcheck disable=SC2016
grep -Fq -- \
  'run_with_deadline 120 "${compose[@]}" up -d --no-build --pull never --no-deps "${selected_internal_services[@]}"' \
  "$guarded_start_script" || {
  fail "guarded startup does not start internal services from pinned existing images"
}
# shellcheck disable=SC2016
grep -Fq -- \
  'run_with_deadline 120 "${compose[@]}" up -d --no-build --pull never --no-deps cloudflared' \
  "$guarded_start_script" || {
  fail "guarded startup does not start the tunnel from pinned existing images"
}

grep -Fq -- 'infra/ops/release-production.sh' "$deployment_guide" || {
  fail "deployment guide does not invoke the explicit release transaction"
}
grep -Fq -- '--bootstrap-admin' "$deployment_guide" || {
  fail "deployment guide does not document explicit one-time administrator bootstrap"
}
if grep -Fq -- '--profile operations run --rm admin-bootstrap' "$deployment_guide"; then
  fail "deployment guide still bypasses the release transaction for bootstrap"
fi
grep -Fq -- 'infra/ops/release-production.sh' "$update_runbook" || {
  fail "update runbook does not invoke the explicit release transaction"
}
grep -Fq -- 'No automatic schema rollback' "$update_runbook" || {
  fail "update runbook omits the non-rollback schema boundary"
}

echo "release-production-tests-ok"
