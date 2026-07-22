# Fail-closed ingress quarantine and recovery

## Objective

Cloudflare ingress must never become reachable merely because Docker or the NUC restarted. The internal Codestead services may retain Docker restart recovery, but public ingress is authorized only after the trusted runtime, storage preparers, internal readiness, and public HTTPS checks pass. Recovery after a Docker daemon restart is automatic, bounded, fail-closed, and serialized with releases.

## Chosen architecture

`cloudflared` uses the exact bounded policy `restart: on-failure:5`. This is only a secondary guard against consecutive fast process failures: Docker resets the failure counter after a sufficiently long successful run, and this policy does not authorize ingress or guarantee activation after a daemon restart. A root-owned `start-production-stack.sh` plus the guarded recovery timer remain the only authorities that may expose the tunnel. The transaction:

1. authenticates its fixed production paths and delegated executables;
2. obtains the existing release lock and installs the fail-closed cleanup trap;
3. rejects an active release-candidate quarantine marker;
4. stops `cloudflared` before any runtime validation, preparation, or internal start;
5. authenticates the PostgreSQL image identity and both privileged preparers;
6. prepares PostgreSQL and object storage;
7. runs the full runtime validator;
8. starts the exact internal pilot inventory, adding ClamAV/scanner only when uploads are explicitly enabled;
9. runs `smoke-production.sh --phase internal`;
10. starts only `cloudflared` with `--no-deps`;
11. runs `smoke-production.sh --phase public`.

An exit trap stops `cloudflared` again after every failure, including tunnel-start and public-smoke failures. The same script is used by systemd start, reload, and automatic daemon-recovery paths, so reload cannot strand a failed tunnel publicly exposed.

## Release quarantine

`/var/lib/learncoding/ingress-control/release-quarantine` is a distinct persistent marker containing exactly `codestead-release-quarantine-v1` plus one newline. The control directory is `root:root` mode `0700`; the marker is a regular, one-link, non-symlink `root:root` mode `0600` file. Every parent component is root-owned and not group/world writable.

A release atomically creates and fsyncs the marker and its directory before candidate mutation. It removes and directory-fsyncs the marker only after the candidate has passed internal and public smoke and the release commit point is durable. Every failure leaves the marker present and the tunnel down. A successful rollback removes it only after the restored runtime passes both smoke phases. Ordinary boot and automatic recovery never remove this marker.

## Automatic daemon recovery

A persistent one-minute systemd timer invokes `recover-production-ingress.sh`. A validated healthy tunnel is a true no-op only after the exact Compose project has one tunnel and the combined internal/public smoke passes. Waiting, exhausted, and release-quarantined states are lock-serialized and keep ingress down without consuming an attempt. Docker unavailability is a fail-closed nonzero alert after lock-serialized cleanup is attempted; it never consumes an application-recovery attempt. A transaction already holding the shared release lock wins: the timer neither stops its tunnel nor changes recovery evidence, and guarded-start contention (`75`) is likewise neutral.

The timer never performs pre-start quarantine outside the lock. It preflights the lock and delegates mutation to `start-production-stack.sh`, which acquires that same lock, quarantines first, and records success before releasing it. After a guarded failure, the timer reacquires the lock, re-reads state, re-probes readiness, quarantines, and records exactly one failure. A state change or lock owner that wins this race remains authoritative.

Recovery state is separate from release quarantine. A canonical `recovery-state.env` records schema, failure count, incident start, and next-attempt epoch. Updates use a same-directory temporary regular file, `root:root` mode `0600`, atomic rename, file fsync, and directory fsync. The backoff is 30, 60, 120, and 240 seconds after successive failures, with five total attempts. Every eligible attempt has a mechanically enforced 60-second worst path, followed by at most 10 seconds of fail-closed cleanup inside the service's 90-second deadline. Exhaustion occurs within 12.5 minutes of the first eligible attempt. The fifth failure atomically publishes a distinct `recovery-exhausted` marker and logs one terminal error. Later timer invocations do not retry.

Production Docker authority is fixed to `unix:///var/run/docker.sock`; context, TLS/config, Compose-file, and project-name overrides are removed, the project name is explicitly `learncoding`, and `COMPOSE_PROFILES` must remain empty for this pilot. The release lock is an exact one-link `root:root` mode `0600` file. Its expected parent alone may use Ubuntu's root-owned sticky mode `1777` (`/run/lock`); every other trusted ancestor remains non-writable.

A root-only explicit reset command removes only validated recovery state/exhaustion files and fsyncs the directory. It never removes release quarantine. Successful automatic recovery clears non-exhausted recovery state durably. Stale, malformed, symlinked, hard-linked, incorrectly owned, or incorrectly permissioned state fails closed and cannot authorize ingress.

## Systemd behavior

`learncoding-compose.service` runs the guarded transaction for both `ExecStart` and `ExecReload`, with an exact per-command PATH. Internal containers retain `unless-stopped`; the tunnel alone uses `on-failure:5`, while the one-minute recovery timer remains the authorization mechanism. The timer is enabled at boot and its oneshot has a bounded timeout and failure alert. It does not alter Docker, unrelated containers, existing host services, database schema, or release state.

After full power restoration, the enabled Compose unit runs the gate normally. After an explicit or unexpected Docker daemon restart, internal containers recover through their existing policies; `on-failure:5` is not trusted to activate or authorize the tunnel. The recovery timer replays the guarded transaction and exposes ingress only after both phases pass.

## Failure semantics

- Validator, preparer, internal start, or internal smoke failure: tunnel stays down.
- Tunnel start or public smoke failure: the trap stops the tunnel again.
- Release in progress or failed candidate marker: automatic recovery defers without changing retry state.
- Docker unavailable: automatic recovery alerts nonzero, attempts safe lock-serialized cleanup, and consumes no application attempt.
- Transient eligible failure: persistent counter/backoff advances atomically.
- Five eligible failures: persistent exhaustion, one terminal log, explicit operator reset required.
- Corrupt or forged control state: no state repair and no ingress start.

## Verification

Tests use isolated fake Docker, smoke, clock, lock, and timeout commands and assert exact argv and trace order. Required cases include boot/reload, daemon loss, both smoke phases, transient versus persistent discovery/stop uncertainty, five-attempt exhaustion, reset, malformed state, release quarantine, guarded-start exit `75`, at least five concurrent timer ticks, state-change races, sticky-lock ancestry, ambient endpoint/profile attacks, and a forced worst-path timeout trace totaling exactly 60 seconds. Static tests pin the tunnel restart policy, explicit internal inventory, `--no-deps` tunnel start, 60+10<90 deadline envelope, local Docker/project authority, timer contract, and PATH boundaries. Existing physical NUC AC-cut, Cloudflare, and live Docker-daemon evidence remain external release blockers; repository tests do not fabricate them.

## Alternatives rejected

Multiple `ExecStartPost` lines were rejected because a failed reload does not guarantee transactional tunnel cleanup. A separate long-running ingress unit was rejected because it broadens installer and dependency state without improving the single guarded transaction. Unbounded `always` and `unless-stopped` tunnel policies were rejected because they can expose ingress without a fresh readiness decision; `on-failure:5` is retained only as bounded consecutive-crash containment and never substitutes for the guarded timer.
