#!/usr/bin/bash -p
set -Eeuo pipefail
umask 077

unset BASH_ENV ENV CDPATH GLOBIGNORE
unset GIT_CONFIG_SYSTEM GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
unset DOCKER_CONFIG COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES
unset NPM_CONFIG_USERCONFIG npm_config_userconfig CURL_HOME
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY no_proxy
export LC_ALL=C
export LANG=C
export HOME=/root
readonly LC_ALL LANG HOME
readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

scratch_directory=
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$scratch_directory" && -d "$scratch_directory" && ! -L "$scratch_directory" &&
    "$scratch_directory" == /var/tmp/codestead-runner-install.* ]]; then
    rm -rf -- "$scratch_directory"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$-" == *p* ]] || fail 'invoke the guest installer through its privileged-mode shebang'
[[ "${EUID:-1}" == 0 && "${UID:-1}" == 0 ]] || fail 'guest installation requires real root'
[[ "$#" == 0 ]] || fail 'the guest installer does not accept positional arguments'

readonly release_root=/opt/learncoding
readonly release_verifier="$release_root/infra/runner-vm/verify-release-tree.py"
readonly runtime_record_verifier="$release_root/infra/runner-vm/verify-runtime-record.mjs"
readonly runner_environment=/etc/learncoding/runner.env
readonly runner_secret=/etc/learncoding/runner-shared-secret
readonly runner_unit_source="$release_root/infra/runner/learncoding-runner.service.example"
readonly runner_unit=/etc/systemd/system/learncoding-runner.service
readonly guest_firewall_unit_source="$release_root/infra/systemd/learncoding-runner-guest-firewall.service"
readonly guest_firewall_unit=/etc/systemd/system/learncoding-runner-guest-firewall.service
readonly runner_root="$release_root/services/runner"
readonly recorded_images="$runner_root/dist/runtime-images.env"
readonly recorded_images_json="$runner_root/dist/runtime-images.json"
readonly install_log=/var/log/learncoding-runner/install.log

expected_manifest_sha256="${RUNNER_RELEASE_MANIFEST_SHA256:-}"
docker_ce_version="${RUNNER_DOCKER_CE_PACKAGE_VERSION:-}"
docker_cli_version="${RUNNER_DOCKER_CLI_PACKAGE_VERSION:-}"
containerd_version="${RUNNER_CONTAINERD_PACKAGE_VERSION:-}"
buildx_version="${RUNNER_BUILDX_PACKAGE_VERSION:-}"
compose_version="${RUNNER_COMPOSE_PACKAGE_VERSION:-}"
nodejs_version="${RUNNER_NODEJS_PACKAGE_VERSION:-}"
docker_key_sha256="${RUNNER_DOCKER_KEY_SHA256:-}"
nodesource_key_sha256="${RUNNER_NODESOURCE_KEY_SHA256:-}"
trivy_version="${RUNNER_TRIVY_VERSION:-}"
trivy_archive_sha256="${RUNNER_TRIVY_ARCHIVE_SHA256:-}"
syft_version="${RUNNER_SYFT_VERSION:-}"
syft_archive_sha256="${RUNNER_SYFT_ARCHIVE_SHA256:-}"
grype_version="${RUNNER_GRYPE_VERSION:-}"
grype_archive_sha256="${RUNNER_GRYPE_ARCHIVE_SHA256:-}"
readonly expected_manifest_sha256 docker_ce_version docker_cli_version containerd_version
readonly buildx_version compose_version nodejs_version docker_key_sha256 nodesource_key_sha256
readonly trivy_version trivy_archive_sha256 syft_version syft_archive_sha256 grype_version grype_archive_sha256

