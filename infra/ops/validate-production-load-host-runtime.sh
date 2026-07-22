#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly node_bin=/usr/bin/node
readonly python_bin=/usr/bin/python3.12
readonly minimum_node_version=22.22.0
readonly tsx_manifest=/opt/learncoding/node_modules/tsx/package.json
readonly expected_tsx_version=4.23.0
readonly peer_credential_helper=/opt/learncoding/infra/ops/production-load-peer-credentials.py

fail() {
  printf 'production load host runtime validation failed: %s\n' "$1" >&2
  exit 1
}

secure_mode() {
  local path="$1" expected_kind="$2" metadata owner group mode links mode_value
  [[ ! -L "$path" ]] || fail "$expected_kind must not be a symlink: $path"
  case "$expected_kind" in
    executable) [[ -f "$path" && -x "$path" ]] || fail "required executable is unavailable: $path" ;;
    file) [[ -f "$path" ]] || fail "required file is unavailable: $path" ;;
    directory) [[ -d "$path" ]] || fail "required directory is unavailable: $path" ;;
    *) fail 'internal path-kind contract is invalid' ;;
  esac
  metadata="$(/usr/bin/stat -Lc '%u:%g:%a:%h' -- "$path")" || fail "cannot inspect required $expected_kind: $path"
  IFS=: read -r owner group mode links <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ && "$links" =~ ^[1-9][0-9]*$ ]] ||
    fail "required $expected_kind metadata is invalid: $path"
  mode_value=$((8#$mode))
  (( (mode_value & 8#022) == 0 )) || fail "required $expected_kind is group/world writable: $path"
  if [[ "$expected_kind" != directory ]]; then
    [[ "$links" == 1 ]] || fail "required $expected_kind has an unexpected hard-link count: $path"
  fi
}

version_at_least() {
  local major="$1" minor="$2" patch="$3" required_major=22 required_minor=22 required_patch=0
  (( major > required_major )) && return 0
  (( major == required_major && minor > required_minor )) && return 0
  (( major == required_major && minor == required_minor && patch >= required_patch ))
}

secure_mode "$node_bin" executable
secure_mode "$python_bin" executable
secure_mode /opt/learncoding directory
secure_mode /opt/learncoding/infra directory
secure_mode /opt/learncoding/infra/ops directory
secure_mode /opt/learncoding/node_modules directory
secure_mode /opt/learncoding/node_modules/tsx directory
secure_mode "$tsx_manifest" file

secure_mode "$peer_credential_helper" file
node_version="$(/usr/bin/env -i PATH=/usr/bin:/bin "$node_bin" --version)" || fail 'fixed Node executable did not report a version'
[[ "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || fail 'fixed Node version is not canonical semver'
version_at_least "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" ||
  fail "fixed Node is below the required ${minimum_node_version} floor"

python_version="$(/usr/bin/env -i PATH=/usr/bin:/bin "$python_bin" --version 2>&1)" ||
  fail 'fixed Python executable did not report a version'
[[ "$python_version" =~ ^Python\ 3\.12\.[0-9]+$ ]] ||
  fail 'fixed Python version is not the reviewed 3.12 runtime'
/usr/bin/env -i PATH=/usr/bin:/bin "$python_bin" -c '
import ast, pathlib, sys
helper_text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
ast.parse(helper_text, filename=sys.argv[1])
' "$peer_credential_helper" || fail 'peer-credential helper syntax is invalid'

/usr/bin/env -i PATH=/usr/bin:/bin "$node_bin" --input-type=module -e '
  import fs from "node:fs";
  const manifest = JSON.parse(fs.readFileSync("/opt/learncoding/node_modules/tsx/package.json", "utf8"));
  if (manifest.name !== "tsx" || manifest.version !== "4.23.0") process.exit(1);
' || fail "tsx does not match reviewed version ${expected_tsx_version}"

(
  cd /opt/learncoding
  /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent "$node_bin" --import tsx --input-type=module -e 'process.exit(0)'
) || fail 'reviewed tsx loader cannot be imported from the fixed release root'

printf 'production load host runtime validated: node=%s tsx=%s\n' "$node_version" "$expected_tsx_version"
