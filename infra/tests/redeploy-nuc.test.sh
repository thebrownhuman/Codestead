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
EOF
export COMPOSE_ENV_FILE="$fake_compose_env"

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

grep -qF "current running commit: $head_sha" <<<"$dry_run_output" \
  || fail "dry run did not report the current commit"
grep -qF "target commit resolved to: $head_sha" <<<"$dry_run_output" \
  || fail "dry run did not resolve the target commit"
grep -qF "+ git" <<<"$dry_run_output" \
  || fail "dry run did not print any planned git command"
grep -qF "dry run: would wait" <<<"$dry_run_output" \
  || fail "dry run did not describe the health-wait step"
[[ "$(git -C "$fake_repo" rev-parse HEAD)" == "$head_sha" ]] \
  || fail "dry run mutated the fake repository's checked-out commit"

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

# --- --no-scan is accepted and skips the trivy gate in the dry-run preview -

dry_run_output="$(REPO_ROOT="$fake_repo" "$script" --no-scan --dry-run "$head_sha" 2>&1)" \
  || fail "--no-scan dry run should succeed"
grep -qF "skipping trivy scan" <<<"$dry_run_output" \
  || fail "--no-scan did not skip the trivy scan step"

# --- non-root without --dry-run is refused (this test never runs as root) --

if [[ "$(id -u)" -ne 0 ]]; then
  if REPO_ROOT="$fake_repo" "$script" "$head_sha" >/dev/null 2>&1; then
    fail "script ran a real (non-dry-run) redeploy without root"
  fi
fi

echo "redeploy-nuc-ok"