[[ "$expected_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'RUNNER_RELEASE_MANIFEST_SHA256 must be one reviewed lowercase SHA-256 digest'
for package_pin in "$docker_ce_version" "$docker_cli_version" "$containerd_version" \
  "$buildx_version" "$compose_version" "$nodejs_version"; do
  [[ "$package_pin" =~ ^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$ ]] ||
    fail 'every Docker and Node package version must be pinned exactly'
done
for key_digest in "$docker_key_sha256" "$nodesource_key_sha256" "$trivy_archive_sha256" \
  "$syft_archive_sha256" "$grype_archive_sha256"; do
  [[ "$key_digest" =~ ^[0-9a-f]{64}$ ]] || fail 'every repository key and scanner archive must have a reviewed SHA-256 digest'
done
for scanner_version in "$trivy_version" "$syft_version" "$grype_version"; do
  [[ "$scanner_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'every scanner version must be pinned exactly'
done

[[ -r /usr/lib/os-release && ! -L /usr/lib/os-release ]] || fail 'the operating-system release record is unsafe'
grep -Fxq 'ID=ubuntu' /usr/lib/os-release || fail 'the runner guest must be Ubuntu'
if ! grep -Fxq 'VERSION_ID="24.04"' /usr/lib/os-release && ! grep -Fxq 'VERSION_ID=24.04' /usr/lib/os-release; then
  fail 'the runner guest must be Ubuntu VERSION_ID 24.04'
fi
ip -o -4 address show | grep -Eq '(^|[[:space:]])192\.168\.122\.12/24([[:space:]]|$)' ||
  fail 'the runner guest does not own its reviewed private address 192.168.122.12/24'

[[ -f "$release_verifier" && ! -L "$release_verifier" && -x "$release_verifier" ]] ||
  fail 'the exact release tree verifier is missing or unsafe'
[[ -f "$runtime_record_verifier" && ! -L "$runtime_record_verifier" ]] ||
  fail 'the canonical runtime record verifier is missing or unsafe'
[[ -x /usr/bin/python3.12 && ! -L /usr/bin/python3.12 ]] || fail 'the fixed Python 3.12 verifier runtime is unavailable'
/usr/bin/python3.12 "$release_verifier" "$release_root" "$expected_manifest_sha256" >/dev/null ||
  fail 'the reviewed release tree verification failed'

validate_apt_sources() {
  local source basename ownership mode line uri suite_seen=0
  [[ -d /etc/apt/sources.list.d && ! -L /etc/apt/sources.list.d ]] ||
    fail 'the apt source directory is missing or unsafe'
  if [[ -e /etc/apt/sources.list ]]; then
    [[ -f /etc/apt/sources.list && ! -L /etc/apt/sources.list ]] ||
      fail 'the legacy apt source file is unsafe'
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" == \#* ]] || fail 'an unreviewed apt repository is configured'
    done </etc/apt/sources.list
  fi
  while IFS= read -r -d '' source; do
    basename="${source##*/}"
    case "$basename" in
      ubuntu.sources|docker.list|nodesource.list) ;;
      *) fail 'an unreviewed apt repository is configured' ;;
    esac
    [[ -f "$source" && ! -L "$source" ]] || fail 'an apt source record is unsafe'
    ownership="$(stat -c '%u:%g:%h' -- "$source")" || fail 'an apt source record cannot be inspected'
    [[ "$ownership" == 0:0:1 ]] || fail 'apt source records must be root-owned with one link'
    mode="$(stat -c '%a' -- "$source")"
    (( (8#$mode & 8#022) == 0 )) || fail 'apt source records must not be writable by group or other'
    case "$basename" in
      ubuntu.sources)
        suite_seen=0
        while IFS= read -r line || [[ -n "$line" ]]; do
          case "$line" in
            URIs:*)
              for uri in ${line#URIs:}; do
                case "$uri" in
                  http://archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|\
                  http://security.ubuntu.com/ubuntu|https://security.ubuntu.com/ubuntu) ;;
                  *) fail 'an unreviewed apt repository is configured' ;;
                esac
              done
              ;;
            Suites:*)
              [[ " ${line#Suites:} " == *' noble '* ]] || fail 'the Ubuntu apt source does not target noble'
              suite_seen=1
              ;;
          esac
        done <"$source"
        (( suite_seen == 1 )) || fail 'the Ubuntu apt source has no reviewed noble suite'
        ;;
      docker.list)
        [[ "$(<"$source")" == 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable' ]] ||
          fail 'an unreviewed apt repository is configured'
        ;;
      nodesource.list)
        [[ "$(<"$source")" == 'deb [arch=amd64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' ]] ||
          fail 'an unreviewed apt repository is configured'
        ;;
    esac
  done < <(find /etc/apt/sources.list.d -mindepth 1 -maxdepth 1 -print0)
}

validate_apt_sources
install -d -o root -g root -m 0700 /var/log/learncoding-runner
install -d -o root -g root -m 0700 /var/tmp
rm -f -- "$install_log.bootstrap"
install -o root -g root -m 0600 /dev/null "$install_log.bootstrap"
scratch_directory="$(mktemp -d /var/tmp/codestead-runner-install.XXXXXXXX)" || fail 'a secure install workspace could not be created'
[[ ! -L "$scratch_directory" && "$(stat -c '%u:%g:%a' -- "$scratch_directory")" == 0:0:700 ]] ||
  fail 'the install workspace is unsafe'

run_deadline() {
  local seconds="$1"
  shift
  /usr/bin/timeout --signal=TERM --kill-after=30s "${seconds}s" "$@"
}

download_reviewed() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"
  run_deadline 330 /usr/bin/curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 --retry 2 \
    --max-filesize 268435456 --output "$destination" "$url" || fail 'a reviewed dependency download failed'
  [[ -f "$destination" && ! -L "$destination" && "$(stat -c '%u:%g:%h' -- "$destination")" == 0:0:1 ]] ||
    fail 'a downloaded dependency is unsafe'
  downloaded_sha256="$(sha256sum -- "$destination")"
  downloaded_sha256="${downloaded_sha256%% *}"
  [[ "$downloaded_sha256" == "$expected_sha256" ]] || fail 'a downloaded dependency checksum does not match its reviewed pin'
}

run_deadline 330 apt-get update >"$install_log.bootstrap" 2>&1 || fail 'the Ubuntu package index refresh failed'
run_deadline 330 apt-get install --yes --no-install-recommends \
  ca-certificates curl gnupg nftables python3.12 >>"$install_log.bootstrap" 2>&1 ||
  fail 'the reviewed bootstrap packages could not be installed'

install -d -o root -g root -m 0755 /etc/apt/keyrings
download_reviewed 'https://download.docker.com/linux/ubuntu/gpg' "$scratch_directory/docker.asc" "$docker_key_sha256"
run_deadline 30 /usr/bin/gpg --batch --yes --dearmor --output "$scratch_directory/docker.gpg" \
  "$scratch_directory/docker.asc" >>"$install_log.bootstrap" 2>&1 || fail 'the Docker signing key could not be decoded'
install -o root -g root -m 0644 "$scratch_directory/docker.gpg" /etc/apt/keyrings/docker.gpg

download_reviewed 'https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key' \
  "$scratch_directory/nodesource.asc" "$nodesource_key_sha256"
run_deadline 30 /usr/bin/gpg --batch --yes --dearmor --output "$scratch_directory/nodesource.gpg" \
  "$scratch_directory/nodesource.asc" >>"$install_log.bootstrap" 2>&1 || fail 'the NodeSource signing key could not be decoded'
install -o root -g root -m 0644 "$scratch_directory/nodesource.gpg" /etc/apt/keyrings/nodesource.gpg

printf '%s\n' \
  'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable' \
  >"$scratch_directory/docker.list"
printf '%s\n' \
  'deb [arch=amd64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  >"$scratch_directory/nodesource.list"
install -o root -g root -m 0644 "$scratch_directory/docker.list" /etc/apt/sources.list.d/docker.list
install -o root -g root -m 0644 "$scratch_directory/nodesource.list" /etc/apt/sources.list.d/nodesource.list
validate_apt_sources

run_deadline 330 apt-get update >>"$install_log.bootstrap" 2>&1 || fail 'the pinned package index refresh failed'
run_deadline 330 apt-get install --yes --no-install-recommends \
  "docker-ce=$docker_ce_version" \
  "docker-ce-cli=$docker_cli_version" \
  "containerd.io=$containerd_version" \
  "docker-buildx-plugin=$buildx_version" \
  "docker-compose-plugin=$compose_version" \
  "nodejs=$nodejs_version" >>"$install_log.bootstrap" 2>&1 || fail 'the pinned Docker and Node package installation failed'

install_scanner() {
  local scanner="$1"
  local version="$2"
  local archive_sha256="$3"
  local url="$4"
  local archive="$scratch_directory/$scanner.tar.gz"
  local extracted="$scratch_directory/$scanner.bin"
  local -a members=()
  download_reviewed "$url" "$archive" "$archive_sha256"
  mapfile -t members < <(run_deadline 30 /usr/bin/tar --gzip --list --file "$archive")
  [[ "${#members[@]}" == 1 && "${members[0]}" == "$scanner" ]] ||
    fail 'a scanner archive does not contain one exact binary member'
  run_deadline 30 /usr/bin/tar --gzip --extract --to-stdout --file "$archive" "$scanner" >"$extracted" ||
    fail 'a reviewed scanner binary could not be extracted'
  [[ -s "$extracted" && ! -L "$extracted" ]] || fail 'an extracted scanner binary is unsafe'
  install -o root -g root -m 0755 "$extracted" "/usr/local/bin/$scanner"
  scanner_output="$(run_deadline 15 "/usr/local/bin/$scanner" --version | head -c 4096)" ||
    fail 'an installed scanner cannot report its version'
  [[ "$scanner_output" == *"$version"* ]] || fail 'an installed scanner differs from its reviewed version'
}

install_scanner trivy "$trivy_version" "$trivy_archive_sha256" \
  "https://github.com/aquasecurity/trivy/releases/download/v${trivy_version}/trivy_${trivy_version}_Linux-64bit.tar.gz"
install_scanner syft "$syft_version" "$syft_archive_sha256" \
  "https://github.com/anchore/syft/releases/download/v${syft_version}/syft_${syft_version}_linux_amd64.tar.gz"
install_scanner grype "$grype_version" "$grype_archive_sha256" \
  "https://github.com/anchore/grype/releases/download/v${grype_version}/grype_${grype_version}_linux_amd64.tar.gz"

readonly trivy_cache=/var/cache/codestead/trivy
install -d -o root -g root -m 0700 "$trivy_cache"
run_deadline 330 /usr/local/bin/trivy image --cache-dir "$trivy_cache" --download-db-only \
  >>"$install_log.bootstrap" 2>&1 || fail 'the offline Trivy database could not be preloaded'
[[ -s "$trivy_cache/db/metadata.json" && ! -L "$trivy_cache/db/metadata.json" &&
  -s "$trivy_cache/db/trivy.db" && ! -L "$trivy_cache/db/trivy.db" ]] ||
  fail 'the offline Trivy database is incomplete or unsafe'
export RUNTIME_TRIVY_CACHE_DIR="$trivy_cache"
readonly RUNTIME_TRIVY_CACHE_DIR

for package_record in \
  "docker-ce:$docker_ce_version" \
  "docker-ce-cli:$docker_cli_version" \
  "containerd.io:$containerd_version" \
  "docker-buildx-plugin:$buildx_version" \
  "docker-compose-plugin:$compose_version" \
  "nodejs:$nodejs_version"; do
  package_name="${package_record%%:*}"
  expected_version="${package_record#*:}"
  installed_version="$(dpkg-query -W -f='${Version}' "$package_name" 2>/dev/null)" ||
    fail 'a pinned Docker or Node package is not installed'
  [[ "$installed_version" == "$expected_version" ]] || fail 'an installed Docker or Node package differs from its reviewed pin'
done

getent group docker >/dev/null || fail 'the pinned Docker installation did not create its local group'
readonly runner_uid=991
readonly runner_gid=991
if getent passwd learncoding-runner >/dev/null; then
  [[ "$(getent passwd learncoding-runner)" == 'learncoding-runner:x:991:991::/var/lib/learncoding-runner:/usr/sbin/nologin' ]] ||
    fail 'the runner account identity is not exact'
  runner_group_record="$(getent group learncoding-runner)" || fail 'the runner primary group is missing'
  IFS=: read -r runner_group_name runner_group_password runner_group_id runner_group_members <<<"$runner_group_record"
  [[ "$runner_group_name" == learncoding-runner && "$runner_group_password" == x &&
    "$runner_group_id" == "$runner_gid" && -z "$runner_group_members" ]] ||
    fail 'the runner account identity is not exact'
else
  ! getent passwd "$runner_uid" >/dev/null || fail 'the reviewed runner UID is already occupied'
  ! getent group "$runner_gid" >/dev/null || fail 'the reviewed runner GID is already occupied'
  groupadd --system --gid "$runner_gid" learncoding-runner
  useradd --system --uid "$runner_uid" --gid "$runner_gid" --home-dir /var/lib/learncoding-runner \
    --create-home --shell /usr/sbin/nologin --comment '' learncoding-runner
fi
usermod --append --groups docker learncoding-runner
[[ "$(id -u learncoding-runner)" == "$runner_uid" && "$(id -g learncoding-runner)" == "$runner_gid" ]] ||
  fail 'the runner account identity is not exact'
mapfile -t runner_groups < <(id -Gn learncoding-runner | tr ' ' '\n' | sort -u)
[[ "${runner_groups[*]}" == 'docker learncoding-runner' ]] ||
  fail 'the runner account has an unreviewed supplementary group'
install -d -o learncoding-runner -g learncoding-runner -m 0700 /var/lib/learncoding-runner
install -d -o root -g learncoding-runner -m 0750 /etc/learncoding
install -o root -g root -m 0600 /dev/null "$install_log"
chown root:root "$install_log.bootstrap"
chmod 0600 "$install_log.bootstrap"
cat -- "$install_log.bootstrap" >>"$install_log"
rm -f -- "$install_log.bootstrap"

[[ -f "$runner_secret" && ! -L "$runner_secret" && -s "$runner_secret" ]] || fail 'the runner secret is missing or unsafe'
[[ "$(stat -c '%U:%G:%a:%h' -- "$runner_secret")" == root:learncoding-runner:440:1 ]] ||
  fail 'the runner secret must be root:learncoding-runner mode 0440 with one link'
[[ -f "$runner_environment" && ! -L "$runner_environment" ]] || fail 'the runner environment is missing or unsafe'
[[ "$(stat -c '%U:%G:%a:%h' -- "$runner_environment")" == root:learncoding-runner:640:1 ]] ||
  fail 'the runner environment must be root:learncoding-runner mode 0640 with one link'

read_environment_value() {
  local file="$1"
  local wanted="$2"
  local line key value file_size found=0 result=
  file_size="$(stat -c '%s' -- "$file")" || return 1
  [[ "$file_size" =~ ^[0-9]{1,6}$ ]] || return 1
  (( file_size > 65536 )) && return 1
  cmp -s -- "$file" <(tr -d '\000' <"$file") || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *$'\r'* && "$line" == *=* ]] || return 1
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
    if [[ "$key" == "$wanted" ]]; then
      found=$((found + 1))
      result="$value"
    fi
  done <"$file"
  [[ "$found" == 1 ]] || return 1
  printf '%s' "$result"
}

