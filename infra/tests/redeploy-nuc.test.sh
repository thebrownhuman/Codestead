#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/infra/ops/redeploy-nuc.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fake_repo="$work/repo"
mkdir -p "$fake_repo"
git -C "$fake_repo" init --quiet --initial-branch=main
git -C "$fake_repo" config user.email "test@example.invalid"
git -C "$fake_repo" config user.name "redeploy-nuc test"
echo "one" >"$fake_repo/README.md"
git -C "$fake_repo" add README.md
git -C "$fake_repo" commit --quiet -m "initial"
head_sha="$(git -C "$fake_repo" rev-parse HEAD)"

fake_compose_env="$work/compose.env"
cat >"$fake_compose_env" <<'EOF'
APP_RUNTIME_IMAGE=ghcr.io/example/codestead-runtime@sha256:old
APP_TOOLING_IMAGE=ghcr.io/example/codestead-tooling@sha256:old
APP_WORKER_IMAGE=ghcr.io/example/codestead-worker@sha256:old
APP_REGRADE_WORKER_IMAGE=ghcr.io/example/codestead-regrade-worker@sha256:old
APP_PROJECT_REVIEW_WORKER_IMAGE=ghcr.io/example/codestead-project-review-worker@sha256:old
APP_SCANNER_WORKER_IMAGE=ghcr.io/example/codestead-scanner-worker@sha256:old
APP_OPERATIONS_IMAGE=ghcr.io/example/codestead-operations@sha256:old
SOME_UNRELATED_SETTING=keep-me
SENTRY_RELEASE=
EOF
export COMPOSE_ENV_FILE="$fake_compose_env"
export DEPLOY_STATE_FILE="$work/deployed-revision"

# --- a git SHA argument is required -----------------------------------------

if "$script" >/dev/null 2>&1; then
  fail "script accepted no arguments"
fi

# --- an unrecognized SHA-shaped argument is rejected ------------------------

if "$script" --dry-run "not-a-sha" >/dev/null 2>&1; then
  fail "script accepted a non-SHA argument"
fi

# --- a dry run against a clean checkout succeeds and never mutates ----------

dry_run_output="$(REPO_ROOT="$fake_repo" "$script" --dry-run "$head_sha" 2>&1)" \
  || fail "dry run against a clean checkout should succeed:
$dry_run_output"

grep -qF "$fake_repo is currently checked out to: $head_sha" <<<"$dry_run_output" \
  || fail "dry run did not report the checked-out commit"
grep -qF "target commit resolved to: $head_sha" <<<"$dry_run_output" \
  || fail "dry run did not resolve the target commit"
grep -qF "+ git" <<<"$dry_run_output" \
  || fail "dry run did not print any planned git command"
grep -qF "building images, this takes a few minutes" <<<"$dry_run_output" \
  || fail "dry run did not print the long-build progress line"
grep -qF "install a trivy shim" <<<"$dry_run_output" \
  || fail "dry run did not describe installing the containerized trivy shim"
grep -qF "dry run: would wait" <<<"$dry_run_output" \
  || fail "dry run did not describe the health-wait step"
[[ "$(git -C "$fake_repo" rev-parse HEAD)" == "$head_sha" ]] \
  || fail "dry run mutated the fake repository's checked-out commit"

# --- with no deploy-state record, the previous deployment is "unknown" and
#     migration always runs, regardless of what /opt is checked out to -------

grep -qF "no readable deploy-state record" <<<"$dry_run_output" \
  || fail "dry run did not report a missing deploy-state record as unknown"
grep -qF "previous deployment is unknown, running migrate to be safe" <<<"$dry_run_output" \
  || fail "an unknown previous deployment did not force a migration run"

# --- once a deploy-state record exists, it (not /opt's checked-out HEAD) is
#     what the migration-diff decision is based on ---------------------------

printf '%s\n' "$head_sha" >"$DEPLOY_STATE_FILE"
dry_run_output="$(REPO_ROOT="$fake_repo" "$script" --dry-run "$head_sha" 2>&1)" \
  || fail "dry run with a deploy-state record should succeed:
$dry_run_output"
grep -qF "last commit this script deployed" <<<"$dry_run_output" \
  || fail "dry run did not report the recorded deploy-state commit"
