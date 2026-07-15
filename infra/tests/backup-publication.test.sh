#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verifier="$repo_root/scripts/backup/verify-archive.sh"
probe="$repo_root/scripts/backup/create-credential-probe.ts"
test_group="${BACKUP_PUBLICATION_TEST_GROUP:-all}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ -f "$verifier" ]] || fail "verified publication is missing verify-archive.sh"
[[ -f "$probe" ]] || fail "verified publication is missing create-credential-probe.ts"
grep -Fq 'backup:credential-probe' "$repo_root/package.json" \
  || fail "verified publication is missing the credential-probe package command"
grep -Fq 'write_success_marker' "$repo_root/scripts/backup/backup.sh" \
  || fail "backup publication does not commit through the success marker"
grep -Fq 'verify-archive.sh' "$repo_root/scripts/backup/backup.sh" \
  || fail "backup publication does not decrypt-verify its candidate"
if grep -Fq 'offsite-sync.sh' "$repo_root/scripts/backup/backup.sh"; then
  fail "backup publication still performs inline offsite synchronization"
fi
python - "$repo_root/scripts/backup/backup.sh" <<'PY'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
pattern = re.compile(
    r"publication_commit_uncertain=1\s+"
    r"if ! run_deadline bash -c \"\$marker_command\".*?; then\s+"
    r"die \"success marker durability failed\"\s+"
    r"fi\s+marker_published=1\s+marker_validation_pending=1\s+"
    r"close_event_monitor.*?\s+marker_validation_pending=0\s+"
    r"marker_committed=1\s+publication_commit_uncertain=0",
    re.DOTALL,
)
if not pattern.search(source):
    raise SystemExit(
        "marker publication is not audited through rename and directory durability"
    )
if not re.search(
    r'credential_inode_match="\$\(run_deadline find -P .*?'
    r'-samefile "\$CREDENTIAL_MASTER_KEY_FILE" -print -quit\)"',
    source,
    re.DOTALL,
):
    raise SystemExit("credential-key inode scan is not inside the shared deadline")
if re.search(
    r'find -P "\$LEARN_DATA_ROOT/app-data".*?-printf .*?\|\s*grep -Fqx',
    source,
    re.DOTALL,
):
    raise SystemExit("credential-key inode scan still uses an ambiguous unbounded pipeline")
if "--label com.centurylinklabs.watchtower.enable=false" not in source:
    raise SystemExit("backup monitor sentinels are not opted out of Watchtower")
if not re.search(
    r'docker compose .*?config --format json.*?compose_project_name',
    source,
    re.DOTALL,
):
    raise SystemExit("event monitor project filter is not derived from Compose config")
PY

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/live-repo" "$work/live-data/app-data" \
  "$work/live-backups" "$work/stages"

cat >"$work/bin/age" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
mode="${1:-}"
shift
output=""
identity=""
recipients=""
while (($# > 1)); do
  case "$1" in
    --identity) identity="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --recipients-file) recipients="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -n "$output" && $# -eq 1 ]] || exit 64
case "$mode" in
  --decrypt)
    [[ -n "$identity" && -f "$identity" ]] || exit 64
    if [[ "${TEST_REPLACE_VERIFY_DEST:-0}" == 1 ]]; then
      destination="$(dirname -- "$output")"
      mv -- "$destination" "${destination}.original"
      mkdir -m 0700 -- "$destination"
      printf '%s\n' preserve-replacement >"$destination/do-not-delete"
      printf '%s\n' preserve-lookalike >"$output"
      exit 75
    fi
    [[ "${TEST_AGE_DECRYPT_FAIL:-0}" != 1 ]] || exit 75
    if [[ -n "${TEST_CONTROLLER_ENVELOPE_MUTATION:-}" ]]; then
      "$TEST_ENVELOPE_MUTATOR" "$1" "$output" "$TEST_CONTROLLER_ENVELOPE_MUTATION"
    else
      cp -- "$1" "$output"
    fi
    ;;
  --encrypt)
    [[ -n "$recipients" && -f "$recipients" ]] || exit 64
    [[ "${TEST_AGE_ENCRYPT_FAIL:-0}" != 1 ]] || exit 76
    cp -- "$1" "$output"
    ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/bin/mutate-envelope" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
input="$1"
output="$2"
mutation="$3"
if [[ "$mutation" == outer-list ]]; then
  printf '%s' not-a-tar-stream >"$output"
  exit 0
fi
root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
tar -xzf "$input" -C "$root"
members=(MANIFEST.txt SHA256SUMS)
[[ ! -f "$root/app-data.tar.gz" ]] || members+=(app-data.tar.gz)
members+=(credential-probe.json database.dump repository.tar.gz)
case "$mutation" in
  unsafe-path)
    printf unsafe >"$root/unsafe-source"
    tar --absolute-names -C "$root" \
      --transform='s|^unsafe-source$|../escape|' -czf "$output" unsafe-source
    ;;
  unsafe-type)
    rm -f -- "$root/database.dump"
    mkdir "$root/database.dump"
    tar -C "$root" -czf "$output" "${members[@]}"
    ;;
  internal-checksum)
    printf tampered >>"$root/database.dump"
    tar -C "$root" -czf "$output" "${members[@]}"
    ;;
  manifest)
    sed -i 's/contains_secret_files=false/contains_secret_files=true/' \
      "$root/MANIFEST.txt"
    tar -C "$root" -czf "$output" "${members[@]}"
    ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/bin/age-keygen" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -y && -f "${2:-}" ]]; then
  printf '%s\n' age1ephemeralpublicationfixture
  exit 0
fi
[[ "${1:-}" == -o && -n "${2:-}" ]] || exit 64
printf '%s\n' AGE-SECRET-KEY-PUBLICATION-FIXTURE >"$2"
chmod 0600 "$2"
EOF
cat >"$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work/bin/python3" <<'EOF'
#!/usr/bin/env bash
exec python "$@"
EOF
cat >"$work/bin/timeout" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
joined=" $* "
if [[ -n "${TEST_TIMEOUT_DEBUG_FILE:-}" ]]; then
  printf '%q ' "$@" >>"$TEST_TIMEOUT_DEBUG_FILE"
  printf '\n' >>"$TEST_TIMEOUT_DEBUG_FILE"
fi
if [[ "${TEST_INODE_SCAN_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$joined" == *" find -P "* \
  && "$joined" == *" -samefile "* ]]; then
  duration="${3%s}"
  [[ "$duration" =~ ^[0-9]+$ ]] || exit 96
  if ((duration > 580)); then
    printf '%s\n' "$duration" >"$TEST_TIMEOUT_GRACE_VIOLATION"
  fi
  /usr/bin/date +%s%N >"$TEST_HUNG_CHILD_STARTED"
  exec /usr/bin/timeout --foreground --kill-after=0.3s 0.2s "${@:4}"
fi
if [[ "${TEST_LATE_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$joined" == *" sync -f "* \
  && "$joined" == *".sha256.tmp."* ]]; then
  duration="${3%s}"
  [[ "$duration" =~ ^[0-9]+$ ]] || exit 96
  if ((duration > 580)); then
    printf '%s\n' "$duration" >"$TEST_TIMEOUT_GRACE_VIOLATION"
  fi
  /usr/bin/date +%s%N >"$TEST_HUNG_CHILD_STARTED"
  exec /usr/bin/timeout --foreground --kill-after=0.3s 0.2s \
    bash -c 'trap "" TERM; while :; do :; done'
fi
event_audit_command=0
for argument in "$@"; do
  [[ "$argument" != event-audit ]] || event_audit_command=1
done
if [[ "${TEST_EVENT_AUDIT_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$event_audit_command" == 1 ]]; then
  audit_count=0
  [[ ! -f "${TEST_EVENT_AUDIT_TIMEOUT_STATE:?}" ]] \
    || audit_count="$(<"$TEST_EVENT_AUDIT_TIMEOUT_STATE")"
  ((audit_count += 1))
  printf '%s' "$audit_count" >"$TEST_EVENT_AUDIT_TIMEOUT_STATE"
  if ((audit_count >= 2)); then
    duration="${3%s}"
    [[ "$duration" =~ ^[0-9]+$ ]] || exit 96
    if ((duration > 580)); then
      printf '%s\n' "$duration" >"$TEST_TIMEOUT_GRACE_VIOLATION"
    fi
    /usr/bin/date +%s%N >"$TEST_HUNG_CHILD_STARTED"
    exec /usr/bin/timeout --foreground --kill-after=0.3s 0.2s \
      bash -c 'trap "" TERM; while :; do :; done'
  fi
fi
if [[ "${TEST_TIMEOUT_EXHAUST:-0}" == 1 ]]; then
  count=0
  [[ ! -f "$TEST_TIMEOUT_STATE" ]] || count="$(<"$TEST_TIMEOUT_STATE")"
  if ((count > 0)) || [[ "$joined" == *" quiesce_mutators "* ]]; then
    ((count += 1))
    printf '%s' "$count" >"$TEST_TIMEOUT_STATE"
    ((count < 2)) || exit 124
  fi
fi
exec /usr/bin/timeout "$@"
EOF
cat >"$work/bin/find" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
joined=" $* "
if [[ "${TEST_INODE_SCAN_TERM_IGNORING_CHILD:-0}" == 1 \
  && "$joined" == *" -samefile "* ]]; then
  trap '' TERM
  while :; do :; done
fi
exec /usr/bin/find "$@"
EOF
cat >"$work/bin/rm" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_BLOCK_CANDIDATE_CLEANUP:-0}" == 1 \
  && " $* " == *".sha256.tmp."* ]]; then
  /usr/bin/sleep 3
fi
exec /usr/bin/rm "$@"
EOF
cat >"$work/bin/date" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_FIXED_BACKUP_TIME:-0}" == 1 && "${1:-}" == -u ]]; then
  case "${2:-}" in
    +%Y%m%dT%H%M%SZ) printf '%s\n' 20260715T010203Z; exit 0 ;;
    +%Y-%m-%dT%H:%M:%S.%NZ) printf '%s\n' 2026-07-15T01:02:03.000000000Z; exit 0 ;;
    +%Y-%m-%dT%H:%M:%SZ) printf '%s\n' 2026-07-15T01:02:03Z; exit 0 ;;
  esac
fi
exec /usr/bin/date "$@"
EOF
cat >"$work/bin/chmod" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${TEST_WATCH_CHMOD_PATH:-}" ]]; then
  for argument in "$@"; do
    if [[ "$argument" == "$TEST_WATCH_CHMOD_PATH" ]]; then
      printf '%s\n' "$argument" >"${TEST_CHMOD_MUTATION_FILE:?}"
    fi
  done
fi
exec /usr/bin/chmod "$@"
EOF
cat >"$work/bin/tar" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
joined=" $* "
if [[ "${TEST_REPOSITORY_TAR_FAIL:-0}" == 1 \
  && "$joined" == *repository.tar.gz* ]]; then
  exit 74
fi
if [[ "${TEST_APP_TAR_FAIL:-0}" == 1 \
  && "$joined" == *app-data.tar.gz* ]]; then
  exit 75
fi
if [[ "${TEST_EVENT_SCENARIO:-}" == boundary-object \
  && "$joined" == *app-data.tar.gz* ]]; then
  state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "$BACKUP_CONFIG_FILE")/event-monitor}"
  printf '%s\n' "start|lifecycle|${TEST_EVENT_REPO_ROOT:?}||" \
    >>"$state_dir/actions"
fi
exec /usr/bin/tar "$@"
EOF
cat >"$work/bin/mktemp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_SIDECAR_CREATE_FAIL:-0}" == 1 \
  && "$*" == *".sha256.tmp.XXXXXX"* ]]; then
  exit 74