validate_runner_environment_allowlist() {
  local line key file_size
  local -A seen=()
  local -a allowed=(
    RUNNER_HOST
    RUNNER_PORT
    RUNNER_SHARED_SECRET_FILE
    RUNNER_MAX_CONCURRENCY
    RUNNER_MAX_QUEUE_DEPTH
    RUNNER_AUTH_MAX_SKEW_SECONDS
    RUNNER_NONCE_TTL_SECONDS
    RUNNER_IDEMPOTENCY_TTL_SECONDS
    RUNNER_TEMP_ROOT
    RUNNER_STATE_ROOT
    RUNNER_DOCKER_BINARY
    RUNNER_IMAGE_C
    RUNNER_IMAGE_CPP
    RUNNER_IMAGE_JAVA
    RUNNER_IMAGE_PYTHON
    RUNNER_IMAGE_JAVASCRIPT
  )
  file_size="$(stat -c '%s' -- "$runner_environment")" || fail 'the runner environment size cannot be read'
  if [[ ! "$file_size" =~ ^[0-9]{1,6}$ ]] || (( file_size > 65536 )); then
    fail 'the runner environment exceeds its size limit'
  fi
  cmp -s -- "$runner_environment" <(tr -d '\000' <"$runner_environment") ||
    fail 'the runner environment contains a NUL byte'
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *$'\r'* && "$line" == *=* ]] || fail 'the runner environment contains a malformed line'
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail 'the runner environment contains a malformed key'
    case "$key" in
      RUNNER_HOST|RUNNER_PORT|RUNNER_SHARED_SECRET_FILE|RUNNER_MAX_CONCURRENCY|RUNNER_MAX_QUEUE_DEPTH|\
      RUNNER_AUTH_MAX_SKEW_SECONDS|RUNNER_NONCE_TTL_SECONDS|RUNNER_IDEMPOTENCY_TTL_SECONDS|\
      RUNNER_TEMP_ROOT|RUNNER_STATE_ROOT|RUNNER_DOCKER_BINARY|RUNNER_IMAGE_C|RUNNER_IMAGE_CPP|\
      RUNNER_IMAGE_JAVA|RUNNER_IMAGE_PYTHON|RUNNER_IMAGE_JAVASCRIPT) ;;
      *) fail 'the runner environment contains an unreviewed key' ;;
    esac
    [[ ! -v "seen[$key]" ]] || fail 'the runner environment contains a duplicate key'
    seen["$key"]=1
  done <"$runner_environment"
  for key in "${allowed[@]}"; do
    [[ -v "seen[$key]" ]] || fail 'the runner environment is missing a required key'
  done
}

