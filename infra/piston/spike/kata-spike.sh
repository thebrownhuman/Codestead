#!/usr/bin/bash
# Throwaway spike (not for merge): Piston privileged under Kata Containers vs plain Docker.
set -Eeuo pipefail
KATA_VERSION=4.2.0
KATA_SHA256=b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8
here=$(cd "$(dirname "$0")" && pwd)

echo "::group::install kata"
sudo apt-get install -y -qq zstd >/dev/null
curl -fsSL -o /tmp/kata.tar.zst \
  "https://github.com/kata-containers/kata-containers/releases/download/$KATA_VERSION/kata-static-$KATA_VERSION-amd64.tar.zst"
echo "$KATA_SHA256  /tmp/kata.tar.zst" | sha256sum -c -
zstd -dc /tmp/kata.tar.zst | sudo tar x -C /
rm /tmp/kata.tar.zst
sudo ln -sf /opt/kata/runtime-rs/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm.rules >/dev/null
sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm
ls -l /dev/kvm
echo "kata config: $(readlink -f /opt/kata/share/defaults/kata-containers/configuration.toml)"
grep -E '^\s*(default_memory|default_vcpus)\s*=' /opt/kata/share/defaults/kata-containers/configuration.toml || true
echo "::endgroup::"

echo "::group::build piston image"
docker build -q -t codestead-piston:spike "$here/.."
echo "::endgroup::"

common=(--tmpfs /piston/jobs:exec,uid=1001,gid=1001,mode=711
  -e PISTON_RUN_MEMORY_LIMIT=268435456 -e PISTON_COMPILE_MEMORY_LIMIT=536870912
  -e PISTON_MAX_CONCURRENT_JOBS=2 -e PISTON_OUTPUT_MAX_SIZE=65536 -e PISTON_MAX_PROCESS_COUNT=32)
docker run -d --name plain --privileged -p 127.0.0.1:2000:2000 "${common[@]}" codestead-piston:spike >/dev/null
for _ in $(seq 60); do curl -sf localhost:2000/api/v2/runtimes >/dev/null && break; sleep 1; done
# Docker --privileged passes every host device to Kata, which runtime-rs cannot map.
# Inside Kata the cgroup tree belongs to the guest kernel, so try narrower variants.
kata_ok=
# Docker mounts cgroupfs read-only without --privileged; inside Kata it is the guest
# kernel cgroup tree, so remount it rw before Piston starts.
remount=(--entrypoint bash)
remount_cmd=(-c "mount -o remount,rw /sys/fs/cgroup && exec /piston_api/src/docker-entrypoint.sh")
for variant in "--cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt systempaths=unconfined"                "--cap-add ALL --security-opt systempaths=unconfined --security-opt seccomp=unconfined"                "--privileged"; do
  docker rm -f kata >/dev/null 2>&1 || true
  for _ in $(seq 30); do docker inspect kata >/dev/null 2>&1 || break; sleep 1; done
  # shellcheck disable=SC2086
  if ! docker run -d --name kata --runtime io.containerd.kata.v2 $variant -p 127.0.0.1:2001:2000 "${common[@]}" "${remount[@]}" codestead-piston:spike "${remount_cmd[@]}" >/dev/null 2>/tmp/kata-err; then
    echo "KATA VARIANT [$variant] create failed: $(head -c 300 /tmp/kata-err)"; continue
  fi
  for _ in $(seq 60); do curl -sf localhost:2001/api/v2/runtimes >/dev/null && break; sleep 1; done
  response=$(curl -s -m 30 localhost:2001/api/v2/execute -H content-type:application/json -d '{"language":"python","version":"3.12.0","files":[{"content":"print(6*7)"}]}' || true)
  echo "KATA VARIANT [$variant] execute response: ${response:0:600}"
  if curl -sf localhost:2001/api/v2/execute -H content-type:application/json -d '{"language":"python","version":"3.12.0","files":[{"content":"print(6*7)"}]}' | grep -q '"stdout":"42'; then
    echo "KATA VARIANT [$variant] WORKS"; kata_ok=1; break
  fi
  echo "KATA VARIANT [$variant] api failed:"; docker logs kata 2>&1 | tail -15 | cut -c1-300
done
[[ -n "$kata_ok" ]] || exit 1

echo "::group::kata containment (inside the container, privileged)"
echo "host kernel: $(uname -r)"
docker exec kata sh -c 'echo "container kernel: $(uname -r)"; echo "block devices: $(ls /dev | grep -E "^(sd|nvme|vd|xvd)" | tr "\n" " ")"; echo "mem total: $(grep MemTotal /proc/meminfo)"; echo "cgroup: $(cat /sys/fs/cgroup/cgroup.controllers)"; echo "host docker sock: $(ls /var/run/docker.sock 2>&1)"; echo "host procs visible: $(ls /proc | grep -c "^[0-9]")"' 2>&1 || echo "docker exec into kata failed (exit $?)"
node "$here/probe.mjs" 2001 kata || true
node "$here/probe.mjs" 2000 plain || true
echo "::endgroup::"

rss() { # host-side RSS in MB of the processes backing a container
  if [[ "$1" == plain ]]; then
    docker stats --no-stream --format '{{.MemUsage}}' plain
  else
    ps -eo rss,comm | awk '/qemu|cloud-hyp|containerd-shim-kata|virtiofsd|dragonball/ {s+=$1} END {printf "%.0f MiB (qemu+shim+virtiofsd RSS)\n", s/1024}'
  fi
}
echo "idle RSS plain: $(rss plain)"
echo "idle RSS kata:  $(rss kata)"

node "$here/bench.mjs" 2000 plain
node "$here/bench.mjs" 2001 kata

# Load: concurrency 2, mixed languages, then sample RSS.
for port in 2000 2001; do
  (for i in $(seq 6); do node "$here/bench.mjs" "$port" load >/dev/null & node "$here/bench.mjs" "$port" load >/dev/null; wait; done) &
done
sleep 8
echo "loaded RSS plain: $(rss plain)"
echo "loaded RSS kata:  $(rss kata)"
wait
echo "piston container RSS (inside, kata): $(docker exec kata sh -c 'ps -eo rss= | awk "{s+=\$1} END {print int(s/1024)\" MiB\"}"')"
