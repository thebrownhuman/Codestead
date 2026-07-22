# Codestead deployment

This is the production reference for a single Ubuntu 24.04 NUC serving an initial private cohort of roughly ten invited learners. The trusted host runs the web app, PostgreSQL, the Gmail-capable transactional outbox worker, the deterministic regrade and practice-recovery coordinators, upload-scanning services, and Cloudflare Tunnel. Submitted code runs on a separate KVM virtual machine. No application, database, or runner port is published to the public internet.

## Topology and trust boundaries

```text
browser -> Cloudflare -> outbound Tunnel -> Next.js app -> PostgreSQL
                                         |                  ^
                                         |                  | scan worker (read-only objects)
                                         |                  +-> internal clamd -> signature-only egress
                                         +-> internal runner-client -> secretless runner-egress-gateway -> runner-egress -> runner VM:4100 -> no-network job containers
```

- `frontend` is the app/tunnel Compose network. It has outbound connectivity.
- `data` is an internal Compose network shared only by the app, migration job, outbox worker, regrade coordinators, practice recovery, upload scan worker, and PostgreSQL. The app, regrade, exam-finalization, and practice-recovery services use the internal runner-client network and receive the runner HMAC secret; only the secretless `runner-egress-gateway` bridges that network to `runner-egress` and the runner VM. These runner-capable clients receive no Gmail, AI-provider, object-storage, or unrelated Better Auth secret.
- PostgreSQL has a persistent bind mount and no host port.
- Uploaded objects are unavailable until the scan worker streams them to clamd. The worker has read-only object access; clamd has no object-storage or database access and only its signature updater has outbound connectivity.
- The runner is not in `compose.yaml`. Docker access is root-equivalent, so it belongs on an independently disposable VM with no database, OAuth, backup, Cloudflare, or learner-credential secrets.
- Cloudflare Tunnel is the only public ingress. Its last rule is an explicit 404 catch-all.
- This is a careful small deployment, not a high-availability service. A NUC, home power, and one ISP remain single points of failure; use a UPS and tested backups.

## Prerequisites

Use a clean Ubuntu Server 24.04 LTS installation with full-disk encryption where unattended reboot recovery is practical. Install Docker Engine and the Compose plugin from Docker's apt repository, not the convenience script. Docker publishes the current Ubuntu instructions in [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and [Install the Compose plugin](https://docs.docker.com/compose/install/linux/).

The trusted host also needs `age`, `git`, `rclone` only when offsite copying is enabled, and ordinary core utilities (`flock`, `sha256sum`, `tar`). Install `smartmontools`, `libvirt-clients`, `nftables`, and Ubuntu's fixed `/usr/bin/python3.12` before recovery evidence is collected. The runner guest needs `qemu-guest-agent`; keep it enabled so the NUC can prove guest service, firewall, release-manifest, and runtime-record identity without SSH. Keep official Ubuntu security updates enabled; Canonical documents the defaults and drop-in configuration in [Automatic updates](https://documentation.ubuntu.com/server/how-to/software/automatic-updates/).

Install and activate the host-side KVM/libvirt prerequisites with the following paste-ready commands. The Docker Engine and Compose plugin remain installed separately from Docker's official apt repository as linked above.

```bash
sudo apt-get update
sudo apt-get install --yes --no-install-recommends \
  age git rclone smartmontools nftables \
  qemu-kvm libvirt-daemon-system libvirt-clients virtinst cloud-image-utils dnsmasq-base \
  python3.12
sudo systemctl enable --now libvirtd.service
sudo systemctl is-enabled --quiet libvirtd.service
sudo systemctl is-active --quiet libvirtd.service
test "$(command -v dnsmasq)" = /usr/sbin/dnsmasq
sudo test -c /dev/kvm
sudo virsh --connect qemu:///system list --all
```

Run the `qemu-guest-agent` installation and `systemctl enable --now qemu-guest-agent.service` inside the runner guest, not on the trusted application host. Treat any failed verification command above as a deployment blocker.

Required external setup:

- A DNS zone in Cloudflare and one locally managed tunnel.
- A private admin path (an admin VLAN or a VPN such as Tailscale) for SSH. Do not expose SSH broadly.
- A dedicated, mounted 2 TB backup filesystem.
- A dedicated Ubuntu KVM guest on the same NUC for the runner; the guest remains a separately firewalled trust boundary and receives no application secrets.
- Two offline copies of the `age` private identity in separate physical locations.

## Place the release and create host directories

