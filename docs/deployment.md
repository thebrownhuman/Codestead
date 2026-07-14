# Codestead deployment

This is the production reference for a single Ubuntu 24.04 NUC serving an initial private cohort of roughly ten invited learners. The trusted host runs the web app, PostgreSQL, the Gmail-capable transactional outbox worker, the deterministic regrade and practice-recovery coordinators, upload-scanning services, and Cloudflare Tunnel. Submitted code runs on a separate KVM virtual machine. No application, database, or runner port is published to the public internet.

## Topology and trust boundaries

```text
browser -> Cloudflare -> outbound Tunnel -> Next.js app -> PostgreSQL
                                         |                  ^
                                         |                  | scan worker (read-only objects)
                                         |                  +-> internal clamd -> signature-only egress
                                         +-> private LAN/VLAN -> runner VM:4100 -> no-network job containers
```

- `frontend` is the app/tunnel Compose network. It has outbound connectivity.
- `data` is an internal Compose network shared only by the app, migration job, outbox worker, regrade coordinators, practice recovery, upload scan worker, and PostgreSQL. Only the regrade, exam-finalization, and practice-recovery workers also join `runner-egress` and receive the runner HMAC secret; they receive no Gmail, AI-provider, object-storage, or Better Auth secret.
- PostgreSQL has a persistent bind mount and no host port.
- Uploaded objects are unavailable until the scan worker streams them to clamd. The worker has read-only object access; clamd has no object-storage or database access and only its signature updater has outbound connectivity.
- The runner is not in `compose.yaml`. Docker access is root-equivalent, so it belongs on an independently disposable VM with no database, OAuth, backup, Cloudflare, or learner-credential secrets.
- Cloudflare Tunnel is the only public ingress. Its last rule is an explicit 404 catch-all.
- This is a careful small deployment, not a high-availability service. A NUC, home power, and one ISP remain single points of failure; use a UPS and tested backups.

## Prerequisites

Use a clean Ubuntu Server 24.04 LTS installation with full-disk encryption where unattended reboot recovery is practical. Install Docker Engine and the Compose plugin from Docker's apt repository, not the convenience script. Docker publishes the current Ubuntu instructions in [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and [Install the Compose plugin](https://docs.docker.com/compose/install/linux/).

