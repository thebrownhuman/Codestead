# Codestead NUC Production Deployment Design

**Date:** 2026-07-14

**Status:** Approved for implementation with mandatory power-loss recovery gate

**Audience:** Codestead administrator and maintainers

**Scope:** Private pilot deployment on the existing Ubuntu NUC

## 1. Outcome

Deploy Codestead as a recoverable, private production service for the first two learners, with a safe path to roughly twenty learners. The deployment must preserve every service already running on the NUC, expose Codestead only through a dedicated Cloudflare Tunnel, and execute untrusted learner code only inside a dedicated KVM guest.

This design deliberately separates application readiness from curriculum editorial status. Draft lessons may be visible with their existing draft labels, but draft content cannot award mastery, certificates, or verified-course claims.

## 2. Verified host baseline

The target host was verified after upgrade and reboot:

- Ubuntu 24.04.4 LTS, kernel 6.8.0-134-generic.
- Intel i7-1165G7, 4 cores / 8 threads, with KVM available at `/dev/kvm`.
- 32 GB RAM and about 1 TB primary storage.
- Docker Engine 29.6.1 and Docker Compose 5.3.1.
- cloudflared 2026.7.1 and Tailscale 1.98.8.
- Docker, cloudflared, and tailscaled are active.
- No failed systemd units after making the unplugged Ethernet interface optional.
- No standard Ubuntu package updates pending. Ubuntu Pro/ESM Apps remains optional hardening, not a pilot blocker.
- Existing portfolio, email service, roadmap tracker, Nginx, and Watchtower containers recovered after reboot.

The existing host cloudflared service, its credentials, existing containers, ports, networks, and reverse proxy configuration are out of scope and must not be modified by Codestead automation.

## 3. Deployment modes

### 3.1 Pilot mode

Pilot mode is the mandatory first rollout:

- Two initial learners, one administrator.
- File uploads disabled fail-closed.
- ClamAV and the upload scanner are not started.
- Code runner limited to exactly two concurrent jobs.
- Gmail API mail adapter enabled after credentials are configured.
- Dedicated Codestead Cloudflare Tunnel route.
- Backups and one restore drill completed before invitations are sent.

`UPLOADS_ENABLED=false` is explicit, not inferred from a missing scanner. Upload creation endpoints return a clear feature-disabled response before reading request bodies. The UI hides or disables upload controls. Existing file metadata and administrator cleanup remain usable if files exist from a future full-mode deployment.

### 3.2 Full mode

Full mode is an explicit later promotion:

- `UPLOADS_ENABLED=true`.
- Compose `uploads` profile starts ClamAV and the scan worker.
- Uploads remain quarantined until a successful malware scan.
- Host capacity, malware definitions, scanner health, and backup capacity are revalidated before promotion.

ClamAV is not a dependency of pilot startup. The full-mode promotion is a separately tested operational change.

## 4. Topology

```text
Internet
  |
  v
Cloudflare edge
  |
  v
Dedicated Codestead cloudflared container (no host port)
  |
  v
Codestead frontend network
  |
  +--> Next.js application
          |
          +--> private data network --> PostgreSQL
          +--> dedicated egress networks --> Gmail / AI providers / GitHub
          +--> runner egress --> KVM runner guest on libvirt NAT

NUC host
  +--> existing services (unchanged)
  +--> Codestead Compose project
  +--> libvirt/KVM runner guest
  +--> local encrypted backups
  +--> dedicated 2 TB backup disk when attached
```

The Compose project retains existing internal `learncoding` path and unit names for compatibility, while the product name and public UI remain Codestead. Renaming internal paths is not required for production safety and would increase migration risk.

## 5. Trusted application stack

### 5.1 Container policy

Every Codestead service must have:

- A reviewed immutable image digest in production configuration.
- `restart: unless-stopped` for long-running services and `restart: "no"` for one-shot jobs.
- Read-only root filesystem where supported.
- All Linux capabilities dropped and `no-new-privileges` enabled.
- Explicit CPU, memory, PID, tmpfs, log rotation, and network limits.
- `com.centurylinklabs.watchtower.enable: "false"` so the host Watchtower never changes Codestead automatically.
- No published host ports.