fi
exec /usr/bin/mktemp "$@"
EOF
cat >"$work/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
destination="${@: -1}"
if [[ "${TEST_ARCHIVE_RENAME_POST_EFFECT_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age ]]; then
  /usr/bin/mv "$@"
  exit 74
fi
if [[ "${TEST_SIDECAR_RENAME_POST_EFFECT_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age.sha256 ]]; then
  /usr/bin/mv "$@"
  exit 75
fi
if [[ "${TEST_ARCHIVE_RENAME_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age ]]; then
  exit 74
fi
if [[ "${TEST_FULL_SIDECAR_RENAME_FAIL:-0}" == 1 \
  && "$destination" == */learncoding-full-*.tar.gz.age.sha256 ]]; then
  exit 75
fi
if [[ "${TEST_MARKER_RENAME_FAIL:-0}" == 1 \
  && "$destination" == */state/local-last-success.env ]]; then
  exit 76
fi
if [[ -n "${TEST_MARKER_WINDOW_EVENT_SERVICE:-}" \
  && "$destination" == */backups/state/local-last-success.env ]]; then
  state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "$BACKUP_CONFIG_FILE")/event-monitor}"
  event_action=start
  [[ "$TEST_MARKER_WINDOW_EVENT_SERVICE" != postgres ]] || event_action=restart
  printf '%s\n' \
    "$event_action|$TEST_MARKER_WINDOW_EVENT_SERVICE|${TEST_EVENT_REPO_ROOT:?}||" \
    >>"$state_dir/actions"
fi
exec /usr/bin/mv "$@"
EOF
cat >"$work/bin/sync" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
target="${@: -1}"
if [[ "${TEST_EVENT_SCENARIO:-}" == boundary-publication \
  && "$target" == */backups/full ]]; then
  state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "$BACKUP_CONFIG_FILE")/event-monitor}"
  printf '%s\n' "start|lifecycle|${TEST_EVENT_REPO_ROOT:?}||" \
    >>"$state_dir/actions"
fi
if [[ "${TEST_MARKER_DIRECTORY_SYNC_FAIL:-0}" == 1 \
  && "$target" == */backups/state ]]; then
  printf '%s\n' marker-renamed >"$TEST_MARKER_EFFECT_RECORDED"
  exit 74
fi
if [[ "${TEST_MARKER_SIGNAL_AFTER_EFFECT:-0}" == 1 \
  && "$target" == */backups/state ]]; then
  printf '%s\n' marker-renamed >"$TEST_MARKER_EFFECT_RECORDED"
  marker_shell="$PPID"
  timeout_pid="$(/usr/bin/ps -o ppid= -p "$marker_shell" | tr -d ' ')"
  backup_pid="$(/usr/bin/ps -o ppid= -p "$timeout_pid" | tr -d ' ')"
  [[ "$backup_pid" =~ ^[0-9]+$ ]] || exit 96
  kill -TERM "$backup_pid"
  kill -TERM "$timeout_pid" 2>/dev/null || true
  exit 143
fi
exec /usr/bin/sync "$@"
EOF
cat >"$work/bin/env" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_PRUNE_FAIL:-0}" == 1 && "$*" == *"scripts/backup/prune.sh"* ]]; then
  exit 74
fi
exec /usr/bin/env "$@"
EOF
chmod 0755 "$work/bin/age" "$work/bin/age-keygen" "$work/bin/flock" \
  "$work/bin/python3" \
  "$work/bin/timeout" "$work/bin/find" "$work/bin/tar" "$work/bin/mktemp" "$work/bin/mv" \
  "$work/bin/sync" \
  "$work/bin/env" "$work/bin/rm" "$work/bin/date" "$work/bin/chmod" \
  "$work/bin/mutate-envelope"

# MSYS cannot represent the production 0640/0440 fixtures. This narrow adapter
# allows orchestration development only; the unchanged real-stat suite remains
# an Ubuntu acceptance gate.
cat >"$work/bin/stat" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${TEST_UNSAFE_DIRECTORY_PATH:-}" \
  && "${@: -1}" == "$TEST_UNSAFE_DIRECTORY_PATH" \
  && "$*" == *"%u"* ]]; then
  printf '%s\n' 2147483646
  exit 0
fi
if [[ "${OSTYPE:-}" == msys* && "$*" == *"%a"* ]]; then
  target="${@: -1}"
  case "$target" in
    */compose.env) printf '%s\n' 640; exit 0 ;;
    */credential-master-key) printf '%s\n' 440; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
EOF
chmod 0755 "$work/bin/stat"

if [[ "${OSTYPE:-}" == msys* ]]; then
  cat >"$work/bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *" rev-parse --show-toplevel "* ]]; then
  value="$(/mingw64/bin/git "$@")"
  cygpath -u "$value"
  exit 0
fi
exec /mingw64/bin/git "$@"
EOF
  cat >"$work/bin/hostname" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -s ]] || exit 64
printf '%s\n' publication-test
EOF
  chmod 0755 "$work/bin/git" "$work/bin/hostname"
fi

identity="$work/identity.txt"
printf '%s\n' AGE-SECRET-KEY-TEST-FIXTURE >"$identity"
chmod 0600 "$identity"

config="$work/backup.env"
cat >"$config" <<EOF
BACKUP_ROOT=$work/live-backups
EMERGENCY_BACKUP_ROOT=$work/emergency-backups
REPO_ROOT=$work/live-repo
LEARN_DATA_ROOT=$work/live-data
BACKUP_STAGE_ROOT=$work/stages
BACKUP_LOCK_FILE=$work/backup.lock
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
EOF
chmod 0600 "$config"

readonly fixture_hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly migration_hash="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
readonly -a required_image_services=(
  app cloudflared exam-finalization-worker mail-worker migrate postgres
  practice-runner-recovery-worker project-review-correction-worker
  regrade-worker reward-worker
)

write_full_manifest() {
  local path="$1" app_data_included="${2:-false}"
  cat >"$path" <<EOF
format=learncoding-backup-v1
created_utc=20260715T010203Z
snapshot_utc=20260715T010204Z
source_host=backup-test
git_commit=0123456789abcdef0123456789abcdef01234567
database_version=postgres (PostgreSQL) 17.5
migration_count=2
migration_last_id=2
migration_last_created_at=2000
migration_state_sha256=$migration_hash
app_data_included=$app_data_included
contains_secret_files=false
contains_email_exports=false
EOF
  local service
  for service in "${required_image_services[@]}"; do
    printf 'image_id.%s=sha256:%s\n' "$service" "$fixture_hash" >>"$path"
  done
}

write_checksums() {
  local stage="$1" schema="$2" app_data_included="${3:-false}"
  case "$schema:$app_data_included" in
    full:false)
      (cd "$stage" && sha256sum --text \
        database.dump repository.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS)
      ;;
    full:true)
      (cd "$stage" && sha256sum --text \
        database.dump repository.tar.gz app-data.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS)
      ;;
    emergency:*)
      (cd "$stage" && sha256sum --text database.dump recovery-config.tar.gz MANIFEST.txt >SHA256SUMS)
      ;;
    *) return 1 ;;
  esac
}

make_safe_repository_tar() {
  local output="$1" root
  root="$(mktemp -d "$work/repository.XXXXXX")"
  mkdir -p "$root/content" "$root/drizzle" "$root/infra" "$root/docs/runbooks"
  printf lesson >"$root/content/lesson.json"
  printf migration >"$root/drizzle/0000.sql"
  printf unit >"$root/infra/unit.conf"
  printf deployment >"$root/docs/deployment.md"
  printf runbook >"$root/docs/runbooks/restore.md"
  printf compose >"$root/compose.yaml"
  printf docker >"$root/Dockerfile"
  printf ignore >"$root/.dockerignore"
  tar -C "$root" -czf "$output" \
    .dockerignore Dockerfile compose.yaml content drizzle docs infra
  rm -rf -- "$root"
}

make_full_archive() {
  local output="$1" mutation="${2:-none}" stage app_data_included=false
  local -a members=()
  stage="$(mktemp -d "$work/full-payload.XXXXXX")"
  printf database >"$stage/database.dump"
  make_safe_repository_tar "$stage/repository.tar.gz"
  printf '%s\n' '{"version":1,"fixture":true}' >"$stage/credential-probe.json"
  write_full_manifest "$stage/MANIFEST.txt" false

  case "$mutation" in
    secret-flag)
      sed -i 's/contains_secret_files=false/contains_secret_files=true/' "$stage/MANIFEST.txt"
      ;;
    email-flag)
      sed -i 's/contains_email_exports=false/contains_email_exports=true/' "$stage/MANIFEST.txt"
      ;;
    duplicate-manifest-key)
      printf '%s\n' 'source_host=second-host' >>"$stage/MANIFEST.txt"
      ;;
    unknown-manifest-key)
      printf '%s\n' 'future_field=unsafe' >>"$stage/MANIFEST.txt"
      ;;
    bad-commit)
      sed -i 's/git_commit=.*/git_commit=unknown/' "$stage/MANIFEST.txt"
      ;;
    bad-created-time)
      sed -i 's/created_utc=.*/created_utc=20260230T010203Z/' "$stage/MANIFEST.txt"
      ;;
    bad-snapshot-time)
      sed -i 's/snapshot_utc=.*/snapshot_utc=not-a-time/' "$stage/MANIFEST.txt"
      ;;
    bad-image-id)
      sed -i '0,/^image_id\./s/sha256:[0-9a-f]\{64\}/sha256:ABCDEF/' "$stage/MANIFEST.txt"
      ;;
    missing-image)
      sed -i '/^image_id\.reward-worker=/d' "$stage/MANIFEST.txt"
      ;;
    unknown-image)
      printf 'image_id.unknown-service=sha256:%s\n' "$fixture_hash" >>"$stage/MANIFEST.txt"
      ;;
    duplicate-image)
      printf 'image_id.app=sha256:%s\n' "$migration_hash" >>"$stage/MANIFEST.txt"
      ;;
    app-data-mismatch)
      sed -i 's/app_data_included=false/app_data_included=true/' "$stage/MANIFEST.txt"
      ;;
    missing-migration-state)
      sed -i '/^migration_state_sha256=/d' "$stage/MANIFEST.txt"
      ;;
    nested-traversal|nested-dot-component|nested-backslash)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-unsafe.XXXXXX")"
      mkdir -p "$nested_root/content"
      printf escape >"$nested_root/content/item"
      case "$mutation" in
        nested-traversal) transform='s|content/item|../escape|' ;;
        nested-dot-component) transform='s|content/item|content/./item|' ;;
        nested-backslash) transform='s|content/item|content\\item|' ;;
      esac
      tar -C "$nested_root" --transform="$transform" \
        -czf "$stage/repository.tar.gz" content/item
      rm -rf -- "$nested_root"
      ;;
    nested-file-ancestor|nested-type-alias)
      local nested_root nested_tar
      nested_root="$(mktemp -d "$work/nested-conflict.XXXXXX")"
      nested_tar="$nested_root/repository.tar"
      printf ancestor >"$nested_root/ancestor"
      if [[ "$mutation" == nested-file-ancestor ]]; then
        printf child >"$nested_root/child"
        tar -C "$nested_root" -cf "$nested_tar" \
          --transform='s|^ancestor$|content|' ancestor
        tar -C "$nested_root" -rf "$nested_tar" \
          --transform='s|^child$|content/x|' child
      else
        mkdir "$nested_root/content"
        tar -C "$nested_root" -cf "$nested_tar" content
        tar -C "$nested_root" -rf "$nested_tar" \
          --transform='s|^ancestor$|content|' ancestor
      fi
      gzip -n <"$nested_tar" >"$stage/repository.tar.gz"
      rm -rf -- "$nested_root"
      ;;
    nested-fifo)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-fifo.XXXXXX")"
      mkdir "$nested_root/content"
      mkfifo "$nested_root/content/pipe"
      tar -C "$nested_root" -czf "$stage/repository.tar.gz" content
      rm -rf -- "$nested_root"
      ;;
    nested-hardlink)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-hardlink.XXXXXX")"
      mkdir "$nested_root/content"
      printf linked >"$nested_root/content/a"
      ln "$nested_root/content/a" "$nested_root/content/b"
      tar -C "$nested_root" -czf "$stage/repository.tar.gz" content/a content/b
      rm -rf -- "$nested_root"
      ;;
    nested-symlink|nested-device|nested-socket)
      python - "$stage/repository.tar.gz" "$mutation" <<'PY'
import io
import tarfile
import sys

output, mutation = sys.argv[1:]
with tarfile.open(output, "w:gz") as archive:
    for name in ["content", "drizzle", "infra", "docs", "docs/runbooks"]:
        entry = tarfile.TarInfo(f"{name}/")
        entry.type = tarfile.DIRTYPE
        entry.mode = 0o755
        archive.addfile(entry)
    for name, value in {
        ".dockerignore": b"ignore",
        "Dockerfile": b"docker",
        "compose.yaml": b"compose",
        "content/lesson.json": b"lesson",
        "drizzle/0000.sql": b"migration",
        "infra/unit.conf": b"infra",
        "docs/deployment.md": b"deployment",
        "docs/runbooks/restore.md": b"runbook",
    }.items():
        entry = tarfile.TarInfo(name)
        entry.mode = 0o644
        entry.size = len(value)
        archive.addfile(entry, io.BytesIO(value))
    special = tarfile.TarInfo("content/special")
    special.mode = 0o644
    if mutation == "nested-symlink":
        special.type = tarfile.SYMTYPE
        special.linkname = "lesson.json"
    elif mutation == "nested-device":
        special.type = tarfile.CHRTYPE
        special.devmajor = 1
        special.devminor = 3
    else:
        special.type = b"s"
    archive.addfile(special)
PY
      ;;
    repository-file-wide-mode|repository-file-special-mode|repository-dir-wide-mode|repository-dir-special-mode)
      python - "$stage/repository.tar.gz" "$mutation" <<'PY'
import io
import os
import tarfile
import tempfile
import sys

archive_path, mutation = sys.argv[1:]
target = "content/lesson.json" if "file" in mutation else "content"
mode = {
    "repository-file-wide-mode": 0o666,
    "repository-file-special-mode": 0o4755,
    "repository-dir-wide-mode": 0o777,
    "repository-dir-special-mode": 0o1777,
}[mutation]
fd, replacement = tempfile.mkstemp(dir=os.path.dirname(archive_path), suffix=".tar.gz")
os.close(fd)
try:
    with tarfile.open(archive_path, "r:gz") as source, tarfile.open(replacement, "w:gz") as output:
        for member in source.getmembers():
            if member.name.rstrip("/") == target:
                member.mode = mode
            extracted = source.extractfile(member) if member.isfile() else None
            output.addfile(member, extracted)
    os.replace(replacement, archive_path)
finally:
    if os.path.exists(replacement):
        os.unlink(replacement)
