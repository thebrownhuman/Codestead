#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup="$repo_root/scripts/backup/emergency-backup.sh"
test_group="${EMERGENCY_BACKUP_TEST_GROUP:-all}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

mkdir -p "$work/bin" "$work/target/emergency" "$work/stage" "$work/runtime"
chmod 0700 "$work/target/emergency" "$work/stage" "$work/runtime"
printf '%s\n' LEARNCODING_EMERGENCY_V1 >"$work/target/.learncoding-backup-root"
chmod 0600 "$work/target/.learncoding-backup-root"
printf '%s\n' age1testrecipient >"$work/recipient.txt"
chmod 0600 "$work/recipient.txt"
printf '%s\n' APP_OPERATIONS_IMAGE=unused >"$work/compose.env"
chmod 0640 "$work/compose.env"

cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == compose ]] || exit 64
shift
while (($#)); do
  case "$1" in
    --env-file|-f) shift 2 ;;
    *) break ;;
  esac
done
[[ "${1:-}" == exec && "$*" == *pg_dump* ]] || exit 64
[[ "${TEST_DUMP_FAIL:-0}" != 1 ]] || exit 74
printf '%s' synthetic-postgres-custom-dump
EOF

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
    --output) output="$2"; shift 2 ;;
    --identity) identity="$2"; shift 2 ;;
    --recipients-file) recipients="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -n "$output" && $# -eq 1 ]] || exit 64
case "$mode" in
  --encrypt)
    [[ -f "$recipients" ]] || exit 64
    [[ "${TEST_AGE_ENCRYPT_FAIL:-0}" != 1 ]] || exit 76
    cp -- "$1" "$output"
    ;;
  --decrypt)
    printf '%s\n' decrypt >>"$TEST_AGE_EVENTS"
    [[ -f "$identity" ]] || exit 64
    if [[ -n "${TEST_EMERGENCY_DIR:-}" && -n "${TEST_EXPECT_FINAL_COUNT:-}" ]]; then
      actual="$(find "$TEST_EMERGENCY_DIR" -maxdepth 1 -type f -name 'learncoding-emergency-*.tar.gz.age' | wc -l | tr -d ' ')"
      [[ "$actual" == "$TEST_EXPECT_FINAL_COUNT" ]] || exit 78
    fi
    [[ "${TEST_AGE_DECRYPT_FAIL:-0}" != 1 ]] || exit 75
    if [[ "${TEST_BAD_MANIFEST:-0}" == 1 \
      || "${TEST_BAD_INTERNAL_CHECKSUM:-0}" == 1 \
      || "${TEST_UNSAFE_MEMBER:-0}" == 1 ]]; then
      mutation_dir="$(mktemp -d)"
      trap 'rm -rf -- "$mutation_dir"' EXIT
      tar -xzf "$1" -C "$mutation_dir"
      if [[ "${TEST_BAD_MANIFEST:-0}" == 1 ]]; then
        sed -i 's/contains_secret_files=false/contains_secret_files=true/' \
          "$mutation_dir/MANIFEST.txt"
      fi
      if [[ "${TEST_BAD_INTERNAL_CHECKSUM:-0}" == 1 ]]; then
        printf tampered >>"$mutation_dir/database.dump"
      fi
      members=(MANIFEST.txt SHA256SUMS database.dump recovery-config.tar.gz)
      if [[ "${TEST_UNSAFE_MEMBER:-0}" == 1 ]]; then
        printf unsafe >"$mutation_dir/unknown.member"
        members+=(unknown.member)
      fi
      tar -C "$mutation_dir" -czf "$output" "${members[@]}"
    else
      cp -- "$1" "$output"
    fi
    ;;
  *) exit 64 ;;
esac
EOF

cat >"$work/bin/age-keygen" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -y && -f "${2:-}" ]]; then
  printf '%s\n' age1ephemeraltestrecipient
  exit 0
fi
[[ "${1:-}" == -o && -n "${2:-}" ]] || exit 64
printf '%s\n' AGE-SECRET-KEY-TEST-ONLY >"$2"
chmod 0600 "$2"
EOF

cat >"$work/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_CHECKSUM_CREATE_FAIL:-0}" == 1 \
  && " $* " == *" --text "* ]]; then
  exit 73
fi
exec /usr/bin/sha256sum "$@"
EOF

cat >"$work/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_ARCHIVE_RENAME_POST_EFFECT_FAIL:-0}" == 1 \
  && "${@: -1}" == *.tar.gz.age ]]; then
  /usr/bin/mv "$@"
  exit 75
fi
if [[ "${TEST_SIDECAR_RENAME_POST_EFFECT_FAIL:-0}" == 1 \
  && "${@: -1}" == *.tar.gz.age.sha256 ]]; then
  /usr/bin/mv "$@"
  exit 74
fi
if [[ "${TEST_SIDECAR_RENAME_FAIL:-0}" == 1 \
  && "${@: -1}" == *.tar.gz.age.sha256 ]]; then
  exit 74