Install a reviewed release at `/opt/learncoding`. Do not deploy a developer working tree containing `.env` files or unreviewed changes.

```bash
sudo install -d -o root -g root -m 0755 /opt/learncoding
sudo install -d -o root -g root -m 0750 /etc/learncoding /etc/learncoding/cloudflare
sudo groupadd --system --gid 2000 codestead-secrets
sudo install -d -o root -g codestead-secrets -m 0750 /etc/learncoding/secrets
sudo install -d -o root -g root -m 0750 /srv/learncoding
sudo install -d -o root -g root -m 0700 /var/lib/learncoding /var/lib/learncoding/releases
sudo install -d -o root -g root -m 0700 /srv/learncoding/postgres
sudo install -d -o 1000 -g 1000 -m 0750 /srv/learncoding/next-cache
sudo install -d -o root -g root -m 0750 /srv/learncoding/app-data
```

Fetch only the exact commit that passed review and CI. Do not deploy a moving branch name, reuse a chat-pasted credential, or run the application from a user-owned clone. Replace the commit value below with the reviewed 40-hex value from GitHub; the validation rejects a branch, shortened SHA, or malformed value.

```bash
CODESTEAD_REPOSITORY='https://github.com/thebrownhuman/Codestead.git'
CODESTEAD_RELEASE_COMMIT='REPLACE_WITH_REVIEWED_40_HEX_COMMIT'
printf '%s\n' "$CODESTEAD_RELEASE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
sudo git -C /opt/learncoding init
if sudo git -C /opt/learncoding remote get-url origin >/dev/null 2>&1; then
  sudo git -C /opt/learncoding remote set-url origin "$CODESTEAD_REPOSITORY"
else
  sudo git -C /opt/learncoding remote add origin "$CODESTEAD_REPOSITORY"
fi
sudo git -C /opt/learncoding fetch --depth=1 --no-tags origin "$CODESTEAD_RELEASE_COMMIT"
sudo git -C /opt/learncoding checkout --detach "$CODESTEAD_RELEASE_COMMIT"
test "$(sudo git -C /opt/learncoding rev-parse HEAD)" = "$CODESTEAD_RELEASE_COMMIT"
CODESTEAD_RELEASE_TREE="$(sudo git -C /opt/learncoding rev-parse 'HEAD^{tree}')"
printf '%s\n' "$CODESTEAD_RELEASE_TREE" | grep -Eq '^[0-9a-f]{40}$'
test -z "$(sudo git -C /opt/learncoding status --porcelain=v1 --untracked-files=all)"
sudo test "$(stat -c '%U:%G' /opt/learncoding)" = root:root
printf 'release_commit=%s\nrelease_tree=%s\n' "$CODESTEAD_RELEASE_COMMIT" "$CODESTEAD_RELEASE_TREE"
unset CODESTEAD_RELEASE_COMMIT CODESTEAD_RELEASE_TREE CODESTEAD_REPOSITORY
```

If the repository is private, use a dedicated read-only GitHub deploy key installed directly on the NUC with mode `0600` and a pinned `github.com` host key; change only `CODESTEAD_REPOSITORY` to the SSH URL. Never embed a token in the remote URL. Record the two non-secret identities printed above in the private release ledger.
Provision the object root before the first Compose start. The same fail-closed command runs before every systemd start and reload. It pins the parent as `root:root` mode `0750`, the exact object mount as `root:1000` mode `01770`, and `.codestead-object-root-v1` as a one-link `root:1000` mode `0440` file containing exactly `codestead-object-storage-v1` plus one newline. It rejects symlinks and identity drift and fsyncs new metadata.

```bash
sudo env UPLOADS_ENABLED=false LEARN_DATA_ROOT=/srv/learncoding \
  /usr/bin/node /opt/learncoding/infra/ops/prepare-object-storage.mjs
sudo stat -c '%U:%G %a %n' /srv/learncoding/app-data /srv/learncoding/app-data/objects \
  /srv/learncoding/app-data/objects/.codestead-object-root-v1
```

UID 1000 is the `node` user in the pinned base image. Recheck it whenever that base image changes. PostgreSQL's official entrypoint initializes and corrects ownership of its own empty data directory.

## Capture the pre-existing container recovery baseline