PY
      ;;
    repository-content-file|repository-compose-directory|repository-missing-drizzle|repository-secret-subtree)
      local nested_root
      nested_root="$(mktemp -d "$work/nested-schema.XXXXXX")"
      case "$mutation" in
        repository-content-file)
          printf content-is-not-a-directory >"$nested_root/content-source"
          tar -C "$nested_root" --transform='s|^content-source$|content|' \
            -czf "$stage/repository.tar.gz" content-source
          ;;
        repository-compose-directory)
          mkdir -p "$nested_root/compose.yaml"
          printf child >"$nested_root/compose.yaml/child"
          tar -C "$nested_root" -czf "$stage/repository.tar.gz" compose.yaml
          ;;
        repository-missing-drizzle|repository-secret-subtree)
          mkdir -p "$nested_root/content" "$nested_root/infra" "$nested_root/docs/runbooks"
          printf lesson >"$nested_root/content/lesson.json"
          printf infra >"$nested_root/infra/unit.conf"
          printf deployment >"$nested_root/docs/deployment.md"
          printf runbook >"$nested_root/docs/runbooks/restore.md"
          printf compose >"$nested_root/compose.yaml"
          printf docker >"$nested_root/Dockerfile"
          printf ignore >"$nested_root/.dockerignore"
          if [[ "$mutation" == repository-secret-subtree ]]; then
            mkdir -p "$nested_root/drizzle" "$nested_root/infra/secrets"
            printf migration >"$nested_root/drizzle/0000.sql"
            printf secret >"$nested_root/infra/secrets/master.key"
          fi
          members=(.dockerignore Dockerfile compose.yaml content docs infra)
          [[ "$mutation" != repository-secret-subtree ]] || members+=(drizzle)
          tar -C "$nested_root" -czf "$stage/repository.tar.gz" "${members[@]}"
          ;;
      esac
      rm -rf -- "$nested_root"
      ;;
    app-data-root-file)
      local app_root
      app_root="$(mktemp -d "$work/app-schema.XXXXXX")"
      printf app-data-is-not-a-directory >"$app_root/source"
      tar -C "$app_root" --transform='s|^source$|app-data|' \
        -czf "$stage/app-data.tar.gz" source
      rm -rf -- "$app_root"
      app_data_included=true
      sed -i 's/app_data_included=false/app_data_included=true/' "$stage/MANIFEST.txt"
      ;;
  esac

  write_checksums "$stage" full "$app_data_included"
  case "$mutation" in
    uppercase-checksum)
      while IFS= read -r checksum_line; do
        printf '%s%s\n' \
          "$(printf '%s' "${checksum_line:0:64}" | tr '[:lower:]' '[:upper:]')" \
          "${checksum_line:64}"
      done <"$stage/SHA256SUMS" >"$stage/SHA256SUMS.upper"
      mv "$stage/SHA256SUMS.upper" "$stage/SHA256SUMS"
      ;;
    duplicate-checksum)
      head -n 1 "$stage/SHA256SUMS" >>"$stage/SHA256SUMS"
      ;;
    bad-checksum-separator)
      sed -i '1s/  / */' "$stage/SHA256SUMS"
      ;;
    checksum-traversal)
      sed -i '1s/  database\.dump$/  ..\/database.dump/' "$stage/SHA256SUMS"
      ;;
    missing-probe)
      rm -f -- "$stage/credential-probe.json"
      sed -i '/  credential-probe\.json$/d' "$stage/SHA256SUMS"
      ;;
  esac

  if [[ "$mutation" == outer-reordered ]]; then
    tar -C "$stage" -czf "$output" \
      database.dump MANIFEST.txt SHA256SUMS credential-probe.json repository.tar.gz
  elif [[ "$mutation" == missing-probe ]]; then
    tar -C "$stage" -czf "$output" \
      MANIFEST.txt SHA256SUMS database.dump repository.tar.gz
  else
    members=(MANIFEST.txt SHA256SUMS)
    [[ "$app_data_included" != true ]] || members+=(app-data.tar.gz)
    members+=(credential-probe.json database.dump repository.tar.gz)
    tar -C "$stage" -czf "$output" "${members[@]}"
  fi
  rm -rf -- "$stage"
}

make_emergency_archive() {
  local output="$1" mutation="${2:-none}" stage root
  stage="$(mktemp -d "$work/emergency-payload.XXXXXX")"
  root="$(mktemp -d "$work/recovery-config.XXXXXX")"
  mkdir -p "$root/drizzle" "$root/infra/env" "$root/infra/systemd" "$root/docs/runbooks"
  printf database >"$stage/database.dump"
  printf compose >"$root/compose.yaml"
  printf docker >"$root/Dockerfile"
  printf ignore >"$root/.dockerignore"
  printf migration >"$root/drizzle/0000.sql"
  printf env >"$root/infra/env/example"
  printf unit >"$root/infra/systemd/backup.service"
  printf deployment >"$root/docs/deployment.md"
  printf runbook >"$root/docs/runbooks/restore.md"
  case "$mutation" in
    emergency-secret-subtree)
      mkdir -p "$root/infra/secrets"
      printf secret >"$root/infra/secrets/master.key"
      ;;
    emergency-missing-systemd)
      rm -rf -- "$root/infra/systemd"
      ;;
    emergency-drizzle-file)
      rm -rf -- "$root/drizzle"
      printf migration-is-not-a-directory >"$root/drizzle"
      ;;
  esac
  tar -C "$root" -czf "$stage/recovery-config.tar.gz" \
    .dockerignore Dockerfile compose.yaml drizzle docs infra
  rm -rf -- "$root"
  cat >"$stage/MANIFEST.txt" <<'EOF'
format=learncoding-emergency-v1
created_utc=20260715T010203Z
scope=database-and-non-secret-recovery-config-only
contains_secret_files=false
contains_email_exports=false
EOF
  if [[ "$mutation" == mixed-schema ]]; then
    printf '%s\n' '{"version":1}' >"$stage/credential-probe.json"
  fi
  write_checksums "$stage" emergency false
  if [[ "$mutation" == bad-internal-checksum ]]; then
    sed -i '1s/^[0-9a-f]/0/' "$stage/SHA256SUMS"
  fi
  local -a members=(MANIFEST.txt SHA256SUMS database.dump recovery-config.tar.gz)
  [[ "$mutation" != mixed-schema ]] || members+=(credential-probe.json)
  tar -C "$stage" -czf "$output" "${members[@]}"
  rm -rf -- "$stage"
}

verify_success() {
  local archive="$1" destination="$2" output
  local -a verifier_command=(bash)
  [[ "${BACKUP_TEST_TRACE_VERIFIER:-0}" != 1 ]] || verifier_command+=( -x )
  verifier_command+=("$verifier")
  output="$(PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
    "${verifier_command[@]}" "$archive" "$identity" "$destination")"
  [[ "$output" == archive_valid=true ]] || fail "verifier emitted a noncanonical success result"
  [[ -f "$destination/MANIFEST.txt" && ! -e "$destination/.archive.plain.tmp" ]] \
    || fail "verifier did not leave only the validated extraction"
}

verify_failure() {
  local archive="$1" destination="$2"
  if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
    bash "$verifier" "$archive" "$identity" "$destination" >/dev/null 2>&1; then
    fail "verifier accepted an unsafe archive fixture"
  fi
  if [[ -d "$destination" ]] && find "$destination" -mindepth 1 -print -quit | grep -q .; then
    fail "verifier failure left extracted plaintext"
  fi
}

if [[ "$test_group" == all || "$test_group" == verifier \
  || "$test_group" == m4-nested-schema \
  || "$test_group" == m6-destination-safety ]]; then
full_archive="$work/full.tar.gz.age"
make_full_archive "$full_archive"
verify_success "$full_archive" "$work/full-verified"

emergency_archive="$work/emergency.tar.gz.age"
make_emergency_archive "$emergency_archive"
verify_success "$emergency_archive" "$work/emergency-verified"

for mutation in secret-flag email-flag duplicate-manifest-key unknown-manifest-key \
  bad-commit bad-created-time bad-snapshot-time bad-image-id missing-image \
  unknown-image duplicate-image app-data-mismatch missing-migration-state missing-probe \
  uppercase-checksum duplicate-checksum bad-checksum-separator checksum-traversal \
  nested-traversal nested-dot-component \
  nested-backslash nested-file-ancestor nested-type-alias nested-fifo \
  nested-hardlink nested-symlink nested-device nested-socket \
  repository-file-wide-mode repository-file-special-mode \
  repository-dir-wide-mode repository-dir-special-mode \
  repository-content-file repository-compose-directory \
  repository-missing-drizzle repository-secret-subtree app-data-root-file \
  outer-reordered; do
  candidate="$work/full-$mutation.tar.gz.age"
  make_full_archive "$candidate" "$mutation"
  verify_failure "$candidate" "$work/verify-$mutation"
done

for mutation in mixed-schema bad-internal-checksum emergency-secret-subtree \
  emergency-missing-systemd emergency-drizzle-file; do
  candidate="$work/emergency-$mutation.tar.gz.age"
  make_emergency_archive "$candidate" "$mutation"
  verify_failure "$candidate" "$work/verify-emergency-$mutation"
done

# A duplicate outer member must fail even when both copies are regular files.
duplicate_stage="$(mktemp -d "$work/duplicate.XXXXXX")"
cp "$work/full-verified/"* "$duplicate_stage/"
tar -C "$duplicate_stage" -cf "$work/duplicate.tar" \
  MANIFEST.txt SHA256SUMS credential-probe.json database.dump repository.tar.gz
tar -C "$duplicate_stage" -rf "$work/duplicate.tar" database.dump
gzip -n <"$work/duplicate.tar" >"$work/duplicate-outer.tar.gz.age"
verify_failure "$work/duplicate-outer.tar.gz.age" "$work/verify-duplicate-outer"

printf 'not-a-tar-stream' >"$work/corrupt-outer.tar.gz.age"
verify_failure "$work/corrupt-outer.tar.gz.age" "$work/verify-corrupt-outer"

# Unsafe outer names and every representable non-regular type are rejected
# before extraction. Linux-only types remain active in the Ubuntu gate.
type_stage="$(mktemp -d "$work/type.XXXXXX")"
printf target >"$type_stage/target"
ln -s target "$type_stage/database.dump"
if [[ -L "$type_stage/database.dump" ]]; then
  tar -C "$type_stage" -czf "$work/symlink-outer.tar.gz.age" database.dump
  verify_failure "$work/symlink-outer.tar.gz.age" "$work/verify-symlink-outer"
fi

mkdir "$type_stage/directory"
tar -C "$type_stage" --transform='s|^directory|database.dump|' \
  -czf "$work/directory-outer.tar.gz.age" directory
verify_failure "$work/directory-outer.tar.gz.age" "$work/verify-directory-outer"

mkfifo "$type_stage/fifo"
tar -C "$type_stage" --transform='s|^fifo$|database.dump|' \
  -czf "$work/fifo-outer.tar.gz.age" fifo
verify_failure "$work/fifo-outer.tar.gz.age" "$work/verify-fifo-outer"

printf linked >"$type_stage/hardlink-source"
ln "$type_stage/hardlink-source" "$type_stage/hardlink-copy"
tar -C "$type_stage" --transform='s|^hardlink-source$|MANIFEST.txt|;s|^hardlink-copy$|database.dump|' \
  -czf "$work/hardlink-outer.tar.gz.age" hardlink-source hardlink-copy
verify_failure "$work/hardlink-outer.tar.gz.age" "$work/verify-hardlink-outer"

printf unknown >"$type_stage/unknown.member"
tar -C "$type_stage" -czf "$work/unknown-outer.tar.gz.age" unknown.member
verify_failure "$work/unknown-outer.tar.gz.age" "$work/verify-unknown-outer"

control_name=$'control\tmember'
printf control >"$type_stage/$control_name"
tar -C "$type_stage" -czf "$work/control-outer.tar.gz.age" "$control_name"
verify_failure "$work/control-outer.tar.gz.age" "$work/verify-control-outer"

printf absolute >"$type_stage/absolute-source"
tar --absolute-names -C "$type_stage" \
  --transform='s|^absolute-source$|/absolute-member|' \
  -czf "$work/absolute-outer.tar.gz.age" absolute-source
verify_failure "$work/absolute-outer.tar.gz.age" "$work/verify-absolute-outer"

printf traversal >"$type_stage/traversal-source"
tar --absolute-names -C "$type_stage" \
  --transform='s|^traversal-source$|../traversal-member|' \
  -czf "$work/traversal-outer.tar.gz.age" traversal-source
verify_failure "$work/traversal-outer.tar.gz.age" "$work/verify-traversal-outer"

if python - "$type_stage/socket" 2>/dev/null <<'PY'
import socket
import sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
s.close()
PY
then
  if [[ -S "$type_stage/socket" ]]; then
    tar -C "$type_stage" --transform='s|^socket$|database.dump|' \
      -czf "$work/socket-outer.tar.gz.age" socket
    verify_failure "$work/socket-outer.tar.gz.age" "$work/verify-socket-outer"
  fi
fi

if [[ "$(id -u)" == 0 ]] && mknod "$type_stage/device" c 1 3 2>/dev/null; then
  tar -C "$type_stage" --transform='s|^device$|database.dump|' \
    -czf "$work/device-outer.tar.gz.age" device
  verify_failure "$work/device-outer.tar.gz.age" "$work/verify-device-outer"
fi

replacement_destination="$work/verify-replaced-destination"
if PATH="$work/bin:$PATH" TEST_REPLACE_VERIFY_DEST=1 BACKUP_CONFIG_FILE="$config" \
  bash "$verifier" "$full_archive" "$identity" "$replacement_destination" \
  >/dev/null 2>&1; then
  fail "verifier succeeded after its destination was replaced"
