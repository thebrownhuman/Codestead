#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common="$repo_root/scripts/backup/common.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# shellcheck source=../../scripts/backup/common.sh
source "$common"

for interface in \
  require_secure_regular_file \
  path_is_within \
  write_success_marker \
  read_success_marker; do
  declare -F "$interface" >/dev/null || fail "required backup interface is missing: $interface"
done

owner_uid="$(id -u)"
secure_file="$work/secure-file"
touch "$secure_file"
chmod 0600 "$secure_file"
require_secure_regular_file "$secure_file" 600 "$owner_uid" \
  || fail "secure regular file was rejected"
require_secure_regular_file "$secure_file" 0600 "$owner_uid" \
  || fail "zero-prefixed secure mode was rejected"

ln -s "$secure_file" "$work/secure-link"
if output="$(require_secure_regular_file "$work/secure-link" 600 "$owner_uid" 2>&1)"; then
  fail "symlinked secure file was accepted"
fi
[[ -z "$output" ]] || fail "secure-file rejection emitted file details"

chmod 0640 "$secure_file"
if require_secure_regular_file "$secure_file" 600 "$owner_uid"; then
  fail "regular file with a non-exact mode was accepted"
fi
chmod 0600 "$secure_file"

mkdir "$work/directory"
if require_secure_regular_file "$work/directory" 600 "$owner_uid"; then
  fail "directory was accepted as a secure regular file"
fi
if require_secure_regular_file "$work/missing" 600 "$owner_uid"; then
  fail "missing path was accepted as a secure regular file"
fi
mkfifo "$work/fifo"
if require_secure_regular_file "$work/fifo" 600 "$owner_uid"; then
  fail "FIFO was accepted as a secure regular file"
fi
if require_secure_regular_file "$secure_file" unsafe "$owner_uid"; then
  fail "malformed expected mode was accepted"
fi
if require_secure_regular_file "$secure_file" 600 invalid-owner; then
  fail "malformed expected owner was accepted"
fi
if require_secure_regular_file "$secure_file" 600 "$((owner_uid + 1))"; then
  fail "owner mismatch was accepted"
fi

containment_root="$work/srv/learncoding"
mkdir -p "$containment_root/real/child" "$work/outside"
path_is_within "$containment_root" "$containment_root" \
  || fail "root equality was rejected"
path_is_within "$containment_root/real/child" "$containment_root" \
  || fail "real descendant was rejected"
path_is_within "/var/tmp/drill" "$containment_root" \
  && fail "unrelated absolute path was accepted"
path_is_within "$containment_root/real/../../outside" "$containment_root" \
  && fail "traversal outside the root was accepted"
path_is_within "${containment_root}-evil" "$containment_root" \
  && fail "same-prefix sibling was accepted"
ln -s "$work/outside" "$containment_root/escape"
path_is_within "$containment_root/escape/child" "$containment_root" \
  && fail "symlinked path component escaped containment"
path_is_within "relative/child" "$containment_root" \
  && fail "relative candidate was accepted"
path_is_within "$containment_root" "relative/root" \
  && fail "relative root was accepted"
path_is_within "/" "/" || fail "filesystem root equality was rejected"
path_is_within "/var/tmp" "/" || fail "filesystem-root descendant was rejected"

archive="learncoding-full-20260714T010203Z.tar.gz.age"
completed="20260714T010204Z"
hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
marker="$work/success.marker"

write_success_marker "$marker" "$archive" "$completed" "$hash" \
  || fail "valid success marker could not be written"
[[ "$(stat -c '%a' -- "$marker")" == "600" ]] \
  || fail "success marker mode is not 0600"
read_success_marker "$marker" || fail "valid success marker could not be read"
[[ "$SUCCESS_ARCHIVE" == "$archive" ]] || fail "success marker archive did not round-trip"
[[ "$SUCCESS_COMPLETED_UTC" == "$completed" ]] || fail "success marker completion did not round-trip"
[[ "$SUCCESS_SHA256" == "$hash" ]] || fail "success marker hash did not round-trip"
reader_stderr="$({
  bash -Eeuo pipefail -c \
    'source "$1"; read_success_marker "$2"; printf "marker-reader-stderr-ok\n" >&2' \
    _ "$common" "$marker"
} 2>&1 >/dev/null)"
[[ "$reader_stderr" == "marker-reader-stderr-ok" ]] \
  || fail "success-marker reader permanently redirected caller stderr"

missing_parent_marker="$work/missing-parent/success.marker"
if write_success_marker "$missing_parent_marker" "$archive" "$completed" "$hash"; then
  fail "success marker was written beneath a missing parent"