fi
if [[ "${TEST_ARCHIVE_RENAME_FAIL:-0}" == 1 \
  && "${@: -1}" == *.tar.gz.age ]]; then
  exit 75
fi
exec /usr/bin/mv "$@"
EOF

cat >"$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work/bin/rmdir" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_CLEANUP_FAIL:-0}" == 1 ]]; then
  /usr/bin/rmdir "$@"
  exit 74
fi
exec /usr/bin/rmdir "$@"
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
chmod 0755 "$work/bin/docker" "$work/bin/age" "$work/bin/age-keygen" \
  "$work/bin/sha256sum" "$work/bin/mv" "$work/bin/flock" "$work/bin/rmdir" \
  "$work/bin/chmod"
cat >"$work/bin/stat" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${TEST_UNSAFE_DIRECTORY_PATH:-}" \
  && "${@: -1}" == "$TEST_UNSAFE_DIRECTORY_PATH" \
  && "$*" == *"%u"* ]]; then
  printf '%s\n' 2147483646
  exit 0
fi
if [[ "${OSTYPE:-}" == msys* \
  && "$*" == *"%a"* && "${@: -1}" == */compose.env ]]; then
  printf '%s\n' 640
  exit 0
fi
exec /usr/bin/stat "$@"
EOF
chmod 0755 "$work/bin/stat"

config="$work/backup.env"
cat >"$config" <<EOF
REPO_ROOT=$repo_root
COMPOSE_ENV_FILE=$work/compose.env
EMERGENCY_BACKUP_ROOT=$work/target
BACKUP_STAGE_ROOT=$work/stage
BACKUP_EPHEMERAL_ROOT=$work/runtime
BACKUP_LOCK_FILE=$work/backup.lock
AGE_RECIPIENT_FILE=$work/recipient.txt
LEARN_DATA_ROOT=$work/live-data
BACKUP_ROOT=$work/live-backups
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
EOF
chmod 0600 "$config"

assert_rejected_directory_was_not_chmodded() {
  local label="$1" config_file="$2" watched_path="$3" mutation_file="$4"
  shift 4
  if /usr/bin/env PATH="$work/bin:$PATH" TEST_AGE_EVENTS="$work/age-events" \
    TEST_WATCH_CHMOD_PATH="$watched_path" \
    TEST_CHMOD_MUTATION_FILE="$mutation_file" \
    BACKUP_CONFIG_FILE="$config_file" "$@" bash "$backup" \
    >"$work/$label.stdout" 2>"$work/$label.stderr"; then
    fail "emergency backup accepted unsafe directory fixture: $label"
  fi
  [[ ! -e "$mutation_file" ]] \
    || fail "$label was chmodded before its ownership/canonical safety was validated"
}

if [[ "$test_group" == all || "$test_group" == m7-directory-safety ]]; then
  assert_rejected_directory_was_not_chmodded unsafe-directory-owner \
    "$config" "$work/target/emergency" "$work/owner-chmod-mutation" \
    TEST_UNSAFE_DIRECTORY_PATH="$work/target/emergency"

  alias_config="$work/alias-backup.env"
  cp -- "$config" "$alias_config"
  mkdir -p -- "$work/alias-parent"
  chmod 0700 -- "$work/alias-parent"
  alias_stage="$work/alias-parent/../stage"
  sed -i "s|^BACKUP_STAGE_ROOT=.*|BACKUP_STAGE_ROOT=$alias_stage|" "$alias_config"
  assert_rejected_directory_was_not_chmodded noncanonical-directory-alias \
    "$alias_config" "$alias_stage" "$work/alias-chmod-mutation"
fi

if [[ "$test_group" == m7-directory-safety ]]; then
  echo "emergency-backup-m7-directory-safety-tests-ok"
  exit 0
fi

archive_count() {
  find "$work/target/emergency" -maxdepth 1 -type f \
    -name 'learncoding-emergency-*.tar.gz.age' | wc -l | tr -d ' '
}

assert_no_transient_material() {
  [[ -z "$(find "$work/stage" "$work/runtime" -mindepth 1 -print -quit)" ]] \
    || fail "emergency backup left plaintext or ephemeral key material"
  if find "$work/target/emergency" -maxdepth 1 -type f -name '.*.tmp.*' -print -quit | grep -q .; then
    fail "emergency backup left a publication temporary"
  fi
}