fi
[[ -f "$replacement_destination/do-not-delete" ]] \
  || fail "verifier cleanup deleted a replaced destination"
[[ -f "$replacement_destination/.archive.plain.tmp" \
  && "$(<"$replacement_destination/.archive.plain.tmp")" == preserve-lookalike ]] \
  || fail "verifier cleanup deleted a lookalike file in a replaced destination"
rm -rf -- "$replacement_destination" "${replacement_destination}.original"

mkdir -p "$work/emergency-backups"
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
  bash "$verifier" "$full_archive" "$identity" \
  "$work/emergency-backups/verification" >/dev/null 2>&1; then
  fail "verifier accepted a destination inside the emergency backup root"
fi
[[ ! -e "$work/emergency-backups/verification" ]]

mkdir -p "$work/live-data"
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
  bash "$verifier" "$full_archive" "$identity" \
  "$work/live-data/verification" >/dev/null 2>&1; then
  fail "verifier accepted a destination inside the live data root"
fi
[[ ! -e "$work/live-data/verification" ]]

# The destination must be disjoint in both directions, even when the protected
# descendant does not exist yet.
ancestor_config="$work/ancestor-destination.env"
cp "$config" "$ancestor_config"
sed -i "s|^LEARN_DATA_ROOT=.*|LEARN_DATA_ROOT=$work/verifier-ancestor-destination/live-data|" \
  "$ancestor_config"
if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$ancestor_config" \
  bash "$verifier" "$full_archive" "$identity" \
  "$work/verifier-ancestor-destination" >/dev/null 2>&1; then
  fail "verifier accepted a destination that is an ancestor of live data"
fi
[[ ! -e "$work/verifier-ancestor-destination" ]]

# A destination with a symlinked ancestor is not a canonically named protected
# extraction directory, even when the resolved target is otherwise disjoint.
mkdir "$work/verifier-safe-parent"
ln -s "$work/verifier-safe-parent" "$work/verifier-symlink-ancestor"
if [[ -L "$work/verifier-symlink-ancestor" ]]; then
  if PATH="$work/bin:$PATH" BACKUP_CONFIG_FILE="$config" \
    bash "$verifier" "$full_archive" "$identity" \
    "$work/verifier-symlink-ancestor/verification" >/dev/null 2>&1; then
    fail "verifier accepted a destination with a symlinked ancestor"
  fi
  [[ ! -e "$work/verifier-safe-parent/verification" ]]
fi

if [[ "$test_group" == m6-destination-safety ]]; then
  echo "backup-publication-m6-destination-tests-ok"
  exit 0
fi

canonical_fixture_hash() {
  local root="$1" output="$2" source="$1/source" stage="$1/stage"
  mkdir -p "$source/content" "$stage"
  printf fixed >"$source/content/item"
  tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' \
    --mtime='2026-07-15 01:02:03 UTC' --use-compress-program='gzip -n' \
    --create --file "$stage/repository.tar.gz" --directory "$source" content
  printf fixed-database >"$stage/database.dump"
  printf '%s\n' '{"fixed":"sealed-probe"}' >"$stage/credential-probe.json"
  printf '%s\n' 'fixed-manifest' >"$stage/MANIFEST.txt"
  (cd "$stage" && sha256sum --text \
    database.dump repository.tar.gz credential-probe.json MANIFEST.txt >SHA256SUMS)
  tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
    --owner=0 --group=0 --numeric-owner --mode='u=rw,go=' \
    --mtime='2026-07-15 01:02:03 UTC' --use-compress-program='gzip -n' \
    --create --file "$output" --directory "$stage" \
    MANIFEST.txt SHA256SUMS credential-probe.json database.dump repository.tar.gz
  sha256sum "$output" | awk '{print $1}'
}
canonical_one="$(canonical_fixture_hash "$work/canonical-one" "$work/canonical-one.envelope.tar.gz")"
canonical_two="$(canonical_fixture_hash "$work/canonical-two" "$work/canonical-two.envelope.tar.gz")"
[[ "$canonical_one" == "$canonical_two" ]] \
  || fail "fixed-input canonical packaging changed across source roots"
if [[ "$test_group" == m4-nested-schema ]]; then
  echo "backup-publication-m4-tests-ok"
  exit 0
fi
fi

# Exercise the full controller with exact fakes. GNU tar/gzip/checksum remain
# real so the candidate accepted by the verifier is the candidate published.
fixture_repo="$work/release"
mkdir -p "$fixture_repo/content" "$fixture_repo/drizzle" "$fixture_repo/infra" \
  "$fixture_repo/docs/runbooks"
printf lesson >"$fixture_repo/content/lesson.json"
printf migration >"$fixture_repo/drizzle/0000.sql"
printf infra >"$fixture_repo/infra/unit.conf"
printf deployment >"$fixture_repo/docs/deployment.md"
printf runbook >"$fixture_repo/docs/runbooks/recovery.md"
printf compose >"$fixture_repo/compose.yaml"
printf docker >"$fixture_repo/Dockerfile"
printf ignore >"$fixture_repo/.dockerignore"
git -C "$fixture_repo" init -q
git -C "$fixture_repo" config user.email backup-test@example.invalid
git -C "$fixture_repo" config user.name backup-test
git -C "$fixture_repo" add .
git -C "$fixture_repo" commit -qm fixture

cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
readonly image_hash="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
event_state_dir="${TEST_EVENT_STATE_DIR:-$(dirname -- "${BACKUP_CONFIG_FILE:?}")/event-monitor}"
mkdir -p -- "$event_state_dir"
touch "$event_state_dir/actions"
if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  joined=" $* "
  [[ "$joined" == *" --format {{.Id}} "* \
    && "$joined" == *"registry.example.invalid/codestead/operations@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"* ]] \
    || exit 64
  printf 'sha256:%s\n' "$image_hash"
  exit 0
fi
if [[ "${1:-}" == inspect ]]; then
  joined=" $* "
  if [[ "$joined" == *"3333333333333333333333333333333333333333333333333333333333333333"* \
    && "$joined" == *".Config.Image"* ]]; then
    status=created
    name=/codestead-backup-monitor-20260714T010203Z-start-4242
    configured_image="registry.example.invalid/codestead/operations@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    runtime_image="sha256:$image_hash"
    project=learncoding
    workdir="${TEST_EVENT_REPO_ROOT:?}"
    service=backup-monitor
    token=20260714T010203Z.4242.aaaaaaaaaaaa
    phase=start
    watchtower=false
    case "${TEST_STALE_SENTINEL:-}" in
      bad-image) configured_image="registry.example.invalid/unrelated@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ;;
      bad-runtime-image) runtime_image=sha256:not-an-image-id ;;
      running) status=running ;;
      bad-name) name=/unrelated-container ;;
      wrong-project) project=unrelated ;;
      wrong-workdir) workdir=/unrelated/release ;;
      wrong-service) service=app ;;
      missing-token) token= ;;
      bad-phase) phase=middle ;;
      missing-watchtower) watchtower= ;;
      true-watchtower) watchtower=true ;;
    esac
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
      "3333333333333333333333333333333333333333333333333333333333333333" \
      "$configured_image" "$runtime_image" "$status" "$name" "$project" \
      "$workdir" "$service" "$token" "$phase" "$watchtower"
    exit 0
  fi
  printf 'sha256:%s\n' "$image_hash"
  exit 0
