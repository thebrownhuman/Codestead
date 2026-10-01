#!/usr/bin/bash
# Installs Piston inside the dedicated runner VM. Run as root in the guest.
#
#   install-piston-guest.sh <image.tar> <image-tar-sha256> <tag>
#
# The image tarball is built and saved on a host with internet access
# (docker build -t codestead-piston:<tag> infra/piston && docker save ...),
# then copied into the VM. Docker itself must already be installed in the
# guest (Ubuntu packages docker.io and docker-compose-v2, installed while the
# VM still had its provisioning egress). After this script, the guest has no
# egress at all.
set -Eeuo pipefail
umask 077
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "${EUID:-1}" == 0 ]] || fail 'run as root inside the runner VM'
[[ "$#" == 3 ]] || fail 'usage: install-piston-guest.sh <image.tar> <image-tar-sha256> <tag>'
image_tar=$1 expected_sha=$2 tag=$3
[[ -f "$image_tar" ]] || fail "image tarball not found: $image_tar"
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'sha256 must be 64 lowercase hex characters'
[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'invalid image tag'
command -v docker >/dev/null || fail 'docker is not installed in the guest'
docker compose version >/dev/null || fail 'docker compose plugin is not installed in the guest'

source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install_dir=/opt/codestead-piston
firewall=/etc/codestead/guest-piston.nft
firewall_unit=/etc/systemd/system/codestead-piston-firewall.service

actual_sha=$(sha256sum "$image_tar" | cut -d' ' -f1)
[[ "$actual_sha" == "$expected_sha" ]] || fail "image tarball sha256 mismatch: $actual_sha"

# Firewall first: no egress, ingress only from the host (SSH) and the app gateway.
install -d -m 0755 /etc/codestead
install -m 0644 "$source_dir/guest-piston.nft" "$firewall"
nft -c -f "$firewall" || fail 'guest firewall failed the syntax check'
cat > "$firewall_unit" <<'UNIT'
[Unit]
Description=Codestead Piston guest firewall (no egress)
DefaultDependencies=no
Before=network-pre.target docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/codestead/guest-piston.nft

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now codestead-piston-firewall.service
# Updates cannot reach the network any more; patch by rebuilding the VM image.
systemctl disable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true

docker load --input "$image_tar" >/dev/null
docker image inspect "codestead-piston:$tag" >/dev/null || fail "codestead-piston:$tag not in the tarball"

install -d -m 0755 "$install_dir"
install -m 0644 "$source_dir/compose.yaml" "$install_dir/compose.yaml"
printf 'PISTON_IMAGE_TAG=%s\n' "$tag" > "$install_dir/.env"
docker compose --project-directory "$install_dir" up -d --wait --wait-timeout 60

# Smoke test from inside the guest.
body='{"language":"python","version":"3.12.0","files":[{"content":"print(6*7)"}]}'
result=$(curl -fsS -m 10 -H 'content-type: application/json' -d "$body" http://127.0.0.1:4100/api/v2/execute) \
  || fail 'Piston smoke test request failed'
[[ "$result" == *'"stdout":"42\n"'* ]] || fail "Piston smoke test returned: $result"
printf 'Piston %s is running on :4100 with no egress.\n' "$tag"
