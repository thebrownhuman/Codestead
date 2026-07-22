#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || fail "fixture lifecycle proof requires Linux"
[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
  || fail "disposable GitHub-hosted runner acknowledgement is required"
command -v docker >/dev/null || fail "Docker is required"
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ -d "$repo_root/.git" && ! -L "$repo_root" ]] || fail "repository root is unsafe"
work="$(mktemp -d /tmp/production-load-fixture-lifecycle.XXXXXX)"
[[ "$work" == /tmp/production-load-fixture-lifecycle.* && -d "$work" && ! -L "$work" ]] \
  || fail "temporary proof directory is unsafe"
chmod 0700 "$work"

proof_label="com.codestead.proof=production-load-fixture-lifecycle-v1"
image_id=""
runtime_image_id=""
cleanup() {
  local cid configured_image label
  if [[ -f "$work/proof.cid" && ! -L "$work/proof.cid" ]]; then
    cid="$(<"$work/proof.cid")"
    if [[ "$cid" =~ ^[0-9a-f]{64}$ ]] && docker inspect "$cid" >/dev/null 2>&1; then
      configured_image="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
      label="$(docker inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$cid" 2>/dev/null || true)"
      [[ "$configured_image" == "$runtime_image_id" && "$label" == production-load-fixture-lifecycle-v1 ]] \
        && docker rm --force "$cid" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] && docker image inspect "$image_id" >/dev/null 2>&1; then
    label="$(docker image inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$image_id" 2>/dev/null || true)"
    [[ "$label" == production-load-fixture-lifecycle-v1 ]] \
      && docker image rm --force "$image_id" >/dev/null 2>&1 || true
  fi
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/production-load-fixture-lifecycle.* ]] \
    && rm -rf -- "$work"
}
trap cleanup EXIT

npm exec -- esbuild scripts/run-production-load-fixture-lifecycle-proof.ts \
  --bundle --platform=node --format=esm --target=node22 --packages=bundle \
  --charset=ascii --legal-comments=none --tree-shaking=true --log-level=warning \
  --outfile="$work/proof.mjs"
printf '%s\n' \
  'schema=1' \
  'profile=codestead-production-load-disposable-network-v1' \
  'egress=default-deny' >"$work/production_load_network_attestation"

cat >"$work/Dockerfile" <<'DOCKERFILE'
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
FROM ${NODE_IMAGE}
LABEL com.codestead.proof="production-load-fixture-lifecycle-v1"
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
[[ "$runtime_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "runtime image identity is invalid"
[[ "$(docker image inspect --format '{{ index .Config.Labels "com.codestead.proof" }}' "$image_id")" \
  == production-load-fixture-lifecycle-v1 ]] || fail "proof image ownership is invalid"

docker run --rm --cidfile "$work/proof.cid" \
  --network none \
  --add-host production-load-postgres:127.0.0.1 \
  --add-host production-load-app:127.0.0.1 \
  --read-only \
  --user 65532:65532 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 256m \
  --cpus 1 \
  --env NODE_ENV=production \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65532,gid=65532 \
  --tmpfs /var/lib/learncoding-production-load-fixtures:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=65532,gid=65532 \
  --label "$proof_label" \
  "$image_id" >"$work/receipt.json" \
  || fail "isolated fixture lifecycle proof failed"

node - "$work/receipt.json" <<'NODE'
const fs = require("node:fs");
const receiptPath = process.argv[2];
const text = fs.readFileSync(receiptPath, "utf8");
if (Buffer.byteLength(text) < 500 || Buffer.byteLength(text) > 16 * 1024) throw new Error("receipt_size");
const value = JSON.parse(text);
if (`${JSON.stringify(value)}\n` !== text) throw new Error("receipt_not_canonical");
const faults = [
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
];
if (Object.keys(value).join(",") !== "schemaVersion,profile,generatedAt,readiness,faults"
  || value.schemaVersion !== 1
  || value.profile !== "codestead-production-load-disposable-lifecycle-v1"
  || new Date(value.generatedAt).toISOString() !== value.generatedAt
  || value.readiness.postgresRoundTrip !== true
  || JSON.stringify(value.readiness.providerStatuses) !== JSON.stringify({ gmail: 204, ai: 204, drive: 204 })
  || value.readiness.authenticatedLearnerCount !== 10
  || value.readiness.authenticatedLearnerSetSha256 !== "sha256:f122b8a5546574f39d920d14f7b2a29d3c55f84321706c99e00ea1655ff7c11d"
  || value.readiness.runnerMaxConcurrentJobs !== 2
  || value.readiness.runnerQueuedJobsObserved < 1
  || JSON.stringify(value.faults.map((item) => item.faultId)) !== JSON.stringify(faults)) {
  throw new Error("receipt_contract");
}
for (const fault of value.faults) {
  if (Object.keys(fault).join(",") !== "faultId,baselineHealthy,baselineAlertVisible,recoveryHealthy,recoveryAlertVisible,authenticatedJourneySteady,authenticatedJourneyRecovered,authenticatedJourneyLearnerCount,acknowledgedMutationFailures,runnerMaxConcurrentJobs,secretLeakFindings"
    || fault.baselineHealthy !== true
    || fault.baselineAlertVisible !== false
    || fault.recoveryHealthy !== true
    || fault.recoveryAlertVisible !== true
    || fault.authenticatedJourneySteady !== true
    || fault.authenticatedJourneyRecovered !== true
    || fault.authenticatedJourneyLearnerCount !== 10
    || fault.acknowledgedMutationFailures !== 0
    || fault.runnerMaxConcurrentJobs !== 2
    || fault.secretLeakFindings !== 0) throw new Error("fault_receipt_contract");
}
NODE

echo 'production load fixture lifecycle proof passed: learners=10 runner_max=2 queued>=1 faults=7'