fi
if [[ "${1:-}" == events ]]; then
  joined=" $* "
  printf '%s\n' "$joined" >"$event_state_dir/events-argv"
  [[ "$joined" == *" --filter type=container "* \
    && "$joined" == *" --filter label=com.docker.compose.project=learncoding "* \
    && "$joined" == *" --filter label=com.docker.compose.project.working_dir="* \
    && "$joined" == *" --filter event=create "* \
    && "$joined" == *" --filter event=destroy "* \
    && "$joined" == *" --filter event=start "* \
    && "$joined" == *" --filter event=restart "* \
    && "$joined" == *" --filter event=unpause "* \
    && "$joined" == *" --since "* \
    && "$joined" != *" --until "* \
    && "$joined" == *" --format "* ]] || {
      printf '%s\n' invalid-argv >"$event_state_dir/events-error"
      exit 64
    }
  expected_repo=""
  for argument in "$@"; do
    case "$argument" in
      label=com.docker.compose.project.working_dir=*)
        expected_repo="${argument#*working_dir=}"
        ;;
    esac
  done
  [[ "$expected_repo" == /* ]] || exit 64
  printf '%s\n' ready >"$event_state_dir/ready"
  cursor=0
  while :; do
    if [[ -e "$event_state_dir/lose-monitor" ]]; then
      exit 70
    fi
    mapfile -t actions <"$event_state_dir/actions"
    while ((cursor < ${#actions[@]})); do
      action_line="${actions[$cursor]}"
      ((cursor += 1))
      IFS='|' read -r action service action_repo token phase extra <<<"$action_line"
      [[ -z "${extra:-}" ]] || exit 71
      # The real daemon applies the exact release-label filters server-side.
      [[ "$action_repo" == "$expected_repo" ]] || continue
      printf '%s\n' "$action_line"
    done
    /usr/bin/sleep 0.01
  done
fi
if [[ "${1:-}" == create ]]; then
  shift
  repo="" token="" phase="" service="" name=""
  joined=" $* "
  [[ "$joined" == *" --pull=never "* \
    && "$joined" == *" --network none "* \
    && "$joined" == *" --read-only "* \
    && "$joined" == *" --cap-drop ALL "* \
    && "$joined" == *" --security-opt no-new-privileges "* \
    && "$joined" == *" --label com.centurylinklabs.watchtower.enable=false "* ]] || exit 64
  while (($#)); do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --label)
        case "$2" in
          com.docker.compose.project=learncoding) ;;
          com.centurylinklabs.watchtower.enable=false) ;;
          com.docker.compose.project.working_dir=*) repo="${2#*=}" ;;
          com.docker.compose.service=*) service="${2#*=}" ;;
          com.codestead.backup.monitor.token=*) token="${2#*=}" ;;
          com.codestead.backup.monitor.phase=*) phase="${2#*=}" ;;
        esac
        shift 2
        ;;
      --pull=never|--network|--cap-drop|--security-opt|--pids-limit|--memory|--cpus)
        if [[ "$1" == --pull=never ]]; then shift; else shift 2; fi
        ;;
      --read-only) shift ;;
      *) shift ;;
    esac
  done
  [[ "$service" == backup-monitor && "$phase" =~ ^(start|end)$ \
    && "$token" =~ ^[A-Za-z0-9.-]+$ && "$repo" == /* \
    && "$name" =~ ^codestead-backup-monitor- ]] || exit 64
  id=""
  if [[ "$phase" == start ]]; then
    id="1111111111111111111111111111111111111111111111111111111111111111"
  else
    id="2222222222222222222222222222222222222222222222222222222222222222"
  fi
  printf '%s|%s|%s|%s\n' "$repo" "$token" "$phase" "$name" >"$event_state_dir/$id"
  printf '%s\n' "create|backup-monitor|$repo|$token|$phase" >>"$event_state_dir/actions"
  printf '%s\n' "$id"
  exit 0
fi
if [[ "${1:-}" == rm ]]; then
  shift
  [[ "${1:-}" == -f || "${1:-}" == --force ]] && shift
  id="${1:-}"
  if [[ "$id" == 3333333333333333333333333333333333333333333333333333333333333333 ]]; then
    printf '%s\n' removed >"$event_state_dir/stale-removed"
    printf '%s\n' "$id"
    exit 0
  fi
  [[ -f "$event_state_dir/$id" ]] || exit 64
  IFS='|' read -r repo token phase name <"$event_state_dir/$id"
  printf '%s\n' "destroy|backup-monitor|$repo|$token|$phase" >>"$event_state_dir/actions"
  rm -f -- "$event_state_dir/$id"
  printf '%s\n' "$id"
  exit 0
fi
if [[ "${1:-}" == ps ]]; then
  joined=" $* "
  [[ "$joined" == *" -a "* && "$joined" == *" --format "* ]] || exit 64
  by_reserved_name=0
  by_exact_labels=0
  [[ "$joined" != *" --filter name=^codestead-backup-monitor- "* ]] \
    || by_reserved_name=1
  if [[ "$joined" == *" --filter label=com.docker.compose.project=learncoding "* \
    && "$joined" == *" --filter label=com.docker.compose.project.working_dir="* \
    && "$joined" == *" --filter label=com.docker.compose.service=backup-monitor "* \
    && "$joined" == *" --filter label=com.centurylinklabs.watchtower.enable=false "* ]]; then
    by_exact_labels=1
  fi
  ((by_reserved_name == 1 || by_exact_labels == 1)) || exit 64
  scenario="${TEST_STALE_SENTINEL:-}"
  if ((by_reserved_name == 1)); then
    case "$scenario" in
      valid|bad-image|bad-runtime-image|running|wrong-project|wrong-workdir|wrong-service|missing-token|bad-phase|missing-watchtower|true-watchtower)
        printf '%s\n' 3333333333333333333333333333333333333333333333333333333333333333
        ;;
      unrelated|bad-name)
        printf '%s\n' name-filtered >"$event_state_dir/unrelated-filtered"
        ;;
    esac
  else
    # Model the daemon's old label-prefilter behavior: malformed reserved-name
    # containers disappear before inspect and therefore expose the regression.
    case "$scenario" in
      valid|bad-image|bad-runtime-image|running|bad-name|missing-token|bad-phase)
        printf '%s\n' 3333333333333333333333333333333333333333333333333333333333333333
        ;;
      unrelated|wrong-project|wrong-workdir|wrong-service|missing-watchtower|true-watchtower)
        printf '%s\n' label-filtered >"$event_state_dir/unrelated-filtered"
        ;;
    esac
  fi
  exit 0
fi
if [[ "${1:-}" == run ]]; then
  [[ "${TEST_PROBE_FAIL:-0}" != 1 ]] || exit 73
  output_source=""
  joined=" $* "
  for required in \
    '--rm' '--pull never' '--network none' '--read-only' '--cap-drop ALL' \
    '--security-opt no-new-privileges' '--pids-limit 64' '--memory 256m' \
    '--cpus 0.5' '--user 1000:1000' '--group-add 2000' '--entrypoint node' \
    '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m' \
    'registry.example.invalid/codestead/operations@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    '/app/scripts/backup/create-credential-probe.ts' \
    '/run/secrets/credential_master_key'; do
    [[ "$joined" == *" $required "* ]] || exit 64
  done
  [[ "$joined" != *" --env "* && "$joined" != *" --env-file "* \
    && "$joined" != *database_url* && "$joined" != *cloudflare* \
    && "$joined" != *rclone* && "$joined" != *oauth* ]] || exit 65
  mount_count=0
  for argument in "$@"; do
    case "$argument" in
      type=bind,src=*,dst=/output)
        ((mount_count += 1))
        output_source="${argument#type=bind,src=}"
        output_source="${output_source%,dst=/output}"
        ;;
      type=bind,src=*,dst=/run/secrets/credential_master_key,readonly)
        ((mount_count += 1))
        ;;
      type=bind,*) exit 66 ;;
    esac
  done
  [[ "$mount_count" -eq 2 && -n "$output_source" && -d "$output_source" ]] || exit 64
  printf '%s\n' '{"version":1,"context":{},"sealed":{},"plaintextSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
    >"$output_source/credential-probe.json"
  chmod 0600 "$output_source/credential-probe.json"
  printf '%s\n' credential-probe >&2
  exit 0
fi
[[ "${1:-}" == compose ]] || exit 64
shift
while (($#)); do
  case "$1" in
    --env-file|-f) shift 2 ;;
    *) break ;;
  esac
done
command="${1:-}"
shift || true
case "$command" in
  config)
    [[ " $* " == *" --format json "* ]] || exit 64
    if [[ "${TEST_COMPOSE_PROJECT_MISMATCH:-0}" == 1 ]]; then
      printf '%s\n' '{"name":"other-project"}'
    else
      printf '%s\n' '{"name":"learncoding"}'
    fi
    exit 0
    ;;
  ps)
    if [[ " $* " == *" --status running --services "* ]]; then
      if [[ "${TEST_NEW_MUTATOR_AFTER_CAPTURE:-0}" == 1 ]]; then
        query_count=0
        [[ ! -f "$TEST_RUNNING_QUERY_STATE" ]] \
          || query_count="$(<"$TEST_RUNNING_QUERY_STATE")"
        ((query_count += 1))
        printf '%s' "$query_count" >"$TEST_RUNNING_QUERY_STATE"
        if ((query_count == 1)); then
          printf '%s\n' postgres app cloudflared
        else
          printf '%s\n' postgres app reward-worker cloudflared
        fi
      elif [[ -n "${TEST_RUNNING_STATE:-}" && -f "$TEST_RUNNING_STATE" ]]; then
        cat "$TEST_RUNNING_STATE"
      else
        printf '%s\n' "${TEST_RUNNING_SERVICES:-postgres app cloudflared}" | tr ' ' '\n'
      fi
      exit 0
    fi
    if [[ " $* " == *" -a --format "* ]]; then
      include_unknown=0
      if [[ "${TEST_UNKNOWN_CREATED_SERVICE:-0}" == 1 \
        && " $* " != *" app "* ]]; then
        include_unknown=1
      fi
      for service in app cloudflared exam-finalization-worker mail-worker migrate postgres \
        practice-runner-recovery-worker project-review-correction-worker regrade-worker reward-worker; do
        printf '%s id-%s\n' "$service" "$service"
      done
      if [[ -n "${TEST_CREATED_OPTIONAL_SERVICE:-}" ]]; then
        printf '%s id-%s\n' "$TEST_CREATED_OPTIONAL_SERVICE" "$TEST_CREATED_OPTIONAL_SERVICE"
      fi
      ((include_unknown == 0)) || printf '%s\n' 'unknown-stopped-service id-unknown-stopped-service'
      exit 0
    fi
    exit 64
    ;;
  stop)
    printf '%s\n' quiesce >&2
    [[ " $* " != *" postgres "* ]] || exit 65
    [[ "${TEST_QUIESCE_FAIL:-0}" != 1 ]] || exit 75
    [[ -z "${TEST_RUNNING_STATE:-}" ]] || printf '%s\n' postgres >"$TEST_RUNNING_STATE"
    exit 0
    ;;
  up)
    if [[ -n "${TEST_FIRST_RESUME_EVENT:-}" \
      && ! -e "$TEST_FIRST_RESUME_EVENT" ]]; then
      /usr/bin/date +%s%N >"$TEST_FIRST_RESUME_EVENT"
    fi
    printf 'resume:%s\n' "${*: -1}" >&2
    [[ "${TEST_RESUME_FAIL:-0}" != 1 ]] || exit 76
    exit 0
    ;;
  exec)
    joined="$*"
    if [[ "$joined" == *pg_dump* ]]; then
      printf '%s\n' dump >&2
      [[ "${TEST_DUMP_FAIL:-0}" != 1 ]] || exit 77
      case "${TEST_EVENT_SCENARIO:-}" in
        oversized-log)
          for ((storm_line = 0; storm_line < 5000; storm_line += 1)); do
            printf '%s\n' "restart|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
              >>"$event_state_dir/actions"
          done
          ;;
        overflow-mutator)
          printf '%s\n' "start|lifecycle|${TEST_EVENT_REPO_ROOT:?}||" \
            >>"$event_state_dir/actions"
          for _ in $(seq 1 300); do
            printf '%s\n' "restart|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
              >>"$event_state_dir/actions"
          done
          ;;
        monitor-loss) printf '%s\n' lost >"$event_state_dir/lose-monitor" ;;
        postgres-restart)
          printf '%s\n' "restart|postgres|${TEST_EVENT_REPO_ROOT:?}||" \
            >>"$event_state_dir/actions"
          ;;
        unrelated-project)
          printf '%s\n' 'start|lifecycle|/unrelated/release||' \
            >>"$event_state_dir/actions"
          ;;
        clamav-restart)
          printf '%s\n' "restart|clamav|${TEST_EVENT_REPO_ROOT:?}||" \
            >>"$event_state_dir/actions"
          ;;
      esac
      printf '%s' synthetic-postgresql-custom-dump
    elif [[ "$joined" == *"postgres --version"* ]]; then
      printf '%s\n' 'postgres (PostgreSQL) 17.5'
    elif [[ "$joined" == *"__drizzle_migrations"* ]]; then
      [[ "${TEST_MIGRATION_FAIL:-0}" != 1 ]] || exit 78
      printf '%s\n' '1|aaa|1000' '2|bbb|2000'
    elif [[ "$joined" == *email_outbox* ]]; then
      printf '%s\n' queued
    else
      exit 64
    fi
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0755 "$work/bin/docker"

compose_env="$work/compose.env"
cat >"$compose_env" <<EOF
APP_OPERATIONS_IMAGE=registry.example.invalid/codestead/operations@sha256:$fixture_hash
SECRETS_GID=2000
EOF
chmod 0640 "$compose_env"
recipient="$work/recipient.txt"
printf '%s\n' age1offlinepublicationfixture >"$recipient"
chmod 0600 "$recipient"
master_key="$work/credential-master-key"
node -e "process.stdout.write(Buffer.alloc(32, 9).toString('base64'))" >"$master_key"
chmod 0440 "$master_key"

make_backup_case() {
  local case_name="$1" case_repo="${2:-$fixture_repo}"
  local case_root marker old_name old_hash
  case_root="$work/$case_name"
  mkdir -p "$case_root/backups/full" "$case_root/backups/state" \
    "$case_root/data/app-data" "$case_root/stage" "$case_root/runtime"
  chmod 0700 "$case_root/backups/full" "$case_root/backups/state" \
    "$case_root/stage" "$case_root/runtime"
  printf '%s\n' LEARNCODING_BACKUP_V1 >"$case_root/backups/.learncoding-backup-root"
  chmod 0600 "$case_root/backups/.learncoding-backup-root"
  printf object >"$case_root/data/app-data/object"
  old_name=learncoding-full-20260701T000000Z.tar.gz.age
  printf old-ciphertext >"$case_root/backups/full/$old_name"
  old_hash="$(sha256sum "$case_root/backups/full/$old_name" | awk '{print $1}')"
  printf '%s  %s\n' "$old_hash" "$old_name" >"$case_root/backups/full/$old_name.sha256"
  chmod 0600 "$case_root/backups/full/$old_name" "$case_root/backups/full/$old_name.sha256"
  marker="$case_root/backups/state/local-last-success.env"
  cat >"$marker" <<EOF
SUCCESS_ARCHIVE=$old_name
SUCCESS_COMPLETED_UTC=20260701T000001Z
SUCCESS_SHA256=$old_hash
EOF
  chmod 0600 "$marker"
  cat >"$case_root/backup.env" <<EOF
BACKUP_ROOT=$case_root/backups
REPO_ROOT=$case_repo
COMPOSE_ENV_FILE=$compose_env
LEARN_DATA_ROOT=$case_root/data
BACKUP_STAGE_ROOT=$case_root/stage
BACKUP_EPHEMERAL_ROOT=$case_root/runtime
BACKUP_LOCK_FILE=$case_root/backup.lock
AGE_RECIPIENT_FILE=$recipient
CREDENTIAL_MASTER_KEY_FILE=$master_key
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
EOF
  chmod 0600 "$case_root/backup.env"
  printf '%s\n' "$case_root"
}

phase_line() {
  local phase="$1" log_file="$2"
  grep -n -m1 "phase=$phase" "$log_file" | cut -d: -f1
}

assert_precommit_failure() {
  local label="$1" expect_resume="$2" case_root archive_count checksum_count
  shift 2
  case_root="$(make_backup_case "publication-$label-failure")"
  cp "$case_root/backups/state/local-last-success.env" "$case_root/old-marker"
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$repo_root/scripts/backup/backup.sh" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup succeeded after injected $label failure"
  fi
  cmp -s "$case_root/old-marker" "$case_root/backups/state/local-last-success.env" \
    || fail "$label failure changed the previous success marker"
  archive_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')"
  [[ "$archive_count" == 1 ]] || fail "$label failure left a candidate final archive"
  checksum_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age.sha256' | wc -l | tr -d ' ')"
  [[ "$checksum_count" == 1 ]] || fail "$label failure left a candidate final sidecar"
  [[ -z "$(find "$case_root/backups" -type f -name '.*.tmp.*' -print -quit)" ]] \
    || fail "$label failure left a publication or marker temporary"
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" -mindepth 1 -print -quit)" ]] \
    || fail "$label failure left plaintext or ephemeral key material"
  if [[ "$expect_resume" == true ]]; then
    if ! grep -Fq 'resume:app' "$case_root/log"; then
      sed -n '1,120p' "$case_root/log" >&2
      find "$case_root/event-monitor" -maxdepth 1 -type f -print -exec sed -n '1,80p' {} \; \
        >&2 2>/dev/null || true
      fail "$label failure did not resume the captured app"
    fi
  fi
  if grep -Eq 'phase=(marker_committed|pruning|complete)|offsite-sync|event=backup_complete' \
    "$case_root/log"; then
    fail "$label failure emitted a post-commit, offsite, or success event"
  fi
  if grep -Fq "$master_key" "$case_root/log" \
    || grep -Fq "$(<"$master_key")" "$case_root/log" \
    || grep -Fq "$(<"$recipient")" "$case_root/log" \
    || grep -Fq 'AGE-SECRET-KEY-' "$case_root/log"; then
    fail "$label failure leaked key or recipient material"
  fi
}

assert_budget_exhaustion_resumes() {
  local budget_case
  budget_case="$(make_backup_case publication-budget-exhaustion)"
  cp "$budget_case/backups/state/local-last-success.env" "$budget_case/old-marker"
  if PATH="$work/bin:$PATH" TEST_TIMEOUT_EXHAUST=1 \
    TEST_TIMEOUT_STATE="$budget_case/timeout-state" \
    TEST_RUNNING_STATE="$budget_case/running-state" \
    BACKUP_CONFIG_FILE="$budget_case/backup.env" \
    bash "$repo_root/scripts/backup/backup.sh" \
    >"$budget_case/stdout" 2>"$budget_case/log"; then
    fail "backup succeeded after the quiesce deadline was exhausted"
  fi
  cmp -s "$budget_case/old-marker" \
    "$budget_case/backups/state/local-last-success.env" \
    || fail "budget exhaustion changed the previous success marker"
  grep -Fq 'resume:app' "$budget_case/log" \
    || fail "budget exhaustion did not immediately attempt resume"
  if grep -Eq 'phase=(files_published|marker_committed|pruning|complete)' \
    "$budget_case/log"; then
    fail "budget exhaustion continued into publication"
  fi
  [[ "$(find "$budget_case/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.age' | wc -l | tr -d ' ')" == 1 ]]
}

assert_preflight_failure() {
  local label="$1" case_root="$2" archive_count
  shift 2
  cp "$case_root/backups/state/local-last-success.env" "$case_root/old-marker"
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$repo_root/scripts/backup/backup.sh" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup accepted unsafe preflight fixture: $label"
  fi
  cmp -s "$case_root/old-marker" "$case_root/backups/state/local-last-success.env" \
    || fail "$label preflight failure changed the previous success marker"
  archive_count="$(find "$case_root/backups/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')"
  [[ "$archive_count" == 1 ]] || fail "$label preflight failure left a candidate final archive"
  [[ -z "$(find "$case_root/backups" -type f -name '.*.tmp.*' -print -quit)" ]] \
    || fail "$label preflight failure left a publication temporary"
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" -mindepth 1 -print -quit)" ]] \
    || fail "$label preflight failure left plaintext or ephemeral key material"
  if grep -Eq '(^|[[:space:]])(quiesce|dump)$|phase=(quiesced|dump_complete|marker_committed|pruning|complete)' \
    "$case_root/log"; then
    fail "$label preflight failure crossed the snapshot/publication boundary"
  fi
}

assert_rejected_directory_was_not_chmodded() {
  local label="$1" case_root="$2" watched_path="$3" mutation_file="$4"
  shift 4
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_WATCH_CHMOD_PATH="$watched_path" \
    TEST_CHMOD_MUTATION_FILE="$mutation_file" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$repo_root/scripts/backup/backup.sh" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup accepted unsafe directory fixture: $label"
  fi
  [[ ! -e "$mutation_file" ]] \
    || fail "$label was chmodded before its ownership/canonical safety was validated"
  if grep -Eq '(^|[[:space:]])(quiesce|dump)$|phase=(quiesced|dump_complete|marker_committed|pruning|complete)' \
    "$case_root/log"; then
    fail "$label crossed the snapshot/publication boundary"
  fi
}

if [[ "$test_group" == all || "$test_group" == m7-directory-safety ]]; then
  unsafe_owner_case="$(make_backup_case publication-unsafe-directory-owner)"
  assert_rejected_directory_was_not_chmodded unsafe-directory-owner \
    "$unsafe_owner_case" "$unsafe_owner_case/backups/full" \
    "$unsafe_owner_case/chmod-mutation" \
    TEST_UNSAFE_DIRECTORY_PATH="$unsafe_owner_case/backups/full"

  alias_case="$(make_backup_case publication-noncanonical-directory-alias)"
  mkdir -p -- "$alias_case/alias-parent"
  chmod 0700 -- "$alias_case/alias-parent"
  alias_stage="$alias_case/alias-parent/../stage"
  sed -i "s|^BACKUP_STAGE_ROOT=.*|BACKUP_STAGE_ROOT=$alias_stage|" \
    "$alias_case/backup.env"
  assert_rejected_directory_was_not_chmodded noncanonical-directory-alias \
    "$alias_case" "$alias_stage" "$alias_case/chmod-mutation"
fi

if [[ "$test_group" == m7-directory-safety ]]; then
  echo "backup-publication-m7-directory-safety-tests-ok"
  exit 0
fi

if [[ "$test_group" == m6-production-canonical ]]; then
  canonical_repo_one="$work/production-canonical-release-one"
  canonical_repo_two="$work/production-canonical-release-two"
  cp -a -- "$fixture_repo" "$canonical_repo_one"
  cp -a -- "$fixture_repo" "$canonical_repo_two"
  [[ "$(git -C "$canonical_repo_one" rev-parse HEAD)" == \
    "$(git -C "$canonical_repo_two" rev-parse HEAD)" ]] \
    || fail "independent canonical repositories do not share the same commit"
  canonical_controller_one="$(make_backup_case production-canonical-one "$canonical_repo_one")"
  canonical_controller_two="$(make_backup_case production-canonical-two "$canonical_repo_two")"
  for canonical_case in "$canonical_controller_one" "$canonical_controller_two"; do
    if ! PATH="$work/bin:$PATH" TEST_FIXED_BACKUP_TIME=1 \
      TEST_RUNNING_STATE="$canonical_case/running-state" \
      BACKUP_CONFIG_FILE="$canonical_case/backup.env" \
      bash "$repo_root/scripts/backup/backup.sh" \
      >"$canonical_case/stdout" 2>"$canonical_case/log"; then
      sed -n '1,80p' "$canonical_case/log" >&2
      fail "production canonical controller fixture failed"
    fi
  done
  canonical_name_one="$(sed -n 's/^SUCCESS_ARCHIVE=//p' \
    "$canonical_controller_one/backups/state/local-last-success.env")"
  canonical_name_two="$(sed -n 's/^SUCCESS_ARCHIVE=//p' \
    "$canonical_controller_two/backups/state/local-last-success.env")"
  [[ "$canonical_name_one" == "$canonical_name_two" ]] \
    || fail "production canonical controller changed the fixed-input filename"
  cmp -s \
    "$canonical_controller_one/backups/full/$canonical_name_one" \
    "$canonical_controller_two/backups/full/$canonical_name_two" \
    || fail "production canonical packaging changed across backup/data roots"
  echo "backup-publication-m6-canonical-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == c1-key-exclusion ]]; then
  repository_key_case="$(make_backup_case publication-key-inside-repository)"
  repository_key_repo="$repository_key_case/release"
  cp -a -- "$fixture_repo" "$repository_key_repo"
  cp -- "$master_key" "$repository_key_repo/content/credential-master-key"
  chmod 0440 "$repository_key_repo/content/credential-master-key"
  sed -i \
    -e "s|^REPO_ROOT=.*|REPO_ROOT=$repository_key_repo|" \
    -e "s|^CREDENTIAL_MASTER_KEY_FILE=.*|CREDENTIAL_MASTER_KEY_FILE=$repository_key_repo/content/credential-master-key|" \
    "$repository_key_case/backup.env"
  assert_preflight_failure key-inside-repository "$repository_key_case"

  app_data_key_case="$(make_backup_case publication-key-inside-app-data)"
  cp -- "$master_key" "$app_data_key_case/data/app-data/credential-master-key"
  chmod 0440 "$app_data_key_case/data/app-data/credential-master-key"
  sed -i \
    "s|^CREDENTIAL_MASTER_KEY_FILE=.*|CREDENTIAL_MASTER_KEY_FILE=$app_data_key_case/data/app-data/credential-master-key|" \
    "$app_data_key_case/backup.env"
  assert_preflight_failure key-inside-app-data "$app_data_key_case"

  hardlink_key_case="$(make_backup_case publication-key-hardlink-in-app-data)"
  if ! ln -- "$master_key" "$hardlink_key_case/data/app-data/key-hardlink"; then
    fail "could not create the credential-key hardlink regression fixture"
  fi
  [[ "$(stat -c '%h' -- "$master_key")" -gt 1 ]] \
    || fail "credential-key hardlink fixture did not share an inode"
  assert_preflight_failure key-hardlink-in-app-data "$hardlink_key_case"
  rm -f -- "$hardlink_key_case/data/app-data/key-hardlink"
fi

if [[ "$test_group" == c1-key-exclusion ]]; then
  echo "backup-publication-c1-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m5-provenance ]]; then
  dirty_release_case="$(make_backup_case publication-dirty-release)"
  dirty_release_repo="$dirty_release_case/release"
  cp -a -- "$fixture_repo" "$dirty_release_repo"
  printf dirty >>"$dirty_release_repo/content/lesson.json"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$dirty_release_repo|" \
    "$dirty_release_case/backup.env"
  assert_preflight_failure dirty-reviewed-release "$dirty_release_case"

  untracked_release_case="$(make_backup_case publication-untracked-included-release)"
  untracked_release_repo="$untracked_release_case/release"
  cp -a -- "$fixture_repo" "$untracked_release_repo"
  printf unreviewed >"$untracked_release_repo/infra/untracked.conf"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$untracked_release_repo|" \
    "$untracked_release_case/backup.env"
  assert_preflight_failure untracked-included-release "$untracked_release_case"

  ignored_release_case="$(make_backup_case publication-ignored-included-release)"
  ignored_release_repo="$ignored_release_case/release"
  cp -a -- "$fixture_repo" "$ignored_release_repo"
  printf '%s\n' infra/ignored.conf >>"$ignored_release_repo/.git/info/exclude"
  printf ignored-but-packaged >"$ignored_release_repo/infra/ignored.conf"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$ignored_release_repo|" \
    "$ignored_release_case/backup.env"
  assert_preflight_failure ignored-untracked-included-release "$ignored_release_case"

  unknown_created_case="$(make_backup_case publication-unknown-created-service)"
  assert_preflight_failure unknown-stopped-created-service "$unknown_created_case" \
    TEST_UNKNOWN_CREATED_SERVICE=1
fi

if [[ "$test_group" == m5-provenance ]]; then
  echo "backup-publication-m5-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m1-transient-mutator ]]; then
  project_mismatch_case="$(make_backup_case publication-event-monitor-project-mismatch)"
  assert_preflight_failure event-monitor-project-mismatch "$project_mismatch_case" \
    TEST_COMPOSE_PROJECT_MISMATCH=1
fi

if [[ "$test_group" == all || "$test_group" == m1-transient-mutator \
  || "$test_group" == m8-stale-sentinels ]]; then
  for stale_rejection in bad-image bad-runtime-image running wrong-project \
    wrong-workdir wrong-service missing-token bad-phase missing-watchtower \
    true-watchtower; do
    stale_rejection_case="$(make_backup_case "publication-stale-sentinel-$stale_rejection")"
    assert_preflight_failure "stale-sentinel-$stale_rejection" "$stale_rejection_case" \
      TEST_STALE_SENTINEL="$stale_rejection" TEST_EVENT_REPO_ROOT="$fixture_repo"
    [[ ! -e "$stale_rejection_case/event-monitor/stale-removed" ]] \
      || fail "unsafe stale sentinel $stale_rejection was removed"
  done

  for stale_allowed in valid unrelated; do
    stale_allowed_case="$(make_backup_case "publication-stale-sentinel-$stale_allowed")"
    cp "$stale_allowed_case/backups/state/local-last-success.env" \
      "$stale_allowed_case/old-marker"
    if ! PATH="$work/bin:$PATH" \
      TEST_STALE_SENTINEL="$stale_allowed" TEST_EVENT_REPO_ROOT="$fixture_repo" \
      TEST_RUNNING_STATE="$stale_allowed_case/running-state" \
      BACKUP_CONFIG_FILE="$stale_allowed_case/backup.env" \
      bash "$repo_root/scripts/backup/backup.sh" \
      >"$stale_allowed_case/stdout" 2>"$stale_allowed_case/log"; then
      sed -n '1,100p' "$stale_allowed_case/log" >&2
      fail "backup rejected $stale_allowed stale-sentinel reconciliation"
    fi
    if cmp -s "$stale_allowed_case/old-marker" \
      "$stale_allowed_case/backups/state/local-last-success.env"; then
      fail "$stale_allowed stale-sentinel reconciliation did not commit"
    fi
    if [[ "$stale_allowed" == valid ]]; then
      [[ -s "$stale_allowed_case/event-monitor/stale-removed" ]] \
        || fail "exact stale sentinel was not removed"
    else
      [[ -s "$stale_allowed_case/event-monitor/unrelated-filtered" \
        && ! -e "$stale_allowed_case/event-monitor/stale-removed" ]] \
        || fail "unrelated sentinel was not filtered without removal"
    fi
    if find "$stale_allowed_case/event-monitor" -maxdepth 1 -type f \
      -regextype posix-extended -regex '.*/[0-9a-f]{64}' -print -quit | grep -q .; then
      fail "$stale_allowed stale-sentinel run accumulated a sentinel container"
    fi
  done

  if [[ "$test_group" == m8-stale-sentinels ]]; then
    echo "backup-publication-m8-stale-sentinel-tests-ok"
    exit 0
  fi

  for event_failure in overflow-mutator monitor-loss postgres-restart \
    boundary-object boundary-publication; do
    assert_precommit_failure "event-monitor-$event_failure" true \
      TEST_EVENT_SCENARIO="$event_failure" TEST_EVENT_REPO_ROOT="$fixture_repo"
  done

  for allowed_event in unrelated-project clamav-restart; do
    allowed_case="$(make_backup_case "publication-event-monitor-$allowed_event")"
    cp "$allowed_case/backups/state/local-last-success.env" "$allowed_case/old-marker"
    if ! PATH="$work/bin:$PATH" \
      TEST_EVENT_SCENARIO="$allowed_event" TEST_EVENT_REPO_ROOT="$fixture_repo" \
      TEST_RUNNING_STATE="$allowed_case/running-state" \
      BACKUP_CONFIG_FILE="$allowed_case/backup.env" \
      bash "$repo_root/scripts/backup/backup.sh" \
      >"$allowed_case/stdout" 2>"$allowed_case/log"; then
      sed -n '1,100p' "$allowed_case/log" >&2
      fail "event monitor rejected allowed $allowed_event activity"
    fi
    if cmp -s "$allowed_case/old-marker" \
      "$allowed_case/backups/state/local-last-success.env"; then
      fail "allowed $allowed_event activity did not commit a recovery point"
    fi
    grep -Fq 'phase=marker_committed' "$allowed_case/log" \
      || fail "allowed $allowed_event activity did not cross the marker boundary"
    [[ -z "$(find "$allowed_case/stage" "$allowed_case/runtime" \
      -mindepth 1 -print -quit)" ]] \
      || fail "allowed $allowed_event activity left protected temporary material"
  done
fi

if [[ "$test_group" == m1-transient-mutator ]]; then
  echo "backup-publication-m1-event-monitor-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m2-post-effect-renames ]]; then
  assert_precommit_failure archive-rename-post-effect true \
    TEST_ARCHIVE_RENAME_POST_EFFECT_FAIL=1
  assert_precommit_failure sidecar-rename-post-effect true \
    TEST_SIDECAR_RENAME_POST_EFFECT_FAIL=1
fi

if [[ "$test_group" == m2-post-effect-renames ]]; then
  echo "backup-publication-m2-tests-ok"
  exit 0
fi

assert_marker_post_effect_preserved() {
  local label="$1" case_root effect_file marker_name marker_hash
  local resume_line alert_line
  shift
  case_root="$(make_backup_case "publication-marker-$label")"
  cp "$case_root/backups/state/local-last-success.env" "$case_root/old-marker"
  effect_file="$case_root/marker-effect"
  if /usr/bin/env PATH="$work/bin:$PATH" \
    TEST_MARKER_EFFECT_RECORDED="$effect_file" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$case_root/running-state" \
    BACKUP_CONFIG_FILE="$case_root/backup.env" "$@" \
    bash "$repo_root/scripts/backup/backup.sh" \
    >"$case_root/stdout" 2>"$case_root/log"; then
    fail "backup reported success after marker $label uncertainty"
  fi
  [[ -s "$effect_file" ]] \
    || fail "marker $label fixture did not perform the authoritative rename"
  if cmp -s "$case_root/old-marker" \
    "$case_root/backups/state/local-last-success.env"; then
    fail "marker $label uncertainty rolled back the committed marker"
  fi
  marker_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' \
    "$case_root/backups/state/local-last-success.env")"
  marker_hash="$(sed -n 's/^SUCCESS_SHA256=//p' \
    "$case_root/backups/state/local-last-success.env")"
  [[ "$marker_name" =~ ^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ \
    && "$marker_hash" =~ ^[0-9a-f]{64}$ \
    && -f "$case_root/backups/full/$marker_name" \
    && -f "$case_root/backups/full/$marker_name.sha256" ]] \
    || fail "marker $label uncertainty orphaned the committed recovery point"
  [[ "$(<"$case_root/backups/full/$marker_name.sha256")" == \
    "$marker_hash  $marker_name" ]] \
    || fail "marker $label uncertainty changed the committed sidecar"
  grep -Fq 'resume:app' "$case_root/log" \
    || fail "marker $label uncertainty did not resume the captured app"
  resume_line="$(grep -n -m1 'resume:app' "$case_root/log" | cut -d: -f1)"
  alert_line="$(grep -n -m1 'event=backup_post_commit_failed' "$case_root/log" \
    | cut -d: -f1)"
  [[ "$resume_line" =~ ^[0-9]+$ && "$alert_line" =~ ^[0-9]+$ \
    && "$resume_line" -lt "$alert_line" ]] \
    || fail "marker $label uncertainty did not resume before reconciliation reporting"
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" \
    -mindepth 1 -print -quit)" ]] \
    || fail "marker $label uncertainty left plaintext or ephemeral material"
}