validate_runner_environment_allowlist
[[ "$(read_environment_value "$runner_environment" RUNNER_HOST)" == 192.168.122.12 ]] ||
  fail 'RUNNER_HOST must equal the reviewed private guest address'
[[ "$(read_environment_value "$runner_environment" RUNNER_PORT)" == 4100 ]] || fail 'RUNNER_PORT must equal 4100'
[[ "$(read_environment_value "$runner_environment" RUNNER_MAX_CONCURRENCY)" == 2 ]] ||
  fail 'RUNNER_MAX_CONCURRENCY=2 is mandatory'
[[ "$(read_environment_value "$runner_environment" RUNNER_SHARED_SECRET_FILE)" == /etc/learncoding/runner-shared-secret ]] ||
  fail 'RUNNER_SHARED_SECRET_FILE is not exact'
[[ "$(read_environment_value "$runner_environment" RUNNER_MAX_QUEUE_DEPTH)" == 100 ]] ||
  fail 'RUNNER_MAX_QUEUE_DEPTH must equal 100'
[[ "$(read_environment_value "$runner_environment" RUNNER_AUTH_MAX_SKEW_SECONDS)" == 300 ]] ||
  fail 'RUNNER_AUTH_MAX_SKEW_SECONDS must equal 300'
[[ "$(read_environment_value "$runner_environment" RUNNER_NONCE_TTL_SECONDS)" == 900 ]] ||
  fail 'RUNNER_NONCE_TTL_SECONDS must equal 900'