Application build targets use separate full image-reference variables so each runtime, tooling, and worker artifact can be recorded by immutable image ID or registry digest. Production release automation never derives several mutable tags from one base tag. The release transaction builds or pulls the complete reviewed set, records IDs, acquires a PostgreSQL advisory lock, migrates, seeds, recreates the stack, and verifies readiness. Watchtower is opt-out only; it never performs a Codestead release.

Only cloudflared reaches the application frontend. PostgreSQL is reachable only on the internal data network. No worker receives a network or secret it does not need.

### 5.2 Secrets

Production secrets remain file-backed Compose secrets. They are never committed, embedded in images, printed by scripts, or stored in `.env`.

Host policy:

- Secret directory: root-owned, group-owned by a dedicated `codestead-secrets` group, mode `0750`.
- Secret files: root-owned, group-owned by that group, mode `0440`.
- A fixed, documented numeric GID is supplied to secret-consuming containers through `group_add`.
- Only services mounting secrets receive the supplemental group.
- The runtime validator checks owner, group, exact permissions, presence, non-empty values, and the complete required inventory for the selected profile.
- Secret values are never displayed by validation output.

The required pilot database inventory is `postgres_password` plus five URLs: `database_bootstrap_url` for fixed user `learncoding`, `database_url` for `learncoding_app`, `database_migrator_url` for `learncoding_migrator`, `database_worker_url` for `learncoding_worker`, and `database_ops_url` for `learncoding_ops`. The bootstrap URL shares only the bootstrap password; every restricted role has its own distinct URL-safe password, and all six files contain no trailing newline, whitespace, or control byte. The rest of the pilot inventory includes the auth secret, lost-device proof key, deletion tombstone key, credential master key, runner shared secret, Gmail credentials when Gmail is enabled, optional Google OAuth secret when Google sign-in is enabled, and the new Cloudflare Tunnel credentials.

The NVIDIA NIM and 21st.dev credentials previously pasted into chat must be revoked and regenerated before production. They must not be reused.

### 5.3 Credential recovery

The credential master key is intentionally excluded from database backups. A separate encrypted recovery kit must contain:

- The credential master key.
- The `age` recovery identity or documented recovery-key location.
- Cloudflare tunnel recovery information.
- Gmail OAuth recovery information.
- A checksum and creation timestamp.

One encrypted copy goes to the dedicated 2 TB backup disk and one to the emergency USB. A restore drill must prove that a database restore plus the recovery key can decrypt a test provider credential. Losing this key permanently makes restored learner API-key ciphertext unreadable.

## 6. Database initialization and administration

Database migration remains a required one-shot dependency before the application starts.

The migration command acquires a deployment-scoped PostgreSQL advisory lock before running Drizzle migrations and releases it in a `finally` path. Concurrent deployment or operator migration attempts fail or wait with a bounded timeout rather than racing.

Two additional one-shot services use an explicit `operations` profile:

1. `platform-seed` stages the filesystem curriculum and upserts provider policy, achievements, and project templates. It is idempotent.
2. `admin-bootstrap` creates the single initial administrator and refuses to elevate an existing learner or create a second administrator.

The operations image contains only the production dependencies and files required by these commands. The initial administrator password is read from a file-backed secret, never a Compose environment value. Bootstrap logs contain the event and administrator email, never the password. The account must change the temporary password, verify email, and enroll TOTP before provider credentials can be changed.

## 7. Isolated code runner

Untrusted learner code never runs in the trusted application Compose project or directly on the NUC host.

The runner is an Ubuntu KVM guest on the same NUC:

