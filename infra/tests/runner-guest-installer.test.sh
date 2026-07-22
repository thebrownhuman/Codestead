#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

(( EUID == 0 )) || fail 'runner guest installer behavior requires Linux root'
command -v bwrap >/dev/null || fail 'Bubblewrap is required'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
installer="$repo_root/infra/runner-vm/install-guest.sh"
verifier="$repo_root/infra/runner-vm/verify-release-tree.py"
runtime_record_verifier="$repo_root/infra/runner-vm/verify-runtime-record.mjs"
guest_policy="$repo_root/infra/runner-vm/guest-runner.nft"
guest_unit="$repo_root/infra/systemd/learncoding-runner-guest-firewall.service"
[[ -f "$installer" && -f "$verifier" && -f "$runtime_record_verifier" && -f "$guest_policy" ]] ||
  fail 'production guest assets are missing'

work="$(mktemp -d /tmp/codestead-guest-installer.XXXXXX)"
cleanup() {
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/codestead-guest-installer.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM
cp -a -- /etc "$work/etc"

release="$work/release"
mkdir -p \
  "$release/infra/runner-vm" \
  "$release/infra/runner" \
  "$release/infra/systemd" \
  "$release/services/runner/dist" \
  "$work/artifacts" \
  "$work/etc-learncoding" \
  "$work/systemd" \
  "$work/keyrings" \
  "$work/sources" \
  "$work/usr-local/bin" \
  "$work/output" \
  "$work/fakes"
cp -- "$installer" "$release/infra/runner-vm/install-guest.sh"
cp -- "$verifier" "$release/infra/runner-vm/verify-release-tree.py"
cp -- "$runtime_record_verifier" "$release/infra/runner-vm/verify-runtime-record.mjs"
cp -- "$guest_policy" "$release/infra/runner-vm/guest-runner.nft"
cp -- "$repo_root/infra/runner/learncoding-runner.service.example" "$release/infra/runner/learncoding-runner.service.example"
if [[ -f "$guest_unit" ]]; then
  cp -- "$guest_unit" "$release/infra/systemd/learncoding-runner-guest-firewall.service"
fi
printf '{"name":"fixture","lockfileVersion":3}\n' >"$release/services/runner/package-lock.json"
printf '{"name":"fixture"}\n' >"$release/services/runner/package.json"

readonly docker_ce_version='5:29.6.1-1~ubuntu.24.04~noble'
readonly docker_cli_version='5:29.6.1-1~ubuntu.24.04~noble'
readonly containerd_version='2.2.1-1~ubuntu.24.04~noble'
readonly buildx_version='0.31.1-1~ubuntu.24.04~noble'
readonly compose_version='5.1.0-1~ubuntu.24.04~noble'
readonly nodejs_version='22.17.0-1nodesource1'
readonly trivy_version='0.69.3'
readonly syft_version='1.42.3'
readonly grype_version='0.104.1'

write_runner_environment() {
  cat >"$work/etc-learncoding/runner.env" <<'EOF'
RUNNER_HOST=192.168.122.12
RUNNER_PORT=4100
RUNNER_SHARED_SECRET_FILE=/etc/learncoding/runner-shared-secret
RUNNER_MAX_CONCURRENCY=2
RUNNER_MAX_QUEUE_DEPTH=100
RUNNER_AUTH_MAX_SKEW_SECONDS=300
RUNNER_NONCE_TTL_SECONDS=900
RUNNER_IDEMPOTENCY_TTL_SECONDS=86400
RUNNER_TEMP_ROOT=/var/lib/learncoding-runner/tmp
RUNNER_STATE_ROOT=/var/lib/learncoding-runner
RUNNER_DOCKER_BINARY=/usr/bin/docker
RUNNER_IMAGE_C=codestead/c@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUNNER_IMAGE_CPP=codestead/cpp@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
RUNNER_IMAGE_JAVA=codestead/java@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
RUNNER_IMAGE_PYTHON=codestead/python@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
RUNNER_IMAGE_JAVASCRIPT=codestead/javascript@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
EOF
  printf '%s' 'fixture-runner-secret-is-more-than-thirty-two-bytes' >"$work/etc-learncoding/runner-shared-secret"
  chown 0:991 "$work/etc-learncoding/runner.env" "$work/etc-learncoding/runner-shared-secret"
  chmod 0640 "$work/etc-learncoding/runner.env"
  chmod 0440 "$work/etc-learncoding/runner-shared-secret"
}

write_identity() {
  local uid="${1:-991}"
  cat >"$work/passwd" <<EOF
root:x:0:0:root:/root:/bin/bash
learncoding-runner:x:${uid}:991::/var/lib/learncoding-runner:/usr/sbin/nologin
EOF
  cat >"$work/group" <<'EOF'
root:x:0:
learncoding-runner:x:991:
docker:x:998:learncoding-runner
EOF
  chmod 0644 "$work/passwd" "$work/group"
}

cat >"$work/sources/ubuntu.sources" <<'EOF'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: noble noble-updates
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
: >"$work/sources.list"
write_runner_environment
write_identity 991

printf 'fixture-docker-key\n' >"$work/artifacts/docker.asc"
printf 'fixture-nodesource-key\n' >"$work/artifacts/nodesource.asc"

make_scanner_archive() {
  local name="$1"
  local version="$2"
  local directory="$work/scanner-$name"
  mkdir -p "$directory"
  if [[ "$name" == trivy ]]; then
    cat >"$directory/$name" <<EOF
#!/usr/bin/bash
set -Eeuo pipefail
printf 'scanner:%s\\n' "\$*" >>/tmp/fixture-output/commands
if [[ "\${1:-}" == --version ]]; then printf 'Version: $version\\n'; exit 0; fi
cache=
while (( \$# )); do
  if [[ "\$1" == --cache-dir ]]; then cache="\$2"; shift 2; continue; fi
  shift
done
if [[ -n "\$cache" ]]; then
  mkdir -p "\$cache/db"
  printf '{}\\n' >"\$cache/db/metadata.json"
  printf 'fixture-db\\n' >"\$cache/db/trivy.db"
fi
EOF
  else
    cat >"$directory/$name" <<EOF
#!/usr/bin/bash
set -Eeuo pipefail
printf 'scanner:%s\\n' "\$*" >>/tmp/fixture-output/commands
if [[ "\${1:-}" == version || "\${1:-}" == --version ]]; then printf '$name $version\\n'; exit 0; fi
exit 0
EOF
  fi
  chmod 0755 "$directory/$name"
  tar -C "$directory" -czf "$work/artifacts/$name.tar.gz" "$name"
}
make_scanner_archive trivy "$trivy_version"
make_scanner_archive syft "$syft_version"
make_scanner_archive grype "$grype_version"

sha256_file() { sha256sum -- "$1" | cut -d' ' -f1; }
docker_key_sha="$(sha256_file "$work/artifacts/docker.asc")"
nodesource_key_sha="$(sha256_file "$work/artifacts/nodesource.asc")"
trivy_sha="$(sha256_file "$work/artifacts/trivy.tar.gz")"
syft_sha="$(sha256_file "$work/artifacts/syft.tar.gz")"
grype_sha="$(sha256_file "$work/artifacts/grype.tar.gz")"

cat >"$work/fakes/apt-get" <<'EOF'
#!/usr/bin/bash
printf 'apt-get:%s\n' "$*" >>/tmp/fixture-output/commands
exit 0
EOF
cat >"$work/fakes/dpkg-query" <<EOF
#!/usr/bin/bash
case "\${@: -1}" in
  docker-ce) printf '%s' '$docker_ce_version' ;;
  docker-ce-cli) printf '%s' '$docker_cli_version' ;;
  containerd.io) printf '%s' '$containerd_version' ;;
  docker-buildx-plugin) printf '%s' '$buildx_version' ;;
  docker-compose-plugin) printf '%s' '$compose_version' ;;
  nodejs) printf '%s' '$nodejs_version' ;;
  *) exit 1 ;;