Before the first Codestead release and before enabling `learncoding-recovery-check.timer`, record the running containers that already belong to this NUC. The root-only capture command stores each name, immutable Docker image ID, approved restart policy, health-check requirement, and a SHA-256 fingerprint of its configuration. Raw environment values and inspect data are hashed in memory and are never written to the baseline. Recovery therefore rejects a stopped, unhealthy, reconfigured, or same-name replacement container. It also fails closed if the file is missing, empty, symlinked, malformed, not owned by `root:root`, or not mode `0600`.

Run this only while every pre-existing service that must survive is healthy and before any Codestead container exists:

```bash
sudo /usr/bin/python3 -B /opt/learncoding/infra/ops/capture-existing-containers.py
sudo test -s /etc/learncoding/existing-containers.txt
sudo stat -c '%U:%G %a %n' /etc/learncoding/existing-containers.txt
```

The capture must print only an aggregate `capturedExistingContainers=N`, and the final `stat` output must be `root:root 600 /etc/learncoding/existing-containers.txt`. Capture fails unless every retained container is running, has `always` or `unless-stopped` restart policy, and reports healthy when it defines a health check. Never add or recreate a container merely to make a failed recovery check pass. If the pre-existing service inventory intentionally changes later, use a reviewed maintenance window, stop Codestead, make every retained service healthy, and run the same command with `--replace`; then rerun the recovery check before restoring public access.

Copy the non-secret examples, then edit only the installed copies:

```bash
sudo install -o root -g root -m 0640 infra/env/compose.env.example /etc/learncoding/compose.env
sudo install -o root -g root -m 0600 infra/env/backup.env.example /etc/learncoding/backup.env
sudo install -o root -g root -m 0640 \
  /opt/learncoding/infra/cloudflare/config.example.yml \
  /etc/learncoding/cloudflare/config.yml
```

Set the real HTTPS origin, private runner address, and immutable image references in `compose.env`. `POSTGRES_IMAGE`, `CLOUDFLARED_IMAGE`, and all seven `APP_*_IMAGE` values must use a non-empty image name ending in `@sha256:` plus a reviewed 64-character digest. Keep `SECRETS_GID=2000`.

Pilot mode is exactly `UPLOADS_ENABLED=false` with no `uploads` token in `COMPOSE_PROFILES`; the dedicated `file-erasure-worker` remains always on so accepted user deletions are physically consumed across restarts, while ClamAV and `scan-worker` are not rendered. Enabling uploads requires exactly the `uploads` profile token, `UPLOADS_ENABLED=true`, and a reviewed version-specific `CLAMAV_IMAGE=clamav/clamav:<version>_base@sha256:<64-hex-digest>`. Floating ClamAV tags, including `latest` and `stable`, are rejected whenever uploads are active. The reference reserves 4 GB for clamd because the official guidance warns that 2 GB may be insufficient after loading signatures.

The reference NUC target is `linux/amd64`. Keep `DEPLOY_PLATFORM=linux/amd64`; the Dockerfile deliberately pins the architecture-specific Node image manifest, not just a floating or wrong-architecture digest. An ARM development machine may build the NUC image through Docker emulation. A native ARM server needs a separate application/build and image-digest review.

## Create runtime secrets

Read [the secret inventory](../infra/secrets/README.md) first. This ceremony is for initial creation only: it acquires a per-directory lock, refuses to overwrite any existing database secret, and rolls back every final created by a failed run. Run it from the installed release. It stages and validates the complete inventory before publication, generates independent URL-safe hexadecimal passwords for the fixed `learncoding`, `learncoding_app`, `learncoding_migrator`, `learncoding_worker`, and `learncoding_ops` roles, creates `postgres_password`, `database_bootstrap_url`, `database_url`, `database_migrator_url`, `database_worker_url`, and `database_ops_url` without trailing whitespace or control bytes, and applies the required `root:codestead-secrets` ownership and exact modes without printing a value.

```bash
sudo -H bash /opt/learncoding/infra/ops/create-database-secrets.sh
sudo -H bash
umask 077
openssl rand -base64 48 | tr -d '\n' > /etc/learncoding/secrets/better_auth_secret
openssl rand -base64 48 | tr -d '\n' > /etc/learncoding/secrets/lost_device_proof_key
openssl rand -base64 48 | tr -d '\n' > /etc/learncoding/secrets/deletion_tombstone_key
openssl rand -base64 32 | tr -d '\n' > /etc/learncoding/secrets/credential_master_key
openssl rand -base64 48 | tr -d '\n' > /etc/learncoding/secrets/runner_shared_secret
: > /etc/learncoding/secrets/google_client_secret
: > /etc/learncoding/secrets/gmail_client_id
: > /etc/learncoding/secrets/gmail_client_secret
: > /etc/learncoding/secrets/gmail_refresh_token
chown root:codestead-secrets /etc/learncoding/secrets/*
chmod 0440 /etc/learncoding/secrets/*
exit
```

