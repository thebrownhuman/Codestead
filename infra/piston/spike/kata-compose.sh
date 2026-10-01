#!/usr/bin/bash
# Throwaway spike: start the REAL compose.yaml piston service (hardened config)
# under Kata and check it serves code, contains it, and stays healthy.
# Expects Kata already installed by kata-spike.sh in the same job.
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
here=$(cd "$(dirname "$0")" && pwd)
cd "$root"

docker build -q -t codestead-piston:compose infra/piston >/dev/null
sha=$(printf 'a%.0s' $(seq 40))
img="ghcr.io/x/y@sha256:$(printf '1%.0s' $(seq 64))"
# Render only the piston service with the same inputs the compose validator uses.
env APP_RUNTIME_IMAGE="$img" APP_TOOLING_IMAGE="$img" APP_WORKER_IMAGE="$img" \
  APP_REGRADE_WORKER_IMAGE="$img" APP_PROJECT_REVIEW_WORKER_IMAGE="$img" \
  APP_SCANNER_WORKER_IMAGE="$img" APP_OPERATIONS_IMAGE="$img" \
  APP_NAME=Spike APP_URL=https://spike.example BOOTSTRAP_ADMIN_EMAIL=a@spike.example \
  SENTRY_RELEASE="$sha" PISTON_IMAGE=codestead-piston:compose COMPOSE_PROFILES= \
  docker compose --env-file infra/env/compose.env.example -f compose.yaml --profile piston \
  config --format json piston > /tmp/piston-compose.json
docker network create glitchtip-ingest >/dev/null 2>&1 || true
docker compose -p pistonspike -f /tmp/piston-compose.json up -d piston
sleep 45; echo "COMPOSE piston state: $(docker inspect -f {{.State.Status}} pistonspike-piston-1)"
docker logs pistonspike-piston-1 2>&1 | tail -5 || true
# The service publishes no port, so call it from a throwaway container on its network.
net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' pistonspike-piston-1)
docker run --rm --network "$net" -v "$here:/spike:ro" node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 \
  sh -c 'cp /spike/probe.mjs /spike/bench.mjs /tmp/ && sed -i "s|http://127.0.0.1:\${port}|http://piston:2000|" /tmp/probe.mjs /tmp/bench.mjs && node /tmp/probe.mjs 0 compose && node /tmp/bench.mjs 0 compose'
echo "COMPOSE egress from piston network: $(docker run --rm --network "$net" alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 sh -c 'wget -q -T 3 -O /dev/null http://1.1.1.1 && echo OPEN || echo blocked')"
