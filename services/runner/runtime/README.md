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
npm run runtime:scan
npm run runtime:record
```

`runtime:build` creates five local linux/amd64 images with BuildKit provenance/SBOM attestations. `runtime:inspect` validates user, labels, empty entrypoint, structured harness metadata, and exact tool versions. `runtime:test` executes 17 real Docker contracts covering every language's success/error path plus stdin, read-only filesystem, writable ephemeral work, no network, hidden-environment stripping, cross-job cleanup, wall timeout, output cap, and PID exhaustion.

`runtime:scan` extracts the SPDX document from each image's local BuildKit in-toto attestation, without uploading image metadata. It then requires Trivy or Grype with preloaded local vulnerability databases and fails when the scanner is missing or a HIGH/CRITICAL finding is present. Trivy is run with OS, Java and version updates disabled plus offline dependency resolution. The gate uses no ignore file, severity downgrade, VEX filter, or `--ignore-unfixed` exception. `ALLOW_MISSING_SCANNER=1` generates SBOMs but explicitly leaves the CVE gate incomplete; it exists only for local development and must never be used for a release decision. Docker Scout is intentionally not invoked because it may use an external service.

`runtime:record` writes `dist/runtime-images.env`. Local records use Docker-addressable immutable image IDs (`repository@sha256:...`) and are suitable when images are built on the runner VM. For a registry release:

```bash
export RUNTIME_REPOSITORY=registry.example/learncoding/runtime
export RUNTIME_RELEASE=2026-07-12.1
export RUNTIME_PUSH=1
npm run runtime:build
npm run runtime:scan
npm run runtime:record
```

The pushed record resolves the linux/amd64 child manifest. Copy all five generated `RUNNER_IMAGE_*` lines into `/etc/learncoding/runner.env`; startup rejects blank, floating, or malformed values, and job execution uses `--pull never`.

## Evidence that remains VM-specific

Local Docker Desktop contracts passed during development, but release still requires the runbook's KVM checks: NUC/LAN/metadata reachability, Docker-socket absence, VM firewall, reboot recovery, real two-job load, kernel/container escape posture, and a scan against the exact images deployed on that VM. Archive `dist/runtime-inspection.json`, `dist/runtime-contract-report.json`, `dist/runtime-images.json`, SBOMs, scanner output, Docker/host versions, and the signed operator decision with the release.