Copy `runner_shared_secret` once over a secure admin channel to `/etc/learncoding/runner-shared-secret` on the runner VM, then remove any transfer artifact. Never reuse it as an auth or encryption key.

If Google login is enabled, set the OAuth client ID in `compose.env`, place only the client secret in `google_client_secret`, and register the exact production callback origin in Google Cloud. If it is disabled, keep both the client ID and secret empty.

The Cloudflare tunnel credentials JSON must be issued by Cloudflare and installed directly as `/etc/learncoding/secrets/cloudflare_tunnel_credentials.json`, owned by `root:codestead-secrets` with mode `0440`. Preserve Cloudflare's compact canonical three-field document: `AccountTag` is a lowercase 32-hex account identity, `TunnelSecret` is canonical base64 for exactly 32 bytes, and `TunnelID` is a lowercase RFC 4122 UUID. Missing, reordered, extra, malformed, or noncanonical values fail preflight; the validator never prints them. The file must never enter Git, an image layer, a backup archive, or a support message. After adding or replacing any secret, restore the complete inventory to the exact metadata expected by preflight:

```bash
sudo chown root:codestead-secrets /etc/learncoding/secrets/*
sudo chmod 0440 /etc/learncoding/secrets/*
```

For the initial administrator only, set `BOOTSTRAP_ADMIN_EMAIL` in `compose.env` and create a temporary independent password. The validator requires at least 16 non-whitespace characters; the following generates more than that without printing it:

```bash
sudo -H bash
umask 077
openssl rand -base64 24 | tr -d '\n' > /etc/learncoding/secrets/bootstrap_admin_password
chown root:codestead-secrets /etc/learncoding/secrets/bootstrap_admin_password
chmod 0440 /etc/learncoding/secrets/bootstrap_admin_password
exit
```

Do not invoke `admin-bootstrap` directly. The explicit first-release transaction below is the only documented path that runs it, and only when `--bootstrap-admin` is present. Retain the non-secret `bootstrap_admin.created` event as evidence, process the verification email, sign in, change the temporary password, and enroll TOTP. Only after those steps succeed, remove the temporary file with `sudo rm /etc/learncoding/secrets/bootstrap_admin_password`.

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

### Review the seven application images

The production preflight accepts exactly the seven reviewed application targets and their digest references. Run the gate from a clean checkout at the candidate commit. Local mode is an explicit unsigned-build risk acceptance for the private NUC only; registry publication additionally requires the verified BuildKit SLSA provenance and Cosign signature/attestation policy enforced by the manager.

```bash
export APP_IMAGE_SOURCE_REPOSITORY=https://github.com/thebrownhuman/Codestead
export APP_IMAGE_SOURCE_REVISION="$(git rev-parse HEAD)"
export APP_IMAGE_TRIVY_CACHE_DIR="$HOME/.cache/codestead/application-image-trivy"
export APP_IMAGE_LOCAL_RISK_ACCEPTANCE=accept-unsigned-local-buildkit-provenance-v1
npm run app-images:test
npm run app-images:build
npm run app-images:inspect
trivy image --cache-dir "$APP_IMAGE_TRIVY_CACHE_DIR" --download-db-only
trivy image --cache-dir "$APP_IMAGE_TRIVY_CACHE_DIR" --download-java-db-only
npm run app-images:scan
npm run app-images:record
```

The final commit marker is `dist/application-images/application-images.json`; its canonical UTF-8 bytes are two-space JSON with LF line endings and one terminal LF. The standalone verifier rejects any reformatting and reports `application-image-record-id=<hex> application-image-record-sha256=<hex>`. Bind release state to `APPLICATION_IMAGE_RECORD_SHA256` using SHA-256 of those exact bytes, never a parsed or reformatted document.

The matching `application-images.env` is published durably before the JSON marker. Both files are source-revision bound, expire after 24 hours, cover all seven distinct identities, and must still match the Compose projection when the release preflight runs. The CI artifact proves the gate ran in CI; it does not prove that the exact images exist on the NUC or in a registry.

### Run the explicit release transaction