if [[ "$test_group" == all || "$test_group" == m2-marker-window ]]; then
  assert_marker_post_effect_preserved directory-sync-failure \
    TEST_MARKER_DIRECTORY_SYNC_FAIL=1
  assert_marker_post_effect_preserved signal-after-rename \
    TEST_MARKER_SIGNAL_AFTER_EFFECT=1
fi

if [[ "$test_group" == m2-marker-window ]]; then
  echo "backup-publication-m2-marker-window-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m10-marker-monitor ]]; then
  for marker_window_service in lifecycle postgres; do
    assert_precommit_failure "marker-monitor-$marker_window_service" true \
      TEST_MARKER_WINDOW_EVENT_SERVICE="$marker_window_service" \
      TEST_EVENT_REPO_ROOT="$fixture_repo"
  done
fi

if [[ "$test_group" == m10-marker-monitor ]]; then
  echo "backup-publication-m10-marker-monitor-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m3-hard-deadline ]]; then
inode_deadline_case="$(make_backup_case publication-inode-scan-first-resume-deadline)"
cp "$inode_deadline_case/backups/state/local-last-success.env" \
  "$inode_deadline_case/old-marker"
if PATH="$work/bin:$PATH" \
  TEST_INODE_SCAN_TERM_IGNORING_CHILD=1 \
  TEST_BLOCK_CANDIDATE_CLEANUP=1 \
  TEST_HUNG_CHILD_STARTED="$inode_deadline_case/hung-child-started" \
  TEST_FIRST_RESUME_EVENT="$inode_deadline_case/first-resume-event" \
  TEST_TIMEOUT_GRACE_VIOLATION="$inode_deadline_case/timeout-grace-violation" \
  TEST_EVENT_REPO_ROOT="$fixture_repo" \
  TEST_RUNNING_STATE="$inode_deadline_case/running-state" \
  BACKUP_CONFIG_FILE="$inode_deadline_case/backup.env" \
  bash "$repo_root/scripts/backup/backup.sh" \
  >"$inode_deadline_case/stdout" 2>"$inode_deadline_case/log"; then
  fail "backup succeeded after the credential-key inode scan ignored TERM"
