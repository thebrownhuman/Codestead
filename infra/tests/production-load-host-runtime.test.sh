#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
validator="$repo_root/infra/ops/validate-production-load-host-runtime.sh"
[[ "$(uname -s)" == Linux && "${EUID:-$(id -u)}" -eq 0 ]] || {
  echo 'SKIP: authoritative production-load host runtime fixtures require Linux root'
  exit 0
}
[[ -f "$validator" && ! -L "$validator" ]] || { echo 'FAIL: runtime validator is missing or symlinked' >&2; exit 1; }
/usr/bin/bash -n "$validator" || { echo 'FAIL: runtime validator syntax is invalid' >&2; exit 1; }

work="$(mktemp -d /tmp/production-load-host-runtime.XXXXXX)"
[[ "$work" == /tmp/production-load-host-runtime.* && ! -L "$work" ]] || exit 1
cleanup() {
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/production-load-host-runtime.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT

make_case() {
  local name="$1" version="$2" tsx_version="$3" import_status="$4"
  local case_root="$work/$name"
  local release_root="$case_root/release"
  local fake_node="$case_root/node"
  mkdir -m 0755 -p "$release_root/node_modules/tsx"
  mkdir -m 0755 -p "$release_root/infra/ops"
  printf '%s\n' 'pass' >"$release_root/infra/ops/production-load-peer-credentials.py"
  chmod 0644 "$release_root/infra/ops/production-load-peer-credentials.py"
  printf '{"name":"tsx","version":"%s"}\n' "$tsx_version" >"$release_root/node_modules/tsx/package.json"
  chmod 0644 "$release_root/node_modules/tsx/package.json"
  {
    printf '%s\n' '#!/usr/bin/bash' 'set -Eeuo pipefail'
    printf 'readonly fake_version=%q\n' "$version"
    printf 'readonly fake_manifest=%q\n' "$release_root/node_modules/tsx/package.json"
    printf 'readonly fake_import_status=%q\n' "$import_status"
    cat <<'FAKE_NODE'
if [[ "$#" == 1 && "$1" == --version ]]; then
  printf '%s\n' "$fake_version"
  exit 0
fi
for argument in "$@"; do
  if [[ "$argument" == --import ]]; then exit "$fake_import_status"; fi
done
/usr/bin/grep -Fqx '{"name":"tsx","version":"4.23.0"}' "$fake_manifest"
FAKE_NODE
  } >"$fake_node"
  chmod 0755 "$fake_node"

  transformed="$(<"$validator")"
  transformed="${transformed//\/usr\/bin\/node/$fake_node}"
  transformed="${transformed//\/opt\/learncoding/$release_root}"
  printf '%s\n' "$transformed" >"$case_root/validator.sh"
  chmod 0500 "$case_root/validator.sh"
}

expect_pass() {
  local name="$1" version="$2" tsx_version="${3:-4.23.0}" import_status="${4:-0}"
  make_case "$name" "$version" "$tsx_version" "$import_status"
  /usr/bin/bash "$work/$name/validator.sh" >"$work/$name/stdout" 2>"$work/$name/stderr" || {
    echo "FAIL: expected validator pass: $name" >&2
    return 1
  }
  /usr/bin/grep -Fqx "production load host runtime validated: node=$version tsx=4.23.0" "$work/$name/stdout" || {
    echo "FAIL: validator success receipt is not exact: $name" >&2
    return 1
  }
}

expect_fail() {
  local name="$1" version="$2" tsx_version="${3:-4.23.0}" import_status="${4:-0}"
  make_case "$name" "$version" "$tsx_version" "$import_status"
  if /usr/bin/bash "$work/$name/validator.sh" >"$work/$name/stdout" 2>"$work/$name/stderr"; then
    echo "FAIL: expected validator rejection: $name" >&2
    return 1
  fi
  [[ ! -s "$work/$name/stdout" ]] || { echo "FAIL: rejected case emitted success output: $name" >&2; return 1; }
}

expect_pass node-floor v22.22.0
expect_pass next-major v23.0.0
expect_fail below-floor v22.21.99
expect_fail malformed-version 22.23.1
expect_fail prerelease-version v22.23.1-rc.1
expect_fail wrong-tsx v22.23.1 4.22.0
expect_fail loader-import-failure v22.23.1 4.23.0 73

make_case writable-node v22.23.1 4.23.0 0
chmod 0775 "$work/writable-node/node"
if /usr/bin/bash "$work/writable-node/validator.sh" >/dev/null 2>&1; then
  echo 'FAIL: group-writable Node executable was accepted' >&2
  exit 1
fi

make_case symlinked-manifest v22.23.1 4.23.0 0
mv "$work/symlinked-manifest/release/node_modules/tsx/package.json" "$work/symlinked-manifest/real-package.json"
ln -s "$work/symlinked-manifest/real-package.json" "$work/symlinked-manifest/release/node_modules/tsx/package.json"
if /usr/bin/bash "$work/symlinked-manifest/validator.sh" >/dev/null 2>&1; then
  echo 'FAIL: symlinked tsx manifest was accepted' >&2
  exit 1
fi

make_case hardlinked-node v22.23.1 4.23.0 0
ln "$work/hardlinked-node/node" "$work/hardlinked-node/node-second-link"
if /usr/bin/bash "$work/hardlinked-node/validator.sh" >/dev/null 2>&1; then
  echo 'FAIL: hard-linked Node executable was accepted' >&2
  exit 1
fi

make_case writable-peer-helper v22.23.1 4.23.0 0
chmod 0664 "$work/writable-peer-helper/release/infra/ops/production-load-peer-credentials.py"
if /usr/bin/bash "$work/writable-peer-helper/validator.sh" >/dev/null 2>&1; then
  echo 'FAIL: group-writable peer-credential helper was accepted' >&2
  exit 1
fi

make_case symlinked-peer-helper v22.23.1 4.23.0 0
mv "$work/symlinked-peer-helper/release/infra/ops/production-load-peer-credentials.py" \
  "$work/symlinked-peer-helper/real-peer-helper.py"
ln -s "$work/symlinked-peer-helper/real-peer-helper.py" \
  "$work/symlinked-peer-helper/release/infra/ops/production-load-peer-credentials.py"
if /usr/bin/bash "$work/symlinked-peer-helper/validator.sh" >/dev/null 2>&1; then
  echo 'FAIL: symlinked peer-credential helper was accepted' >&2
  exit 1
fi

echo 'production load host runtime fixtures passed'