grep -qF "no migration files changed since $head_sha" <<<"$dry_run_output" \
  || fail "a recorded deploy-state commit equal to the target should skip migration"
rm -f "$DEPLOY_STATE_FILE"

# --- an untracked compose.override.yml never blocks the dirty-tree check ---

touch "$fake_repo/compose.override.yml"
dry_run_output="$(REPO_ROOT="$fake_repo" "$script" --dry-run "$head_sha" 2>&1)" \
  || fail "an untracked compose.override.yml must not block a dry run:
$dry_run_output"
rm -f "$fake_repo/compose.override.yml"

# --- a dirty tracked file refuses the redeploy, even in --dry-run ----------

echo "two" >"$fake_repo/README.md"
if REPO_ROOT="$fake_repo" "$script" --dry-run "$head_sha" >/dev/null 2>&1; then
  fail "script proceeded with an uncommitted tracked change"
fi
git -C "$fake_repo" checkout --quiet -- README.md

# --- --no-scan is accepted, skips the trivy gate, and never calls the
#     record step (it requires scan evidence) -------------------------------

dry_run_output="$(REPO_ROOT="$fake_repo" "$script" --no-scan --dry-run "$head_sha" 2>&1)" \
  || fail "--no-scan dry run should succeed"
grep -qF "skipping trivy scan" <<<"$dry_run_output" \
  || fail "--no-scan did not skip the trivy scan step"
grep -qF "UNSCANNED" <<<"$dry_run_output" \
  || fail "--no-scan did not clearly log an UNSCANNED deploy"
grep -qF "extract the 7 APP_*_IMAGE references from" <<<"$dry_run_output" \
  || fail "--no-scan did not describe extracting digests from the inspection report instead of record"
grep -qF "manage-application-images.mjs record" <<<"$dry_run_output" \
  && fail "--no-scan must never call the record step (it requires scan evidence)"

# --- --scan (the default) still uses record, not the inspection report -----

dry_run_output="$(REPO_ROOT="$fake_repo" "$script" --dry-run "$head_sha" 2>&1)" \
  || fail "--scan dry run should succeed"
grep -qF "manage-application-images.mjs record" <<<"$dry_run_output" \
  || fail "the scanned path did not call record"
grep -qF "extract the 7 APP_*_IMAGE references from" <<<"$dry_run_output" \
  && fail "the scanned path should not fall back to the inspection report"

# --- non-root without --dry-run is refused (this test never runs as root) --

if [[ "$(id -u)" -ne 0 ]]; then
  if REPO_ROOT="$fake_repo" "$script" "$head_sha" >/dev/null 2>&1; then
    fail "script ran a real (non-dry-run) redeploy without root"
  fi
fi

# --- a hermetic deploy exports the resolved SHA to every Compose invocation
#     without persisting the release or changing unrelated settings ----------

real_git="$(command -v git)"
real_node="$(command -v node)"
fake_bin="$work/bin"
mkdir -p "$fake_bin"
export TEST_REAL_GIT="$real_git" TEST_REAL_NODE="$real_node"
export TEST_COMPOSE_TRACE="$work/compose-trace"
cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${3:-}" == fetch ]]; then exit 0; fi
exec "$TEST_REAL_GIT" "$@"
EOF
cat >"$fake_bin/id" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == -u ]] || exit 64
printf '0\n'
EOF
cat >"$fake_bin/node" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == -e ]]; then exec "$TEST_REAL_NODE" "$@"; fi
[[ "$1" == scripts/app-images/manage-application-images.mjs ]] || exit 64
case "$2" in
  build) ;;
  inspect)
    mkdir -p dist/application-images
    printf '{"records":[' >dist/application-images/application-inspection.json
    separator=""
    for variable in APP_RUNTIME_IMAGE APP_TOOLING_IMAGE APP_WORKER_IMAGE APP_REGRADE_WORKER_IMAGE \
      APP_PROJECT_REVIEW_WORKER_IMAGE APP_SCANNER_WORKER_IMAGE APP_OPERATIONS_IMAGE; do
      printf '%s{"variable":"%s","reference":"registry.example.test/image@sha256:%064d"}' \
        "$separator" "$variable" 1 >>dist/application-images/application-inspection.json
      separator=,
    done
    printf ']}\n' >>dist/application-images/application-inspection.json
    ;;
  *) exit 64 ;;
