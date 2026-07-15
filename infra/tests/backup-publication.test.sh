#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verifier="$repo_root/scripts/backup/verify-archive.sh"
probe="$repo_root/scripts/backup/create-credential-probe.ts"

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
    cp -- "$1" "$output"
    ;;
  --encrypt)
    [[ -n "$recipients" && -f "$recipients" ]] || exit 64
    [[ "${TEST_AGE_ENCRYPT_FAIL:-0}" != 1 ]] || exit 76
    cp -- "$1" "$output"
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
cat >"$work/bin/timeout" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_TIMEOUT_EXHAUST:-0}" == 1 ]]; then
  count=0
  [[ ! -f "$TEST_TIMEOUT_STATE" ]] || count="$(<"$TEST_TIMEOUT_STATE")"
  ((count += 1))
  printf '%s' "$count" >"$TEST_TIMEOUT_STATE"
  ((count < 2)) || exit 124
fi
exec /usr/bin/timeout "$@"
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
exec /usr/bin/mv "$@"
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
  "$work/bin/timeout" "$work/bin/tar" "$work/bin/mktemp" "$work/bin/mv" \
  "$work/bin/env"

# MSYS cannot represent the production 0640/0440 fixtures. This narrow adapter
# allows orchestration development only; the unchanged real-stat suite remains
# an Ubuntu acceptance gate.
if [[ "${OSTYPE:-}" == msys* ]]; then
  cat >"$work/bin/stat" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == *"%a"* ]]; then
  target="${@: -1}"
  case "$target" in
    */compose.env) printf '%s\n' 640; exit 0 ;;
    */credential-master-key) printf '%s\n' 440; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
EOF
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
  chmod 0755 "$work/bin/stat" "$work/bin/git" "$work/bin/hostname"
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
  printf runbook >"$root/docs/runbooks/restore.md"
  printf compose >"$root/compose.yaml"
  printf docker >"$root/Dockerfile"
  printf ignore >"$root/.dockerignore"
  tar -C "$root" -czf "$output" \
    .dockerignore Dockerfile compose.yaml content drizzle docs infra
  rm -rf -- "$root"
}

make_full_archive() {
  local output="$1" mutation="${2:-none}" stage
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
  esac

  write_checksums "$stage" full false
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
    tar -C "$stage" -czf "$output" \
      MANIFEST.txt SHA256SUMS credential-probe.json database.dump repository.tar.gz
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
  printf runbook >"$root/docs/runbooks/restore.md"
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
  nested-hardlink outer-reordered; do
  candidate="$work/full-$mutation.tar.gz.age"
  make_full_archive "$candidate" "$mutation"
  verify_failure "$candidate" "$work/verify-$mutation"
done

for mutation in mixed-schema bad-internal-checksum; do
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
if [[ "${1:-}" == inspect ]]; then
  printf 'sha256:%s\n' "$image_hash"
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
      for service in app cloudflared exam-finalization-worker mail-worker migrate postgres \
        practice-runner-recovery-worker project-review-correction-worker regrade-worker reward-worker; do
        printf '%s id-%s\n' "$service" "$service"
      done
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
    printf 'resume:%s\n' "${*: -1}" >&2
    [[ "${TEST_RESUME_FAIL:-0}" != 1 ]] || exit 76
    exit 0
    ;;
  exec)
    joined="$*"
    if [[ "$joined" == *pg_dump* ]]; then
      printf '%s\n' dump >&2
      [[ "${TEST_DUMP_FAIL:-0}" != 1 ]] || exit 77
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
  local case_name="$1" case_root marker old_name old_hash
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
REPO_ROOT=$fixture_repo
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
  local label="$1" expect_resume="$2" case_root archive_count
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
  [[ -z "$(find "$case_root/backups" -type f -name '.*.tmp.*' -print -quit)" ]] \
    || fail "$label failure left a publication or marker temporary"
  [[ -z "$(find "$case_root/stage" "$case_root/runtime" -mindepth 1 -print -quit)" ]] \
    || fail "$label failure left plaintext or ephemeral key material"
  if [[ "$expect_resume" == true ]]; then
    grep -Fq 'resume:app' "$case_root/log" \
      || fail "$label failure did not resume the captured app"
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

success_case="$(make_backup_case publication-success)"
if ! PATH="$work/bin:$PATH" TEST_RUNNING_STATE="$success_case/running-state" \
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

budget_case="$(make_backup_case publication-budget-exhaustion)"
cp "$budget_case/backups/state/local-last-success.env" "$budget_case/old-marker"
if PATH="$work/bin:$PATH" TEST_TIMEOUT_EXHAUST=1 \
  TEST_TIMEOUT_STATE="$budget_case/timeout-state" \
  TEST_RUNNING_STATE="$budget_case/running-state" \
  BACKUP_CONFIG_FILE="$budget_case/backup.env" \
  bash "$repo_root/scripts/backup/backup.sh" >"$budget_case/stdout" 2>"$budget_case/log"; then
  fail "backup succeeded after the quiesce deadline was exhausted"
fi
cmp -s "$budget_case/old-marker" "$budget_case/backups/state/local-last-success.env" \
  || fail "budget exhaustion changed the previous success marker"
grep -Fq 'resume:app' "$budget_case/log" || fail "budget exhaustion did not immediately attempt resume"
if grep -Eq 'phase=(files_published|marker_committed|pruning|complete)' "$budget_case/log"; then
  fail "budget exhaustion continued into publication"
fi
[[ "$(find "$budget_case/backups/full" -maxdepth 1 -type f -name 'learncoding-full-*.age' | wc -l | tr -d ' ')" == 1 ]]

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
