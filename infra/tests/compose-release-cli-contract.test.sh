#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

docker_bin="${DOCKER_BIN:-docker}"
if ! command -v "$docker_bin" >/dev/null 2>&1; then
  if [[ -n "${DOCKER_BIN:-}${REQUIRE_COMPOSE_MAJOR:-}" ]]; then
    fail "required Docker CLI is unavailable"
  fi
  echo "SKIP: Docker CLI is unavailable; run this contract on the production host before release."
  exit 0
fi

if ! compose_version="$("$docker_bin" compose version --short 2>/dev/null)"; then
  if [[ -n "${DOCKER_BIN:-}${REQUIRE_COMPOSE_MAJOR:-}" ]]; then
    fail "Docker Compose is unavailable"
  fi
  echo "SKIP: Docker Compose is inaccessible from this shell; run this contract on the production host before release."
  exit 0
fi
compose_version="${compose_version#v}"
[[ "$compose_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.+-].*)?$ ]] || {
  fail "Docker Compose returned an unrecognized version"
}

required_major="${REQUIRE_COMPOSE_MAJOR:-2}"
[[ "$required_major" =~ ^[1-9][0-9]*$ ]] || fail "REQUIRE_COMPOSE_MAJOR must be a positive integer"
compose_major="${compose_version%%.*}"
(( compose_major >= required_major )) || {
  fail "Docker Compose $compose_version is older than required major $required_major"
}

up_help="$("$docker_bin" compose up --help)" || fail "Docker Compose up help failed"
stop_help="$("$docker_bin" compose stop --help)" || fail "Docker Compose stop help failed"
rm_help="$("$docker_bin" compose rm --help)" || fail "Docker Compose rm help failed"

for option in --no-build --pull --remove-orphans --no-deps; do
  grep -Fq -- "$option" <<<"$up_help" || fail "Docker Compose up does not support $option"
done
grep -Fq -- '--timeout' <<<"$stop_help" || fail "Docker Compose stop does not support --timeout"
grep -Fq -- '--force' <<<"$rm_help" || fail "Docker Compose rm does not support --force"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
digest="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
cat >"$work/compose.yaml" <<EOF
services:
  app:
    image: "registry.example.test/codestead/app@$digest"
    restart: unless-stopped
EOF

"$docker_bin" compose -f "$work/compose.yaml" config --quiet || fail "Docker Compose rejected the release fixture"
rendered_images="$("$docker_bin" compose -f "$work/compose.yaml" config --images)" || {
  fail "Docker Compose could not render immutable image references"
}
[[ "$rendered_images" == "registry.example.test/codestead/app@$digest" ]] || {
  fail "Docker Compose changed the immutable image reference"
}

echo "compose-release-cli-contract-ok version=$compose_version required-major=$required_major"
