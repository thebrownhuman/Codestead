#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Not wired into CI: infra/tests/backup-ci-registration.test.mjs pins the
# exact `application` job run list, and touching ci.yml also stales a hash in
# docs/evidence/backup-status-outbox that needs owner approval to refresh.
# Run its test locally instead: bash infra/tests/redeploy-nuc.test.sh

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: redeploy-nuc.sh [--scan|--no-scan] [--no-migrate] [--dry-run] <git-sha>

Redeploys the pilot NUC deployment to <git-sha>: fetches and checks out the
commit, builds the seven reviewed application images from a clean clone,
swaps only the seven APP_*_IMAGE lines in the running compose.env, runs
migrations only if the migration set changed since the last commit this
script actually deployed, restarts the app+worker services with --no-build
--pull never, and waits for /health/ready.
The resolved commit SHA is exported as SENTRY_RELEASE for Compose; it is
never written into compose.env.

  --scan        Run the Trivy vulnerability gate (default). Trivy runs as a
                pinned container (the NUC has no host packages) with the
                Docker socket and Trivy's cache mounted in.
  --no-scan     Skip Trivy for a quick beta deploy.
  --no-migrate  Never run migrate, even if the migration set changed. For
                migrations with their own ordered steps (e.g. a fenced role
                bootstrap) that the operator runs by hand around this script.
  --dry-run     Print every command instead of running it. No mutation.

Environment overrides (all optional, defaults match the NUC pilot):
  REPO_ROOT            Root checkout to redeploy in place (default /opt/learncoding)
  BUILD_ROOT            Disposable clean clone used for the image build
                        (default /var/tmp/codestead-build)
  COMPOSE_ENV_FILE      Running compose env file (default /etc/learncoding/compose.env)
  COMPOSE_PROJECT       Compose -p project name (default learncoding)
  COMPOSE_FILE          Primary compose file (default $REPO_ROOT/compose.yaml)
  COMPOSE_OVERRIDE_FILE Optional override compose file
                        (default $REPO_ROOT/compose.override.yml, used only if present)
  TRIVY_CACHE_DIR       Trivy cache dir (default /var/lib/learncoding/trivy-cache)
  TRIVY_IMAGE           Pinned aquasec/trivy image reference (default matches
                        the Trivy 0.69.3 the app-images scan pipeline requires)
  DEPLOY_STATE_FILE     Where this script records the last commit it actually
                        deployed (default /var/lib/learncoding/redeploy-nuc/deployed-revision)
  HEALTH_WAIT_SECONDS   Seconds to wait for /health/ready (default 180)

This script must run as root on the NUC. It never deletes volumes or data,
and never touches any Compose project other than $COMPOSE_PROJECT.
EOF
}

# --- argument parsing -------------------------------------------------------

scan=true
migrate_allowed=true
dry_run=false
target_sha=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --scan)
      scan=true
      shift
      ;;
    --no-scan)
      scan=false
      shift
      ;;
    --no-migrate)
      migrate_allowed=false
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      fatal "unknown option: $1"
      ;;
    *)
      [[ -z "$target_sha" ]] || fatal "unexpected extra argument: $1"
      target_sha="$1"
      shift
      ;;
  esac
done

[[ -n "$target_sha" ]] || { usage; fatal "a git SHA is required"; }
[[ "$target_sha" =~ ^[0-9a-fA-F]{7,40}$ ]] || fatal "argument does not look like a git commit SHA: $target_sha"

if [[ "$dry_run" != true && "$(id -u)" -ne 0 ]]; then
  fatal "must run as root (use sudo); pass --dry-run to preview without root"
fi

# --- configuration -----------------------------------------------------------