esac
EOF
cat >"$work/fakes/ip" <<'EOF'
#!/usr/bin/bash
printf '2: eth0    inet 192.168.122.12/24 brd 192.168.122.255 scope global eth0\n'
EOF
cat >"$work/fakes/usermod" <<'EOF'
#!/usr/bin/bash
printf 'usermod:%s\n' "$*" >>/tmp/fixture-output/commands
exit 0
EOF
cat >"$work/fakes/useradd" <<'EOF'
#!/usr/bin/bash
printf 'useradd:%s\n' "$*" >>/tmp/fixture-output/commands
exit 0
EOF
cat >"$work/fakes/groupadd" <<'EOF'
#!/usr/bin/bash
printf 'groupadd:%s\n' "$*" >>/tmp/fixture-output/commands
exit 0
EOF
cat >"$work/fakes/systemctl" <<'EOF'
#!/usr/bin/bash
printf 'systemctl:%s\n' "$*" >>/tmp/fixture-output/commands
exit 0
EOF
cat >"$work/fakes/docker" <<'EOF'
#!/usr/bin/bash
printf 'docker:%s\n' "$*" >>/tmp/fixture-output/commands
exit 0
EOF
cat >"$work/fakes/npm" <<'EOF'
#!/usr/bin/bash
printf 'npm:%s\n' "$*" >>/tmp/fixture-output/commands
if [[ "$*" == *'runtime:record'* ]]; then
  mkdir -p /opt/learncoding/services/runner/dist
  /usr/bin/python3 - <<'PY'