fi
wide_parent="$work/wide-parent"
mkdir "$wide_parent"
chmod 0777 "$wide_parent"
if write_success_marker "$wide_parent/success.marker" "$archive" "$completed" "$hash"; then
  fail "success marker was written beneath an unprotected parent"
fi
ln -s "$work" "$work/parent-link"
if write_success_marker "$work/parent-link/new.marker" "$archive" "$completed" "$hash"; then
  fail "success marker was written through a symlinked parent"
fi
ln -s "$marker" "$work/write-target-link"
if write_success_marker "$work/write-target-link" "$archive" "$completed" "$hash"; then
  fail "success marker replaced a symlinked destination"
fi
mkdir "$work/write-target-directory"
if write_success_marker "$work/write-target-directory" "$archive" "$completed" "$hash"; then
  fail "success marker replaced a non-regular destination"
fi

marker_snapshot="$work/marker.snapshot"
cp "$marker" "$marker_snapshot"
for invalid_archive in \
  "../$archive" \
  "learncoding-full-20260714T010203Z.tar.gz" \
  "other-full-20260714T010203Z.tar.gz.age"; do
  if write_success_marker "$marker" "$invalid_archive" "$completed" "$hash"; then
    fail "invalid success-marker archive was accepted: $invalid_archive"
  fi
  cmp -s "$marker" "$marker_snapshot" || fail "invalid archive changed the live marker"
done

for invalid_completed in \
  "20261314T010204Z" \
  "20260230T010204Z" \
  "20260714T250204Z" \
  "2026-07-14T01:02:04Z"; do
  if write_success_marker "$marker" "$archive" "$invalid_completed" "$hash"; then
    fail "invalid success-marker timestamp was accepted: $invalid_completed"
  fi
  cmp -s "$marker" "$marker_snapshot" || fail "invalid timestamp changed the live marker"
done

for invalid_hash in \
  "${hash^^}" \
  "${hash:0:63}" \
  "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"; do
  if write_success_marker "$marker" "$archive" "$completed" "$invalid_hash"; then
    fail "invalid success-marker hash was accepted"
  fi
  cmp -s "$marker" "$marker_snapshot" || fail "invalid hash changed the live marker"
done

assert_marker_read_failure() {
  local fixture="$1"
  SUCCESS_ARCHIVE=stale
  SUCCESS_COMPLETED_UTC=stale
  SUCCESS_SHA256=stale
  if read_success_marker "$fixture"; then
    fail "invalid success marker was accepted: $(basename -- "$fixture")"
  fi
  [[ -z "${SUCCESS_ARCHIVE:-}" && -z "${SUCCESS_COMPLETED_UTC:-}" && -z "${SUCCESS_SHA256:-}" ]] \
    || fail "failed success-marker read retained partially parsed globals"
}

expect_marker_read_failure() {
  local fixture="$1"
  shift
  printf '%s' "$*" >"$fixture"
  chmod 0600 "$fixture"
  assert_marker_read_failure "$fixture"
}

valid_line_1="SUCCESS_ARCHIVE=$archive"
valid_line_2="SUCCESS_COMPLETED_UTC=$completed"
valid_line_3="SUCCESS_SHA256=$hash"
expect_marker_read_failure "$work/bad-archive.marker" \
  "SUCCESS_ARCHIVE=../$archive"$'\n'"$valid_line_2"$'\n'"$valid_line_3"$'\n'
expect_marker_read_failure "$work/impossible-time.marker" \
  "$valid_line_1"$'\n'"SUCCESS_COMPLETED_UTC=20260230T010204Z"$'\n'"$valid_line_3"$'\n'
expect_marker_read_failure "$work/uppercase-hash.marker" \
  "$valid_line_1"$'\n'"$valid_line_2"$'\n'"SUCCESS_SHA256=${hash^^}"$'\n'
expect_marker_read_failure "$work/short-hash.marker" \
  "$valid_line_1"$'\n'"$valid_line_2"$'\n'"SUCCESS_SHA256=${hash:0:63}"$'\n'
expect_marker_read_failure "$work/nonhex-hash.marker" \
  "$valid_line_1"$'\n'"$valid_line_2"$'\n'"SUCCESS_SHA256=gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"$'\n'
expect_marker_read_failure "$work/missing-field.marker" \
  "$valid_line_1"$'\n'"$valid_line_2"$'\n'
expect_marker_read_failure "$work/duplicate-field.marker" \
  "$valid_line_1"$'\n'"$valid_line_2"$'\n'"$valid_line_3"$'\n'"$valid_line_3"$'\n'
expect_marker_read_failure "$work/extra-field.marker" \
  "$valid_line_1"$'\n'"$valid_line_2"$'\n'"$valid_line_3"$'\n'"EXTRA=value"$'\n'
