# Codestead isolated runner

This is a standalone Node/TypeScript HTTP service for authoritative compile, run, and visible/hidden-test jobs. It has no application, database, UI, or AI dependency.

## Security boundary

Deploy this service and its Docker daemon inside the dedicated runner VM, never on the trusted application host. The VM/firewall remains the primary boundary. The service intentionally has no application/database/provider credentials.

Each execution uses an immutable allowlisted image and a Docker argument array—never a shell command—with:

- network disabled;
- read-only container root;
- read-only source bind mount;
- separate size-bounded tmpfs mounts for temporary files and compilation;
- all Linux capabilities dropped;
- no-new-privileges;
- unprivileged UID/GID 65532;
- PID, memory/swap, CPU, wall-time, file, descriptor, and combined-output limits;
- forced cleanup after timeout/output-limit and temporary-directory cleanup in a finally block.

Docker containers are defense in depth, not a substitute for the runner VM. Do not expose this listener or its Docker daemon publicly.

## Runtime image contract

The service accepts only:

| Request value | Configured version |
|---|---|
| c | C23 / GCC 14.2.0 |
| cpp | C++20 / G++ 14.2.0 |
| java | Java 21 |
| python | Python 3.14 |
| javascript | Node.js 22 |

All five RUNNER_IMAGE_* values are mandatory and must be full OCI references ending in @sha256 followed by 64 hex characters. Floating tags are rejected at startup. The digest is returned with every result for reproduction and appeals.

Every learner container is labeled `io.learncoding.runner.job=true`. The VM service launcher removes only containers carrying that exact label before starting the runner, so a process orphaned by a runner crash cannot survive the next service start. Do not reuse this label for operator-managed containers.

Runtime images and the compiled no-shell harness now live under [`runtime/`](runtime/README.md). Each provides an executable `/opt/runner/execute` supporting this fixed interface:

    /opt/runner/execute +      --mode compile|run +      --language c|cpp|java|python|javascript +      --source-root /input +      --entrypoint /input/<validated-relative-path>

The harness must:

- write all compiler artifacts only below /work or /tmp;
- use exit 0 for success;
- use a nonzero code other than 125–127 for learner compile/runtime failure;
- emit only learner stdout on stdout and bounded diagnostics on stderr;
- compile again in run mode (the MVP favors isolation and hidden-test safety over caching);
- forward its stdin to the learner program in run mode;
- never require a network, writable root, extra capability, secret, or hidden expected output.

The service performs one compile container and then one fresh run container per test. Only the current test's stdin enters that container. Expected output and future hidden tests stay in the service process. Hidden normalized results contain only opaque ID/category, status, timing, exit code, and a learner-safe feedback code.

## Authentication

Except for GET /healthz, requests require:

- x-runner-timestamp: ten-digit Unix seconds;
- x-runner-nonce: 16–128 URL-safe characters, single use within the TTL;
- x-runner-signature: sha256=<hex HMAC>;
- x-request-id: required 8-128-character correlation ID and signature input;
- x-idempotency-key: required for POST /v1/jobs.

HMAC-v2 canonical request (GET uses an empty idempotency-key line):

    "LEARNCODING-RUNNER-HMAC-V2" + "\n" +
    UPPERCASE_METHOD + "\n" +
    PATH_WITHOUT_QUERY + "\n" +
    TIMESTAMP + "\n" +
    NONCE + "\n" +
    REQUEST_ID + "\n" +
    IDEMPOTENCY_KEY_OR_EMPTY + "\n" +
    SHA256_HEX(RAW_BODY)

The signature is HMAC-SHA256 with RUNNER_SHARED_SECRET. Signed responses include x-runner-response-signature over:

    REQUEST_ID + "\n" + STATUS_CODE + "\n" + SHA256_HEX(RESPONSE_BODY)