The trusted host also needs `age`, `git`, `rclone` only when offsite copying is enabled, and ordinary core utilities (`flock`, `sha256sum`, `tar`). Keep official Ubuntu security updates enabled; Canonical documents the defaults and drop-in configuration in [Automatic updates](https://documentation.ubuntu.com/server/how-to/software/automatic-updates/).

Required external setup:

- A DNS zone in Cloudflare and one locally managed tunnel.
- A private admin path (an admin VLAN or a VPN such as Tailscale) for SSH. Do not expose SSH broadly.
- A dedicated, mounted 2 TB backup filesystem.
- A second KVM VM or physical host for the runner.
- Two offline copies of the `age` private identity in separate physical locations.

## Place the release and create host directories

Install a reviewed release at `/opt/learncoding`. Do not deploy a developer working tree containing `.env` files or unreviewed changes.

```bash
sudo install -d -o root -g root -m 0755 /opt/learncoding
sudo install -d -o root -g root -m 0750 /etc/learncoding /etc/learncoding/cloudflare
sudo install -d -o root -g root -m 0700 /etc/learncoding/secrets
sudo install -d -o root -g root -m 0750 /srv/learncoding
sudo install -d -o root -g root -m 0700 /srv/learncoding/postgres
sudo install -d -o 1000 -g 1000 -m 0750 /srv/learncoding/next-cache /srv/learncoding/app-data
```

UID 1000 is the `node` user in the pinned base image. Recheck it whenever that base image changes. PostgreSQL's official entrypoint initializes and corrects ownership of its own empty data directory.

Copy the non-secret examples, then edit only the installed copies:

```bash
sudo install -o root -g root -m 0640 infra/env/compose.env.example /etc/learncoding/compose.env
sudo install -o root -g root -m 0600 infra/env/backup.env.example /etc/learncoding/backup.env
sudo install -o root -g root -m 0644 infra/cloudflare/config.example.yml /etc/learncoding/cloudflare/config.yml
```

Set the real HTTPS origin, private runner address, and immutable image references in `compose.env`. `POSTGRES_IMAGE`, `CLOUDFLARED_IMAGE`, and `CLAMAV_IMAGE` must end in `@sha256:` plus a reviewed 64-character digest. Use a reviewed version-specific `clamav/clamav:<version>_base` image with the persistent signature volume; floating tags, including `latest` and `stable`, are rejected by runtime validation. The reference reserves 4 GB for clamd because the official guidance warns that 2 GB may be insufficient after loading signatures.

The reference NUC target is `linux/amd64`. Keep `DEPLOY_PLATFORM=linux/amd64`; the Dockerfile deliberately pins the architecture-specific Node image manifest, not just a floating or wrong-architecture digest. An ARM development machine may build the NUC image through Docker emulation. A native ARM server needs a separate application/build and image-digest review.

## Create runtime secrets

Read [the secret inventory](../infra/secrets/README.md) first. Generate independent values in a root shell with `umask 077`; the following keeps values out of terminal output and avoids URL-encoding ambiguity by making the database password hexadecimal.

```bash
sudo -H bash
umask 077
openssl rand -hex 32 > /etc/learncoding/secrets/postgres_password
db_password=$(</etc/learncoding/secrets/postgres_password)
printf 'postgresql://learncoding:%s@postgres:5432/learncoding\n' "$db_password" > /etc/learncoding/secrets/database_url
unset db_password
openssl rand -base64 48 > /etc/learncoding/secrets/better_auth_secret
openssl rand -base64 48 > /etc/learncoding/secrets/lost_device_proof_key
openssl rand -base64 32 > /etc/learncoding/secrets/credential_master_key
openssl rand -base64 48 > /etc/learncoding/secrets/runner_shared_secret
: > /etc/learncoding/secrets/google_client_secret
: > /etc/learncoding/secrets/gmail_client_id
: > /etc/learncoding/secrets/gmail_client_secret
: > /etc/learncoding/secrets/gmail_refresh_token
chmod 0400 /etc/learncoding/secrets/*
exit
```

Copy `runner_shared_secret` once over a secure admin channel to `/etc/learncoding/runner-shared-secret` on the runner VM, then remove any transfer artifact. Never reuse it as an auth or encryption key.

If Google login is enabled, set the OAuth client ID in `compose.env`, place only the client secret in `google_client_secret`, and register the exact production callback origin in Google Cloud. If it is disabled, keep both the client ID and secret empty.

The Cloudflare tunnel credentials JSON must be issued by Cloudflare and installed directly as `/etc/learncoding/secrets/cloudflare_tunnel_credentials.json` with mode `0400`. It must never enter Git, an image layer, a backup archive, or a support message.

## Configure Cloudflare Tunnel

Replace the UUID and hostname in `/etc/learncoding/cloudflare/config.yml`. Keep the credential path at `/run/secrets/cloudflare_tunnel_credentials`, the origin at `http://app:3000`, and the final `http_status:404` rule. Cloudflare requires that catch-all and documents local validation in [Configuration file](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/).

The tunnel creates outbound-only connections. Cloudflare's [Tunnel configuration](https://developers.cloudflare.com/tunnel/configuration/) lists the required egress endpoints and TCP/UDP port 7844. Do not open inbound 80 or 443 on the NUC.

For a family deployment, put the app hostname behind a Cloudflare Access policy limited to invited email identities. Application authentication is still required; Access is an additional outer gate, not a replacement.

## Validate and start

The static validator does not need Docker or credentials:

```bash
node infra/tests/validate-static.mjs
```

On the NUC, runtime validation checks secret presence/permissions without printing values, private runner addressing, pinned images, data directories, tunnel catch-all, Docker availability, and the rendered Compose model:

```bash
sudo REPO_ROOT=/opt/learncoding COMPOSE_ENV_FILE=/etc/learncoding/compose.env \
  bash /opt/learncoding/infra/ops/validate-runtime.sh
```

Install and enable startup plus backup timers:

```bash
sudo REPO_ROOT=/opt/learncoding bash infra/ops/install-systemd.sh --enable
```

`learncoding-compose.service` builds images, waits for PostgreSQL health, runs migrations once, starts the app only after migrations succeed, and then starts the tunnel. It never runs `docker compose down -v`; persistent data is not tied to container lifecycle.

Inspect the first boot:

```bash
sudo systemctl status learncoding-compose.service
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml ps
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml logs --since 10m app migrate regrade-worker clamav scan-worker cloudflared
curl --fail --silent --show-error https://learn.example.com/ >/dev/null
```

Then verify login, onboarding, one lesson read, one quiz submission, and one code run using a non-admin learner account. Confirm PostgreSQL and runner port 4100 are unreachable from the public internet.

Before accepting uploads, follow [Upload scanning](runbooks/upload-scanning.md). Upload a harmless text fixture and confirm it moves from `pending` to `safe`; use the standard EICAR test file only in a controlled maintenance check and confirm it becomes `quarantined`. Neither scanner service publishes a host port.

## Mail delivery

`mail-worker` claims pending `email_outbox` rows, retries transient failures, and recovers stale claims after a worker crash. Keep `MAIL_ADAPTER=console` only for a non-delivering smoke test. For delivery, set `MAIL_ADAPTER=gmail` and populate the three root-owned Gmail OAuth secret files. The worker alone joins the dedicated outbound network; the database remains on the internal network. Confirm an invitation and password-reset message arrive before admitting learners.

`regrade-worker` processes only administrator-reviewed assessment corrections, with a regrade batch size of at most two. It verifies the complete immutable impact snapshot, reruns the whole deterministic form, and requires every runner response to match the reviewed image digest before appending an outcome. The same worker processes up to 20 local-only mastery projection repairs per poll; unresolved exact mappings wait 24 hours and remain visible in the admin correction view. Monitor the aggregate regrade and mastery-repair counts in `assessment_regrade.batch` and follow the [assessment correction runbook](runbooks/assessment-corrections.md); logs intentionally omit learner IDs, source, tests, result bodies, and projection snapshots.

`practice-runner-recovery-worker` reconciles only stale non-authoritative compile/run admissions. The web transaction stores the exact bounded request snapshot before remote dispatch; after an app crash the worker reuses that request and its original idempotency key, never generates a new job identity, and leaves all uncertain outcomes active for the next reconciliation. Monitor `practice_runner_recovery.batch`: `corrupt` or sustained `indeterminate` counts require operator investigation. The worker logs counts only, never source, stdin, request bodies, learner identity, or runner results.

No email export, mailbox archive, `.eml`, `.mbox`, `.pst`, or `.ost` file belongs in application data or backups.

## Runner handoff

Build `services/runner` on its dedicated VM, install [the example unit](../infra/runner/learncoding-runner.service.example), and follow [Runner isolation](runbooks/runner-isolation.md). Do not copy the app's `.env`, database URL, OAuth secrets, credential master key, Cloudflare credentials, backup identity, or rclone configuration to that VM.

The app's `RUNNER_BASE_URL` must be a private RFC 1918 address. Firewall port 4100 so only the trusted NUC can connect. The runner must bind that private interface rather than `0.0.0.0` or a public interface. Keep `RUNNER_STATE_ROOT=/var/lib/learncoding-runner`, backed by the example unit's mode-`0700` systemd `StateDirectory`; its mode-`0600` recovery journal remains on the disposable runner VM and is not part of trusted-host backups.

## Backups and ongoing operations

Complete [Backup and restore](runbooks/backup-and-restore.md) before inviting users. A deployment is not ready until a fresh encrypted archive has passed a restore drill.

Operator references:

- [Firewall and network](runbooks/firewall-and-network.md)
- [Updates and rollback](runbooks/updates-and-rollback.md)
- [Logs and monitoring](runbooks/logs-and-monitoring.md)
- [Backup and restore](runbooks/backup-and-restore.md)
- [Runner isolation](runbooks/runner-isolation.md)
- [Incident response](runbooks/incident-response.md)
- [Upload scanning](runbooks/upload-scanning.md)
- [API rate limiting](runbooks/rate-limiting.md)

Monthly, review disk use, update status, image digests, pending outbox count, backup freshness, offsite presence, UPS health, and the runner VM boundary. Quarterly, perform the supervised restore drill. Before every release, take and verify an encrypted backup.
