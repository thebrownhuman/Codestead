#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
validator="$repo_root/infra/ops/validate-production-load-test-control-runtime.sh"
require_linux_root="${CODESTEAD_REQUIRE_LINUX_ROOT:-0}"
[[ "$require_linux_root" == 0 || "$require_linux_root" == 1 ]] || {
  echo 'FAIL: CODESTEAD_REQUIRE_LINUX_ROOT must be exactly 0 or 1' >&2
  exit 1
}
if [[ "$(uname -s)" != Linux || "${EUID:-$(id -u)}" -ne 0 ]]; then
  [[ "$require_linux_root" == 0 ]] || {
    echo 'FAIL: authoritative test-control runtime fixtures require Linux root' >&2
    exit 1
  }
  echo 'SKIP: authoritative test-control runtime fixtures require Linux root'
  exit 0
fi
[[ -f "$validator" && ! -L "$validator" ]] || { echo 'FAIL: runtime validator is missing or symlinked' >&2; exit 1; }
/usr/bin/bash -n "$validator" || { echo 'FAIL: runtime validator syntax is invalid' >&2; exit 1; }

work="$(mktemp -d /tmp/production-load-test-control-runtime.XXXXXX)"
[[ "$work" == /tmp/production-load-test-control-runtime.* && ! -L "$work" ]] || exit 1
cleanup() {
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/production-load-test-control-runtime.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT

make_case() {
  local name="$1" case_root="$work/$1" release="$work/$1/release" etc_root="$work/$1/etc"
  local bundle manifest active digest manifest_digest transformed
  mkdir -p "$release/infra/runtime" "$etc_root"
  chmod 0755 "$release" "$release/infra" "$release/infra/runtime" "$etc_root"
  bundle="$release/infra/runtime/production-load-test-control-service.mjs"
  manifest="$release/RELEASE.SHA256SUMS"
  active="$etc_root/active-release.env"
  /usr/bin/head -c 2048 /dev/zero | /usr/bin/tr '\000' x >"$bundle"
  chmod 0644 "$bundle"
  digest="$(sha256sum "$bundle")"
  digest="${digest%% *}"
  printf '%s  %s\n' "$digest" 'infra/runtime/production-load-test-control-service.mjs' >"$manifest"
  chmod 0644 "$manifest"
  manifest_digest="$(sha256sum "$manifest")"
  manifest_digest="${manifest_digest%% *}"
  printf 'SCHEMA_VERSION=1\nRELEASE_MANIFEST_SHA256=%s\n' "$manifest_digest" >"$active"
  chmod 0644 "$active"

  transformed="$(<"$validator")"
  transformed="${transformed//\/opt\/learncoding/$release}"
  transformed="${transformed//\/etc\/learncoding/$etc_root}"
  printf '%s\n' "$transformed" >"$case_root/validator.sh"
  chmod 0500 "$case_root/validator.sh"
}

expect_pass() {
  local name="$1"
  make_case "$name"
  /usr/bin/bash "$work/$name/validator.sh" >"$work/$name/stdout" 2>"$work/$name/stderr" || {
    echo "FAIL: expected validator pass: $name" >&2
    return 1
  }
  grep -Eq '^production load test-control runtime validated: sha256=[0-9a-f]{64} bytes=2048$' \
    "$work/$name/stdout" || { echo "FAIL: success receipt is not canonical: $name" >&2; return 1; }
}

expect_rejected_case() {
  local name="$1"
  if /usr/bin/bash "$work/$name/validator.sh" >"$work/$name/stdout" 2>"$work/$name/stderr"; then
    echo "FAIL: expected validator rejection: $name" >&2
    return 1
  fi
  [[ ! -s "$work/$name/stdout" ]] || { echo "FAIL: rejected case emitted success output: $name" >&2; return 1; }
}

expect_pass reviewed-bundle

make_case writable-nested-runtime
chmod 0775 "$work/writable-nested-runtime/release/infra/runtime"
expect_rejected_case writable-nested-runtime

make_case symlinked-bundle
mv "$work/symlinked-bundle/release/infra/runtime/production-load-test-control-service.mjs" \
  "$work/symlinked-bundle/real-bundle.mjs"
ln -s "$work/symlinked-bundle/real-bundle.mjs" \
  "$work/symlinked-bundle/release/infra/runtime/production-load-test-control-service.mjs"
expect_rejected_case symlinked-bundle

make_case hardlinked-bundle
ln "$work/hardlinked-bundle/release/infra/runtime/production-load-test-control-service.mjs" \
  "$work/hardlinked-bundle/second-bundle-link.mjs"
expect_rejected_case hardlinked-bundle

make_case tampered-bundle
printf x >>"$work/tampered-bundle/release/infra/runtime/production-load-test-control-service.mjs"
expect_rejected_case tampered-bundle

make_case tampered-manifest
printf '%064d  unrelated-file\n' 0 >>"$work/tampered-manifest/release/RELEASE.SHA256SUMS"
expect_rejected_case tampered-manifest

make_case duplicate-active-identity
duplicate_identity="$(grep '^RELEASE_MANIFEST_SHA256=' \
  "$work/duplicate-active-identity/etc/active-release.env")"
printf '%s\n' "$duplicate_identity" >>"$work/duplicate-active-identity/etc/active-release.env"
expect_rejected_case duplicate-active-identity

echo 'production load test-control runtime fixtures passed'
