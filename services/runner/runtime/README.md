# Runtime images and native harness

These images are the only artifacts allowed to compile or execute learner code. They are built on the disposable runner VM, never on the NUC that stores accounts, provider credentials, or backups. Docker isolation is defense in depth; the dedicated KVM VM remains the security boundary.

## Reviewed linux/amd64 inputs

`images.env` pins child manifests, not floating/multi-platform tags. The versions observed by `npm run runtime:inspect` on 2026-07-13 are:

| Runtime | Tool version | Pinned source manifest |
|---|---|---|
| C | Alpine GCC 14.2.0-r6 (`-std=c23`) | `alpine:3.22@sha256:7c8cb692ae09657cbc4a3f3cbd0e8d5a2690ba38386aaaf252dbb060bf5eb2e6` plus exact `gcc` and `musl-dev` packages |
| C++ | Alpine G++ 14.2.0-r6 (`-std=c++20`) | same reviewed Alpine manifest plus exact `g++` and `musl-dev` packages |
| Java | Alpine OpenJDK 21.0.11_p10-r0 LTS | `alpine:3.23@sha256:1beb0dc0a51de7ff38e3b5274078a2e0b81113ba5c7535e1a03d5913a5edbda3` plus exact `openjdk21-jdk` package |
| Python | CPython 3.14.6 | `python:3.14-alpine3.23@sha256:e10f6e0f219a81c65c518e339e7e9bf2f8c63b6ba1bf112e1bb2d1e395ed0c17` |
| JavaScript | Node.js 22.23.1 | `node:22-alpine3.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737` with npm, npx, Corepack and Yarn removed |

The harness build uses the same digest-pinned Alpine 3.22 manifest and exact GCC/musl development package versions. Package specifications are validated before Docker receives them, all final Alpine package databases remain present for vulnerability detection and SBOM attribution, and `/sbin/apk` is removed only after installation. The native harness is statically linked against musl. No package database, scanner target, or finding is deleted or ignored to satisfy the release gate.

Changing any base digest is a release change: rebuild, inspect, scan, rerun contracts in the KVM, and replace all configured output digests atomically.

## Harness contract

`harness.c` compiles into `/opt/runner/execute`. It parses four fixed named arguments, rejects duplicates/unknowns/path traversal/symlinks/language mismatch, recursively selects only fixed source extensions, and launches absolute compiler/interpreter paths with `execv`. It never invokes a shell, `eval`, a package manager, or a learner-selected executable. Child environments are cleared and rebuilt from a minimal non-secret allowlist.

Normal compile/run mode preserves the runner API's bounded plain stdout/stderr contract. The machine-readable inspection protocol is:

```json
{"protocolVersion":1,"language":"python","compileThenRun":true,"shell":false}
```

Retrieve it with `/opt/runner/execute --describe`. Exit `0` means success; ordinary nonzero codes are learner compile/runtime failures; `125`–`127` are reserved for harness/container infrastructure failure; signal exits use `128 + signal` so the outer executor can recognize OOM/kill outcomes.

Every final image:

- defaults to numeric user/group `65532:65532`;
- contains no package-manager executable, application dependency, test bank, provider key, or runner HMAC secret;
- has no inherited entrypoint and exposes only the fixed harness as its default command;
- writes compiler artifacts under the per-container `/work` tmpfs;
- compiles again for each run/test container, so no artifact or hidden test state crosses jobs.

The outer executor additionally supplies `--network none`, read-only root/input, owned `0700` tmpfs mounts, no capabilities, `no-new-privileges`, exact CPU/memory/PID/file/output/wall limits, and `--interactive` solely to forward bounded test stdin.

## Local/KVM release sequence

From `services/runner`:

```bash
npm ci
npm test
npm run typecheck
npm run runtime:build
npm run runtime:inspect
npm run runtime:test
export RUNTIME_LOCAL_RISK_ACCEPTANCE=accept-unsigned-local-buildkit-provenance-v1
npm run runtime:scan
npm run runtime:record
```

The release host must use Docker's containerd image store. `runtime:build` requires the canonical decimal `RUNTIME_SOURCE_DATE_EPOCH` pinned in `images.env`. Local builds export each linux/amd64 image to a securely created temporary OCI archive with timestamp rewriting and that fixed epoch, disable embedded provenance/SBOM only for that deterministic export, load the archive, and verify two distinct content identities: the Docker-addressable platform-manifest digest and its image-config digest. Both the expected tag and canonical `repository@sha256:...` manifest reference must resolve to the same linux/amd64 descriptor and config. The archive directory is removed after success or failure. Registry pushes remain immutable and use maximum BuildKit provenance plus embedded SBOM attestations. `runtime:inspect` validates user, labels, empty entrypoint, structured harness metadata, exact tool versions, and both identities. `runtime:test` executes 17 real Docker contracts covering every language's success/error path plus stdin, read-only filesystem, writable ephemeral work, no network, hidden-environment stripping, cross-job cleanup, wall timeout, output cap, and PID exhaustion.
The source repository and revision are deliberately excluded from every Dockerfile `ARG`, environment value, and OCI label. Declaring even an unused source build argument changes the image config and creates a self-referential pin cycle whenever committed curriculum digests advance or a fork changes repository coordinates. `RUNTIME_SOURCE_REPOSITORY` and `RUNTIME_SOURCE_REVISION` are passed as undeclared BuildKit invocation parameters and are bound externally by the local provenance record or verified registry SLSA statement, release record, signature, and attestation. `runtime:inspect` rejects embedded `org.opencontainers.image.source` and `org.opencontainers.image.revision` labels, and the build-input contract rejects either source coordinate in the Dockerfile.