[[ "$(read_environment_value "$runner_environment" RUNNER_IDEMPOTENCY_TTL_SECONDS)" == 86400 ]] ||
  fail 'RUNNER_IDEMPOTENCY_TTL_SECONDS must equal 86400'
[[ "$(read_environment_value "$runner_environment" RUNNER_TEMP_ROOT)" == /var/lib/learncoding-runner/tmp ]] ||
  fail 'RUNNER_TEMP_ROOT is not exact'
[[ "$(read_environment_value "$runner_environment" RUNNER_STATE_ROOT)" == /var/lib/learncoding-runner ]] ||
  fail 'RUNNER_STATE_ROOT is not exact'
[[ "$(read_environment_value "$runner_environment" RUNNER_DOCKER_BINARY)" == /usr/bin/docker ]] ||
  fail 'RUNNER_DOCKER_BINARY is not exact'
for image_key in RUNNER_IMAGE_C RUNNER_IMAGE_CPP RUNNER_IMAGE_JAVA RUNNER_IMAGE_PYTHON RUNNER_IMAGE_JAVASCRIPT; do
  image_reference="$(read_environment_value "$runner_environment" "$image_key")" ||
    fail 'the runner environment is missing an exact runtime image'
  [[ "$image_reference" =~ ^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[0-9a-f]{64}$ ]] ||
    fail 'a runner environment image is not an immutable exact reference'