import hashlib
import json
from pathlib import Path

languages = ("c", "cpp", "java", "python", "javascript")
environment = {}
for line in Path("/etc/learncoding/runner.env").read_text(encoding="utf-8").splitlines():
    if line.startswith("RUNNER_IMAGE_"):
        key, value = line.split("=", 1)
        environment[key] = value

records = []
for language in languages:
    reference = environment[f"RUNNER_IMAGE_{language.upper()}"]
    manifest_digest = reference.rsplit("@", 1)[1]
    config_digest = "sha256:" + hashlib.sha256(f"fixture-config:{language}".encode()).hexdigest()
    records.append({
        "language": language,
        "reference": reference,
        "manifestDigest": manifest_digest,
        "configDigest": config_digest,
        "rootDigest": manifest_digest,
    })

payload = {"schemaVersion": 1, "release": "local", "local": True, "records": records}
record_id = hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()
document = {"schemaVersion": 1, "recordId": record_id, "release": "local", "local": True, "records": records}
env_text = "\n".join([
    "# Generated by runtime/manage-images.mjs record; do not hand-edit.",
    f"# runtime-record-id={record_id}",
    *(f"RUNNER_IMAGE_{language.upper()}={environment[f'RUNNER_IMAGE_{language.upper()}']}" for language in languages),
]) + "\n"

scenario_path = Path("/tmp/fixture-output/runtime-record-scenario")
scenario = scenario_path.read_text(encoding="utf-8").strip() if scenario_path.exists() else "valid"
if scenario == "env-mismatch":
    env_text = env_text.replace("RUNNER_IMAGE_C=", "RUNNER_IMAGE_C_BROKEN=", 1)
elif scenario == "json-record-id-mismatch":
    document["recordId"] = "0" * 64

directory = Path("/opt/learncoding/services/runner/dist")
(directory / "runtime-images.env").write_text(env_text, encoding="utf-8")
(directory / "runtime-images.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
PY
fi
exit 0
EOF
cat >"$work/fakes/curl" <<'EOF'
#!/usr/bin/bash
printf 'curl:%s\n' "$*" >>/tmp/fixture-output/commands
/usr/bin/env | /usr/bin/sort > /tmp/fixture-output/curl-environment
output=
url=
while (( $# )); do
  case "$1" in
    --output|-o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  https://download.docker.com/linux/ubuntu/gpg) source=/tmp/fixture-artifacts/docker.asc ;;
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key) source=/tmp/fixture-artifacts/nodesource.asc ;;
  *trivy*) source=/tmp/fixture-artifacts/trivy.tar.gz ;;
  *syft*) source=/tmp/fixture-artifacts/syft.tar.gz ;;
  *grype*) source=/tmp/fixture-artifacts/grype.tar.gz ;;
  *) exit 70 ;;