fi
[[ -s "$inode_deadline_case/hung-child-started" \
  && -s "$inode_deadline_case/first-resume-event" ]] \
  || fail "inode-deadline fixture did not record the hung scan and first resume"
[[ ! -e "$inode_deadline_case/timeout-grace-violation" ]] \
  || fail "inode scan received a timeout outside the 600-second ceiling"
node - "$inode_deadline_case/hung-child-started" \
  "$inode_deadline_case/first-resume-event" <<'EOF'
const fs = require("node:fs");
const [startedPath, resumedPath] = process.argv.slice(2);
const started = BigInt(fs.readFileSync(startedPath, "utf8").trim());
const resumed = BigInt(fs.readFileSync(resumedPath, "utf8").trim());
if (resumed < started || resumed - started > 2_000_000_000n) process.exit(1);
EOF
cmp -s "$inode_deadline_case/old-marker" \
  "$inode_deadline_case/backups/state/local-last-success.env" \
  || fail "inode-deadline failure changed the previous success marker"
grep -Fq 'resume:app' "$inode_deadline_case/log" \
  || fail "inode-deadline failure did not attempt app resume"
[[ "$(find "$inode_deadline_case/backups/full" -maxdepth 1 -type f \
  -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')" == 1 ]] \
  || fail "inode-deadline failure left a candidate final archive"
[[ -z "$(find "$inode_deadline_case/stage" "$inode_deadline_case/runtime" \
  -mindepth 1 -print -quit)" ]] \
  || fail "inode-deadline failure left plaintext or ephemeral key material"

hard_deadline_case="$(make_backup_case publication-hard-first-resume-deadline)"
cp "$hard_deadline_case/backups/state/local-last-success.env" \
  "$hard_deadline_case/old-marker"
if PATH="$work/bin:$PATH" \
  TEST_LATE_TERM_IGNORING_CHILD=1 \
  TEST_BLOCK_CANDIDATE_CLEANUP=1 \
  TEST_HUNG_CHILD_STARTED="$hard_deadline_case/hung-child-started" \
  TEST_FIRST_RESUME_EVENT="$hard_deadline_case/first-resume-event" \
  TEST_TIMEOUT_GRACE_VIOLATION="$hard_deadline_case/timeout-grace-violation" \
  TEST_RUNNING_STATE="$hard_deadline_case/running-state" \
  BACKUP_CONFIG_FILE="$hard_deadline_case/backup.env" \
  bash "$repo_root/scripts/backup/backup.sh" \
  >"$hard_deadline_case/stdout" 2>"$hard_deadline_case/log"; then
  fail "backup succeeded after a late-stage TERM-ignoring child exceeded its command budget"
fi
[[ -s "$hard_deadline_case/hung-child-started" \
  && -s "$hard_deadline_case/first-resume-event" ]] \
  || fail "hard-deadline fixture did not record the hung child and first resume"
if [[ -e "$hard_deadline_case/timeout-grace-violation" ]]; then
  fail "deadline passed kill grace outside the 600-second ceiling"
fi
node - "$hard_deadline_case/hung-child-started" \
  "$hard_deadline_case/first-resume-event" <<'EOF'
const fs = require("node:fs");
const [startedPath, resumedPath] = process.argv.slice(2);
const started = BigInt(fs.readFileSync(startedPath, "utf8").trim());
const resumed = BigInt(fs.readFileSync(resumedPath, "utf8").trim());
if (resumed < started || resumed - started > 2_000_000_000n) process.exit(1);
EOF
cmp -s "$hard_deadline_case/old-marker" \
  "$hard_deadline_case/backups/state/local-last-success.env" \
  || fail "hard-deadline failure changed the previous success marker"
grep -Fq 'resume:app' "$hard_deadline_case/log" \
  || fail "hard-deadline failure did not attempt app resume"
[[ "$(find "$hard_deadline_case/backups/full" -maxdepth 1 -type f \
  -name 'learncoding-full-*.tar.gz.age' | wc -l | tr -d ' ')" == 1 ]] \
  || fail "hard-deadline failure left a candidate final archive"
[[ -z "$(find "$hard_deadline_case/stage" "$hard_deadline_case/runtime" \
  -mindepth 1 -print -quit)" ]] \
  || fail "hard-deadline failure left plaintext or ephemeral key material"
fi

if [[ "$test_group" == m3-hard-deadline ]]; then
  echo "backup-publication-m3-tests-ok"
  exit 0
fi

if [[ "$test_group" == m3-budget-exhaustion ]]; then
  assert_budget_exhaustion_resumes
  echo "backup-publication-m3-budget-exhaustion-tests-ok"
  exit 0
fi

if [[ "$test_group" == all || "$test_group" == m9-bounded-event-audit ]]; then
  audit_deadline_case="$(make_backup_case publication-event-audit-deadline)"
  cp "$audit_deadline_case/backups/state/local-last-success.env" \
    "$audit_deadline_case/old-marker"
  if PATH="$work/bin:$PATH" \
    TEST_EVENT_AUDIT_TERM_IGNORING_CHILD=1 \
    TEST_EVENT_AUDIT_TIMEOUT_STATE="$audit_deadline_case/audit-timeout-state" \
    TEST_BLOCK_CANDIDATE_CLEANUP=1 \
    TEST_HUNG_CHILD_STARTED="$audit_deadline_case/hung-child-started" \
    TEST_FIRST_RESUME_EVENT="$audit_deadline_case/first-resume-event" \
    TEST_TIMEOUT_GRACE_VIOLATION="$audit_deadline_case/timeout-grace-violation" \
    TEST_TIMEOUT_DEBUG_FILE="$audit_deadline_case/timeout-debug" \
    TEST_EVENT_REPO_ROOT="$fixture_repo" \
    TEST_RUNNING_STATE="$audit_deadline_case/running-state" \
    BACKUP_CONFIG_FILE="$audit_deadline_case/backup.env" \
    bash "$repo_root/scripts/backup/backup.sh" \
    >"$audit_deadline_case/stdout" 2>"$audit_deadline_case/log"; then
    fail "backup succeeded when the bounded event audit ignored TERM"
  fi
  if [[ ! -s "$audit_deadline_case/hung-child-started" \
    || ! -s "$audit_deadline_case/first-resume-event" ]]; then
    sed -n '1,160p' "$audit_deadline_case/log" >&2
    find "$audit_deadline_case/event-monitor" -maxdepth 1 -type f \
      -print -exec sed -n '1,80p' {} \; >&2 2>/dev/null || true
    sed -n '1,120p' "$audit_deadline_case/timeout-debug" >&2 2>/dev/null || true
    fail "event-audit deadline fixture omitted the hung audit or first resume"
  fi
  [[ ! -e "$audit_deadline_case/timeout-grace-violation" ]] \
    || fail "event audit received a timeout outside the 600-second ceiling"
  node - "$audit_deadline_case/hung-child-started" \
    "$audit_deadline_case/first-resume-event" <<'EOF'
const fs = require("node:fs");
const [startedPath, resumedPath] = process.argv.slice(2);
const started = BigInt(fs.readFileSync(startedPath, "utf8").trim());
const resumed = BigInt(fs.readFileSync(resumedPath, "utf8").trim());
if (resumed < started || resumed - started > 2_000_000_000n) process.exit(1);
EOF
  cmp -s "$audit_deadline_case/old-marker" \
    "$audit_deadline_case/backups/state/local-last-success.env" \
    || fail "event-audit deadline failure changed the previous success marker"
  grep -Fq 'resume:app' "$audit_deadline_case/log" \
    || fail "event-audit deadline failure did not attempt app resume first"

  assert_precommit_failure event-audit-oversized true \
    TEST_EVENT_SCENARIO=oversized-log TEST_EVENT_REPO_ROOT="$fixture_repo"
fi

if [[ "$test_group" == m9-bounded-event-audit ]]; then
  echo "backup-publication-m9-bounded-event-audit-tests-ok"
  exit 0
fi

for controller_mutation in outer-list unsafe-path unsafe-type internal-checksum manifest; do
  assert_precommit_failure "controller-$controller_mutation" true \
    TEST_CONTROLLER_ENVELOPE_MUTATION="$controller_mutation" \
    TEST_ENVELOPE_MUTATOR="$work/bin/mutate-envelope"
