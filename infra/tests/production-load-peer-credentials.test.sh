#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || fail "peer-credential proof requires Linux"
[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
  || fail "disposable GitHub-hosted runner acknowledgement is required"
command -v docker >/dev/null || fail "Docker is required"
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ -d "$repo_root/.git" && ! -L "$repo_root" ]] || fail "repository root is unsafe"
helper_source="$repo_root/infra/ops/production-load-peer-credentials.py"
[[ -f "$helper_source" && ! -L "$helper_source" ]] || fail "reviewed peer helper is unsafe"
work="$(mktemp -d /tmp/production-load-peer-credentials.XXXXXX)"
[[ "$work" == /tmp/production-load-peer-credentials.* && -d "$work" && ! -L "$work" ]] \
  || fail "temporary proof directory is unsafe"
chmod 0700 "$work"

proof_label="com.codestead.proof=production-load-peer-credentials-v1"
image_id=""
runtime_image_id=""
cleanup() {
  local cid configured_image label
  if [[ -f "$work/proof.cid" && ! -L "$work/proof.cid" ]]; then
    cid="$(<"$work/proof.cid")"
    if [[ "$cid" =~ ^[0-9a-f]{64}$ ]] && docker inspect "$cid" >/dev/null 2>&1; then
      configured_image="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
      label="$(docker inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$cid" 2>/dev/null || true)"
      [[ "$configured_image" == "$runtime_image_id" && "$label" == production-load-peer-credentials-v1 ]] \
        && docker rm --force "$cid" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] && docker image inspect "$image_id" >/dev/null 2>&1; then
    label="$(docker image inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$image_id" 2>/dev/null || true)"
    [[ "$label" == production-load-peer-credentials-v1 ]] \
      && docker image rm --force "$image_id" >/dev/null 2>&1 || true
  fi
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/production-load-peer-credentials.* ]] \
    && rm -rf -- "$work"
}
trap cleanup EXIT

npm exec -- esbuild infra/tests/fixtures/run-production-load-peer-credentials-proof.ts \
  --bundle --platform=node --format=esm --target=node22 --packages=bundle \
  --charset=ascii --legal-comments=none --tree-shaking=true --log-level=warning \
  --outfile="$work/proof.mjs"
install -m 0444 "$helper_source" "$work/production-load-peer-credentials.py"

cat >"$work/Dockerfile" <<'DOCKERFILE'
ARG NODE_IMAGE
ARG PYTHON_IMAGE
FROM ${NODE_IMAGE} AS node_runtime
FROM ${PYTHON_IMAGE}
LABEL com.codestead.proof="production-load-peer-credentials-v1"
COPY --from=node_runtime --chown=0:0 --chmod=0755 /usr/local/bin/node /usr/local/bin/node
RUN mkdir -p /opt/learncoding/infra/ops /usr/bin \
 && chown 0:0 /opt/learncoding /opt/learncoding/infra /opt/learncoding/infra/ops \
 && chmod 0755 /opt/learncoding /opt/learncoding/infra /opt/learncoding/infra/ops \
 && install -o 0 -g 0 -m 0755 /usr/local/bin/python3.12 /usr/bin/python3.12
COPY --chown=0:0 --chmod=0444 production-load-peer-credentials.py /opt/learncoding/infra/ops/production-load-peer-credentials.py
COPY --chown=0:0 --chmod=0444 proof.mjs /opt/proof.mjs
ENTRYPOINT ["/usr/local/bin/node", "/opt/proof.mjs"]
DOCKERFILE

node_image="node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"
python_image="python:3.12.13-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b"
docker build --pull=false --iidfile "$work/image.id" \
  --build-arg "NODE_IMAGE=$node_image" --build-arg "PYTHON_IMAGE=$python_image" "$work" >/dev/null
image_id="$(<"$work/image.id")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "peer proof image identity is invalid"
runtime_image_id="$(docker image inspect --format '{{.Id}}' "$image_id")"
[[ "$runtime_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "peer runtime image identity is invalid"
[[ "$(docker image inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$image_id")" \
  == production-load-peer-credentials-v1 ]] || fail "peer proof image ownership is invalid"

proof_output="$(docker run --rm --cidfile "$work/proof.cid" --label "$proof_label" \
  --network none --read-only --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 128m --cpus 1 \
  --tmpfs /run:rw,noexec,nosuid,nodev,size=4m,mode=0755,uid=0,gid=0 "$image_id")" \
  || fail "Linux SO_PEERCRED proof failed"
[[ "$proof_output" == \
  'linux SO_PEERCRED proof passed: root peer=accepted non-root peer=denied adapter_calls=1' ]] \
  || fail "peer proof receipt is not canonical"

printf '%s\n' "$proof_output"
