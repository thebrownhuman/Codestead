# Load and capacity testing

The production release gate and the historical read-only projection smoke are separate commands. The production command is an authenticated, project-scoped client for the approved Ubuntu NUC drill. The projection smoke is only a small unauthenticated HTTP latency check and cannot satisfy the release gate.

## Production release gate

Before running, install the reviewed systemd catalog and host runtime as described in `docs/deployment.md`. The production client is the dedicated `learncoding-load-gate` account; it never receives database, Better Auth, Docker, libvirt, or KVM access. The root load-control daemon alone receives the two systemd credentials and owns the private fault journal. The separate root test-control daemon receives no application credential.

The dependency chain is `learncoding-production-load-gate.service` -> `learncoding-production-load-control.service` -> `learncoding-production-load-test-control.service` -> `learncoding-production-load-fixture-runtime.service`. The test-control service owns `/run/learncoding/codestead-production-load-test-control.sock` as `root:root` with mode `0600`; it validates the same approved decision, active release, and run manifest before and after every request. The non-root fixture container owns only `/run/learncoding-production-load-fixtures/runtime.sock` as UID/GID `65532` with mode `0600`. Both protocols accept only canonical, allowlisted, run-bound operations, have a maximum of two active requests, apply deadlines and cancellation, and emit stable, detail-free failures. Do not start the required services directly and do not grant the learner gate account access to either socket.

The disposable fixture runtime is implemented as a pinned, non-root, read-only, `--network none` container. It starts real loopback PostgreSQL and tunnel proxies, fake Gmail/AI/offsite providers, a bounded 32 MiB quota volume, stale-backup control, ten distinct authenticated synthetic learner sessions, and a measured two-slot runner queue. CI executes all seven disposable fault lifecycles and requires steady and recovered authenticated journeys, visible recovery signals, zero acknowledged mutation failures, and zero secret findings. The lifecycle receipt contains only fixed identifiers, counts, booleans, and hashes; it never persists session material.

This disposable proof does **not** replace physical NUC evidence. Host CPU, available RAM, disk I/O/free space, temperature, OOM/throttle counters, runner-VM telemetry, KVM identity, and the eight host/container/worker restart faults still come only from the root Linux control backend during the approved NUC run. A workstation or CI result cannot yield a release `PASS`; the gate remains `NOT_RUN` until the NUC decision, active release, recovery point, unrelated-container inventory, and runner VM are present and validated. Mocks, fabricated telemetry, or manually created sockets are never substitutes.

The disposable lifecycle proof is registered in Ubuntu CI as `production-load:fixture-runtime:lifecycle`. It is intentionally restricted to an acknowledged GitHub-hosted disposable runner and must not be repurposed as NUC release evidence.

Create the three-value, non-secret environment file from the reviewed example and edit only its values:

```bash
sudo install -o root -g root -m 0600 \
  /opt/learncoding/infra/env/production-load.env.example \
  /etc/learncoding/production-load.env
sudoedit /etc/learncoding/production-load.env
```

`/etc/learncoding/production-load.env` must contain only `LOAD_BASE_URL`, `LOAD_NUC_HOST_ID`, and `LOAD_RUNNER_VM_ID`. The root-owned mode-`0600` files `/etc/learncoding/secrets/database_url` and `/etc/learncoding/secrets/better_auth_secret` are loaded only by the control daemon. Publish the product-owner-approved, release-bound trust manifest as the root-owned mode-`0600` regular file `/etc/learncoding/production-load-manifest.json`; never generate or refresh it automatically during a run.

Confirm prerequisites, then start only the manual gate:

```bash
sudo /usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-host-runtime.sh
sudo docker image inspect \
  node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 >/dev/null
sudo /usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-fixture-runtime.sh
sudo systemctl is-enabled --quiet learncoding-production-load-recovery.path
sudo test -f /etc/learncoding/production-load-manifest.json
sudo test -f /etc/learncoding/secrets/database_url
sudo test -f /etc/learncoding/secrets/better_auth_secret
sudo systemctl start learncoding-production-load-gate.service
sudo systemctl show learncoding-production-load-gate.service \
  --property=ActiveState,SubState,Result,ExecMainStatus
sudo journalctl -u learncoding-production-load-test-control.service \
  -u learncoding-production-load-control.service \
  -u learncoding-production-load-gate.service --since today
```

Do not start `learncoding-production-load-control.service` directly. Do not start `learncoding-production-load-test-control.service` directly either. Starting the gate brings up both required root daemons, and `StopWhenUnneeded=yes` stops them after the bounded gate finishes. The gate accepts no command-line arguments and cannot award learner credit. Reports are written only below `/var/lib/learncoding-production-load-evidence`.

At boot, `learncoding-production-load-recovery.path` watches only `/var/lib/learncoding-production-load/production-load-fault-journal.json`. If that exact journal exists, it activates the distinct bounded `--recover-only` service. Recovery never listens on the control socket, never receives application credentials, and may use an expired manifest only to reset the exact journal-bound fault and clear the journal. Do not invoke recovery manually and do not create a journal as a trigger.

Unsupported arguments, legacy projection variables, cookies, token-like `LOAD_*` variables, a missing or unsafe manifest, an absent or unsafe socket, or an unavailable backend all fail closed.
The client uses real wall-clock time, aborts active HTTP/control work on `SIGINT` or `SIGTERM`, removes signal handlers, and closes client resources before returning. It writes exactly one sanitized JSON line containing only `verdict` and, when a validated artifact exists, `artifactPath` and `artifactSha256`. `PASS` exits zero. A report verdict of `FAIL`, a terminal `FAIL`, or `NOT_RUN` exits nonzero. Reports and terminal receipts use exclusive evidence publication and are never overwritten.

The fixed gate performs the approved 10-minute ramp, 60-minute sustained window, 10-minute drain, five-second resource sampling, and ordered project-scoped fault matrix. It seeds only the frozen synthetic data set and binds the decision, active release, public origin, NUC identity, runner VM identity, workload, faults, and report through the production orchestrator.

## Historical projection smoke

For a small local, read-only projection check:

```bash
LOAD_BASE_URL=http://127.0.0.1:3000 \
LOAD_CONCURRENCY=10 \
LOAD_REQUESTS_PER_SCENARIO=50 \
LOAD_P95_LIMIT_MS=1500 \
LOAD_REPORT_PATH=test-results/load-smoke.json \
npm run test:load:smoke
```

This command warms and samples landing, catalog, learning home, roadmap, and review projections without credentials or mutation traffic. It records HTTP counts and latency percentiles, but it does not exercise authenticated learner journeys, runner admission, PostgreSQL, NUC resources, fault recovery, or release evidence. Never use its result as a production gate verdict.