Before every release, deploy a clean root-owned Git checkout whose bytes exactly match its reviewed `HEAD`. Use the transaction's `--acquire-images` option to pull exactly the lowercase digest references rendered from the reviewed Compose configuration; each acquisition is recorded before any container or database mutation. If those exact images were imported through an audited offline process, omit that option and the transaction will require them to exist locally. Run the transaction as root; it rejects an ambient `RELEASE_GIT_COMMIT` override, unsafe/symlinked paths, and an untrusted release-evidence directory. Every Compose mutation, boot, recovery, and rollback command carries `--no-build --pull never`.

For the initial release only, after creating the temporary administrator password file above, run:

```bash
sudo REPO_ROOT=/opt/learncoding \
  COMPOSE_ENV_FILE=/etc/learncoding/compose.env \
  COMPOSE_FILE_PATH=/opt/learncoding/compose.yaml \
  bash /opt/learncoding/infra/ops/release-production.sh --acquire-images --bootstrap-admin
```

For every later application release, omit the bootstrap flag and ensure the temporary password file remains absent:

```bash
sudo test ! -e /etc/learncoding/secrets/bootstrap_admin_password
sudo REPO_ROOT=/opt/learncoding \
  COMPOSE_ENV_FILE=/etc/learncoding/compose.env \
  COMPOSE_FILE_PATH=/opt/learncoding/compose.yaml \
  bash /opt/learncoding/infra/ops/release-production.sh --acquire-images
```

The transaction takes a bounded exclusive host lock and records the current and previously deployed Git commits plus candidate and previous running image identities under `/var/lib/learncoding/releases`. It stops `cloudflared` before database or candidate mutation, runs migration and the idempotent seed, starts the internal app/workers, and exercises authenticated session revocation, disabled upload creation, seed/migration/admin invariants, and a representative Python run before public exposure. Only then does it start the tunnel and verify the exact HTTPS origin and security headers. Any post-start failure immediately stops the tunnel and leaves a `result=failed` record. A prior pinned runtime is restored automatically only when the operator supplied `--schema-backward-compatible`; the flag asserts application compatibility with the already-migrated schema and never reverses SQL. Once the new `active-release.env` rename is visible, it is the recovery commit marker: a later fsync or audit-pointer failure re-quarantines the tunnel but deliberately skips automatic restore, leaving the failed candidate eligible for the explicit rollback tool so containers never diverge behind the committed manifest. Otherwise use a verified database recovery point for incompatible schema changes.

### Install the reviewed host runtime for supervised load gates

The application remains containerized, but the supervised production-load control, gate, and exact-journal recovery units intentionally run the repository's TypeScript entrypoints on the trusted host. They therefore require a fixed `/usr/bin/node` and the production `tsx` package tree under `/opt/learncoding`. Do not use a `curl | bash` setup script. Configure the signed NodeSource 22.x apt repository with the same reviewed-key procedure used by `infra/runner-vm/install-guest.sh`, then install the reviewed package version below. If `apt-cache` does not list that exact version, stop and review a replacement rather than silently floating.

```bash
NODEJS_APT_VERSION=22.23.1-1nodesource1
sudo apt-get update
apt-cache madison nodejs | grep -F "${NODEJS_APT_VERSION}"
sudo apt-get install --yes --no-install-recommends "nodejs=${NODEJS_APT_VERSION}"
test "$(/usr/bin/node --version)" = v22.23.1
test -x /usr/bin/npm

cd /opt/learncoding
sudo /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin \
  /usr/bin/npm ci --omit=dev --ignore-scripts --prefix /opt/learncoding --no-audit --no-fund
sudo chown -R root:root /opt/learncoding/node_modules
sudo chmod -R go-w /opt/learncoding/node_modules
sudo /usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-host-runtime.sh
```

The validator fails closed when `/usr/bin/node` is missing, symlinked, non-root-owned, group/world-writable, below the package engine floor of `22.22.0`, or when the root-owned `tsx` manifest is not exactly `4.23.0`. The systemd installer repeats this check before publishing any unit, and each Node-backed load unit repeats it immediately before execution.
After the transaction succeeds, install the reviewed units, reload systemd, and enable only the trusted stack plus the persistent timers:

```bash
cd /opt/learncoding
sudo REPO_ROOT=/opt/learncoding bash /opt/learncoding/infra/ops/install-systemd.sh --enable
sudo systemctl is-active --quiet learncoding-runner-firewall.service
sudo systemctl is-active --quiet learncoding-compose.service
sudo systemctl is-enabled --quiet learncoding-recovery-check.timer
sudo systemctl is-enabled --quiet learncoding-ingress-recovery.timer
```