expect_marker_read_failure "$work/reordered.marker" \
  "$valid_line_2"$'\n'"$valid_line_1"$'\n'"$valid_line_3"$'\n'
expect_marker_read_failure "$work/whitespace.marker" \
  " $valid_line_1"$'\n'"$valid_line_2"$'\n'"$valid_line_3"$'\n'
expect_marker_read_failure "$work/crlf.marker" \
  "$valid_line_1"$'\r\n'"$valid_line_2"$'\r\n'"$valid_line_3"$'\r\n'
expect_marker_read_failure "$work/no-final-newline.marker" \
  "$valid_line_1"$'\n'"$valid_line_2"$'\n'"$valid_line_3"
injection_sentinel="$work/marker-injection-executed"
expect_marker_read_failure "$work/injection.marker" \
  "SUCCESS_ARCHIVE=\$(touch -- $injection_sentinel)"$'\n'"$valid_line_2"$'\n'"$valid_line_3"$'\n'
[[ ! -e "$injection_sentinel" ]] || fail "success-marker parser executed injected shell content"
printf '%s\0%s\n%s\n%s\n' \
  'SUCCESS_ARCHIVE=learncoding' '-full-20260714T010203Z.tar.gz.age' \
  "$valid_line_2" "$valid_line_3" \
  >"$work/nul-injection.marker"
chmod 0600 "$work/nul-injection.marker"
assert_marker_read_failure "$work/nul-injection.marker"

if read_success_marker "$work/no-marker"; then
  fail "missing success marker was accepted"
fi
ln -s "$marker" "$work/marker-link"
if read_success_marker "$work/marker-link"; then
  fail "symlinked success marker was accepted"
fi
cp "$marker" "$work/wrong-mode.marker"
chmod 0640 "$work/wrong-mode.marker"
if read_success_marker "$work/wrong-mode.marker"; then
  fail "success marker with a non-0600 mode was accepted"
fi

replacement_archive="learncoding-full-20260714T020304Z.tar.gz.age"
replacement_completed="20260714T020305Z"
replacement_hash="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
replacement_marker="$work/replacement.marker"
write_success_marker "$replacement_marker" "$replacement_archive" "$replacement_completed" "$replacement_hash" \
  || fail "replacement success marker could not be prepared"
replacement_triggered=0
cmp() {
  if ((replacement_triggered == 0)); then
    replacement_triggered=1
    mv -fT -- "$replacement_marker" "$marker"
  fi
  command cmp "$@"
}
if ! read_success_marker "$marker"; then
  fail "valid atomic marker replacement caused a false read failure"
fi
unset -f cmp
((replacement_triggered == 1)) || fail "atomic marker replacement regression did not trigger"
observed_marker="$SUCCESS_ARCHIVE|$SUCCESS_COMPLETED_UTC|$SUCCESS_SHA256"
old_marker="$archive|$completed|$hash"
new_marker="$replacement_archive|$replacement_completed|$replacement_hash"
[[ "$observed_marker" == "$old_marker" || "$observed_marker" == "$new_marker" ]] \
  || fail "concurrent marker read observed a mixed or incomplete state"
read_success_marker "$marker" || fail "atomically replaced success marker could not be read"
[[ "$SUCCESS_ARCHIVE|$SUCCESS_COMPLETED_UTC|$SUCCESS_SHA256" == "$new_marker" ]] \
  || fail "post-replacement success-marker read did not observe the complete new state"

before_failure_hash="$(sha256sum "$marker" | awk '{print $1}')"
fake_bin="$work/fake-bin"
mkdir "$fake_bin"
cat >"$fake_bin/mv" <<'FAKE_MV'
#!/usr/bin/env bash
exit 73
FAKE_MV
chmod 0700 "$fake_bin/mv"
if PATH="$fake_bin:$PATH" bash -Eeuo pipefail -c \
  'source "$1"; write_success_marker "$2" "$3" "$4" "$5"' \
  _ "$common" "$marker" "learncoding-full-20260714T030405Z.tar.gz.age" \
  "20260714T030406Z" "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"; then
  fail "injected pre-rename failure was reported as success"
fi
after_failure_hash="$(sha256sum "$marker" | awk '{print $1}')"
[[ "$after_failure_hash" == "$before_failure_hash" ]] \
  || fail "pre-rename failure changed the prior success marker"
if find "$work" -maxdepth 1 -name '.success.marker.tmp.*' -print -quit | grep -q .; then
  fail "pre-rename failure left a marker temporary behind"
fi

echo "restore-path-safety-tests-ok"