- 4 vCPU.
- 8 GB RAM.
- 100 GB thin-provisioned qcow2 disk.
- Stable MAC and DHCP reservation on the default private libvirt NAT network.
- No Wi-Fi bridge.
- Host-to-guest runner traffic only on the private runner API port.
- Exactly two concurrent jobs; excess requests queue.
- No application, database, Cloudflare, Gmail, AI-provider, backup, or host SSH secrets.
- Only the shared runner authentication secret is installed.

Inside the guest, every submission runs in an ephemeral, network-disabled sandbox with strict wall-clock, CPU, memory, process, filesystem, output, and source-size limits. C, C++, Java, Python, and JavaScript runtimes are pinned and verified. Workspaces are destroyed after each job. The service rejects replayed or expired signed requests and never accepts traffic from the public Internet.

The host firewall/libvirt rules must allow only the fixed Codestead gateway source to call the guest API. The deployment-level `RUNNER_BASE_URL` is the private runner VM upstream consumed only by the secretless `runner-egress-gateway` as `RUNNER_GATEWAY_UPSTREAM`; the effective container `RUNNER_BASE_URL` for the app and runner-consuming workers is `http://runner-egress-gateway:4100`. Only that gateway joins `runner-egress`. Formal exams and code execution are not enabled until an end-to-end runner smoke test passes from the application container through the gateway.

## 8. Cloudflare exposure

Codestead uses a new Cloudflare Tunnel identity and hostname. It does not reuse or edit the existing host tunnel.

- cloudflared runs inside the Codestead Compose project.
- It joins only the frontend network.
- It forwards the configured public hostname to `http://app:3000`.
- It uses a file-backed tunnel credential and a read-only config.
- No container publishes a host port.
- TLS terminates at Cloudflare; the app trusts only the configured public origin.
- Cloudflare origin checks and application host/origin checks reject alternate hosts.
- Preflight validates the hostname, application origin, credential path, upstream service, and final catch-all order. The tunnel exposes bounded local metrics/health only inside the Compose network.

DNS and tunnel creation are external deployment steps and cannot be proven by repository tests. They require recorded deployment evidence.

## 9. Health, observability, and failure behavior

The application exposes two unauthenticated, non-sensitive endpoints:

- Liveness: process is responding.
- Readiness: process is responding and a minimal database query succeeds.

The Compose application health check uses readiness rather than the home page. PostgreSQL retains `pg_isready`. Long-running workers emit structured startup, heartbeat, success, retry, and terminal-failure events without secrets or learner source. Container status and recent worker heartbeat are checked by the production smoke script.

The deployment smoke test verifies:

- Compose configuration resolves with immutable images.
- PostgreSQL is healthy and migrations completed.
- App readiness passes from inside the frontend network.
- Seed and bootstrap jobs completed successfully.
- Every expected worker is running.
- cloudflared is connected.
- Public HTTPS returns the correct origin and security headers.
- Runner health and a representative Python job pass through the application boundary.
- Upload creation is disabled in pilot mode.

An external monitor is recommended because a powered-off NUC cannot alert through itself. Local journald and container logs remain the diagnostic source, but they are not an availability monitor.

## 10. Backups and recovery

### 10.1 Backup sets

Nightly encrypted backups contain:

- A consistent PostgreSQL logical dump.
- Application object/data storage captured under a short maintenance/quiesce window so the database and files represent one recovery point.
- Deployment metadata: Git commit, image digests, schema migration state, timestamp, and manifest.
- Cryptographic checksums.

The credential master key is stored only in the separate recovery kit described above.

### 10.2 Validation before publication

Each new archive is encrypted with `age`, checksummed, decrypted to a temporary verification area, and structurally validated before it is marked successful or any older recovery point is pruned. A corrupt newest archive cannot advance the last-success marker.

The rclone configuration and `age` material are root-owned, reject symlinks, and use exact restrictive modes. Offsite verification downloads both the encrypted archive and checksum sidecar, validates the remote bytes locally, and then performs the isolated restore drill. Restore tooling rejects the live data roots and every destination nested below them.

### 10.3 Destinations and retention