The installer publishes the reviewed units, validates and enables the host runner firewall before the trusted Compose stack, enables the bounded recovery checker, and enables the eight reviewed recovery, backup, offsite-publication, restore-drill reminder, and retention timers. The guest-only firewall unit may be present in the installed catalog but is enabled only inside the isolated runner VM by `install-guest.sh`.

Do not enable `learncoding-restore-drill.service`; it remains a supervised manual operation. `learncoding-backup.timer`, `learncoding-offsite-sync.timer`, `learncoding-offsite-retention.timer`, `learncoding-restore-drill-reminder.timer`, and `learncoding-retention.timer` use `OnCalendar=` with `Persistent=true`, so systemd catches up a missed calendar run after downtime. The reminder only validates the latest passing report and never starts a restore. `learncoding-backup-check.timer`, `learncoding-recovery-check.timer`, and `learncoding-ingress-recovery.timer` use monotonic boot/active intervals; after a reboot they schedule fresh post-boot checks rather than replaying a missed wall-clock event.

`learncoding-compose.service` is deliberately only the ordinary boot/recovery path. It requires `/opt/learncoding`, `/etc/learncoding`, and `/srv/learncoding`, runs pilot preflight, starts already-reviewed local images with `--no-build --pull never`, and runs pilot readiness smoke. Boot, reboot, start, and reload never migrate, seed, bootstrap, build, or pull. The stop command never uses `down -v`; persistent data is not tied to container lifecycle. Database initialization and application release remain exclusively in the explicit transaction above.

Inspect the first boot:

```bash
sudo systemctl status learncoding-compose.service
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml ps
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml logs --since 10m app regrade-worker cloudflared
sudo find /var/lib/learncoding/releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
curl --fail --silent --show-error https://learn.example.com/ >/dev/null
```

Then verify login, onboarding, one lesson read, one quiz submission, and one code run using a non-admin learner account. Confirm PostgreSQL and runner port 4100 are unreachable from the public internet.

## Disposable production-topology gate

The independent `production-topology` CI job exercises the real production Compose graph on a disposable GitHub-hosted Linux runner. It builds the runtime, tooling, operations, and worker targets; starts real PostgreSQL; proves the production migration service waits on its advisory lock and that a second run is idempotent; runs the platform seed; and creates the only administrator through the actual `admin-bootstrap` one-shot with a file-backed temporary password. The default pilot stack then starts with `UPLOADS_ENABLED=false`, an isolated runner stub behind the real egress gateway, and a fake in-project tunnel process. No real provider credentials, provider network calls, host ports, ClamAV, or scanner worker are used; the dedicated erasure worker is still exercised in the pilot graph.

The gate commits a deterministic audit marker, restarts PostgreSQL, the application, every worker, the runner boundary, and the tunnel fixture, then replays seed/bootstrap and requires the marker plus the explicit administrator, provider-policy, achievement, course, curriculum-artifact, and project-template identity snapshot to remain exact. On the hosted disposable runner it captures every service container ID and `StartedAt`, restarts `docker.service`, requires restart policies alone to recover the existing healthy containers without a Compose mutation, and proves that every service entered a new generation. Its exit trap runs `down --volumes --remove-orphans`, removes the owned fallback network before recomputing remnants, proves every random test image tag and labeled container/network/volume is absent, and deletes only its marked temporary directory. A cleanup defect fails an otherwise successful gate without hiding an earlier test failure.

The reviewed job installs Docker Engine and CLI `29.6.1` from Docker's official Ubuntu repository after verifying the repository key checksum, and installs Docker Compose `5.3.1` through the SHA-pinned official setup action. The harness refuses any version drift. Before the optional daemon restart it also requires both the current and effective Docker endpoint to be the local system socket `unix:///var/run/docker.sock`, requires that socket to exist, rejects every pre-existing container before setup, and immediately rejects any foreign container before restart. These checks intentionally reject Docker Desktop, remote contexts, shared daemons, and the production NUC.

Run the ordinary tranche only on a disposable Linux Docker host with those exact reviewed Docker versions:

```bash
CODESTEAD_DISPOSABLE_HOST=1 bash infra/tests/production-topology.test.sh
```

The Docker-daemon tranche is deliberately accepted only on a GitHub-hosted disposable runner:

```bash
GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted \
  CODESTEAD_DISPOSABLE_HOST=1 \
  CODESTEAD_DISPOSABLE_DOCKER_DAEMON=1 \
  CODESTEAD_TOPOLOGY_RESTART_DOCKER=1 \
  bash infra/tests/production-topology.test.sh
```

