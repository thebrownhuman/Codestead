#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
ceremony="$repo_root/infra/ops/create-database-secrets.sh"
validator="$repo_root/infra/ops/validate-database-secrets.mjs"
sandbox="$(mktemp -d)"
secret_names=(
  postgres_password
  database_bootstrap_url
  database_url
  database_migrator_url
  database_worker_url
  database_ops_url
)
root_fixture='skipped'

cleanup() {
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n rm -rf -- "$sandbox" >/dev/null 2>&1 || true
  else
    chmod -R u+rwX "$sandbox" >/dev/null 2>&1 || true
    rm -rf -- "$sandbox" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'database secret atomic ceremony test failed: %s\n' "$1" >&2
  exit 1
}

assert_silent() {
  [[ ! -s "$1" && ! -s "$2" ]] || fail 'ceremony emitted output'
}

assert_no_finals() {
  local directory="$1"
  local name
  for name in "${secret_names[@]}"; do
    [[ ! -e "$directory/$name" && ! -L "$directory/$name" ]] ||
      fail "partial final survived: $name"
  done
}

assert_no_transients() {
  local directory="$1"
  local transient
  shopt -s nullglob
  for transient in "$directory"/.database-secret-ceremony.*; do
    fail "transient ceremony artifact survived: $(basename -- "$transient")"
  done
  shopt -u nullglob
}

assert_inventory() {
  local directory="$1"
  node "$validator" \
    learncoding learncoding \
    "$directory/postgres_password" \
    "$directory/database_bootstrap_url" \
    "$directory/database_url" \
    "$directory/database_migrator_url" \
    "$directory/database_worker_url" \
    "$directory/database_ops_url" >/dev/null 2>&1 ||
    fail 'published inventory failed the production validator'
}

assert_modes() {
  local directory="$1"
  local name
  [[ "$(stat -c '%a' "$directory")" == '750' ]] || fail 'secret directory mode is not 0750'
  for name in "${secret_names[@]}"; do
    [[ "$(stat -c '%a' "$directory/$name")" == '440' ]] ||
      fail "$name mode is not 0440"
  done
}

# An existing final must stop the ceremony before random generation and remain untouched.
no_clobber_dir="$sandbox/no-clobber"
no_clobber_bin="$sandbox/no-clobber-bin"
mkdir -p "$no_clobber_dir" "$no_clobber_bin"
printf '%s' 'existing-sentinel' >"$no_clobber_dir/database_url"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  ': >"${CODESTEAD_OPENSSL_MARKER:?}"' \
  'exit 71' >"$no_clobber_bin/openssl"
chmod 0755 "$no_clobber_bin/openssl"
if CODESTEAD_OPENSSL_MARKER="$sandbox/openssl-called" \
  PATH="$no_clobber_bin:$PATH" CODESTEAD_SECRETS_DIR="$no_clobber_dir" \
  bash "$ceremony" >"$sandbox/no-clobber.out" 2>"$sandbox/no-clobber.err"; then
  fail 'ceremony accepted a pre-existing final'
fi
assert_silent "$sandbox/no-clobber.out" "$sandbox/no-clobber.err"
[[ ! -e "$sandbox/openssl-called" ]] || fail 'random generation began before no-clobber rejection'
[[ "$(<"$no_clobber_dir/database_url")" == 'existing-sentinel' ]] ||
  fail 'pre-existing final was modified'
for name in "${secret_names[@]}"; do
  [[ "$name" == 'database_url' || (! -e "$no_clobber_dir/$name" && ! -L "$no_clobber_dir/$name") ]] ||
    fail 'no-clobber rejection created another final'
done
assert_no_transients "$no_clobber_dir"

# Two overlapping creators must yield exactly one complete inventory.
concurrent_dir="$sandbox/concurrent"
concurrent_bin="$sandbox/concurrent-bin"
mkdir -p "$concurrent_dir" "$concurrent_bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'sleep 0.15' \
  'exec "${CODESTEAD_REAL_OPENSSL:?}" "$@"' >"$concurrent_bin/openssl"
chmod 0755 "$concurrent_bin/openssl"
CODESTEAD_REAL_OPENSSL="$(command -v openssl)" PATH="$concurrent_bin:$PATH" \
  CODESTEAD_SECRETS_DIR="$concurrent_dir" bash "$ceremony" \
  >"$sandbox/concurrent-1.out" 2>"$sandbox/concurrent-1.err" &
first_pid=$!
CODESTEAD_REAL_OPENSSL="$(command -v openssl)" PATH="$concurrent_bin:$PATH" \
  CODESTEAD_SECRETS_DIR="$concurrent_dir" bash "$ceremony" \
  >"$sandbox/concurrent-2.out" 2>"$sandbox/concurrent-2.err" &
second_pid=$!
set +e
wait "$first_pid"
first_status=$?
wait "$second_pid"
second_status=$?
set -e
assert_silent "$sandbox/concurrent-1.out" "$sandbox/concurrent-1.err"
assert_silent "$sandbox/concurrent-2.out" "$sandbox/concurrent-2.err"
if ! { [[ "$first_status" == '0' && "$second_status" != '0' ]] ||
  [[ "$first_status" != '0' && "$second_status" == '0' ]]; }; then
  fail "concurrent creators returned $first_status and $second_status"
