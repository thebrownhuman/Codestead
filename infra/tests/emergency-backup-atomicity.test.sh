#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup="${EMERGENCY_BACKUP_SCRIPT_UNDER_TEST:-$repo_root/scripts/backup/emergency-backup.sh}"
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

fixture_repo="$work/release"
mkdir -p "$fixture_repo/drizzle" "$fixture_repo/infra/env" \
  "$fixture_repo/infra/systemd" "$fixture_repo/docs/runbooks"
printf '%s' compose >"$fixture_repo/compose.yaml"
printf '%s' docker >"$fixture_repo/Dockerfile"
printf '%s' ignore >"$fixture_repo/.dockerignore"
printf '%s' migration >"$fixture_repo/drizzle/0000.sql"
printf '%s' env >"$fixture_repo/infra/env/production.example"
printf '%s' unit >"$fixture_repo/infra/systemd/backup.service"
printf '%s' deployment >"$fixture_repo/docs/deployment.md"
printf '%s' runbook >"$fixture_repo/docs/runbooks/restore.md"
printf '%s' reviewed-benign-material \
  >"$fixture_repo/docs/runbooks/recovery-material.txt"
git -C "$fixture_repo" init -q
git -C "$fixture_repo" config user.email backup-test@example.invalid
git -C "$fixture_repo" config user.name backup-test
git -C "$fixture_repo" add .
git -C "$fixture_repo" commit -qm fixture

master_key="$work/credential-master-key"
node -e "process.stdout.write(Buffer.alloc(32, 11).toString('base64'))" \
  >"$master_key"
chmod 0440 "$master_key"

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
if [[ "${TEST_MUTATE_REVIEWED_SOURCE_AFTER_DUMP:-0}" == 1 ]]; then
  printf '%s' live-unreviewed-mutation >>"${TEST_MUTATION_FILE:?}"
  printf '%s\n' mutated >"${TEST_MUTATION_OBSERVED:?}"
fi
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
if [[ "${TEST_STAGE_CHMOD_FAIL:-0}" == 1 ]]; then
  for argument in "$@"; do
    if [[ "$argument" == */stage/emergency.* \
      || "$argument" == */stage/emergency-verify.* \
      || "$argument" == */runtime/learncoding-emergency.* ]]; then
      exit 80
    fi
  done
fi
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
  && "$*" == *"%a"* ]]; then
  case "${@: -1}" in
    */compose.env) printf '%s\n' 640; exit 0 ;;
    */credential-master-key) printf '%s\n' 440; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
EOF
chmod 0755 "$work/bin/stat"

cat >"$work/bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
real_git=/usr/bin/git
[[ "${OSTYPE:-}" != msys* ]] || real_git=/mingw64/bin/git
if [[ " $* " == *" rev-parse --show-toplevel "* ]]; then
  value="$("$real_git" "$@")"
  [[ "${OSTYPE:-}" != msys* ]] || value="$(cygpath -u "$value")"
  if [[ "${TEST_GIT_TOPLEVEL_ALIAS:-0}" == 1 ]]; then
    printf '%s/../%s\n' "$value" "$(basename -- "$value")"
  else
    printf '%s\n' "$value"
  fi
  exit 0
fi
exec "$real_git" "$@"
EOF
chmod 0755 "$work/bin/git"

cat >"$work/bin/mktemp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${TEST_STAGE_MKTEMP_FAIL_AT:-}" && " $* " == *" -d "* \
  && ( "$*" == *"/emergency."* || "$*" == *"/emergency-verify."* \
    || "$*" == *"/learncoding-emergency."* ) ]]; then
  count=0
  [[ ! -f "${TEST_STAGE_MKTEMP_STATE:?}" ]] \
    || count="$(<"$TEST_STAGE_MKTEMP_STATE")"
  ((count += 1))
  printf '%s' "$count" >"$TEST_STAGE_MKTEMP_STATE"
  if ((count == TEST_STAGE_MKTEMP_FAIL_AT)); then
    exit 79
  fi
