#!/usr/bin/bash -p
set -Eeuo pipefail
umask 077

export LC_ALL=C
export LANG=C
readonly LC_ALL LANG

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$-" == *p* ]] || fail 'invoke this file through its privileged-mode shebang'
[[ "${EUID:-1}" == 0 && "${UID:-1}" == 0 ]] || fail 'runner VM provisioning requires real root'
[[ "${BASH_SOURCE[0]}" == /* ]] || fail 'invoke the installed provisioner by absolute path'

helper_sha256='32cc1dfe74aa474f873943c68965bbc00d0f71119d649a1d2c61cdfe1cf507b8'
contract_sha256='e79719c49bbe6101c83645669c0f36fda4c887b80c5ddc0cda120f00ad17fc33'
readonly helper_sha256 contract_sha256

script_directory="${BASH_SOURCE[0]%/*}"
[[ -n "$script_directory" && "$script_directory" != "${BASH_SOURCE[0]}" ]] ||
  fail 'could not derive the installed provisioner directory'
readonly script_directory

base_image="${RUNNER_BASE_IMAGE_PATH:-}"
base_image_sha256="${RUNNER_BASE_IMAGE_SHA256:-}"
ssh_key="${RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE:-}"
[[ "$base_image" == /* && "$ssh_key" == /* ]] || fail 'base image and SSH key paths must be absolute'
[[ "$base_image_sha256" =~ ^[0-9a-f]{64}$ ]] || fail 'base image SHA-256 must be lowercase hexadecimal'
[[ "$base_image" != *$'\n'* && "$base_image" != *$'\r'* &&
  "$ssh_key" != *$'\n'* && "$ssh_key" != *$'\r'* ]] || fail 'input paths must be single-line values'
readonly base_image base_image_sha256 ssh_key

readonly helper="$script_directory/codestead_runner_provision.py"
readonly contract="$script_directory/runner-contract.json"
readonly network="$script_directory/codestead-runner-network.xml"
readonly meta_data="$script_directory/cloud-init/meta-data"
readonly user_data_template="$script_directory/cloud-init/user-data.template"
readonly provisioner="${BASH_SOURCE[0]}"

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# This bootstrap is the trust boundary for the Python helper.  It verifies the
# same no-follow descriptor bytes that it compiles and executes; the helper can
# never run in order to attest itself.
trusted_bootstrap='import hashlib
import os
import re
import stat
import sys

def fail(message):
    raise SystemExit("trusted helper bootstrap: " + message)

path = sys.argv[1]
expected = sys.argv[2]
if not os.path.isabs(path) or "\n" in path or "\r" in path:
    fail("helper path is not one absolute single-line path")
if re.fullmatch(r"[0-9a-f]{64}", expected) is None:
    fail("expected helper digest is malformed")

parents = []
cursor = os.path.dirname(path)
while True:
    parents.append(cursor)
    parent = os.path.dirname(cursor)
    if parent == cursor:
        break
    cursor = parent
for directory in reversed(parents):
    info = os.lstat(directory)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail("helper ancestor is not a no-follow directory")
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
        fail("helper ancestor is not root-owned and non-writable by peers")

listed = os.lstat(path)
mode = stat.S_IMODE(listed.st_mode)
if stat.S_ISLNK(listed.st_mode) or not stat.S_ISREG(listed.st_mode):
    fail("helper is not one regular no-follow file")
if listed.st_uid != 0 or listed.st_gid != 0 or listed.st_nlink != 1 or mode & 0o222:
    fail("helper ownership, group, link count, or immutable mode is unsafe")

flags = os.O_RDONLY | os.O_CLOEXEC
if not hasattr(os, "O_NOFOLLOW"):
    fail("O_NOFOLLOW is unavailable")
flags |= os.O_NOFOLLOW
descriptor = os.open(path, flags)
try:
    before = os.fstat(descriptor)
    identity = lambda value: (
        value.st_dev, value.st_ino, value.st_size, value.st_mode,
        value.st_uid, value.st_gid, value.st_nlink,
        value.st_mtime_ns, value.st_ctime_ns,
    )
    if identity(before) != identity(listed):
        fail("helper changed between lstat and open")
    if before.st_size > 4 * 1024 * 1024:
        fail("helper exceeds its reviewed size bound")
    chunks = []
    consumed = 0
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 65536)
        if not chunk:
            break
        consumed += len(chunk)
        if consumed > 4 * 1024 * 1024:
            fail("helper grew beyond its reviewed size bound")
        chunks.append(chunk)
        digest.update(chunk)
    after = os.fstat(descriptor)
    if identity(after) != identity(before):
        fail("helper changed while it was verified")
    if not __import__("hmac").compare_digest(digest.hexdigest(), expected):
        fail("helper digest mismatch")
    source = b"".join(chunks)
    code = compile(source, path, "exec")
finally:
    os.close(descriptor)

sys.argv = [path] + sys.argv[3:]
namespace = {
    "__name__": "__main__",
    "__file__": path,
    "__package__": None,
    "__cached__": None,
}
exec(code, namespace, namespace)'
readonly trusted_bootstrap

exec /usr/bin/timeout --signal=TERM --kill-after=15s 600s \
  /usr/bin/env -i LC_ALL=C LANG=C PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/bin/python3 -I -B -c "$trusted_bootstrap" "$helper" "$helper_sha256" provision \
    --contract "$contract" \
    --contract-sha256 "$contract_sha256" \
    --provisioner "$provisioner" \
    --helper "$helper" \
    --helper-sha256 "$helper_sha256" \
    --network "$network" \
    --meta-data "$meta_data" \
    --user-data-template "$user_data_template" \
    --base-image "$base_image" \
    --base-image-sha256 "$base_image_sha256" \
    --ssh-key "$ssh_key"