- Primary local encrypted recovery points on the NUC.
- Copy to the dedicated 2 TB backup disk when attached.
- Encrypted rclone copy to the administrator's Google Drive.
- Emergency recovery kit on the 32 GB USB; the USB is not the primary rolling archive.
- Retention: 7 daily, 4 weekly, and 12 monthly recovery points.

Offsite health is based on the latest successfully uploaded recovery point and an explicit maximum age, not equality with today's local filename. This avoids false failures between scheduled offsite syncs.

### 10.4 Restore drill

Before learner invitations, a drill must download an encrypted archive from Google Drive, verify its checksum, decrypt it, restore into isolated temporary PostgreSQL and application-data locations, run schema and application smoke checks, prove test credential decryption using the recovery kit, and clean up the isolated drill resources.

Target pilot objectives are RPO 24 hours and RTO 4 hours. These are deployment objectives until measured by the recorded drill.

## 11. Scheduled operations

Systemd timers invoke Compose with the explicit production Compose file and env file. They never depend on the caller's working directory or shell environment.

Scheduled jobs include:

- Nightly backup and verification.
- Offsite synchronization.
- Backup freshness check.
- Periodic restore drill reminder or controlled drill.
- Data-retention lifecycle command with one canonical confirmation version.
- Storage reconciliation when uploads/full mode is enabled.

The retention confirmation token must be identical in `package.json`, Compose, systemd, tests, and documentation.

## 12. Deployment sequence

1. Revoke exposed provider credentials and create fresh production credentials.
2. Install only required host packages: libvirt/KVM tooling, `age`, and `rclone`; do not install Kubernetes.
3. Create the runner VM, pin its address, deploy the runner, and pass isolated runner tests.
4. Create Codestead directories, service group, exact permissions, secrets, env file, Cloudflare config, and backup destinations.
5. Run the preflight validator; any missing, weak, mismatched, or unpinned setting fails closed.
6. Build or pull the exact reviewed application images.
7. Render and inspect Compose configuration.
8. Start PostgreSQL and run migration.
9. Run platform seed.
10. Run single-admin bootstrap.
11. Start the pilot application and workers, without the `uploads` profile.
12. Start the dedicated cloudflared container.
13. Run internal, public, auth, runner, restart, and uploads-disabled smoke tests.
14. Create a backup and complete the first isolated restore drill.
15. Reboot the NUC once and prove automatic recovery without changing existing services.
16. Invite the first learner only after all required evidence passes.

## 13. Power-loss recovery

Power-cut recovery is a release gate, not an assumption.

### 13.1 Automatic startup chain

Deployment evidence must confirm the NUC firmware setting **Restore on AC Power Loss: Power On**. After power returns:

1. Ubuntu boots without an interactive prompt and mounts the required Codestead data filesystem by stable UUID. Optional removable backup disks use `nofail`/automount semantics so their absence alerts but never blocks application boot.
2. Docker, libvirtd, the libvirt default NAT network, cloudflared dependencies, and systemd timers start automatically.
3. The Codestead runner VM is marked for libvirt autostart.
4. The runner service inside the guest is enabled and uses `Restart=on-failure` with its durable journal.
5. The Codestead Compose systemd unit declares `RequiresMountsFor` for the application tree, configuration tree, and primary data root; waits for Docker; validates configuration; and starts already-reviewed pinned images with `--no-build` and no implicit pull. A bounded `Restart=on-failure`/backoff policy retries transient boot failures and alerts after exhaustion. Building and migration-coupled release work remain separate from boot recovery.
6. Long-running containers use `restart: unless-stopped`; one-shot migration, seed, bootstrap, retention, reconciliation, backup, and restore services do not loop.
7. Persistent systemd timers run a missed backup, retention, or health check after boot according to their timer semantics.
8. The health monitor waits for PostgreSQL recovery, application readiness, workers, runner, and tunnel, then records recovery or raises an external alert.

The target is public application readiness within 15 minutes of power restoration under the verified pilot load. Existing NUC services must recover exactly as they did before Codestead was installed.

