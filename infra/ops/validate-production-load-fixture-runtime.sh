#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository_root=/opt/learncoding
readonly bundle="$repository_root/infra/runtime/production-load-fixture-runtime.mjs"
readonly attestation=/etc/learncoding/production-load-network-attestation
readonly socket_parent=/run/learncoding-production-load-fixtures
readonly image='node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94'

[[ "${EUID:-$(id -u)}" -eq 0 ]] || exit 70
[[ "$(stat -Lc '%F:%u:%g:%a:%h' -- "$bundle")" == 'regular file:0:0:444:1' ]] || exit 71
[[ "$(stat -Lc '%F:%u:%g:%a:%h' -- "$attestation")" == 'regular file:0:0:444:1' ]] || exit 72
[[ "$(cat -- "$attestation")" == $'schema=1\nprofile=codestead-production-load-disposable-network-v1\negress=default-deny' ]] || exit 73
[[ "$(stat -Lc '%F:%u:%g:%a' -- "$socket_parent")" == 'directory:65532:65532:700' ]] || exit 74
[[ ! -L "$bundle" && ! -L "$attestation" && ! -L "$socket_parent" ]] || exit 75
/usr/bin/docker image inspect --format '{{.Id}}' "$image" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 76
[[ ! -e "$socket_parent/runtime.sock" ]] || {
  [[ -S "$socket_parent/runtime.sock" ]] || exit 77
  [[ "$(stat -Lc '%u:%g:%a:%h' -- "$socket_parent/runtime.sock")" == '65532:65532:600:1' ]] || exit 78
}