done

[[ -f "$runner_unit_source" && ! -L "$runner_unit_source" ]] || fail 'the reviewed runner unit is missing or unsafe'
[[ -f "$guest_firewall_unit_source" && ! -L "$guest_firewall_unit_source" ]] ||
  fail 'the reviewed guest firewall unit is missing or unsafe'
install -o root -g root -m 0644 "$runner_unit_source" "$runner_unit"
install -o root -g root -m 0644 "$guest_firewall_unit_source" "$guest_firewall_unit"

run_gate() {
  "$@" >>"$install_log" 2>&1 || fail 'a reviewed runner build or runtime gate failed'
}

systemctl daemon-reload >>"$install_log" 2>&1 || fail 'systemd could not load the reviewed guest units'
systemctl enable --now learncoding-runner-guest-firewall.service >>"$install_log" 2>&1 ||
  fail 'the guest firewall could not be enabled'
systemctl is-enabled --quiet learncoding-runner-guest-firewall.service || fail 'the guest firewall is not enabled'
systemctl is-active --quiet learncoding-runner-guest-firewall.service || fail 'the guest firewall is not active'
systemctl enable --now docker.service >>"$install_log" 2>&1 || fail 'Docker could not be enabled'
run_gate docker info

run_gate npm --prefix "$runner_root" ci
run_gate npm --prefix "$runner_root" test
run_gate npm --prefix "$runner_root" run typecheck
run_gate npm --prefix "$runner_root" run build
run_gate npm --prefix "$runner_root" run runtime:build
run_gate npm --prefix "$runner_root" run runtime:inspect
run_gate npm --prefix "$runner_root" run runtime:test
run_gate npm --prefix "$runner_root" run runtime:scan
run_gate npm --prefix "$runner_root" run runtime:record