PostgreSQL receives a 120-second graceful-stop budget and the application/workers receive 60 seconds for controlled reboot or shutdown. This reduces unnecessary SIGKILL recovery while sudden AC loss still relies on the crash-consistency contract below.

### 13.2 Durable-data contract

PostgreSQL uses its persistent bind mount with checksums and keeps `fsync=on`, `synchronous_commit=on`, and `full_page_writes=on`. Production configuration must reject unsafe durability overrides. PostgreSQL crash recovery replays WAL before the application readiness endpoint succeeds.

Every user-visible mutation is committed transactionally before success is returned. Idempotency keys protect retries after an ambiguous disconnect. Authoritative lesson/code drafts, exam autosaves, progress, rewards, audit records, provider budgets, mail outbox items, and work queues live in PostgreSQL rather than container filesystems. Object writes use write-temporary, file-fsync, atomic-rename, directory-fsync, then transactional metadata publication; deletion uses the inverse recoverable sequence and reconciliation detects divergence.

Lesson drafts and exam answers also use a browser-durable outbox rather than React memory or `sessionStorage` alone. Each entry is scoped to the authenticated user, session/device, course/skill or exam, and idempotency key; it contains no hidden tests, provider credentials, or server secrets. The client persists locally before showing `Saved locally`, retries on startup and bounded reachability probes, and deletes the entry only after an authoritative server acknowledgement. Logout, session revocation, exam finalization, and administrator deletion purge the relevant local records. Tests prove that offline edits survive tab/browser close and synchronize exactly once after recovery.

The runner fsyncs its privacy-safe job journal through atomic replacement. On guest restart, accepted queued or running work becomes a durable retryable recovery result rather than disappearing or awarding unknown evidence. Application reconciliation retains the original request identity.

No acknowledged, committed learning record may be lost after sudden power removal. The UI distinguishes `Saving locally`, `Saved locally`, `Syncing`, `Saved to Codestead`, and `Needs attention`. Browser-durable local work survives close/reopen, while the server guarantee begins at `Saved to Codestead`. Without a UPS, no system can truthfully guarantee the final keystroke before local persistence, an unacknowledged network request, or hardware writes falsely reported as durable. A UPS remains the only way to materially reduce that final in-flight window and uncontrolled hardware-shutdown risk.

### 13.3 Recovery rehearsal

After a verified backup and before learner invitations, perform one administrator-supervised AC-loss rehearsal:

- Record a known saved draft, progress mutation, audit event, queued mail item, and two runner jobs.
- Remove power without a graceful shutdown, restore it, and rely on firmware autostart.
- Verify filesystems are clean/recovered, PostgreSQL has no checksum errors, every acknowledged marker remains, ambiguous requests reconcile idempotently, runner jobs recover safely, and no duplicate XP/mail/evidence appears.
- Verify an offline lesson draft and exam answer persisted in the browser-durable outbox survive browser close/reopen and synchronize once after service recovery.
- Verify Docker services, runner VM, tunnel, persistent timers, existing NUC containers, and public HTTPS recover automatically.
- Run an immediate encrypted backup and compare database/object reconciliation reports.
- Record outage duration, recovery duration, SMART/NVMe health, container restart counts, PostgreSQL recovery logs, and the exact Git/image versions.

A failed rehearsal blocks learner invitations. Repeating destructive AC-loss tests is unnecessary after the mechanism is proven; subsequent releases use crash/restart simulations plus periodic controlled reboot tests.

## 14. Rollback

Every release records the previous application image tag/digest and Git commit.

- Application rollback changes the pinned image reference to the previous release and recreates only Codestead services.
- Database migrations must be backward-compatible for at least one application release. A destructive schema rollback requires restoring a verified recovery point instead of ad hoc SQL.
- The dedicated Cloudflare route can be disabled independently without touching existing tunnels.
- The runner VM can be stopped independently; the application must present code execution as unavailable rather than retry indefinitely.
- Pilot upload mode remains off unless full mode was explicitly approved.
- Existing NUC containers and host services are never part of Codestead rollback commands.