esac
cp -- "$source" "$output"
EOF
cat >"$work/fakes/gpg" <<'EOF'
#!/usr/bin/bash
printf 'gpg:%s\n' "$*" >>/tmp/fixture-output/commands
output=
input=
while (( $# )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dearmor) shift ;;
    *) input="$1"; shift ;;
  esac
done
cp -- "$input" "$output"
EOF
chmod 0555 "$work/fakes/"*
mkdir -p "$work/usr-bin"
cp -al -- /usr/bin/. "$work/usr-bin/"
for fake_name in apt-get dpkg-query curl gpg systemctl npm docker ip usermod useradd groupadd; do
  rm -f -- "$work/usr-bin/$fake_name"
  cp -- "$work/fakes/$fake_name" "$work/usr-bin/$fake_name"
done
mkdir -p "$work/usr-sbin"
cp -al -- /usr/sbin/. "$work/usr-sbin/"
for fake_name in ip usermod useradd groupadd; do
  rm -f -- "$work/usr-sbin/$fake_name"
  cp -- "$work/fakes/$fake_name" "$work/usr-sbin/$fake_name"
done

find "$release" -type d -exec chown 0:0 {} + -exec chmod 0755 {} +
find "$release" -type f -exec chown 0:0 {} + -exec chmod 0644 {} +
chmod 0755 "$release/infra/runner-vm/install-guest.sh" "$release/infra/runner-vm/verify-release-tree.py"
chmod 0644 "$release/infra/runner-vm/verify-runtime-record.mjs"

write_release_manifest() {
  rm -f -- "$release/RELEASE.SHA256SUMS"
  (
    cd "$release"
    find . -type f ! -name RELEASE.SHA256SUMS -printf '%P\0' |
      sort -z |
      xargs -0 sha256sum -- >RELEASE.SHA256SUMS
  )
  chown 0:0 "$release/RELEASE.SHA256SUMS"
  chmod 0644 "$release/RELEASE.SHA256SUMS"
  sha256_file "$release/RELEASE.SHA256SUMS"
}
manifest_sha="$(write_release_manifest)"

reset_writable_mounts() {
  rm -rf -- "$work/systemd" "$work/keyrings" "$work/usr-local"
  mkdir -p "$work/systemd" "$work/keyrings" "$work/usr-local/bin"
  : >"$work/output/commands"
  rm -f -- "$work/output/curl-environment" "$work/output/runtime-record-scenario"
  rm -f -- "$release/services/runner/dist/runtime-images.env" \
    "$release/services/runner/dist/runtime-images.json"
}

run_installer() {
  local label="$1"
  local runtime_record_scenario="${2:-valid}"
  reset_writable_mounts
  printf '%s\n' "$runtime_record_scenario" >"$work/output/runtime-record-scenario"
  set +e
  /usr/bin/env -i \
    RUNNER_RELEASE_MANIFEST_SHA256="$manifest_sha" \
    RUNNER_DOCKER_CE_PACKAGE_VERSION="$docker_ce_version" \
    RUNNER_DOCKER_CLI_PACKAGE_VERSION="$docker_cli_version" \
    RUNNER_CONTAINERD_PACKAGE_VERSION="$containerd_version" \
    RUNNER_BUILDX_PACKAGE_VERSION="$buildx_version" \
    RUNNER_COMPOSE_PACKAGE_VERSION="$compose_version" \
    RUNNER_NODEJS_PACKAGE_VERSION="$nodejs_version" \
    RUNNER_DOCKER_KEY_SHA256="$docker_key_sha" \
    RUNNER_NODESOURCE_KEY_SHA256="$nodesource_key_sha" \
    RUNNER_TRIVY_VERSION="$trivy_version" \
    RUNNER_TRIVY_ARCHIVE_SHA256="$trivy_sha" \
    RUNNER_SYFT_VERSION="$syft_version" \
    RUNNER_SYFT_ARCHIVE_SHA256="$syft_sha" \
    RUNNER_GRYPE_VERSION="$grype_version" \
    RUNNER_GRYPE_ARCHIVE_SHA256="$grype_sha" \
    HOME=/attacker/home \
    BASH_ENV=/attacker/bash-env \
    ENV=/attacker/env \
    DOCKER_CONFIG=/attacker/docker \
    NPM_CONFIG_USERCONFIG=/attacker/npmrc \
    http_proxy=http://attacker.invalid \
    HTTPS_PROXY=http://attacker.invalid \
    NO_PROXY=attacker.invalid \
    /usr/bin/bwrap --die-with-parent --new-session --unshare-pid --unshare-net --unshare-ipc --unshare-uts \
      --ro-bind / / \
      --bind "$work/usr-bin" /usr/bin \
      --bind "$work/usr-sbin" /usr/sbin \
      --bind "$work/etc" /etc \
      --tmpfs /opt --dir /opt/learncoding --bind "$release" /opt/learncoding \
      --tmpfs /var --tmpfs /tmp --dir /tmp/fixture-artifacts --dir /tmp/fixture-output \
      --bind "$work/etc-learncoding" /etc/learncoding \
      --bind "$work/systemd" /etc/systemd/system \
      --bind "$work/keyrings" /etc/apt/keyrings \
      --bind "$work/sources" /etc/apt/sources.list.d \
      --bind "$work/sources.list" /etc/apt/sources.list \
      --ro-bind "$work/passwd" /etc/passwd \
      --ro-bind "$work/group" /etc/group \
      --bind "$work/usr-local" /usr/local \
      --ro-bind "$work/artifacts" /tmp/fixture-artifacts \
      --bind "$work/output" /tmp/fixture-output \
      --proc /proc --dev /dev --tmpfs /run --chdir / -- \
      /opt/learncoding/infra/runner-vm/install-guest.sh \
      >"$work/output/$label.stdout" 2>"$work/output/$label.stderr"
  local status=$?
  set -e
  return "$status"
}

printf 'unlisted\n' >"$release/unlisted.txt"
chown 0:0 "$release/unlisted.txt"
chmod 0644 "$release/unlisted.txt"
if run_installer unlisted; then
  fail 'installer accepted an unlisted release-tree member'
fi
grep -Fq 'reviewed release tree verification failed' "$work/output/unlisted.stderr" ||
  fail "unlisted-member rejection did not reach the exact release-tree gate: $(<"$work/output/unlisted.stderr")"
rm -f -- "$release/unlisted.txt"

printf 'UNREVIEWED_SETTING=1\n' >>"$work/etc-learncoding/runner.env"
if run_installer extra-env; then
  fail 'installer accepted a runner environment key outside the exact allowlist'
fi
grep -Fq 'runner environment contains an unreviewed key' "$work/output/extra-env.stderr" ||
  fail "extra-environment rejection did not reach the exact environment allowlist: $(<"$work/output/extra-env.stderr")"
write_runner_environment

printf 'deb https://attacker.invalid noble main\n' >"$work/sources/evil.list"
if run_installer hostile-repository; then
  fail 'installer accepted an unreviewed apt repository'
fi
grep -Fq 'unreviewed apt repository' "$work/output/hostile-repository.stderr" ||
  fail "hostile-repository rejection did not reach the repository allowlist: $(<"$work/output/hostile-repository.stderr")"
rm -f -- "$work/sources/evil.list"

write_identity 992
if run_installer wrong-user; then
  fail 'installer accepted a runner account with the wrong numeric identity'
fi
grep -Fq 'runner account identity is not exact' "$work/output/wrong-user.stderr" ||
  fail "wrong-user rejection did not reach the numeric identity gate: $(<"$work/output/wrong-user.stderr")"
write_identity 991

if run_installer runtime-env-mismatch env-mismatch; then
  fail 'installer accepted a runtime environment projection that did not match its JSON commit marker'
fi
grep -Fq 'canonical runtime image record verification failed' "$work/output/runtime-env-mismatch.stderr" ||
  fail "runtime env mismatch did not reach the canonical record gate: $(<"$work/output/runtime-env-mismatch.stderr")"

if run_installer runtime-record-id-mismatch json-record-id-mismatch; then
  fail 'installer accepted a runtime JSON record with a forged record id'
fi
grep -Fq 'canonical runtime image record verification failed' "$work/output/runtime-record-id-mismatch.stderr" ||
  fail "runtime record-id mismatch did not reach the canonical record gate: $(<"$work/output/runtime-record-id-mismatch.stderr")"

run_installer success || fail "installer rejected the reviewed fixture: $(<"$work/output/success.stderr")"
[[ -f "$guest_unit" ]] || fail 'production guest firewall unit is missing'
[[ -f "$work/systemd/learncoding-runner-guest-firewall.service" ]] || fail 'guest firewall unit was not installed'
grep -Fq 'systemctl:enable --now learncoding-runner-guest-firewall.service' "$work/output/commands" ||
  fail 'guest firewall was not enabled before the runner'
grep -Fq 'systemctl:enable --now learncoding-runner.service' "$work/output/commands" || fail 'runner was not enabled'
grep -Fq 'apt-get:install --yes --no-install-recommends docker-ce=' "$work/output/commands" ||
  fail 'exact Docker packages were not requested'
grep -Fq 'apt-get:install --yes --no-install-recommends docker-ce=' "$work/output/commands" || fail 'Docker pin was not used'
grep -Fq 'scanner:image --cache-dir /var/cache/codestead/trivy --download-db-only' "$work/output/commands" ||
  fail 'the offline Trivy database was not preloaded'
grep -Fxq 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable' \
  "$work/sources/docker.list" || fail 'Docker repository is not exact and signed'
grep -Fxq 'deb [arch=amd64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  "$work/sources/nodesource.list" || fail 'NodeSource repository is not exact and signed'
if grep -Eiq 'attacker|BASH_ENV=|ENV=|DOCKER_CONFIG=|NPM_CONFIG_USERCONFIG=|(^|_)(http|https|all)_proxy=|NO_PROXY=' \
  "$work/output/curl-environment"; then
  fail 'installer forwarded a poisoned shell, package-manager, or proxy environment to curl'
fi

printf '%s\n' 'runner-guest-installer-tests-ok'