# This file is a standalone copy on purpose (the owner runs it from wherever
# they last downloaded it, e.g. /tmp/redeploy-nuc.sh, not from inside a
# checkout). Every path below is therefore either an absolute default or
# derived from REPO_ROOT/BUILD_ROOT/etc — never from this script's own
# location (no $0/BASH_SOURCE-relative paths anywhere in this file).
repo_root="${REPO_ROOT:-/opt/learncoding}"
build_root="${BUILD_ROOT:-/var/tmp/codestead-build}"
compose_env_file="${COMPOSE_ENV_FILE:-/etc/learncoding/compose.env}"
compose_project="${COMPOSE_PROJECT:-learncoding}"
compose_file="${COMPOSE_FILE:-$repo_root/compose.yaml}"
compose_override_file="${COMPOSE_OVERRIDE_FILE:-$repo_root/compose.override.yml}"
trivy_cache_dir="${TRIVY_CACHE_DIR:-/var/lib/learncoding/trivy-cache}"
# Pinned to the exact Trivy release scripts/app-images/manage-application-images.mjs
# requires (see scannerEvidenceInputs's "Trivy 0.69.3 is required" check).
trivy_image="${TRIVY_IMAGE:-docker.io/aquasec/trivy@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c}"
deploy_state_file="${DEPLOY_STATE_FILE:-/var/lib/learncoding/redeploy-nuc/deployed-revision}"
health_wait_seconds="${HEALTH_WAIT_SECONDS:-180}"
[[ "$health_wait_seconds" =~ ^[1-9][0-9]*$ ]] || fatal "HEALTH_WAIT_SECONDS must be a positive integer"

# The seven reviewed application image identities. Never add, remove, or
# rename an entry here without also updating compose.yaml and docs/deployment.md.
readonly application_image_vars=(
  APP_RUNTIME_IMAGE
  APP_TOOLING_IMAGE
  APP_WORKER_IMAGE
  APP_REGRADE_WORKER_IMAGE
  APP_PROJECT_REVIEW_WORKER_IMAGE
  APP_SCANNER_WORKER_IMAGE
  APP_OPERATIONS_IMAGE
)

# The exact non-database services the last manual pilot redeploy restarted
# (see memory/homelab-nuc.md "REDEPLOY STEPS"). postgres and the system
# cloudflared unit are intentionally never touched here.
app_services=(
  runner-egress-gateway
  app
  mail-worker
  reward-worker
  regrade-worker
  exam-finalization-worker
  practice-runner-recovery-worker
  project-review-correction-worker
  file-erasure-worker
)
# The piston practice runner (docs/runbooks/piston-kata.md) is restarted with
# the app only when compose.env enables its profile; its image is built on the
# NUC and pinned in PISTON_IMAGE, so this script never builds or pulls it.
compose_profiles=""
[[ -r "$compose_env_file" ]] && compose_profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' "$compose_env_file" | tail -n 1)"
case "$compose_profiles" in
  piston|uploads,piston) app_services+=(piston) ;;
esac
readonly app_services

run() {
  if [[ "$dry_run" == true ]]; then
    printf '+ %q' "$1" >&2
    shift
    for arg in "$@"; do printf ' %q' "$arg" >&2; done
    printf '\n' >&2
    return 0
  fi
  "$@"
}

capture() {
  # Runs even in --dry-run, since dry-run must still report real repository
  # state (current SHA, dirty status, migration diff) to be a useful preview.
  "$@"
}

compose_files_args=(-f "$compose_file")
[[ -e "$compose_override_file" ]] && compose_files_args+=(-f "$compose_override_file")

compose() {
  run docker compose -p "$compose_project" "${compose_files_args[@]}" --env-file "$compose_env_file" "$@"
}

# Installs a `trivy` shim ahead of PATH that forwards every invocation to the
# pinned aquasec/trivy container. Both the explicit `trivy image --download-*`
# calls below and manage-application-images.mjs's own bare `trivy` spawn (it
# only ever looks the command up on PATH) go through it unmodified. /tmp and
# build_root are mounted 1:1 so absolute --config/--output paths the scan
# pipeline passes resolve the same way inside the container.
trivy_shim_dir=""
prepare_trivy_container_shim() {
  if [[ "$dry_run" == true ]]; then
    echo "+ (install a trivy shim running $trivy_image via docker, with /var/run/docker.sock, /tmp, $build_root and $trivy_cache_dir mounted)" >&2
    return 0
  fi
  [[ -n "$trivy_shim_dir" ]] && return 0
  trivy_shim_dir="$(mktemp -d)"
  cat >"$trivy_shim_dir/trivy" <<SHIM
#!/usr/bin/env bash
set -Eeuo pipefail
exec docker run --rm \\
  --network host \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v /tmp:/tmp \\
  -v "$build_root:$build_root" \\
  -v "$trivy_cache_dir:$trivy_cache_dir" \\
  -w "\$PWD" \\
  -e TRIVY_CACHE_DIR \\
  "$trivy_image" "\$@"
SHIM
  chmod 0755 "$trivy_shim_dir/trivy"
  export PATH="$trivy_shim_dir:$PATH"
}

