#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${CODESTEAD_DISPOSABLE_HOST:-}" != 1 ]]; then
  echo "Set CODESTEAD_DISPOSABLE_HOST=1 only on a disposable Docker host." >&2
  exit 64
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_dir
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
readonly repo_root
readonly postgres_image="postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394"
readonly node_image="node:22.23.1-alpine3.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737"
readonly suffix="$$-$RANDOM"
readonly network="codestead-db-acceptance-$suffix"
readonly postgres_container="codestead-db-acceptance-postgres-$suffix"

cleanup() {
  local status=$?
  trap - EXIT
  docker rm -f -- "$postgres_container" >/dev/null 2>&1 || true
  docker network rm -- "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker image inspect "$postgres_image" >/dev/null
docker image inspect "$node_image" >/dev/null
docker network create "$network" >/dev/null
docker run --detach --pull never --name "$postgres_container" --network "$network" \
  --network-alias postgres \
  --env POSTGRES_USER=legacy_bootstrap \
  --env POSTGRES_PASSWORD=bootstrap-Fake-A-0000000000000000 \
  --env POSTGRES_DB=learncoding \
  "$postgres_image" >/dev/null

ready=false
for _ in $(seq 1 120); do
  if docker exec "$postgres_container" pg_isready \
    --username legacy_bootstrap --dbname learncoding >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.25
done
[[ "$ready" == true ]] || { echo "PostgreSQL did not become ready." >&2; exit 1; }

docker run --rm --pull never --network "$network" --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 512m \
  --volume "$repo_root:/repo:ro" --workdir /repo \
  --env POSTGRES_HOST=postgres \
  --env POSTGRES_USER=legacy_bootstrap \
  --env POSTGRES_PASSWORD=bootstrap-Fake-A-0000000000000000 \
  "$node_image" node infra/tests/database-least-privilege-integration.mjs