Therefore, identical runtime inputs must produce identical manifest and config digests across different source revisions. The curriculum pin generator consumes only the archive-verified `runtime-local-build-identities.json` handoff and writes `scripts/curriculum-runtime-pins.json`; scan/sign/record evidence remains a separate fail-closed release gate and is never treated as the curriculum authoring source.


For normalized local images, `runtime:scan` requires exactly Trivy 0.69.3 to generate an SPDX 2.3 document directly from each exact Docker-local manifest and to enforce the HIGH/CRITICAL vulnerability gate. It validates the complete SPDX document against the official SPDX 2.3 JSON schema and writes a `.spdx.target.json` checksum record binding the exact bytes to that manifest. Trivy is forced to the local Docker image source with OS, Java and version updates disabled plus offline dependency resolution; its main and Java databases must both match their reviewed schema versions and remain unexpired when `runtime:record` commits the release. Registry scans fetch the exact BuildKit in-toto statement with ORAS, verify its descriptor chain and linux/amd64 subject, and preserve those exact statement bytes. The completed `dist/runtime-security` directory is published atomically; a failed scan leaves only `dist/runtime-security.failed/failure.json` and can never be recorded. The gate has no missing-scanner bypass, ignore file, severity downgrade, VEX filter, `--ignore-unfixed` exception, online upload, or Docker Scout invocation.

Before an offline Trivy scan, preload its database into a trusted dedicated cache (CI does this automatically):

```bash
export RUNTIME_TRIVY_CACHE_DIR=/var/cache/codestead/trivy
trivy image --cache-dir "$RUNTIME_TRIVY_CACHE_DIR" --download-db-only
trivy image --cache-dir "$RUNTIME_TRIVY_CACHE_DIR" --download-java-db-only
```

Timestamp normalization and pinned inputs are repeatability controls; they are not a bit-for-bit reproducibility claim until two independent clean builders produce the same manifest and config digests. Local scan evidence is deliberately unsigned and therefore requires a clean Git worktree plus the explicit residual-risk decision `RUNTIME_LOCAL_RISK_ACCEPTANCE=accept-unsigned-local-buildkit-provenance-v1`. The manager records the exact source repository, revision, Docker/Buildx versions, Dockerfile, harness, pinned inputs, and image identities and fails closed if any required input is missing or changed.

`runtime:record` re-resolves every current identity and refuses stale security, inspection, runtime-contract, or real-executor evidence before atomically publishing `dist/runtime-images.env` and canonical commit marker `dist/runtime-images.json`. Local records use canonical Docker-addressable platform-manifest references (`repository@sha256:...`) and are suitable when images are built on the runner VM. For a registry release, install ORAS, Trivy, and Cosign; authenticate Docker/ORAS to the registry; publish a Cosign signature and signed SLSA v0.2 attestation for every exact child-manifest reference; then set the exact certificate policy and run:

```bash
export RUNTIME_REPOSITORY=registry.example/learncoding/runtime
export RUNTIME_RELEASE=2026-07-12.1
export RUNTIME_PUSH=1
export RUNTIME_COSIGN_CERTIFICATE_IDENTITY=https://github.com/example/repository/.github/workflows/release.yml@refs/heads/main
export RUNTIME_COSIGN_CERTIFICATE_OIDC_ISSUER=https://token.actions.githubusercontent.com
npm run runtime:build
for language in c cpp java python javascript; do
  docker pull --platform linux/amd64 "${RUNTIME_REPOSITORY}-${language}:${RUNTIME_RELEASE}"
done
npm run runtime:inspect
npm run runtime:test
export RUNTIME_TRIVY_CACHE_DIR=/var/cache/codestead/trivy
trivy image --cache-dir "$RUNTIME_TRIVY_CACHE_DIR" --download-db-only
trivy image --cache-dir "$RUNTIME_TRIVY_CACHE_DIR" --download-java-db-only
npm run runtime:scan
npm run runtime:record
```

The pushed record resolves the linux/amd64 child manifest separately from the attested root index. Deploy `runtime-images.json` and `runtime-images.env` as one reviewed pair; the JSON file is the canonical commit marker and the environment file must be its exact projection. Only then copy the five validated `RUNNER_IMAGE_*` values into `/etc/learncoding/runner.env`; startup rejects blank, floating, or malformed values, and job execution uses `--pull never`.

## Evidence that remains VM-specific

Local Docker Desktop contracts passed during development, but release still requires the runbook's KVM checks: NUC/LAN/metadata reachability, Docker-socket absence, VM firewall, reboot recovery, real two-job load, kernel/container escape posture, and a scan against the exact images deployed on that VM. Archive `dist/runtime-inspection.json`, `dist/runtime-contract-report.json`, `dist/runtime-images.json`, SBOMs, scanner output, Docker/host versions, and the signed operator decision with the release.