[[ -f "$recorded_images_json" && ! -L "$recorded_images_json" ]] ||
  fail 'the runtime image JSON commit marker was not produced safely'
[[ -f "$recorded_images" && ! -L "$recorded_images" ]] ||
  fail 'the runtime image environment projection was not produced safely'
/usr/bin/node "$runtime_record_verifier" "$recorded_images_json" "$recorded_images" >>"$install_log" 2>&1 ||
  fail 'canonical runtime image record verification failed'
for image_key in RUNNER_IMAGE_C RUNNER_IMAGE_CPP RUNNER_IMAGE_JAVA RUNNER_IMAGE_PYTHON RUNNER_IMAGE_JAVASCRIPT; do
  installed_image="$(read_environment_value "$runner_environment" "$image_key")" ||
    fail 'the installed runner environment is missing an exact runtime image'
  recorded_image="$(read_environment_value "$recorded_images" "$image_key")" ||
    fail 'the runtime image record is incomplete'
  [[ "$installed_image" =~ ^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[0-9a-f]{64}$ ]] ||
    fail 'an installed runtime image is not an immutable exact reference'
  [[ "$recorded_image" == "$installed_image" ]] || fail 'an installed runtime image differs from the tested runtime record'
  run_gate docker image inspect "$installed_image"
done

systemctl daemon-reload >>"$install_log" 2>&1 || fail 'systemd could not reload the reviewed runner unit'
systemctl enable --now learncoding-runner.service >>"$install_log" 2>&1 || fail 'the runner service could not be enabled'
systemctl is-active --quiet learncoding-runner.service || fail 'the runner service is not active'

printf '%s\n' \
  'os_verified=true' \
  'release_verified=true' \
  'packages_verified=true' \
  'runtime_verified=true' \
  'runner_enabled=true'
