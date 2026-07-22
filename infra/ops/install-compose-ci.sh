#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly compose_version=5.1.4
readonly compose_sha256=33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4
readonly compose_url="https://github.com/docker/compose/releases/download/v${compose_version}/docker-compose-linux-x86_64"
readonly docker_bin=/usr/bin/docker
readonly curl_bin=/usr/bin/curl
readonly sha256_bin=/usr/bin/sha256sum
readonly install_bin=/usr/bin/install
readonly mktemp_bin=/usr/bin/mktemp

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(/usr/bin/uname -s)" == Linux && "$(/usr/bin/uname -m)" == x86_64 ]] ||
  fail 'the pinned CI Compose plugin supports Linux x86_64 only'
[[ -x "$docker_bin" && -x "$curl_bin" && -x "$sha256_bin" && -x "$install_bin" && -x "$mktemp_bin" ]] ||
  fail 'a fixed CI dependency is unavailable'
[[ -n "${HOME:-}" && "$HOME" == /* && -d "$HOME" && ! -L "$HOME" ]] ||
  fail 'HOME must be an existing absolute non-symlink directory'

readonly plugin_directory="$HOME/.docker/cli-plugins"
"$install_bin" --directory --mode 0700 -- "$plugin_directory"
[[ -d "$plugin_directory" && ! -L "$plugin_directory" ]] || fail 'the Docker CLI plugin directory is unsafe'
staging="$($mktemp_bin "$plugin_directory/.docker-compose.${compose_version}.XXXXXX")"
cleanup() {
  [[ -n "${staging:-}" && "$staging" == "$plugin_directory"/.docker-compose."$compose_version".* ]] &&
    /usr/bin/rm --force -- "$staging"
}
trap cleanup EXIT HUP INT TERM

"$curl_bin" --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 --retry 2 \
  --output "$staging" "$compose_url" || fail 'the pinned Docker Compose binary could not be downloaded'
actual_sha256="$($sha256_bin -- "$staging")"
actual_sha256="${actual_sha256%% *}"
[[ "$actual_sha256" == "$compose_sha256" ]] || fail 'the Docker Compose binary checksum does not match its reviewed pin'
"$install_bin" -m 0755 -- "$staging" "$plugin_directory/docker-compose"
installed_version="$($docker_bin compose version --short 2>/dev/null)" || fail 'the installed Docker Compose plugin is unavailable'
installed_version="${installed_version#v}"
[[ "$installed_version" == "$compose_version" ]] || fail 'Docker Compose did not resolve to the reviewed CI version'
printf 'docker-compose-ci-version=%s\n' "$installed_version"