echo "== redeploy-nuc: target sha=$target_sha repo=$repo_root scan=$scan dry_run=$dry_run =="

# --- step 1: fetch + checkout ------------------------------------------------

[[ -d "$repo_root/.git" ]] || fatal "$repo_root is not a git checkout"

git_repo() { git -C "$repo_root" "$@"; }

dirty_tracked="$(capture git_repo status --porcelain=v1 --untracked-files=no)"
[[ -z "$dirty_tracked" ]] || fatal "refusing to redeploy: $repo_root has uncommitted tracked changes:
$dirty_tracked"

checked_out_sha="$(capture git_repo rev-parse HEAD)"
echo "$repo_root is currently checked out to: $checked_out_sha"

# The checked-out commit is NOT the same thing as the commit whose images are
# actually running: an operator can `git checkout` the target ahead of a
# redeploy (or a previous redeploy can fail after checkout but before the
# containers were updated), which would otherwise make the migration-diff
# check below silently skip a migration. Only this script's own record of the
# last commit it successfully deployed is trusted for that decision; a
# missing/unreadable record means "unknown" and migrations always run.
previous_sha=""
if [[ -f "$deploy_state_file" ]]; then
  previous_sha="$(tr -d '[:space:]' <"$deploy_state_file" 2>/dev/null || true)"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || previous_sha=""
fi
if [[ -n "$previous_sha" ]]; then
  echo "last commit this script deployed ($deploy_state_file): $previous_sha"
else
  echo "no readable deploy-state record at $deploy_state_file; treating the previous deployment as unknown"
fi

run git_repo fetch --quiet origin
run git_repo checkout --quiet --detach "$target_sha"

if [[ "$dry_run" != true ]]; then
  resolved_sha="$(git_repo rev-parse HEAD)"
else
  # In dry-run the checkout above did not run; resolve against the fetched
  # remote so the preview still reports what would be deployed.
  resolved_sha="$(capture git_repo rev-parse "$target_sha" 2>/dev/null || echo "$target_sha")"
fi
echo "target commit resolved to: $resolved_sha"

# Compose's process environment takes precedence over --env-file, including
# an empty or stale SENTRY_RELEASE there. Use the actual checked-out commit,
# not an abbreviated argument or an inherited value; leave compose.env alone.
export SENTRY_RELEASE="$resolved_sha"

# --- step 2: build the seven images from a clean clone -----------------------

echo "-- building application images in a clean clone: $build_root --"
run rm -rf "$build_root"
run git clone --quiet --no-hardlinks "$repo_root" "$build_root"
run git -C "$build_root" checkout --quiet --detach "$resolved_sha"
run git -C "$build_root" remote set-url origin "https://github.com/thebrownhuman/Codestead"
if [[ -d "$repo_root/node_modules" ]]; then
  run cp -a "$repo_root/node_modules" "$build_root/node_modules"
elif [[ "$dry_run" == true ]]; then
  echo "+ (cd $build_root && npm ci)" >&2
else
  ( cd "$build_root" && npm ci )
fi

image_env=(
  "APP_IMAGE_SOURCE_REPOSITORY=https://github.com/thebrownhuman/Codestead"
  "APP_IMAGE_SOURCE_REVISION=$resolved_sha"
  "APP_IMAGE_TRIVY_CACHE_DIR=$trivy_cache_dir"
  "APP_IMAGE_LOCAL_RISK_ACCEPTANCE=accept-unsigned-local-buildkit-provenance-v1"
)

build_step() {
  local step="$1"
  if [[ "$dry_run" == true ]]; then
    printf '+ (cd %q && env' "$build_root" >&2
    printf ' %q' "${image_env[@]}" >&2
    printf ' node scripts/app-images/manage-application-images.mjs %q)\n' "$step" >&2
    return 0
  fi
  ( cd "$build_root" && env "${image_env[@]}" node scripts/app-images/manage-application-images.mjs "$step" )
}