fi
assert_inventory "$concurrent_dir"
assert_modes "$concurrent_dir"
assert_no_transients "$concurrent_dir"

# A failure after staging metadata but before publication must leave no finals.
before_publish_dir="$sandbox/before-publish"
before_publish_bin="$sandbox/before-publish-bin"
mkdir -p "$before_publish_dir" "$before_publish_bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'count=0' \
  '[[ ! -e "${CODESTEAD_CHMOD_COUNTER:?}" ]] || read -r count <"$CODESTEAD_CHMOD_COUNTER"' \
  'count=$((count + 1))' \
  'printf "%s" "$count" >"$CODESTEAD_CHMOD_COUNTER"' \
  '[[ "$count" != 2 ]] || exit 72' \
  'exec "${CODESTEAD_REAL_CHMOD:?}" "$@"' >"$before_publish_bin/chmod"
chmod 0755 "$before_publish_bin/chmod"
if CODESTEAD_CHMOD_COUNTER="$sandbox/chmod-counter" CODESTEAD_REAL_CHMOD="$(command -v chmod)" \
  PATH="$before_publish_bin:$PATH" CODESTEAD_SECRETS_DIR="$before_publish_dir" \
  bash "$ceremony" >"$sandbox/before-publish.out" 2>"$sandbox/before-publish.err"; then
  fail 'ceremony ignored an injected pre-publication failure'
fi
assert_silent "$sandbox/before-publish.out" "$sandbox/before-publish.err"
assert_no_finals "$before_publish_dir"
assert_no_transients "$before_publish_dir"

# Failure on the third atomic publication must roll back the first two finals.
during_publish_dir="$sandbox/during-publish"
during_publish_bin="$sandbox/during-publish-bin"
mkdir -p "$during_publish_dir" "$during_publish_bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'count=0' \
  '[[ ! -e "${CODESTEAD_LN_COUNTER:?}" ]] || read -r count <"$CODESTEAD_LN_COUNTER"' \
  'count=$((count + 1))' \
  'printf "%s" "$count" >"$CODESTEAD_LN_COUNTER"' \
  '[[ "$count" != 3 ]] || exit 73' \
  'exec "${CODESTEAD_REAL_LN:?}" "$@"' >"$during_publish_bin/ln"
chmod 0755 "$during_publish_bin/ln"
if CODESTEAD_LN_COUNTER="$sandbox/ln-counter" CODESTEAD_REAL_LN="$(command -v ln)" \
  PATH="$during_publish_bin:$PATH" CODESTEAD_SECRETS_DIR="$during_publish_dir" \
  bash "$ceremony" >"$sandbox/during-publish.out" 2>"$sandbox/during-publish.err"; then
  fail 'ceremony ignored an injected mid-publication failure'
fi
assert_silent "$sandbox/during-publish.out" "$sandbox/during-publish.err"
assert_no_finals "$during_publish_dir"
assert_no_transients "$during_publish_dir"

# A non-root invocation may never fall back to the production default directory.
if [[ "$(id -u)" != '0' ]]; then
  if env -u CODESTEAD_SECRETS_DIR -u CODESTEAD_SECRETS_TEST_GROUP \
    bash "$ceremony" >"$sandbox/non-root-default.out" 2>"$sandbox/non-root-default.err"; then
    fail 'non-root default invocation succeeded'
  fi
  assert_silent "$sandbox/non-root-default.out" "$sandbox/non-root-default.err"
fi

# On Linux CI, exercise the real root ownership path in a contained fixture.
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  root_dir="$sandbox/root-fixture"
  # The output captures intentionally remain owned and inspected by the caller.
  # shellcheck disable=SC2024
  sudo -n env \
    CODESTEAD_SECRETS_DIR="$root_dir" \
    CODESTEAD_SECRETS_TEST_GROUP=root \
    bash "$ceremony" >"$sandbox/root.out" 2>"$sandbox/root.err" ||
    fail 'contained root ceremony failed'
  assert_silent "$sandbox/root.out" "$sandbox/root.err"
  sudo -n /usr/bin/node "$validator" \
    learncoding learncoding \
    "$root_dir/postgres_password" \
    "$root_dir/database_bootstrap_url" \
    "$root_dir/database_url" \
    "$root_dir/database_migrator_url" \
    "$root_dir/database_worker_url" \
    "$root_dir/database_ops_url" >/dev/null 2>&1 ||
    fail 'root fixture inventory failed the production validator'
  [[ "$(sudo -n stat -c '%a %u:%g' "$root_dir")" == '750 0:0' ]] ||
    fail 'root fixture directory metadata drifted'
  for name in "${secret_names[@]}"; do
    [[ "$(sudo -n stat -c '%a %u:%g' "$root_dir/$name")" == '440 0:0' ]] ||
      fail "$name root fixture metadata drifted"
  done
  [[ -z "$(sudo -n find "$root_dir" -mindepth 1 -maxdepth 1 \
    -name '.database-secret-ceremony.*' -print -quit)" ]] ||
    fail 'root fixture retained a lock or staging directory'
  root_fixture='passed'
elif [[ "${CI:-}" == 'true' ]]; then
  fail 'CI must provide passwordless sudo for the contained root fixture'
fi

printf 'database secret atomic ceremony tests passed (root_fixture=%s)\n' "$root_fixture"