Timestamps outside the configured skew and nonce replay are rejected. Both the nonce TTL and durable idempotency TTL must be strictly greater than twice the configured maximum clock skew: a future-dated request accepted at one edge of the window remains cryptographically valid until the opposite edge, including across a runner restart that clears the in-memory nonce store. Startup rejects an unsafe relationship. Sign the exact raw JSON bytes sent; reserialization changes the signature and idempotency request hash. Binding request ID and idempotency key prevents an on-path party on the private link from redirecting a valid body into a different replay namespace. HMAC-v1 and v2 are intentionally incompatible: deploy the trusted app client and isolated runner together, stop intake during the brief rollout, and do not run mixed versions.

## API

### POST /v1/jobs

Returns 202 for a new job and 200 for an idempotent replay. The strict JSON schema rejects unknown fields, unsupported languages/extensions, unsafe paths, unpinned runtime versions, excessive files/source/tests/resources, and inconsistent mode fields.

Modes:

- COMPILE: source only;
- RUN: source plus optional top-level stdin;
- TEST: source, immutable testBundleVersion, and one or more VISIBLE/HIDDEN tests.

Compile and run results distinguish compile error, wrong answer, runtime error, timeout, memory/output limit, infrastructure failure, and accepted. Infrastructure failures are retryable operational outcomes, not learner failures.

### GET /v1/jobs/:jobId

Returns QUEUED, RUNNING, COMPLETED, or FAILED and a dynamic FIFO queue position while queued. Source and test inputs are never returned.

### GET /healthz

Unauthenticated minimal liveness/queue response. It contains no image, secret, source, or test data.

### GET /metrics

HMAC-authenticated Prometheus text for uptime, queue/active gauges, submissions, completions/failures, auth/idempotency/queue events, timeout, and output-limit counters.

## Queue and idempotency

The queue is FIFO with exactly two active jobs and bounded waiting depth. Idempotency keys are bound to the raw-body SHA-256; reuse with a different body is HTTP 409.

Job identity, privacy-preserving recovery results, request hashes, and idempotency bindings are also stored in a crash-safe runner-local journal. `RUNNER_STATE_ROOT` defaults to `/var/lib/learncoding-runner`, matching the example unit's systemd `StateDirectory`. The directory must be owned by the runner user with mode `0700`; the journal must be a regular, owned, non-symlink file with mode `0600`. Startup fails closed for corrupt state, unsafe permissions, unsupported schema, oversized files/arrays, or a mismatched job/idempotency binding. The journal is capped at 128 MiB and 100,000 job/binding records per array before detailed parsing or writing.

Each new QUEUED record and its idempotency binding is atomically written and fsynced before the queue can start work. RUNNING and terminal transitions use the same write-temp/fsync/rename/directory-fsync boundary. A persistence failure prevents new work and terminates the production process so systemd can restart it. On startup, prior QUEUED or RUNNING records become signed, GET-visible FAILED records with retryable error code `RUNNER_RESTART_RECOVERED`; the original submission/correlation IDs, request hash, timestamps, and idempotent POST replay remain available.

An unexpired durable idempotency binding is checked by key and raw-body hash before validating the request against the current runtime configuration. Therefore an exact replay still resolves its original job after an operator changes an image/version policy; a different body under that key remains HTTP 409. GET visibility and idempotent replay for a terminal job share that binding's TTL (24 hours by default). Expired terminal jobs and bindings are atomically removed at startup and before a new POST. An active job and its binding are retained even when the original TTL passes. If restart recovery terminalizes that job, its binding receives one fresh configured TTL from startup so the first exact POST still resolves the recovered job and changed-body reuse still returns 409; it is evicted only after that recovery grace expires. New requests and expired terminal bindings always use current validation.