esac
EOF
cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" == compose ]] || exit 64
printf '%s\t%s\n' "${SENTRY_RELEASE-}" "$*" >>"$TEST_COMPOSE_TRACE"
# No daemon is contacted: ps reports no unhealthy services, exec succeeds.
EOF
chmod 0700 "$fake_bin"/*

for stored_release in "" "previous-release"; do
  sed -i "s/^SENTRY_RELEASE=.*/SENTRY_RELEASE=$stored_release/" "$fake_compose_env"
  grep -v '^APP_.*_IMAGE=' "$fake_compose_env" >"$work/unrelated-before"
  : >"$TEST_COMPOSE_TRACE"
  # Force migrations so both operation and long-running services are checked.
  rm -f "$DEPLOY_STATE_FILE"
  deploy_output="$(PATH="$fake_bin:$PATH" REPO_ROOT="$fake_repo" BUILD_ROOT="$work/build" \
    SENTRY_RELEASE=caller-stale "$script" --no-scan "${head_sha:0:7}" 2>&1)" \
    || fail "hermetic deploy failed:\n$deploy_output"
  [[ -s "$TEST_COMPOSE_TRACE" ]] || fail "deploy never invoked Compose"
  while IFS=$'\t' read -r release command; do
    [[ "$release" == "$head_sha" ]] || fail "Compose received '$release' instead of resolved SHA '$head_sha'"
  done <"$TEST_COMPOSE_TRACE"
  grep -qF -- 'up -d --no-build --pull never --no-deps runner-egress-gateway app mail-worker reward-worker regrade-worker exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker file-erasure-worker' "$TEST_COMPOSE_TRACE" \
    || fail "deploy did not restart the app and every pilot worker"
  ! grep -qF -- 'file-erasure-worker piston' "$TEST_COMPOSE_TRACE" || fail "deploy restarted piston without its profile"
  grep -qF -- '--exit-code-from migrate migrate' "$TEST_COMPOSE_TRACE" || fail "migration invocation was not exercised"
  grep -qF -- 'exec -T app node -e' "$TEST_COMPOSE_TRACE" || fail "health invocation was not exercised"
  grep -v '^APP_.*_IMAGE=' "$fake_compose_env" >"$work/unrelated-after"
  cmp -s "$work/unrelated-before" "$work/unrelated-after" \
    || fail "deploy changed SENTRY_RELEASE or another non-image compose.env setting"
  [[ "$(<"$DEPLOY_STATE_FILE")" == "$head_sha" ]] || fail "deploy did not record the resolved commit"
done

# --- --no-migrate never runs migrate, even when the migration set changed --
: >"$TEST_COMPOSE_TRACE"
rm -f "$DEPLOY_STATE_FILE"
deploy_output="$(PATH="$fake_bin:$PATH" REPO_ROOT="$fake_repo" BUILD_ROOT="$work/build"   "$script" --no-scan --no-migrate "${head_sha:0:7}" 2>&1)" || fail "--no-migrate deploy failed:
$deploy_output"
grep -qF -- "--no-migrate: NOT running migrate" <<<"$deploy_output"   || fail "--no-migrate did not say it skipped migrate"
! grep -qF -- '--exit-code-from migrate migrate' "$TEST_COMPOSE_TRACE"   || fail "--no-migrate still ran migrate"
grep -qF -- 'up -d --no-build --pull never --no-deps runner-egress-gateway app' "$TEST_COMPOSE_TRACE"   || fail "--no-migrate did not restart the app services"

# --- the piston profile adds the piston runner to the restarted services ----
printf '%s
' 'COMPOSE_PROFILES=uploads,piston' >>"$fake_compose_env"
: >"$TEST_COMPOSE_TRACE"
rm -f "$DEPLOY_STATE_FILE"
deploy_output="$(PATH="$fake_bin:$PATH" REPO_ROOT="$fake_repo" BUILD_ROOT="$work/build"   "$script" --no-scan "${head_sha:0:7}" 2>&1)" || fail "piston-profile deploy failed:
$deploy_output"
grep -qF -- '--no-deps runner-egress-gateway app mail-worker reward-worker regrade-worker exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker file-erasure-worker piston' "$TEST_COMPOSE_TRACE"   || fail "piston-profile deploy did not restart piston"

echo "redeploy-nuc-ok"