assert_emergency_failure() {
  local label="$1" expect_decrypt="$2" before before_sidecars after_sidecars
  shift 2
  before="$(archive_count)"
  before_sidecars="$(find "$work/target/emergency" -maxdepth 1 -type f \
    -name 'learncoding-emergency-*.tar.gz.age.sha256' | wc -l | tr -d ' ')"
  : >"$work/age-events"
  if /usr/bin/env PATH="$work/bin:$PATH" TEST_AGE_EVENTS="$work/age-events" \
    TEST_EMERGENCY_DIR="$work/target/emergency" TEST_EXPECT_FINAL_COUNT="$before" \
    BACKUP_CONFIG_FILE="$config" "$@" bash "$backup" \
    >"$work/$label.stdout" 2>"$work/$label.stderr"; then
    fail "emergency backup succeeded after injected $label failure"
  fi
  [[ "$(archive_count)" == "$before" ]] || fail "$label failure changed final archive count"
  after_sidecars="$(find "$work/target/emergency" -maxdepth 1 -type f \
    -name 'learncoding-emergency-*.tar.gz.age.sha256' | wc -l | tr -d ' ')"
  [[ "$after_sidecars" == "$before_sidecars" ]] || fail "$label failure left an orphan sidecar"
  assert_no_transient_material
  if [[ "$expect_decrypt" == true ]]; then
    grep -Fxq decrypt "$work/age-events" \
      || fail "$label failure occurred before decrypt validation was attempted"
  fi
  [[ ! -e "$work/target/state/local-last-success.env" ]]
  if grep -Fq "$(<"$work/recipient.txt")" "$work/$label.stderr" \
    || grep -Fq 'AGE-SECRET-KEY-' "$work/$label.stderr"; then
    fail "$label failure leaked recipient or identity material"
  fi
}

assert_emergency_failure dump false TEST_DUMP_FAIL=1
assert_emergency_failure checksum-creation false TEST_CHECKSUM_CREATE_FAIL=1
assert_emergency_failure encryption false TEST_AGE_ENCRYPT_FAIL=1
assert_emergency_failure decryption true TEST_AGE_DECRYPT_FAIL=1
assert_emergency_failure bad-manifest true TEST_BAD_MANIFEST=1
assert_emergency_failure bad-internal-checksum true TEST_BAD_INTERNAL_CHECKSUM=1
assert_emergency_failure unsafe-member true TEST_UNSAFE_MEMBER=1
assert_emergency_failure archive-rename true TEST_ARCHIVE_RENAME_FAIL=1
assert_emergency_failure sidecar-rename true TEST_SIDECAR_RENAME_FAIL=1
assert_emergency_failure archive-rename-post-effect true \
  TEST_ARCHIVE_RENAME_POST_EFFECT_FAIL=1
assert_emergency_failure sidecar-rename-post-effect true \
  TEST_SIDECAR_RENAME_POST_EFFECT_FAIL=1
assert_emergency_failure cleanup false TEST_AGE_ENCRYPT_FAIL=1 TEST_CLEANUP_FAIL=1

# Four old valid pairs prove a failed candidate cannot trigger keep-three.
for stamp in 20260710T010203Z 20260711T010203Z 20260712T010203Z 20260713T010203Z; do
  seeded="learncoding-emergency-$stamp.tar.gz.age"
  printf 'seed-%s' "$stamp" >"$work/target/emergency/$seeded"
  seeded_hash="$(sha256sum "$work/target/emergency/$seeded" | awk '{print $1}')"
  printf '%s  %s\n' "$seeded_hash" "$seeded" \
    >"$work/target/emergency/$seeded.sha256"
  chmod 0600 "$work/target/emergency/$seeded" \
    "$work/target/emergency/$seeded.sha256"
done
[[ "$(archive_count)" == 4 ]]
assert_emergency_failure bad-manifest-no-prune true TEST_BAD_MANIFEST=1
[[ "$(archive_count)" == 4 ]] || fail "failed emergency validation triggered pruning"

# A valid candidate is decrypt-verified before its final name appears, then
# and only then may keep-three retention run.
: >"$work/age-events"
if ! PATH="$work/bin:$PATH" TEST_AGE_EVENTS="$work/age-events" \
  TEST_EMERGENCY_DIR="$work/target/emergency" TEST_EXPECT_FINAL_COUNT=4 \
  BACKUP_CONFIG_FILE="$config" \
  bash "$backup" >"$work/success.stdout" 2>"$work/success.stderr"; then
  sed -n '1,80p' "$work/success.stderr" >&2
  fail "valid emergency publication fixture failed"
fi
grep -Fxq decrypt "$work/age-events" || fail "successful emergency backup skipped decrypt validation"
assert_no_transient_material
[[ "$(archive_count)" == 3 ]] || fail "successful emergency publication did not apply keep-three"

[[ ! -e "$work/target/state/local-last-success.env" ]]
if find "$work/target/emergency" -type f \( -name '*credential*' -o -name '*key*' \) -print -quit | grep -q .; then
  fail "emergency backup published credential recovery material"
fi
for archive in "$work/target/emergency"/*.tar.gz.age; do
  [[ -f "$archive.sha256" ]]
  if [[ "${OSTYPE:-}" != msys* ]]; then
    [[ "$(stat -c '%a' "$archive")" == 600 ]]
    [[ "$(stat -c '%a' "$archive.sha256")" == 600 ]]
  fi
done

echo "emergency-backup-atomicity-tests-ok"