# A cold build of the seven images takes several minutes with no other
# output in between; say so up front rather than looking hung.
echo "building images, this takes a few minutes..."
build_step build
build_step inspect

# `record` (below) requires the scan step's security manifest evidence, so it
# only runs on the scanned path. --no-scan instead reads the seven digests
# straight from `inspect`'s own report, which needs neither trivy nor record.
application_images_env=""
extraction_temp=""

if [[ "$scan" == true ]]; then
  echo "-- running trivy scan (use --no-scan to skip for a quick beta deploy) --"
  # Trivy isn't a host package here (everything else runs in Docker); run it
  # as the exact pinned image instead, with the Docker socket so it can read
  # images from the daemon that built them, matching what
  # scripts/app-images/manage-application-images.mjs already expects when it
  # shells out to a bare `trivy` on PATH.
  prepare_trivy_container_shim
  run trivy image --cache-dir "$trivy_cache_dir" --download-db-only
  run trivy image --cache-dir "$trivy_cache_dir" --download-java-db-only
  build_step scan
  build_step record
  application_images_env="$build_root/dist/application-images/application-images.env"
  if [[ "$dry_run" != true ]]; then
    [[ -f "$application_images_env" ]] || fatal "expected image record missing: $application_images_env"
  fi
else
  echo "-- skipping trivy scan (--no-scan): compose.env will be updated from UNSCANNED digests --"
  inspection_report="$build_root/dist/application-images/application-inspection.json"
  if [[ "$dry_run" == true ]]; then
    echo "+ (extract the 7 APP_*_IMAGE references from $inspection_report)" >&2
  else
    [[ -f "$inspection_report" ]] || fatal "expected inspection report missing: $inspection_report"
    extraction_temp="$(mktemp)"
    node -e '
      const fs = require("fs");
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const record of report.records) {
        process.stdout.write(`${record.variable}=${record.reference}\n`);
      }
    ' "$inspection_report" >"$extraction_temp"
    application_images_env="$extraction_temp"
  fi
fi

# --- step 3: back up compose.env and swap only the 7 image lines ------------

[[ -f "$compose_env_file" ]] || fatal "compose env file not found: $compose_env_file"
backup_file="${compose_env_file}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
run cp -a "$compose_env_file" "$backup_file"
echo "compose env backed up to: $backup_file"

if [[ "$dry_run" == true ]]; then
  echo "-- would replace these lines in $compose_env_file (values redacted) --"
  for var in "${application_image_vars[@]}"; do
    echo "  $var=<recorded digest>"
  done
else
  [[ "$scan" == true ]] || echo "-- UNSCANNED beta deploy: compose.env is being updated from inspect-only digests, no Trivy/record evidence --"
  new_env="$(mktemp)"
  trap 'rm -f "$new_env" "$extraction_temp"' EXIT

  declare -A new_values=()
  for var in "${application_image_vars[@]}"; do
    line="$(grep -E "^${var}=" "$application_images_env" || true)"
    [[ -n "$line" ]] || fatal "recorded image env is missing $var"
    new_values["$var"]="${line#"${var}="}"
  done

  cp -a "$compose_env_file" "$new_env"
  for var in "${application_image_vars[@]}"; do
    if grep -qE "^${var}=" "$new_env"; then
      sed -i "s|^${var}=.*|${var}=${new_values[$var]}|" "$new_env"
    else
      printf '%s=%s\n' "$var" "${new_values[$var]}" >>"$new_env"
    fi
  done

  # Verify no line other than the seven image lines changed.
  changed_lines="$(diff --unchanged-line-format='' --old-line-format='%L' --new-line-format='' \
    "$compose_env_file" "$new_env" || true)"
  unexpected=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    matched=false
    for var in "${application_image_vars[@]}"; do
      [[ "$line" == "${var}="* ]] && { matched=true; break; }
    done
    [[ "$matched" == true ]] || unexpected+="$line"$'\n'
  done <<<"$changed_lines"
  if [[ -n "$unexpected" ]]; then
    fatal "refusing to apply compose.env: an unexpected (non-image) line would change"
  fi

  install -m 0600 "$new_env" "$compose_env_file"
  rm -f "$new_env" "$extraction_temp"
  trap - EXIT
  echo "compose.env updated: 7 APP_*_IMAGE lines replaced, all other lines unchanged"