## 15. Test strategy

Implementation follows test-driven development. Required automated gates are:

- Unit tests for upload fail-closed behavior and bootstrap password-file loading.
- API tests for liveness/readiness without information leakage.
- Static Compose tests for uploads profile membership, Watchtower opt-out, no host ports, secret groups, explicit networks, resource limits, and one-shot operations services.
- Runtime validator tests for exact secret inventory and permission failures in pilot and full modes.
- Backup tests for corruption, partial snapshots, last-success handling, offsite staleness, and restore-drill download/decrypt/restore flow.
- Systemd/static tests for explicit Compose and env-file arguments plus the canonical retention token.
- CI build, typecheck, lint, security scanners, unit/integration suites, and Compose rendering.
- Builds of every application and runner target, SBOM generation, dependency/image vulnerability scanning, and recording of the exact deployable image identities.
- Deployment-only evidence for Cloudflare connectivity, KVM isolation, public HTTPS, Gmail delivery, backup destination, restore timing, reboot recovery, and real provider validation.
- Crash tests for PostgreSQL, every worker, the application, Docker daemon, runner guest/service, and interrupted backup; a same-NUC supervised AC-loss rehearsal proves the complete startup chain once.

The first implementation gate repairs the current semantic Compose inventory failure caused by the existing `reward-worker` service, then extends that validator for the new operations services and pilot/full profiles. CI must not skip PostgreSQL, browser, or curriculum-runtime jobs because an earlier application gate is red.

A disposable Linux production-topology test starts PostgreSQL, runs migrations twice, runs seed, creates a test administrator through the bootstrap service, starts the pilot stack with a stub runner, waits for readiness, verifies persistence across restart, and tears down cleanly. Same-NUC release evidence adds ten authenticated simulated learners, two concurrent runner jobs, queue backpressure, resource/temperature measurements, and rollback/reboot checks.

Tests may use fakes for external services, but the final production checklist clearly distinguishes automated proof from NUC evidence.

## 16. Resource envelope

Expected pilot steady-state memory is about 12–18 GB including the 8 GB runner VM, PostgreSQL, application, workers, Docker overhead, and existing services. Full mode with ClamAV may reach about 18–24 GB. CPU is bursty and bounded; the two-job runner limit protects the 4-core host.

At least 8 GB host memory and 15% root-disk capacity must remain available under the pilot load test. If those guards fail, invitations stop and capacity is adjusted before adding learners.

## 17. Non-goals

This rollout does not:

- Make the service generally public or commercial.
- Run learner code on learner laptops.
- Enable uploads in the first pilot.
- Install Kubernetes.
- Modify existing NUC services, host cloudflared routes, or open host ports.
- Claim all curriculum is human-reviewed.
- Promise 24/7 availability.
- Solve physical theft risk on the currently unencrypted root disk.

## 18. Acceptance criteria

Production pilot is ready only when all of the following are true:

- Repository checks and deployment regression tests pass from a clean checkout.
- No known exposed credential is used.
- Secrets are readable by intended containers and unreadable by unrelated users/services.
- Seed and single-admin bootstrap work from deployable one-shot services.
- Pilot starts without ClamAV and upload attempts fail closed.
- No Codestead host port is published and Watchtower cannot update Codestead.
- App readiness checks the database.
- The KVM runner passes authentication, isolation, limits, cleanup, queue, and representative language tests.
- Dedicated Cloudflare hostname works over HTTPS without altering existing routes.
- Gmail invitation delivery is proven.
- Backup creation, offsite copy, download, decrypt, restore, and credential recovery are proven.
- NUC reboot recovery is proven.
- Sudden AC-loss recovery preserves every acknowledged test marker, restarts the full trusted stack and runner automatically, creates no duplicate evidence, and restores public readiness within 15 minutes.
- Rollback to the previous application image is rehearsed or mechanically verified.
- The deployment evidence log records exact versions, image digests, Git commit, test results, backup ID, and unresolved risks.
