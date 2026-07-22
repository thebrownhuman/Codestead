#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || fail "disposable sandbox proof requires Linux"
[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
  || fail "disposable GitHub-hosted runner acknowledgement is required"
command -v docker >/dev/null || fail "Docker is required"
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ -d "$repo_root/.git" && ! -L "$repo_root" ]] || fail "repository root is unsafe"
work="$(mktemp -d /tmp/production-load-disposable-sandbox.XXXXXX)"
[[ "$work" == /tmp/production-load-disposable-sandbox.* && -d "$work" && ! -L "$work" ]] \
  || fail "temporary proof directory is unsafe"
chmod 0700 "$work"

proof_label="com.codestead.proof=production-load-disposable-sandbox-v1"
image_id=""
runtime_image_id=""
cleanup() {
  local cid cidfile configured_image label
  for cidfile in "$work"/*.cid; do
    [[ -f "$cidfile" && ! -L "$cidfile" ]] || continue
    cid="$(<"$cidfile")"
    [[ "$cid" =~ ^[0-9a-f]{64}$ ]] || continue
    if docker inspect "$cid" >/dev/null 2>&1; then
      configured_image="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
      label="$(docker inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$cid" 2>/dev/null || true)"
      [[ "$configured_image" == "$runtime_image_id" && "$label" == production-load-disposable-sandbox-v1 ]] \
        && docker rm --force "$cid" >/dev/null 2>&1 || true
    fi
  done
  if [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] && docker image inspect "$image_id" >/dev/null 2>&1; then
    label="$(docker image inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$image_id" 2>/dev/null || true)"
    [[ "$label" == production-load-disposable-sandbox-v1 ]] \
      && docker image rm --force "$image_id" >/dev/null 2>&1 || true
  fi
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/production-load-disposable-sandbox.* ]] \
    && rm -rf -- "$work"
}
trap cleanup EXIT

npm exec -- esbuild infra/tests/fixtures/run-production-load-disposable-sandbox-proof.ts \
  --bundle --platform=node --format=esm --target=node22 --packages=bundle \
  --charset=ascii --legal-comments=none --tree-shaking=true --log-level=warning \
  --outfile="$work/proof.mjs"
printf '%s\n' \
  'schema=1' \
  'profile=codestead-production-load-disposable-network-v1' \
  'egress=default-deny' >"$work/production_load_network_attestation"

cat >"$work/Dockerfile" <<'DOCKERFILE'
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
LABEL com.codestead.proof="production-load-disposable-sandbox-v1"
RUN mkdir -p /run/secrets && chown 0:0 /run /run/secrets && chmod 0755 /run /run/secrets
COPY --chown=0:0 --chmod=0444 proof.mjs /opt/proof.mjs
COPY --chown=0:0 --chmod=0444 production_load_network_attestation /run/secrets/production_load_network_attestation
ENTRYPOINT ["/usr/local/bin/node", "/opt/proof.mjs"]
DOCKERFILE

node_image="node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"
docker build --pull=false --iidfile "$work/image.id" --build-arg "NODE_IMAGE=$node_image" "$work" >/dev/null
image_id="$(<"$work/image.id")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "proof image identity is invalid"
runtime_image_id="$(docker image inspect --format '{{.Id}}' "$image_id")"
[[ "$runtime_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "proof runtime image identity is invalid"
[[ "$(docker image inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$image_id")" \
  == production-load-disposable-sandbox-v1 ]] || fail "proof image ownership is invalid"

common=(
  --rm
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --pids-limit 32
  --memory 64m
  --cpus 0.5
  --label "$proof_label"
)

positive_output="$(docker run "${common[@]}" --cidfile "$work/positive.cid" \
  --network none --user 65532:65532 "$image_id")" \
  || fail "positive disposable sandbox proof failed"
[[ "$positive_output" == \
  'production load disposable sandbox proof passed: fixed-identities default-deny non-root' ]] \
  || fail "positive proof receipt is not canonical"

if docker run "${common[@]}" --cidfile "$work/root.cid" \
  --network none --user 0:0 "$image_id" >"$work/root.stdout" 2>"$work/root.stderr"; then
  fail "expected root identity rejection"
fi
grep -Fq 'unattested_sandbox' "$work/root.stderr" || fail "root rejection was not explicit"

if docker run "${common[@]}" --cidfile "$work/routed.cid" \
  --network bridge --user 65532:65532 "$image_id" >"$work/routed.stdout" 2>"$work/routed.stderr"; then
  fail "expected routed network rejection"
fi
grep -Fq 'unattested_sandbox' "$work/routed.stderr" || fail "routed rejection was not explicit"

echo 'production load disposable sandbox rejection proof passed: routed=denied root=denied'