Do not run this destructive test against the NUC or any shared Docker daemon. This CI gate proves container/service restart persistence; it does not replace the controlled NUC reboot, physical AC-cut, offsite restore, Cloudflare, Gmail, or live-runner evidence.

## Power-loss evidence boundary

Repository checks establish only the interim trusted-stack boot seam. Before learner invitations, deployment evidence must still record the firmware setting **Restore on AC Power Loss: Power On**, separate libvirt autostart and guest-service evidence for the runner VM, and the later supervised hard-cut rehearsal. Those NUC and runner gates are unfinished until their dedicated rollout tasks run; this document does not claim that a reboot, AC removal, public recovery, or the 15-minute recovery target has passed.

The eventual rehearsal must preserve every acknowledged server record marked `Saved to Codestead` and create no duplicate XP, mail, or evidence. Before learner invitations, offline lesson drafts and exam answers must use a browser-durable outbox that persists locally before displaying `Saved locally`; evidence must prove they survive browser close/reopen and synchronize exactly once after recovery. Logout, session revocation, exam finalization, and administrator deletion must purge the scoped local records. Without a UPS, the system cannot truthfully guarantee the final keystroke before browser persistence, an unacknowledged network request, or a hardware write falsely reported as durable; the server guarantee begins only at `Saved to Codestead`.

Before capturing evidence, mount the dedicated backup filesystem at `/mnt/learncoding-backups` with `rw,nodev,nosuid,noexec`; it must resolve through `lsblk` to a different physical disk from `/srv/learncoding`. A bind mount or second partition on the application disk is rejected. Confirm the current backup created `/mnt/learncoding-backups/state/local-last-success.env`, and confirm the latest successful release atomically published root-owned, non-group-writable `/etc/learncoding/active-release.env`, `/etc/learncoding/managed-containers.<MANAGED_INVENTORY_SHA256>.tsv`, and `/etc/learncoding/application-images.<APPLICATION_IMAGE_RECORD_SHA256>.json`. The two hash-addressed evidence files are immutable, are durably published first, and are selected only by the hashes in `active-release.env`; that manifest is the sole mutable commit marker. Together they bind the exact Git commit and tree, exact verified application-image-record bytes, release manifest, host firewall policy, eleven managed Compose container/image identities, and runner runtime record. Recovery must derive both evidence paths from the validated active manifest. Never hand-edit any of these files.

Use one event ID for the pre/post pair. The pre-capture must finish before the supervised power cut; the post-capture must occur after a different boot ID is observed:

```bash
sudo install -d -o root -g root -m 0700 /var/lib/learncoding/recovery-evidence
event="hardcut-$(date -u +%Y%m%dT%H%M%SZ)"
sudo /opt/learncoding/infra/ops/capture-recovery-evidence.sh pre \
  "/var/lib/learncoding/recovery-evidence/${event}.pre.json"
# Follow the power-loss runbook: perform the physical cut, observe readiness,
# reconcile every marker exactly once, and complete the immediate backup first.
power_restored_utc='ACTUAL_FIRST_FIRMWARE_POWER_ON_UTC'
public_ready_utc='ACTUAL_FIRST_PUBLIC_READY_UTC'
sudo /opt/learncoding/infra/ops/capture-recovery-evidence.sh post \
  "/var/lib/learncoding/recovery-evidence/${event}.post.json" \
  "$power_restored_utc" \
  "$public_ready_utc"
sudo /usr/bin/env EVENT_ID="$event" /usr/bin/bash -ceu '
  cd /var/lib/learncoding/recovery-evidence
  /usr/bin/sha256sum --check -- \
    "${EVENT_ID}.pre.json.sha256" \
    "${EVENT_ID}.post.json.sha256"
'
```

The collector is silent on success and publishes JSON plus its checksum append-only. It fails without a commit marker if the backup is stale or malformed, either disk reports SMART errors, PostgreSQL durability is weakened, a managed container/image differs, a required timer or firewall is unhealthy, the runner VM/guest agent/service/runtime identity drifts, output is excessive, the 15-minute recovery checker fails, or the two operator observations are missing, malformed, future-dated, clock-inconsistent, reversed, or more than 900 seconds apart. Follow the complete [Power-loss recovery](runbooks/power-loss-recovery.md) marker, reconciliation, and immediate-backup procedure before post capture. The JSON binds the supplied restoration/readiness observations. These files are technical evidence only; they do not prove a physical cut occurred, operator identity, or clock custody. Record the operator, observer, UTC cut time, firmware setting, and external ledger separately. Never claim the hard-cut gate passed from CI, a synthetic reboot, or repository tests.