fi
exec /usr/bin/mktemp "$@"
EOF
cat >"$work/bin/find" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${TEST_CREDENTIAL_INODE_ALIAS:-0}" == 1 \
  && " $* " == *" -samefile "* \
  && " $* " == *" ${TEST_CREDENTIAL_KEY_PATH:?} "* ]]; then
  printf '%s\n' "${TEST_CREDENTIAL_ALIAS_PATH:?}"
  exit 0
fi
exec /usr/bin/find "$@"
EOF
chmod 0755 "$work/bin/mktemp" "$work/bin/find"

config="$work/backup.env"
cat >"$config" <<EOF
REPO_ROOT=$fixture_repo
COMPOSE_ENV_FILE=$work/compose.env
EMERGENCY_BACKUP_ROOT=$work/target
BACKUP_STAGE_ROOT=$work/stage
BACKUP_EPHEMERAL_ROOT=$work/runtime
BACKUP_LOCK_FILE=$work/backup.lock
AGE_RECIPIENT_FILE=$work/recipient.txt
LEARN_DATA_ROOT=$work/live-data
BACKUP_ROOT=$work/live-backups
CREDENTIAL_MASTER_KEY_FILE=$master_key
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

assert_emergency_preflight_failure() {
  local label="$1" config_file="$2" before_archives before_sidecars
  shift 2
  before_archives="$(archive_count)"
  before_sidecars="$(find "$work/target/emergency" -maxdepth 1 -type f \
    -name 'learncoding-emergency-*.tar.gz.age.sha256' | wc -l | tr -d ' ')"
  : >"$work/age-events"
  if /usr/bin/env PATH="$work/bin:$PATH" TEST_AGE_EVENTS="$work/age-events" \
    BACKUP_CONFIG_FILE="$config_file" "$@" bash "$backup" \
    >"$work/$label.stdout" 2>"$work/$label.stderr"; then
    fail "emergency backup accepted unsafe reviewed-source fixture: $label"
  fi
  [[ "$(archive_count)" == "$before_archives" ]] \
    || fail "$label changed the emergency archive count"
  [[ "$(find "$work/target/emergency" -maxdepth 1 -type f \
    -name 'learncoding-emergency-*.tar.gz.age.sha256' | wc -l | tr -d ' ')" \
    == "$before_sidecars" ]] || fail "$label changed the emergency sidecar count"
  assert_no_transient_material
}

if [[ "$test_group" == minor-staging-cleanup ]]; then
  for staging_case in second-create chmod; do
    : >"$work/age-events"
    if [[ "$staging_case" == second-create ]]; then
      injected=(TEST_STAGE_MKTEMP_FAIL_AT=2 \
        TEST_STAGE_MKTEMP_STATE="$work/stage-mktemp-state")
    else
      injected=(TEST_STAGE_CHMOD_FAIL=1)
    fi
    if /usr/bin/env PATH="$work/bin:$PATH" TEST_AGE_EVENTS="$work/age-events" \
      BACKUP_CONFIG_FILE="$config" "${injected[@]}" bash "$backup" \
      >"$work/staging-$staging_case.stdout" \
      2>"$work/staging-$staging_case.stderr"; then
      fail "emergency backup succeeded after $staging_case staging failure"
    fi
    [[ -z "$(find "$work/stage" "$work/runtime" -mindepth 1 -print -quit)" ]] \
      || fail "$staging_case staging failure left an incremental directory"
  done
  echo "emergency-backup-minor-staging-cleanup-tests-ok"
  exit 0
fi