done

if [[ "$test_group" == m6-controller-verifier-failures ]]; then
  echo "backup-publication-m6-controller-tests-ok"
  exit 0
fi

success_case="$(make_backup_case publication-success)"
if ! PATH="$work/bin:$PATH" TEST_CREATED_OPTIONAL_SERVICE=lifecycle \
  TEST_RUNNING_STATE="$success_case/running-state" \
  BACKUP_CONFIG_FILE="$success_case/backup.env" \
  bash "$repo_root/scripts/backup/backup.sh" >"$success_case/stdout" 2>"$success_case/log"; then
  sed -n '1,80p' "$success_case/log" >&2
  fail "valid full publication fixture failed"
fi
for phase in quiesced dump_complete objects_complete encrypted candidate_verified \
  files_published marker_committed pruning resuming resumed; do
  [[ -n "$(phase_line "$phase" "$success_case/log")" ]] \
    || fail "successful publication omitted phase=$phase"
done
previous=0
for phase in quiesced dump_complete objects_complete encrypted candidate_verified \
  files_published marker_committed pruning resuming resumed; do
  current="$(phase_line "$phase" "$success_case/log")"
  (( current > previous )) || fail "successful publication phase order is unsafe"
  previous="$current"
done
success_marker="$success_case/backups/state/local-last-success.env"
success_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' "$success_marker")"
success_hash="$(sed -n 's/^SUCCESS_SHA256=//p' "$success_marker")"
[[ "$success_name" =~ ^learncoding-full-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]]
[[ "$success_hash" == "$(sha256sum "$success_case/backups/full/$success_name" | awk '{print $1}')" ]]
[[ -f "$success_case/backups/full/$success_name.sha256" ]]
[[ "$(<"$success_case/backups/full/$success_name.sha256")" == "$success_hash  $success_name" ]] \
  || fail "successful publication wrote a noncanonical ciphertext sidecar"
if [[ "${OSTYPE:-}" != msys* ]]; then
  [[ "$(stat -c '%a' "$success_marker")" == 600 ]]
  [[ "$(stat -c '%a' "$success_case/backups/full/$success_name")" == 600 ]]
  [[ "$(stat -c '%a' "$success_case/backups/full/$success_name.sha256")" == 600 ]]
fi
[[ -z "$(find "$success_case/stage" "$success_case/runtime" -mindepth 1 -print -quit)" ]]
grep -Fq 'resume:cloudflared' "$success_case/log" \
  || fail "cloudflared was not resumed last"
if grep -Eq 'resume:(postgres|reward-worker|regrade-worker|mail-worker)' "$success_case/log"; then
  fail "successful publication resumed a service absent from the captured set"
fi
[[ "$(grep -c '^resume:' "$success_case/log")" == 2 ]] \
  || fail "successful publication did not resume exactly the captured set"
if grep -Eq 'stop.*postgres|offsite-sync' "$success_case/log"; then
  fail "successful publication stopped PostgreSQL or invoked offsite sync"
fi

for conflicting_service in migrate lifecycle platform-seed admin-bootstrap unknown-service; do
  conflict_case="$(make_backup_case "publication-conflict-$conflicting_service")"
  cp "$conflict_case/backups/state/local-last-success.env" "$conflict_case/old-marker"
  if PATH="$work/bin:$PATH" \
    TEST_RUNNING_SERVICES="postgres app $conflicting_service cloudflared" \
    TEST_RUNNING_STATE="$conflict_case/running-state" \
    BACKUP_CONFIG_FILE="$conflict_case/backup.env" \
    bash "$repo_root/scripts/backup/backup.sh" \
    >"$conflict_case/stdout" 2>"$conflict_case/log"; then
    fail "backup accepted running conflict $conflicting_service"
  fi
  cmp -s "$conflict_case/old-marker" "$conflict_case/backups/state/local-last-success.env" \
    || fail "$conflicting_service conflict changed the previous success marker"
  if grep -Fxq dump "$conflict_case/log"; then
    fail "$conflicting_service conflict reached the database dump"
  fi
done

race_case="$(make_backup_case publication-mutator-race)"
cp "$race_case/backups/state/local-last-success.env" "$race_case/old-marker"
if PATH="$work/bin:$PATH" TEST_NEW_MUTATOR_AFTER_CAPTURE=1 \
  TEST_RUNNING_QUERY_STATE="$race_case/running-query-state" \
  BACKUP_CONFIG_FILE="$race_case/backup.env" \
  bash "$repo_root/scripts/backup/backup.sh" >"$race_case/stdout" 2>"$race_case/log"; then
  fail "backup accepted a mutator that started after running-set capture"
fi
cmp -s "$race_case/old-marker" "$race_case/backups/state/local-last-success.env" \
  || fail "mutator-race failure changed the previous success marker"
if grep -Fxq dump "$race_case/log"; then
  fail "mutator-race failure reached the database dump"
fi

assert_precommit_failure repository-packaging false TEST_REPOSITORY_TAR_FAIL=1
assert_precommit_failure probe false TEST_PROBE_FAIL=1
assert_precommit_failure quiesce true TEST_QUIESCE_FAIL=1
assert_precommit_failure migration-query true TEST_MIGRATION_FAIL=1
assert_precommit_failure dump true TEST_DUMP_FAIL=1
assert_precommit_failure object-packaging true TEST_APP_TAR_FAIL=1
assert_precommit_failure encryption true TEST_AGE_ENCRYPT_FAIL=1
assert_precommit_failure decryption true TEST_AGE_DECRYPT_FAIL=1
assert_precommit_failure sidecar-creation true TEST_SIDECAR_CREATE_FAIL=1
assert_precommit_failure archive-rename true TEST_ARCHIVE_RENAME_FAIL=1
assert_precommit_failure sidecar-rename true TEST_FULL_SIDECAR_RENAME_FAIL=1
assert_precommit_failure marker-write true TEST_MARKER_RENAME_FAIL=1

assert_budget_exhaustion_resumes

prune_case="$(make_backup_case publication-prune-failure)"
cp "$prune_case/backups/state/local-last-success.env" "$prune_case/old-marker"
if PATH="$work/bin:$PATH" TEST_PRUNE_FAIL=1 \
  TEST_RUNNING_STATE="$prune_case/running-state" \
  BACKUP_CONFIG_FILE="$prune_case/backup.env" \
  bash "$repo_root/scripts/backup/backup.sh" >"$prune_case/stdout" 2>"$prune_case/log"; then
  fail "backup reported success after post-marker prune failure"
fi
if cmp -s "$prune_case/old-marker" "$prune_case/backups/state/local-last-success.env"; then
  fail "post-marker prune failure rolled back the valid publication"
fi
prune_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' "$prune_case/backups/state/local-last-success.env")"
[[ -f "$prune_case/backups/full/$prune_name" \
  && -f "$prune_case/backups/full/$prune_name.sha256" ]] \
  || fail "post-marker prune failure removed the committed recovery point"
grep -Fq 'resume:app' "$prune_case/log" \
  || fail "post-marker prune failure did not resume the captured app"
grep -Fq 'event=backup_post_commit_failed' "$prune_case/log" \
  || fail "post-marker prune failure omitted the fixed post-commit alert"

resume_case="$(make_backup_case publication-resume-failure)"
cp "$resume_case/backups/state/local-last-success.env" "$resume_case/old-marker"
if PATH="$work/bin:$PATH" TEST_RESUME_FAIL=1 \
  TEST_RUNNING_STATE="$resume_case/running-state" \
  BACKUP_CONFIG_FILE="$resume_case/backup.env" \
  bash "$repo_root/scripts/backup/backup.sh" >"$resume_case/stdout" 2>"$resume_case/log"; then
  fail "backup reported success after resume failure"
fi
if cmp -s "$resume_case/old-marker" "$resume_case/backups/state/local-last-success.env"; then
  fail "post-marker resume failure rolled back the valid publication"
fi
resume_name="$(sed -n 's/^SUCCESS_ARCHIVE=//p' "$resume_case/backups/state/local-last-success.env")"
[[ -f "$resume_case/backups/full/$resume_name" && -f "$resume_case/backups/full/$resume_name.sha256" ]]

# The probe package command writes a sealed, reopenable schema without storing
# the random plaintext, and safely replaces only regular outputs.
probe_key="$work/probe-master-key"
node -e "process.stdout.write(Buffer.alloc(32, 7).toString('base64'))" >"$probe_key"
chmod 0440 "$probe_key"
probe_output="$work/credential-probe.json"
probe_log="$(cd "$repo_root" && npm run --silent backup:credential-probe -- "$probe_output" "$probe_key")"
[[ "$probe_log" == credential_probe_created=true ]] \
  || fail "credential probe emitted a noncanonical result"
cp "$probe_output" "$work/first-credential-probe.json"
probe_log="$(cd "$repo_root" && npm run --silent backup:credential-probe -- "$probe_output" "$probe_key")"
[[ "$probe_log" == credential_probe_created=true ]] \
  || fail "credential probe atomic replacement emitted a noncanonical result"
if cmp -s "$work/first-credential-probe.json" "$probe_output"; then
  fail "credential probe replacement reused random plaintext"
fi
[[ -z "$(find "$work" -maxdepth 1 -type f \
  -name '.credential-probe.json.tmp.*' -print -quit)" ]] \
  || fail "credential probe replacement left a temporary"
if [[ "${OSTYPE:-}" != msys* ]]; then
  [[ "$(stat -c '%a' "$probe_output")" == 600 ]] \
    || fail "credential probe output mode is not 0600"
fi
node --import tsx --input-type=module - "$probe_output" "$probe_key" <<'EOF'
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import credentialVault from "./src/lib/security/credential-vault.ts";

const { openCredential, parseMasterKey } = credentialVault;

const [outputPath, keyPath] = process.argv.slice(2);
const value = JSON.parse(await readFile(outputPath, "utf8"));
const expectedKeys = ["context", "plaintextSha256", "sealed", "version"];
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) process.exit(2);
if ("plaintext" in value || value.version !== 1) process.exit(3);
const expectedContext = {
  credentialId: "00000000-0000-4000-8000-000000000001",
  userId: "backup-recovery-probe",
  provider: "nvidia_nim",
  keyVersion: 1,
};
if (JSON.stringify(value.context) !== JSON.stringify(expectedContext)) process.exit(5);
const expectedSealedKeys = [
  "authTag", "ciphertext", "dataIv", "keyVersion", "lastFour", "wrapIv", "wrappedDataKey",
];
if (JSON.stringify(Object.keys(value.sealed).sort()) !== JSON.stringify(expectedSealedKeys)) process.exit(6);
if (!/^[0-9a-f]{64}$/.test(value.plaintextSha256) || value.sealed.keyVersion !== 1) process.exit(7);
const master = parseMasterKey((await readFile(keyPath, "utf8")).trim());
try {
  const plaintext = openCredential(value.sealed, value.context, master);
  const actual = createHash("sha256").update(plaintext, "utf8").digest("hex");
  if (actual !== value.plaintextSha256) process.exit(4);
  if (!/^[A-Za-z0-9_-]{43}$/.test(plaintext) || value.sealed.lastFour !== plaintext.slice(-4)) process.exit(8);
} finally {
  master.fill(0);
}
EOF

printf malformed >"$work/bad-probe-key"
chmod 0440 "$work/bad-probe-key"
if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
  "$work/bad-probe.json" "$work/bad-probe-key") >/dev/null 2>&1; then
  fail "credential probe accepted a malformed master key"
fi
[[ ! -e "$work/bad-probe.json" ]] || fail "failed credential probe left a partial output"

cp "$probe_output" "$work/probe-before-failed-replacement.json"
if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
  "$probe_output" "$work/bad-probe-key") >/dev/null 2>&1; then
  fail "credential probe replaced a valid output with a malformed-key result"
fi
cmp -s "$work/probe-before-failed-replacement.json" "$probe_output" \
  || fail "failed credential probe replacement changed the previous output"

mkdir "$work/probe-directory-output"
if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
  "$work/probe-directory-output" "$probe_key") >/dev/null 2>&1; then
  fail "credential probe accepted a directory output"
fi
[[ -d "$work/probe-directory-output" ]]

ln -s "$probe_key" "$work/probe-symlink-key"
if [[ -L "$work/probe-symlink-key" ]]; then
  if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
    "$work/probe-from-symlink-key.json" "$work/probe-symlink-key") >/dev/null 2>&1; then
    fail "credential probe accepted a symlinked master key"
  fi
  [[ ! -e "$work/probe-from-symlink-key.json" ]]
fi

printf sentinel >"$work/probe-symlink-target"
ln -s "$work/probe-symlink-target" "$work/probe-symlink-output"
if [[ -L "$work/probe-symlink-output" ]]; then
  if (cd "$repo_root" && npm run --silent backup:credential-probe -- \
    "$work/probe-symlink-output" "$probe_key") >/dev/null 2>&1; then
    fail "credential probe accepted a symlink output"
  fi
  [[ "$(cat "$work/probe-symlink-target")" == sentinel ]] \
    || fail "credential probe modified a symlink target"
else
  # Git Bash without Windows symlink privileges copies the target. The real
  # symlink assertion remains mandatory and unchanged on Ubuntu.
  rm -f -- "$work/probe-symlink-output"
fi

echo "backup-publication-tests-ok"