Before accepting uploads, follow [Upload scanning](runbooks/upload-scanning.md). Upload a harmless text fixture and confirm it moves from `pending` to `safe`; use the standard EICAR test file only in a controlled maintenance check and confirm it becomes `quarantined`. Neither scanner service publishes a host port.

## Mail delivery

`mail-worker` claims pending `email_outbox` rows, retries transient failures, and recovers stale claims after a worker crash. Keep `MAIL_ADAPTER=console` only for a non-delivering smoke test. For delivery, set `MAIL_ADAPTER=gmail` and populate the three root-owned Gmail OAuth secret files. The worker alone joins the dedicated outbound network; the database remains on the internal network. Confirm an invitation and password-reset message arrive before admitting learners.

`regrade-worker` processes only administrator-reviewed assessment corrections, with a regrade batch size of at most two. It verifies the complete immutable impact snapshot, reruns the whole deterministic form, and requires every runner response to match the reviewed image digest before appending an outcome. The same worker processes up to 20 local-only mastery projection repairs per poll; unresolved exact mappings wait 24 hours and remain visible in the admin correction view. Monitor the aggregate regrade and mastery-repair counts in `assessment_regrade.batch` and follow the [assessment correction runbook](runbooks/assessment-corrections.md); logs intentionally omit learner IDs, source, tests, result bodies, and projection snapshots.

`practice-runner-recovery-worker` reconciles only stale non-authoritative compile/run admissions. The web transaction stores the exact bounded request snapshot before remote dispatch; after an app crash the worker reuses that request and its original idempotency key, never generates a new job identity, and leaves all uncertain outcomes active for the next reconciliation. Monitor `practice_runner_recovery.batch`: `corrupt` or sustained `indeterminate` counts require operator investigation. The worker logs counts only, never source, stdin, request bodies, learner identity, or runner results.

No email export, mailbox archive, `.eml`, `.mbox`, `.pst`, or `.ost` file belongs in application data or backups.

## Runner handoff

Build `services/runner` on its dedicated VM, install [the example unit](../infra/runner/learncoding-runner.service.example), and follow [Runner isolation](runbooks/runner-isolation.md). Do not copy the app's `.env`, database URL, OAuth secrets, credential master key, Cloudflare credentials, backup identity, or rclone configuration to that VM.

The deployment-level `RUNNER_BASE_URL` in `/etc/learncoding/compose.env` is the private runner VM upstream and is passed only to `runner-egress-gateway` as `RUNNER_GATEWAY_UPSTREAM`. The effective container `RUNNER_BASE_URL` for the app and runner-consuming workers is fixed to `http://runner-egress-gateway:4100`; never route those clients directly to the VM. Firewall port 4100 so only the trusted gateway source on the NUC can connect. The runner must bind that private interface rather than `0.0.0.0` or a public interface. Keep `RUNNER_STATE_ROOT=/var/lib/learncoding-runner`, backed by the example unit's mode-`0700` systemd `StateDirectory`; its mode-`0600` recovery journal remains on the disposable runner VM and is not part of trusted-host backups.

## Backups and ongoing operations

Complete [Backup and restore](runbooks/backup-and-restore.md) before inviting users. A deployment is not ready until a fresh encrypted archive has passed a restore drill.

Operator references:

- [Firewall and network](runbooks/firewall-and-network.md)
- [Updates and rollback](runbooks/updates-and-rollback.md)
- [Logs and monitoring](runbooks/logs-and-monitoring.md)
- [Backup and restore](runbooks/backup-and-restore.md)
- [Runner isolation](runbooks/runner-isolation.md)
- [Power-loss recovery](runbooks/power-loss-recovery.md)
- [Incident response](runbooks/incident-response.md)
- [Upload scanning](runbooks/upload-scanning.md)
- [API rate limiting](runbooks/rate-limiting.md)
- [Data lifecycle, export, and account deletion](runbooks/data-lifecycle.md) — canonical retention policy `2026-07-14.v4`

Monthly, review disk use, update status, image digests, pending outbox count, backup freshness, offsite presence, UPS health, and the runner VM boundary. Quarterly, perform the supervised restore drill. Before every release, take and verify an encrypted backup.
