#!/usr/bin/bash
# Throwaway spike: measure the compose piston service under Kata for several
# Kata/compose tunings. Expects Kata installed by kata-spike.sh in this job.
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
here=$(cd "$(dirname "$0")" && pwd)
cd "$root"
conf=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml
sudo cp "$conf" /tmp/kata-base.toml
docker build -q -t codestead-piston:matrix infra/piston >/dev/null
sha=$(printf 'a%.0s' $(seq 40)); img="ghcr.io/x/y@sha256:$(printf '1%.0s' $(seq 64))"
env APP_RUNTIME_IMAGE="$img" APP_TOOLING_IMAGE="$img" APP_WORKER_IMAGE="$img" \
  APP_REGRADE_WORKER_IMAGE="$img" APP_PROJECT_REVIEW_WORKER_IMAGE="$img" \
  APP_SCANNER_WORKER_IMAGE="$img" APP_OPERATIONS_IMAGE="$img" \
  APP_NAME=Spike APP_URL=https://spike.example BOOTSTRAP_ADMIN_EMAIL=a@spike.example \
  SENTRY_RELEASE="$sha" PISTON_IMAGE=codestead-piston:matrix COMPOSE_PROFILES= \
  docker compose --env-file infra/env/compose.env.example -f compose.yaml --profile piston \
  config --format json piston > /tmp/piston.json
# The piston service publishes no port; add one for measurement only.
node -e 'const f="/tmp/piston.json",c=JSON.parse(require("fs").readFileSync(f));c.services.piston.ports=[{target:2000,published:"2100",host_ip:"127.0.0.1"}];c.networks.piston.internal=false;require("fs").writeFileSync(f,JSON.stringify(c))'
node -e 'const f="/tmp/piston.json",c=JSON.parse(require("fs").readFileSync(f));const s=c.services.piston;s.tmpfs=s.tmpfs.filter(t=>t.startsWith("/piston/jobs"));require("fs").writeFileSync("/tmp/piston-notmpfs.json",JSON.stringify(c))'

kata_rss() { ps -eo rss,comm | awk '/qemu|containerd-shim-kata|virtiofsd/ {s+=$1} END {printf "%d", s/1024}'; }

run_variant() { # label compose-file kata-settings...
  local label=$1 file=$2; shift 2
  sudo cp /tmp/kata-base.toml "$conf"
  sudo sed -i -E "s/^(\s*default_memory\s*=).*/\1 1536/" "$conf"
  for kv in "$@"; do
    key=${kv%%=*}; value=${kv#*=}
    sudo sed -i -E "s|^(\s*$key\s*=).*|\1 $value|" "$conf"
  done
  docker compose -p m -f "$file" down -t 1 >/dev/null 2>&1 || true
  local t0; t0=$(date +%s%N)
  docker compose -p m -f "$file" up -d piston >/dev/null
  until curl -sf -m 2 localhost:2100/api/v2/execute -H content-type:application/json \
      -d '{"language":"python","version":"3.12.0","files":[{"content":"print(1)"}]}' | grep -q '"stdout":"1'; do sleep 0.2; done
  echo "MATRIX $label cold_start_ms=$(( ($(date +%s%N) - t0) / 1000000 ))"
  sleep 3; echo "MATRIX $label rss_idle_mb=$(kata_rss)"
  node "$here/matrix.mjs" http://127.0.0.1:2100 "$label"
  for _ in 1 2 3; do node "$here/matrix.mjs" http://127.0.0.1:2100 load >/dev/null & done; sleep 6
  echo "MATRIX $label rss_load_mb=$(kata_rss)"; wait
  sleep 30; echo "MATRIX $label rss_after_30s_mb=$(kata_rss)"
  echo "MATRIX $label box_mounts: $(curl -s localhost:2100/api/v2/execute -H content-type:application/json -d '{"language":"python","version":"3.12.0","files":[{"content":"import os\nfor l in open(\"/proc/self/mounts\"):\n  p=l.split()\n  if p[1] in (\"/\",\"/box\",\"/tmp\",\"/piston/packages\") or p[1].startswith(\"/piston\"): print(p[1],p[2])"}]}' | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).run.stdout.replace(/\n/g,"; "))')"
  docker compose -p m -f "$file" down -t 1 >/dev/null 2>&1
}

run_variant before_tmpfs /tmp/piston-notmpfs.json
run_variant pr1_default /tmp/piston.json
run_variant vcpu2 /tmp/piston.json default_vcpus=2 default_maxvcpus=4
run_variant cache_always /tmp/piston.json default_vcpus=2 default_maxvcpus=4 'virtio_fs_cache="always"' 'virtio_fs_extra_args=["--thread-pool-size=4", "-o", "announce_submounts"]'
run_variant tuned_reclaim /tmp/piston.json default_vcpus=2 default_maxvcpus=4 'virtio_fs_cache="always"' 'virtio_fs_extra_args=["--thread-pool-size=4", "-o", "announce_submounts"]' reclaim_guest_freed_memory=true