if [[ "$test_group" == c1-reviewed-source ]]; then
  c1_section="${C1_REVIEWED_SOURCE_SECTION:-all}"
  if [[ "$c1_section" == all || "$c1_section" == aliases \
    || "$c1_section" == repo-root-alias ]]; then
  repo_alias_config="$work/repo-alias.env"
  cp -- "$config" "$repo_alias_config"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$fixture_repo/../release|" \
    "$repo_alias_config"
  assert_emergency_preflight_failure noncanonical-repo-root-alias \
    "$repo_alias_config"
  fi

  if [[ "$c1_section" == all || "$c1_section" == aliases \
    || "$c1_section" == git-toplevel-alias ]]; then
  assert_emergency_preflight_failure noncanonical-git-toplevel-alias \
    "$config" TEST_GIT_TOPLEVEL_ALIAS=1
  fi

  if [[ "$c1_section" == all || "$c1_section" == aliases \
    || "$c1_section" == credential-alias ]]; then
  credential_alias_config="$work/credential-alias.env"
  cp -- "$config" "$credential_alias_config"
  mkdir -p -- "$work/credential-alias-parent"
  sed -i "s|^CREDENTIAL_MASTER_KEY_FILE=.*|CREDENTIAL_MASTER_KEY_FILE=$work/credential-alias-parent/../credential-master-key|" \
    "$credential_alias_config"
  assert_emergency_preflight_failure noncanonical-credential-key-alias \
    "$credential_alias_config"
  fi

  if [[ "$c1_section" == all || "$c1_section" == unsafe-sources ]]; then
  untracked_repo="$work/release-untracked"
  cp -a -- "$fixture_repo" "$untracked_repo"
  printf '%s' synthetic-runtime-material \
    >"$untracked_repo/docs/runbooks/operator-notes.txt"
  untracked_config="$work/untracked.env"
  cp -- "$config" "$untracked_config"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$untracked_repo|" "$untracked_config"
  assert_emergency_preflight_failure innocuous-untracked-source "$untracked_config"

  dirty_repo="$work/release-dirty"
  cp -a -- "$fixture_repo" "$dirty_repo"
  printf '%s' dirty >>"$dirty_repo/docs/runbooks/restore.md"
  dirty_config="$work/dirty.env"
  cp -- "$config" "$dirty_config"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$dirty_repo|" "$dirty_config"
  assert_emergency_preflight_failure dirty-reviewed-source "$dirty_config"

  ignored_repo="$work/release-ignored"
  cp -a -- "$fixture_repo" "$ignored_repo"
  printf '%s\n' docs/runbooks/ignored-material.txt \
    >>"$ignored_repo/.git/info/exclude"
  printf '%s' ignored-runtime-material \
    >"$ignored_repo/docs/runbooks/ignored-material.txt"
  ignored_config="$work/ignored.env"
  cp -- "$config" "$ignored_config"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$ignored_repo|" "$ignored_config"
  assert_emergency_preflight_failure ignored-untracked-source "$ignored_config"

  assert_emergency_preflight_failure deterministic-key-inode-alias "$config" \
    TEST_CREDENTIAL_INODE_ALIAS=1 \
    TEST_CREDENTIAL_KEY_PATH="$master_key" \
    TEST_CREDENTIAL_ALIAS_PATH="$fixture_repo/docs/runbooks/recovery-material.txt"

  hardlink_repo="$work/release-hardlink"
  cp -a -- "$fixture_repo" "$hardlink_repo"
  hardlink_config="$work/hardlink.env"
  cp -- "$config" "$hardlink_config"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$hardlink_repo|" "$hardlink_config"
  rm -f -- "$hardlink_repo/docs/runbooks/recovery-material.txt"
  if ln -- "$master_key" "$hardlink_repo/docs/runbooks/recovery-material.txt"; then
    git -C "$hardlink_repo" add docs/runbooks/recovery-material.txt
    git -C "$hardlink_repo" commit -qm hardlink-fixture
    [[ "$(stat -c '%h' -- "$master_key")" -gt 1 ]] \
      || fail "real credential-key hardlink fixture did not share an inode"
    assert_emergency_preflight_failure real-key-hardlink "$hardlink_config"
    rm -f -- "$hardlink_repo/docs/runbooks/recovery-material.txt"
  elif [[ "${OSTYPE:-}" != msys* ]]; then
    fail "Ubuntu credential-key hardlink regression fixture could not be created"
  fi
  fi

  if [[ "$c1_section" == all || "$c1_section" == race ]]; then
  race_repo="$work/release-race"
  cp -a -- "$fixture_repo" "$race_repo"
  race_config="$work/race.env"
  cp -- "$config" "$race_config"
  sed -i "s|^REPO_ROOT=.*|REPO_ROOT=$race_repo|" "$race_config"
  race_source="$race_repo/docs/runbooks/recovery-material.txt"
  race_commit="$(git -C "$race_repo" rev-parse HEAD)"
  race_committed_bytes="$(git -C "$race_repo" show \
    "$race_commit:docs/runbooks/recovery-material.txt")"
  assert_emergency_preflight_failure reviewed-object-live-source-race \
    "$race_config" TEST_MUTATE_REVIEWED_SOURCE_AFTER_DUMP=1 \
    TEST_MUTATION_FILE="$race_source" \
    TEST_MUTATION_OBSERVED="$work/race-mutation-observed"
  [[ -s "$work/race-mutation-observed" ]] \
    || fail "reviewed-source race fixture did not mutate after commit selection"
  [[ "$(git -C "$race_repo" show \
    "$race_commit:docs/runbooks/recovery-material.txt")" == "$race_committed_bytes" ]] \
    || fail "reviewed-source race changed the selected Git object"
  [[ "$(<"$race_source")" != "$race_committed_bytes" ]] \
    || fail "reviewed-source race did not diverge the live worktree bytes"
  fi

  if [[ "$c1_section" == all || "$c1_section" == exact-object ]]; then
  : >"$work/age-events"
  before="$(archive_count)"
  if ! PATH="$work/bin:$PATH" TEST_AGE_EVENTS="$work/age-events" \
    TEST_EMERGENCY_DIR="$work/target/emergency" TEST_EXPECT_FINAL_COUNT="$before" \
    BACKUP_CONFIG_FILE="$config" bash "$backup" \
    >"$work/provenance.stdout" 2>"$work/provenance.stderr"; then
    fail "clean reviewed emergency source did not publish"
  fi
  newest="$(find "$work/target/emergency" -maxdepth 1 -type f \
    -name 'learncoding-emergency-*.tar.gz.age' -printf '%T@ %p\n' \
    | sort -nr | head -n1 | cut -d' ' -f2-)"
  expected_commit="$(git -C "$fixture_repo" rev-parse HEAD)"
  actual_outer="$work/provenance-outer"
  actual_recovery="$work/provenance-actual-recovery"
  expected_recovery="$work/provenance-expected-recovery"
  mkdir -p -- "$actual_outer" "$actual_recovery" "$expected_recovery"
  tar -xzf "$newest" -C "$actual_outer" MANIFEST.txt recovery-config.tar.gz
  grep -Fxq "git_commit=$expected_commit" "$actual_outer/MANIFEST.txt" \
    || fail "emergency manifest did not bind the reviewed Git commit"
  git -C "$fixture_repo" archive --format=tar "$expected_commit" -- \
    .dockerignore Dockerfile compose.yaml docs/deployment.md docs/runbooks \
    drizzle infra/env infra/systemd \
    | tar -xf - -C "$expected_recovery"
  tar -xzf "$actual_outer/recovery-config.tar.gz" -C "$actual_recovery"
  (cd "$expected_recovery" && find . -mindepth 1 -printf '%y %P\n' | sort) \
    >"$work/expected-recovery-inventory"
  (cd "$actual_recovery" && find . -mindepth 1 -printf '%y %P\n' | sort) \
    >"$work/actual-recovery-inventory"
  cmp -s "$work/expected-recovery-inventory" "$work/actual-recovery-inventory" \
    || fail "nested recovery archive paths differ from the manifest Git object"
  while IFS= read -r -d '' expected_file; do
    relative_path="${expected_file#"$expected_recovery/"}"
    cmp -s "$expected_file" "$actual_recovery/$relative_path" \
      || fail "nested recovery bytes differ from Git object: $relative_path"
  done < <(find "$expected_recovery" -type f -print0)
  assert_no_transient_material
  fi
  echo "emergency-backup-c1-reviewed-source-tests-ok"
  exit 0
fi

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
