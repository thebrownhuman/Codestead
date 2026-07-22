#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly release_root=/opt/learncoding
readonly runtime_directory=/opt/learncoding/infra/runtime
readonly runtime_bundle=/opt/learncoding/infra/runtime/production-load-test-control-service.mjs
readonly release_manifest=/opt/learncoding/RELEASE.SHA256SUMS
readonly active_release=/etc/learncoding/active-release.env
readonly runtime_member=infra/runtime/production-load-test-control-service.mjs

fail() {
  printf 'production load test-control runtime validation failed: %s\n' "$1" >&2
  exit 1
}

secure_path() {
  local target="$1" kind="$2" metadata owner group mode links mode_value
  [[ ! -L "$target" ]] || fail "$kind must not be a symlink: $target"
  case "$kind" in
    directory) [[ -d "$target" ]] || fail "required directory is unavailable: $target" ;;
    file) [[ -f "$target" ]] || fail "required file is unavailable: $target" ;;
    *) fail 'internal path-kind contract is invalid' ;;
  esac
  metadata="$(/usr/bin/stat -Lc '%u:%g:%a:%h' -- "$target")" || fail "cannot inspect $kind: $target"
  IFS=: read -r owner group mode links <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ && "$links" =~ ^[1-9][0-9]*$ ]] ||
    fail "$kind metadata is invalid: $target"
  mode_value=$((8#$mode))
  (( (mode_value & 8#022) == 0 )) || fail "$kind is group/world writable: $target"
  if [[ "$kind" == file ]]; then
    [[ "$links" == 1 ]] || fail "file has an unexpected hard-link count: $target"
  fi
}

secure_path "$release_root" directory
secure_path /opt/learncoding/infra directory
secure_path "$runtime_directory" directory
secure_path "$runtime_bundle" file
secure_path "$release_manifest" file
secure_path /etc/learncoding directory
secure_path "$active_release" file

bundle_size="$(/usr/bin/stat -Lc '%s' -- "$runtime_bundle")" || fail 'cannot read runtime bundle size'
[[ "$bundle_size" =~ ^[0-9]+$ ]] || fail 'runtime bundle size is invalid'
(( bundle_size >= 1024 && bundle_size <= 1048576 )) || fail 'runtime bundle size is outside bounds'

approved_manifest_sha=""
approved_manifest_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" != *$'\r'* ]] || fail 'active release uses non-canonical line endings'
  case "$line" in
    RELEASE_MANIFEST_SHA256=*)
      approved_manifest_sha="${line#RELEASE_MANIFEST_SHA256=}"
      approved_manifest_count=$((approved_manifest_count + 1))
      ;;
  esac
done <"$active_release"
[[ "$approved_manifest_count" == 1 && "$approved_manifest_sha" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'active release has no unique canonical manifest identity'

manifest_receipt="$(/usr/bin/sha256sum -- "$release_manifest")" || fail 'cannot hash release manifest'
actual_manifest_sha="${manifest_receipt%% *}"
[[ "$actual_manifest_sha" == "$approved_manifest_sha" ]] || fail 'release manifest is not the active candidate'

expected_bundle_sha=""
bundle_record_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *"  $runtime_member" ]]; then
    [[ "$line" =~ ^([0-9a-f]{64})\ \ $runtime_member$ ]] || fail 'runtime bundle manifest record is malformed'
    expected_bundle_sha="${BASH_REMATCH[1]}"
    bundle_record_count=$((bundle_record_count + 1))
  fi
done <"$release_manifest"
[[ "$bundle_record_count" == 1 ]] || fail 'release manifest has no unique runtime bundle record'

bundle_receipt="$(/usr/bin/sha256sum -- "$runtime_bundle")" || fail 'cannot hash runtime bundle'
actual_bundle_sha="${bundle_receipt%% *}"
[[ "$actual_bundle_sha" == "$expected_bundle_sha" ]] || fail 'runtime bundle does not match the active release manifest'

printf 'production load test-control runtime validated: sha256=%s bytes=%s\n' \
  "$actual_bundle_sha" "$bundle_size"