The journal deliberately stores no submitted source, stdin, test input/expected bodies, or execution streams that could echo them. Live responses keep normal compiler/run stdout and stderr plus visible-test diagnostics while the process remains up. The recovery projection writes empty compile/run streams and metadata-only test outcomes with no per-test actual/expected/stderr fields. Consequently, a rare restart can degrade output detail for a recovered COMPLETED result while preserving status, totals, timings, runtime/image/hash evidence, and retry semantics. The trusted application should retain any full response it already received. The journal is runner-local operational state, not an application backup and must never be copied to the trusted app host.

## Local development

    npm install
    npm run typecheck
    npm test
    npm run build

On Windows, macOS, or Linux with Docker available, the repository root also
provides a development-only launcher:

    npm run runner:local

It reads only `RUNNER_SHARED_SECRET` and non-secret runner settings from the
root `.env`, reads the five recorded digest-pinned images from
`services/runner/dist/runtime-images.env`, and binds the service to
`127.0.0.1:4100`. Database, authentication, mail, and AI-provider credentials
are not copied into the runner process. Local state and temporary job files
stay under the ignored `services/runner/.local` directory. The launcher checks
Docker and every recorded image, removes only stale containers bearing the
runner job label, owns one local runner process, and passes the same inherited
descriptor contract verified by the service.

Keep this terminal open while using Code Lab. `Ctrl+C` stops the service. The
launcher is for local development only; production must continue to use the
Linux VM, systemd unit, kernel `flock`, and `infra/runner/run-runner.sh` below.
With the runner open, a second terminal can verify a real compile/run in every
recorded image without touching application evidence:

    npm run runner:smoke

The normal unit suite uses fake process/job executors. `npm run runtime:test` is a separate opt-in release contract that executes real learner fixtures in all five Docker images plus adversarial timeout/output/PID/filesystem/network/cleanup cases.

## Runner build artifact image

[`Dockerfile`](Dockerfile) produces a verification-only image from a digest-pinned base. It is useful for inspecting the compiled files and for generating recorded SBOM and vulnerability-scan evidence. It intentionally has no Docker CLI, `flock`, secret wiring, persistent state, exposed listener, or service entrypoint, and its default command exits with an error. It is not deployment-ready and must not be presented as a runnable runner-service image.

The only supported production path is the example systemd unit plus [`infra/runner/run-runner.sh`](../../infra/runner/run-runner.sh) on the isolated Linux runner VM. That host launcher acquires the kernel lifetime lock before reconciliation, provisions private state, removes labeled stale learner containers, and then passes the inherited lock descriptor to the service. Direct `npm start`, `npm run dev`, or `node dist/index.js` invocation lacks that descriptor and intentionally fails startup verification. The development-only `npm run runner:local` path does not replace or weaken that production boundary.

Linux runner validation is an external release gate: execute the reconciliation test, runtime-image contract tests, and a real signed compile/run job against the candidate systemd deployment inside a disposable runner VM. Build the verification-only image separately, generate an SBOM, run the approved CVE scanner, and retain those artifacts with the release record. Static validation and the ordinary unit suite do not launch Docker or the systemd service, so their green status is not image or deployment-smoke evidence.

## Runtime-image release gate

Before configuring a new digest:

1. Follow [`runtime/README.md`](runtime/README.md) to build, inspect, contract-test, scan, and record every image.
2. Verify exact compiler/interpreter version.
3. Run language parity and deterministic-output fixtures.
4. Run loop, fork-bomb, allocation, output/file growth, process, procfs, path, network, metadata, and cross-job isolation cases inside the dedicated disposable runner VM.
5. Confirm hidden expected/future test values never enter a learner container or normalized hidden result.
6. Record the digest and test artifact, then update the environment atomically.

Relevant primary documentation:

- Docker run security/resource options: https://docs.docker.com/reference/cli/docker/container/run/
- Docker seccomp: https://docs.docker.com/engine/security/seccomp/
- Docker rootless mode: https://docs.docker.com/engine/security/rootless/
- Node crypto/HMAC: https://nodejs.org/api/crypto.html
- Node child_process spawn with shell disabled: https://nodejs.org/api/child_process.html
