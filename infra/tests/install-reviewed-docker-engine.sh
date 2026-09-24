#!/usr/bin/env bash
# Installs the reviewed Docker Engine on a disposable GitHub-hosted Ubuntu 24.04
# runner. Mirrors the production-topology job step: compose.yaml uses
# interface_name and gw_priority, which need Docker Engine 28.1 or later.
set -Eeuo pipefail
expected_endpoint='unix:///var/run/docker.sock'
current_context="$(docker context show)"
current_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' "$current_context")"
effective_endpoint="${DOCKER_HOST:-$current_endpoint}"
if [[ "$current_endpoint" != "$expected_endpoint" || "$effective_endpoint" != "$expected_endpoint" || ! -S /var/run/docker.sock ]]; then
  echo "This job requires the disposable host system Docker socket." >&2
  exit 1
fi
container_ids="$(docker ps -aq)"
if [[ -n "$container_ids" ]]; then
  echo "This job refuses a host with pre-existing containers." >&2
  exit 1
fi

readonly docker_package_version='5:29.6.1-1~ubuntu.24.04~noble'
readonly docker_gpg_sha256='1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570'
docker_gpg_key="$(mktemp)"
trap 'rm -f -- "$docker_gpg_key"' EXIT
curl --fail --silent --show-error --location \
  https://download.docker.com/linux/ubuntu/gpg \
  --output "$docker_gpg_key"
printf '%s  %s\n' "$docker_gpg_sha256" "$docker_gpg_key" | sha256sum --check --status

. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_CODENAME" == noble ]] || {
  echo "The reviewed Docker package is pinned to Ubuntu 24.04 noble." >&2
  exit 1
}
sudo install -m 0755 -d /etc/apt/keyrings
sudo install -m 0644 "$docker_gpg_key" /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$(dpkg --print-architecture)" "$VERSION_CODENAME" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

conflicting_packages=(
  docker.io docker-doc docker-compose docker-compose-v2 podman-docker
  containerd runc moby-engine moby-cli moby-buildx moby-compose
)
installed_conflicts=()
for package in "${conflicting_packages[@]}"; do
  if dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii '; then
    installed_conflicts+=("$package")
  fi
done
if ((${#installed_conflicts[@]} > 0)); then
  sudo apt-get remove --yes "${installed_conflicts[@]}"
fi

sudo apt-get update
apt-cache madison docker-ce | awk '{print $3}' | grep -Fx -- "$docker_package_version" >/dev/null
apt-cache madison docker-ce-cli | awk '{print $3}' | grep -Fx -- "$docker_package_version" >/dev/null
sudo apt-get install --yes --no-install-recommends --allow-downgrades \
  docker-ce=$docker_package_version \
  docker-ce-cli=$docker_package_version \
  containerd.io \
  docker-buildx-plugin
sudo systemctl enable --now docker.service
[[ "$(docker version --format '{{.Server.Version}}')" == 29.6.1 ]] || {
  echo "Docker Engine is not the reviewed 29.6.1." >&2
  exit 1
}