fi

# --- step 4: run migrations only if the migration set changed ---------------

run_migrate=false
migration_diff=""
if [[ -z "$previous_sha" ]]; then
  run_migrate=true
  echo "-- previous deployment is unknown, running migrate to be safe --"
elif [[ "$dry_run" != true ]]; then
  migration_diff="$(git_repo diff --name-only "$previous_sha" "$resolved_sha" -- drizzle)"
  [[ -n "$migration_diff" ]] && run_migrate=true
else
  migration_diff="$(capture git_repo diff --name-only "$previous_sha" "$target_sha" -- drizzle 2>/dev/null || echo "<unknown until checkout>")"
  [[ -n "$migration_diff" ]] && run_migrate=true
fi

if [[ "$run_migrate" == true && "$migrate_allowed" != true ]]; then
  [[ -n "$migration_diff" ]] && { echo "-- migration set changed since $previous_sha --"; echo "$migration_diff"; }
  echo "-- --no-migrate: NOT running migrate; the operator must apply these migrations by hand --"
elif [[ "$run_migrate" == true ]]; then
  [[ -n "$migration_diff" ]] && { echo "-- migration set changed since $previous_sha, running migrate --"; echo "$migration_diff"; }
  compose --profile operations up --no-deps --no-build --pull never \
    --force-recreate --exit-code-from migrate migrate
  compose --profile operations rm -f migrate
else
  echo "-- no migration files changed since $previous_sha, skipping migrate --"
fi

# --- step 5: restart app + worker services and wait for health --------------

compose up -d --no-build --pull never --no-deps "${app_services[@]}"

if [[ "$dry_run" == true ]]; then
  echo "-- dry run: would wait up to ${health_wait_seconds}s for /health/ready --"
else
  echo "-- waiting up to ${health_wait_seconds}s for containers healthy + /health/ready --"
  deadline=$((SECONDS + health_wait_seconds))
  ready=false
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    unhealthy="$(docker compose -p "$compose_project" "${compose_files_args[@]}" --env-file "$compose_env_file" \
      ps --all --format '{{.Service}} {{.Health}}' "${app_services[@]}" 2>/dev/null \
      | awk '$2 != "" && $2 != "healthy" { print }')"
    if [[ -z "$unhealthy" ]]; then
      if docker compose -p "$compose_project" "${compose_files_args[@]}" --env-file "$compose_env_file" \
        exec -T app node -e \
        "fetch('http://127.0.0.1:3000/health/ready', { redirect: 'manual' }).then((r) => { if (r.status !== 200) process.exit(1); }).catch(() => process.exit(1));" \
        >/dev/null 2>&1; then
        ready=true
        break
      fi
    fi
    sleep 5
  done
  [[ "$ready" == true ]] || fatal "app did not become healthy / /health/ready within ${health_wait_seconds}s; rollback with:
  sudo cp -a '$backup_file' '$compose_env_file' && sudo bash -c 'cd $repo_root && docker compose -p $compose_project ${compose_files_args[*]} --env-file $compose_env_file up -d --no-build --pull never --no-deps ${app_services[*]}'"

  # Record the deployed commit only once the app is verified healthy, so a
  # later run's migration-diff check reflects what's actually running.
  mkdir -p "$(dirname "$deploy_state_file")"
  state_tmp="$(mktemp "${deploy_state_file}.XXXXXX")"
  printf '%s\n' "$resolved_sha" >"$state_tmp"
  mv -f "$state_tmp" "$deploy_state_file"
fi

# --- step 6: summary + rollback command --------------------------------------

cat <<EOF

== redeploy complete ==
deployed commit:     $resolved_sha
previous deployment: ${previous_sha:-unknown}
image evidence:      $([[ "$scan" == true ]] && echo "scanned (Trivy + application-images record)" || echo "UNSCANNED beta deploy (--no-scan)")
compose env backup:  $backup_file

Rollback to the previous images (never reverses a migration):
  sudo cp -a '$backup_file' '$compose_env_file'
  sudo docker compose -p '$compose_project' ${compose_files_args[*]} --env-file '$compose_env_file' \\
    up -d --no-build --pull never --no-deps ${app_services[*]}
EOF
